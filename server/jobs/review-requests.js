/*
 * POST|GET /api/jobs/review-requests  —  queue post-delivery review requests
 * ============================================================================
 * A callable job, intended to be run on a schedule. vercel.json registers it as
 * a daily cron; it can also be invoked by hand with the same bearer token.
 *
 * AUTH  Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends this header
 *       automatically once CRON_SECRET is set on the project) or
 *       Bearer <ADMIN_API_TOKEN> for manual runs. With NEITHER variable set the
 *       job refuses to run rather than exposing an open endpoint.
 *
 * ELIGIBILITY  paid order + delivered_at older than REVIEW_REQUEST_DELAY_DAYS
 *              + no request already recorded + no review already submitted.
 *
 * RUNNING TWICE IS SAFE  review_requests.order_id is UNIQUE, and the order is
 * only picked up while review_request_status is still 'not_due'. A second run
 * in the same window selects nothing; a concurrent run loses the insert race
 * and skips that order.
 *
 * NO EMAIL PROVIDER CONFIGURED  the request is still recorded and the message
 * still lands in outbound_messages as 'queued'. The job reports queued vs sent
 * separately and never claims a delivery that did not happen.
 */
"use strict";

const http      = require("../_lib/http");
const catalog   = require("../_lib/catalog");
const messaging = require("../_lib/messaging");
const db        = require("../_lib/db");

const CRON_SECRET     = process.env.CRON_SECRET;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SITE_URL        = (process.env.SITE_URL || "").replace(/\/+$/, "");

const BATCH_LIMIT = 50;

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
    console.error("[jobs/review-requests] refusing to run — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!authorised(req)) {
    return http.fail(res, 401, "unauthorised", "Not authorised.");
  }
  if (!http.requireStorage(res)) return;

  const cutoff = new Date(Date.now() - catalog.REVIEW_REQUEST_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const summary = { scanned: 0, queued: 0, sent: 0, skipped: 0, failed: 0, cutoff: cutoff };

  try {
    const due = await db.select("orders", {
      where: {
        payment_status:        "paid",
        review_request_status: "not_due",
        delivered_at:          ["lte", cutoff],
        review_id:             ["is", null]
      },
      order: { column: "delivered_at", ascending: true },
      limit: BATCH_LIMIT
    });

    summary.scanned = due.length;

    for (let i = 0; i < due.length; i++) {
      const order = due[i];
      const now   = db.nowISO();

      // The UNIQUE index on review_requests.order_id is what makes a second
      // concurrent run a no-op rather than a duplicate message.
      let request;
      try {
        const inserted = await db.insert("review_requests", {
          id:            db.newId(),
          order_id:      order.order_id,
          order_uuid:    order.id,
          customer_id:   order.customer_id || null,
          channel:       "email",
          scheduled_for: now,
          status:        "queued",
          attempts:      0,
          last_error:    null,
          sent_at:       null,
          created_at:    now,
          updated_at:    now
        });
        request = (inserted && inserted[0]) || null;
      } catch (err) {
        if (err instanceof db.UniqueViolationError) { summary.skipped++; continue; }
        throw err;
      }

      // Claim the order immediately so a parallel run cannot select it again.
      await db.update("orders", {
        where: { id: order.id, review_request_status: "not_due" },
        set:   { review_request_status: "queued", review_requested_at: now, updated_at: now }
      });

      const reviewUrl = (SITE_URL || "") + "/pages/order/review?orderId=" +
        encodeURIComponent(order.order_id);

      const result = await messaging.send({
        channel: "email",
        to: order.ship_email,
        subject: "How is your NAFUME fragrance?",
        body: messaging.reviewRequestEmail(order, reviewUrl),
        relatedType: "review_request",
        relatedId: order.order_id
      });

      if (result.sent) {
        summary.sent++;
        await db.update("review_requests", {
          where: { order_id: order.order_id },
          set:   { status: "sent", sent_at: db.nowISO(), attempts: 1, updated_at: db.nowISO() }
        });
        await db.update("orders", {
          where: { id: order.id },
          set:   { review_request_status: "sent", updated_at: db.nowISO() }
        });
      } else {
        // Left 'queued' on purpose: the row is a real pending task, not a
        // failure to hide. Adding RESEND_API_KEY lets a later run pick it up.
        summary.queued++;
        await db.update("review_requests", {
          where: { order_id: order.order_id },
          set:   { attempts: 1, last_error: result.reason || null, updated_at: db.nowISO() }
        });
      }
    }

    return http.ok(res, {
      summary: summary,
      emailProviderConfigured: messaging.emailConfigured(),
      delayDays: catalog.REVIEW_REQUEST_DELAY_DAYS,
      note: messaging.emailConfigured()
        ? undefined
        : "No email provider configured — requests are recorded and queued in outbound_messages. Set RESEND_API_KEY to deliver them."
    });

  } catch (err) {
    return http.handleError(res, err, "jobs/review-requests");
  }
};
