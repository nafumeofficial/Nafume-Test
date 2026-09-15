/*
 * POST|GET /api/jobs/review-requests  —  queue post-delivery review requests
 * ============================================================================
 * A callable job, run daily by vercel.json (via /api/jobs/maintenance); it can
 * also be invoked by hand with the same bearer token.
 *
 * AUTH  Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends this header
 *       automatically once CRON_SECRET is set on the project) or
 *       Bearer <ADMIN_API_TOKEN> for manual runs. With NEITHER variable set the
 *       job refuses to run rather than exposing an open endpoint.
 *
 * DUE  paid + not cancelled + delivery RECORDED (fulfilment "delivered") +
 *      delivered_at older than REVIEW_REQUEST_DELAY_DAYS (default 5) + no
 *      request already recorded + no review already submitted.
 *      The delay only decides when we ASK. A customer can review from the
 *      moment delivery is recorded (signed in to the owning account).
 *
 * THE LINK  Each request carries a one-order review-link token. Only its hash
 *      is stored (review_requests.access_token_hash); the token itself exists
 *      only in the email. It expires REVIEW_LINK_TTL_DAYS (default 60) after
 *      the request.
 *
 * RUNNING TWICE IS SAFE  review_requests.order_id is UNIQUE, and each order is
 * claimed with a conditional update off review_request_status 'not_due' before
 * any message is attempted. A second or concurrent run (Vercel Cron may
 * occasionally deliver the same run twice) selects nothing or loses the insert
 * race and skips that order.
 *
 * NO EMAIL PROVIDER CONFIGURED  the request is still recorded and the message
 * still lands in outbound_messages as 'queued'. The job reports queued vs sent
 * separately and never claims a delivery that did not happen.
 */
"use strict";

const http      = require("../_lib/http");
const auth      = require("../_lib/auth");
const catalog   = require("../_lib/catalog");
const messaging = require("../_lib/messaging");
const access    = require("../_lib/review-access");
const db        = require("../_lib/db");

const JOB_TOKENS  = ["CRON_SECRET", "ADMIN_API_TOKEN"];
const BATCH_LIMIT = 50;

function linkTtlDays() {
  const v = parseInt(process.env.REVIEW_LINK_TTL_DAYS || "60", 10);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }

  if (!auth.anyConfigured(JOB_TOKENS)) {
    console.error("[jobs/review-requests] refusing to run — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!auth.bearerMatches(req, JOB_TOKENS)) {
    return http.fail(res, 401, "unauthorised", "Not authorised.");
  }
  if (!http.requireStorage(res)) return;

  const siteUrl = (process.env.SITE_URL || "").replace(/\/+$/, "");
  const delayDays = catalog.REVIEW_REQUEST_DELAY_DAYS;
  const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString();

  const summary = { scanned: 0, queued: 0, sent: 0, skipped: 0, failed: 0, cutoff: cutoff };

  try {
    const candidates = await db.select("orders", {
      where: {
        payment_status:        "paid",
        fulfillment_status:    "delivered",
        review_request_status: "not_due",
        delivered_at:          ["lte", cutoff],
        review_id:             ["is", null]
      },
      order: { column: "delivered_at", ascending: true },
      limit: BATCH_LIMIT
    });
    const due = candidates.filter(function (o) { return o.order_status !== "cancelled"; });

    summary.scanned = due.length;

    for (let i = 0; i < due.length; i++) {
      const order = due[i];
      const now   = db.nowISO();

      // Claim the order first. Zero rows → another run already has it.
      const claimed = await db.update("orders", {
        where: { id: order.id, review_request_status: "not_due" },
        set:   { review_request_status: "queued", review_requested_at: now, updated_at: now }
      });
      if (!claimed || !claimed.length) { summary.skipped++; continue; }

      const link = access.newReviewToken();
      try {
        await db.insert("review_requests", {
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
          access_token_hash:       link.hash,
          access_token_expires_at: new Date(Date.now() + linkTtlDays() * 24 * 60 * 60 * 1000).toISOString(),
          created_at:    now,
          updated_at:    now
        });
      } catch (err) {
        // UNIQUE(order_id): a concurrent run recorded it first.
        if (err instanceof db.UniqueViolationError) { summary.skipped++; continue; }
        // Anything else: release the claim so the next run retries this order.
        await db.update("orders", {
          where: { id: order.id, review_request_status: "queued" },
          set:   { review_request_status: "not_due", review_requested_at: null, updated_at: db.nowISO() }
        }).catch(function () {});
        throw err;
      }

      const reviewUrl = (siteUrl || "") + "/pages/order/review?orderId=" +
        encodeURIComponent(order.order_id) + "&token=" + encodeURIComponent(link.token);

      const result = await messaging.send({
        channel: "email",
        to: order.ship_email,
        subject: "How is your NAFUME fragrance?",
        body: messaging.reviewRequestEmail(order, reviewUrl),
        relatedType: "review_request",
        relatedId: order.order_id,
        dedupe: true
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
        // failure to hide. drain-outbox delivers it once a provider works.
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
      delayDays: delayDays,
      note: messaging.emailConfigured()
        ? undefined
        : "No email provider configured — requests are recorded and queued in outbound_messages. Set RESEND_API_KEY to deliver them."
    });

  } catch (err) {
    return http.handleError(res, err, "jobs/review-requests");
  }
};
