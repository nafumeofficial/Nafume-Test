/*
 * GET|POST /api/jobs/drain-outbox  —  deliver messages that were only queued
 * ============================================================================
 * Every customer-facing message is written to `outbound_messages` before any
 * provider is called. A message stays 'queued' when:
 *   - no provider was configured at the time (RESEND_API_KEY added later), or
 *   - the provider was down, timed out, or rejected the attempt.
 *
 * This job retries those. It is the reason "no email provider yet" is a
 * deferral rather than a loss: add the key, run this once, and the backlog goes
 * out.
 *
 * AUTH  Bearer CRON_SECRET (Vercel Cron sends it) or ADMIN_API_TOKEN.
 *
 * SAFETY
 *   - Only 'queued' and 'failed' rows are touched. A 'sent' row is never
 *     re-sent, so running this repeatedly cannot spam a customer.
 *   - Each row is claimed by incrementing `attempts` BEFORE the provider call,
 *     so two concurrent runs cannot both send the same message.
 *   - Rows past MAX_ATTEMPTS are left alone and reported, rather than retried
 *     forever against an address that will never work.
 *   - WhatsApp rows are skipped entirely while no provider exists — they are
 *     not failures, just not deliverable yet.
 */
"use strict";

const http      = require("../_lib/http");
const db        = require("../_lib/db");
const messaging = require("../_lib/messaging");

const CRON_SECRET     = process.env.CRON_SECRET;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

const MAX_ATTEMPTS = 5;
const BATCH_LIMIT  = 40;

function authorised(req) {
  const header = String((req.headers && req.headers.authorization) || "");
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  if (CRON_SECRET && token === CRON_SECRET) return true;
  if (ADMIN_API_TOKEN && token === ADMIN_API_TOKEN) return true;
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }

  if (!CRON_SECRET && !ADMIN_API_TOKEN) {
    console.error("[jobs/drain-outbox] refusing — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!authorised(req)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!http.requireStorage(res)) return;

  const summary = {
    scanned: 0, sent: 0, failed: 0, skippedWhatsApp: 0, givenUp: 0,
    emailProviderConfigured: messaging.emailConfigured(),
    whatsappProviderConfigured: messaging.whatsappConfigured()
  };

  if (!messaging.emailConfigured()) {
    return http.ok(res, {
      summary: summary,
      note: "No email provider configured. Set RESEND_API_KEY, then run this job to deliver the queued backlog."
    });
  }

  try {
    const queued = await db.select("outbound_messages", {
      where: { status: "queued" },
      order: { column: "created_at", ascending: true },
      limit: BATCH_LIMIT
    });

    const failed = await db.select("outbound_messages", {
      where: { status: "failed" },
      order: { column: "created_at", ascending: true },
      limit: BATCH_LIMIT
    });

    const rows = queued.concat(failed);
    summary.scanned = rows.length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (row.channel === "whatsapp" && !messaging.whatsappConfigured()) {
        summary.skippedWhatsApp++;
        continue;
      }
      if ((row.attempts || 0) >= MAX_ATTEMPTS) {
        summary.givenUp++;
        continue;
      }
      if (!row.to_address || row.error === "invalid_recipient") {
        summary.givenUp++;
        continue;
      }

      // Claim the row BEFORE calling the provider. A parallel run reading the
      // same row afterwards sees the higher attempt count and, once it hits
      // MAX_ATTEMPTS, stops — so a message cannot be sent twice by two workers
      // racing on the same batch.
      const claimed = await db.update("outbound_messages", {
        where: { id: row.id, attempts: row.attempts || 0 },
        set:   { attempts: (row.attempts || 0) + 1, status: "queued" }
      });
      if (!claimed || !claimed.length) continue;   // somebody else took it

      const result = await messaging.deliverQueuedRow(row);
      if (result.sent) summary.sent++;
      else summary.failed++;
    }

    return http.ok(res, {
      summary: summary,
      note: summary.givenUp > 0
        ? summary.givenUp + " message(s) exceeded the retry limit or have an unusable address; they were left untouched for manual review."
        : undefined
    });

  } catch (err) {
    return http.handleError(res, err, "jobs/drain-outbox");
  }
};
