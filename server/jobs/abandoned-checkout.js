/*
 * GET|POST /api/jobs/abandoned-checkout  —  email people who left checkout
 * ============================================================================
 * Runs every 10 minutes. For each saved cart that has been quiet for an hour
 * (and is under two days old) it sends ONE reminder — unless the person ordered
 * in the meantime (then it just marks the cart converted) or unsubscribed.
 *
 * Idempotent: the reminder is stamped on the row before the next run, and the
 * email itself is de-duplicated per lead, so a doubled cron cannot double-send.
 *
 * AUTH  Bearer CRON_SECRET or ADMIN_API_TOKEN (same rule as the other jobs).
 */
"use strict";

const http      = require("../_lib/http");
const auth      = require("../_lib/auth");
const db        = require("../_lib/db");
const abandoned = require("../_lib/abandoned");
const messaging = require("../_lib/messaging");

const JOB_TOKENS = ["CRON_SECRET", "ADMIN_API_TOKEN"];
const BATCH = 30;

function siteUrl() { return (process.env.SITE_URL || "").replace(/\/+$/, ""); }

async function run() {
  const now = Date.now();
  const rows = await db.select("leads", { where: { source: abandoned.SOURCE, converted_at: ["is", null] }, limit: 500 });
  const out = { considered: rows.length, reminded: 0, converted: 0, skipped: 0 };

  for (let i = 0; i < rows.length && out.reminded < BATCH; i++) {
    const lead = rows[i], meta = lead.metadata || {};
    const savedAt = Date.parse(meta.savedAt || lead.updated_at);
    const age = now - savedAt;
    if (meta.unsubscribed || meta.remindedAt || age < abandoned.REMIND_AFTER_MS || age > abandoned.GIVE_UP_AFTER_MS) {
      out.skipped++; continue;
    }

    // Did they order after saving this cart? Then there is nothing to remind about.
    const orders = await db.select("orders", { where: { ship_email: ["ilike", lead.email], created_at: ["gte", meta.savedAt || lead.updated_at] }, limit: 1 });
    if (orders.length) {
      await db.update("leads", { where: { id: lead.id }, set: { converted_at: db.nowISO() } });
      out.converted++; continue;
    }

    // Stamp first: a crash after sending can never lead to a second reminder.
    await db.update("leads", { where: { id: lead.id }, set: { metadata: Object.assign({}, meta, { remindedAt: db.nowISO() }) } });
    const r = await messaging.send({
      channel: "email", to: lead.email,
      subject: "You left something in your NAFUME cart",
      body: messaging.abandonedCheckoutEmail(meta, siteUrl(), abandoned.unsubscribeUrl(siteUrl(), lead.email_normalized)),
      relatedType: "abandoned_checkout", relatedId: lead.id, dedupe: true
    });
    if (r && r.queued !== false) out.reminded++;
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }
  if (!auth.anyConfigured(JOB_TOKENS)) {
    return http.fail(res, 503, "job_not_configured", "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!auth.bearerMatches(req, JOB_TOKENS)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!http.requireStorage(res)) return;
  try {
    return http.ok(res, { ranAt: new Date().toISOString(), summary: await run() });
  } catch (err) {
    return http.handleError(res, err, "jobs/abandoned-checkout");
  }
};
module.exports.run = run;
