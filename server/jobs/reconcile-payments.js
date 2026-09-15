/*
 * GET|POST /api/jobs/reconcile-payments  —  settle payments nobody reported
 * ============================================================================
 * The safety net under the webhook and the browser callback. It asks Razorpay
 * about every open online order (pending, or awaiting_verification) and applies
 * the shared rules in _lib/payments.js:
 *
 *   captured + same order + same amount + same currency   → paid (once)
 *   authorized / still processing                         → awaiting_verification
 *   every attempt failed (for an order awaiting verification) → failed
 *   captured or authorized but NOT matching the order     → reported, untouched
 *   Razorpay unreachable                                  → reported, untouched
 *
 * It never invents orders, alters amounts, refunds, cancels, or marks anything
 * paid that Razorpay does not positively confirm as captured.
 *
 * AUTH  Bearer CRON_SECRET (Vercel Cron sends it) or ADMIN_API_TOKEN. With
 *       neither set the job refuses to run.
 *
 * `?dryRun=1` reports what it would do without changing anything.
 *
 * Idempotent: the paid transition is the same conditional UPDATE every other
 * path uses, so repeated or overlapping runs cannot double-process an order or
 * re-send a confirmation email. Vercel Cron delivery is best effort and may
 * occasionally run twice; that is safe here.
 */
"use strict";

const http     = require("../_lib/http");
const db       = require("../_lib/db");
const auth     = require("../_lib/auth");
const payments = require("../_lib/payments");

const JOB_TOKENS = ["CRON_SECRET", "ADMIN_API_TOKEN"];

/* A pending order younger than this is probably a customer still paying. An
   order already awaiting verification is checked sooner: the customer has
   told us they paid. */
const MIN_AGE_PENDING_MINUTES  = 15;
const MIN_AGE_AWAITING_MINUTES = 2;

/* Razorpay orders are not payable for ever; older than this needs a human. */
const MAX_AGE_DAYS = 7;

/* An authorized payment still not captured after this long is flagged. */
const AUTHORIZED_ALERT_MINUTES = 60;

const BATCH_LIMIT = 40;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }

  if (!auth.anyConfigured(JOB_TOKENS)) {
    console.error("[jobs/reconcile-payments] refusing — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!auth.bearerMatches(req, JOB_TOKENS)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!payments.configured()) {
    return http.fail(res, 503, "payments_unavailable", "Razorpay credentials are not configured.");
  }
  if (!http.requireStorage(res)) return;

  const dryRun = String((req.query && req.query.dryRun) || "") === "1";

  const summary = {
    dryRun:      dryRun,
    scanned:     0,
    recovered:   0,          // open order proven captured and marked paid
    awaiting:    0,          // authorized / processing — capture not confirmed
    failed:      0,          // every attempt failed
    stillUnpaid: 0,          // Razorpay has no payment for it
    unresolved:  0,          // could not ask Razorpay right now
    mismatched:  0           // money on the order that does not match it
  };
  const needsAttention = [];

  try {
    const now    = Date.now();
    const oldest = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Orders whose customer reported a payment come first; abandoned pending
    // checkouts fill whatever budget is left, newest first.
    const awaitingRows = await db.select("orders", {
      where: { payment_status: "awaiting_verification", checkout_type: "razorpay", created_at: ["gte", oldest] },
      order: { column: "created_at", ascending: true },
      limit: BATCH_LIMIT
    });
    const pendingRows = awaitingRows.length >= BATCH_LIMIT ? [] : await db.select("orders", {
      where: { payment_status: "pending", checkout_type: "razorpay", created_at: ["gte", oldest] },
      order: { column: "created_at", ascending: false },
      limit: BATCH_LIMIT - awaitingRows.length
    });
    const candidates = awaitingRows.concat(pendingRows);

    const due = candidates.filter(function (o) {
      if (!o.razorpay_order_id) return false;
      const ageMin = (now - new Date(o.created_at).getTime()) / 60000;
      return o.payment_status === "awaiting_verification"
        ? ageMin >= MIN_AGE_AWAITING_MINUTES
        : ageMin >= MIN_AGE_PENDING_MINUTES;
    });

    summary.scanned = due.length;

    for (let i = 0; i < due.length; i++) {
      const order = due[i];
      const settled = await payments.settleOrder(order, { via: "reconciliation", dryRun: dryRun });

      switch (settled.state) {
        case "paid":
          if (dryRun) {
            summary.recovered++;
            needsAttention.push({ orderId: order.order_id, issue: "would_recover", detail: settled.detail });
          } else if (settled.transitioned) {
            summary.recovered++;
            console.warn("[jobs/reconcile-payments] recovered unconfirmed payment for", order.order_id);
          }
          break;
        case "awaiting_verification": {
          summary.awaiting++;
          const ageMin = (now - new Date(order.created_at).getTime()) / 60000;
          if (ageMin >= AUTHORIZED_ALERT_MINUTES) {
            needsAttention.push({ orderId: order.order_id, issue: "not_captured", detail: settled.detail });
          }
          break;
        }
        case "failed":
          summary.failed++;
          break;
        case "mismatch":
          summary.mismatched++;
          needsAttention.push({ orderId: order.order_id, issue: "payment_mismatch", detail: settled.detail });
          console.error("[jobs/reconcile-payments] CRITICAL payment mismatch on", order.order_id);
          break;
        case "unreachable":
          summary.unresolved++;
          needsAttention.push({ orderId: order.order_id, issue: "razorpay_unreachable", detail: settled.detail });
          break;
        default:
          summary.stillUnpaid++;
      }
    }

    return http.ok(res, {
      summary: summary,
      needsAttention: needsAttention,
      note: summary.mismatched > 0
        ? "One or more payments do not match the recorded order. These were NOT changed — reconcile them by hand in the Razorpay dashboard."
        : undefined
    });

  } catch (err) {
    return http.handleError(res, err, "jobs/reconcile-payments");
  }
};
