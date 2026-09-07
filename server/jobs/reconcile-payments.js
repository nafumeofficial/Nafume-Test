/*
 * GET|POST /api/jobs/reconcile-payments  —  find money we may have missed
 * ============================================================================
 * The safety net under the safety net.
 *
 * An order is normally marked paid by the browser callback, and failing that by
 * the Razorpay webhook. Both can miss: the browser can die, and a webhook can
 * be mis-configured, mis-delivered, or dropped during an outage. This job asks
 * Razorpay directly about every pending order and repairs the ones that were
 * actually paid.
 *
 * AUTH  Bearer CRON_SECRET (Vercel Cron sends it automatically) or
 *       ADMIN_API_TOKEN for a manual run. With neither set the job refuses.
 *
 * WHAT IT WILL AND WILL NOT DO
 *   WILL   mark an order paid when Razorpay confirms a CAPTURED payment on that
 *          order for exactly the amount we recorded.
 *   WILL   report anything it cannot resolve, so a human can look.
 *   WILL NOT invent orders, alter amounts, refund, cancel, or touch anything
 *          Razorpay does not positively confirm. Silence from Razorpay leaves
 *          the order exactly as it is.
 *
 * `?dryRun=1` reports what it would do without changing anything — the safe way
 * to run it the first time against real data.
 *
 * Idempotent: repair goes through repo.markOrderPaid(), the same conditional
 * pending→paid update the webhook and the browser callback use, so running this
 * repeatedly (or alongside them) cannot double-process an order or re-send a
 * confirmation email.
 */
"use strict";

const http      = require("../_lib/http");
const db        = require("../_lib/db");
const repo      = require("../_lib/repo");
const messaging = require("../_lib/messaging");

const KEY_ID          = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET      = process.env.RAZORPAY_KEY_SECRET;
const CRON_SECRET     = process.env.CRON_SECRET;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const SITE_URL        = (process.env.SITE_URL || "").replace(/\/+$/, "");

/* Only look at orders old enough that a normal checkout would have finished.
   A two-minute-old pending order is probably a customer still typing their UPI
   PIN, and asking Razorpay about it would be noise. */
const MIN_AGE_MINUTES = 15;

/* And not so old that the Razorpay order has certainly expired. */
const MAX_AGE_DAYS = 7;

const BATCH_LIMIT = 40;

function authorised(req) {
  const header = String((req.headers && req.headers.authorization) || "");
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  if (CRON_SECRET && token === CRON_SECRET) return true;
  if (ADMIN_API_TOKEN && token === ADMIN_API_TOKEN) return true;
  return false;
}

/* Razorpay lists the payments made against one of its orders. */
async function fetchOrderPayments(razorpayOrderId) {
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const auth = Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64");
    const resp = await fetch(
      "https://api.razorpay.com/v1/orders/" + encodeURIComponent(razorpayOrderId) + "/payments",
      { method: "GET", headers: { "Authorization": "Basic " + auth }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return { error: "fetch_failed_" + resp.status };
    const data = await resp.json();
    return { payments: Array.isArray(data.items) ? data.items : [] };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.name === "AbortError" ? "timeout" : "network_error" };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }

  if (!CRON_SECRET && !ADMIN_API_TOKEN) {
    console.error("[jobs/reconcile-payments] refusing — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!authorised(req)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!KEY_ID || !KEY_SECRET) {
    return http.fail(res, 503, "payments_unavailable", "Razorpay credentials are not configured.");
  }
  if (!http.requireStorage(res)) return;

  const dryRun = String((req.query && req.query.dryRun) || "") === "1";

  const summary = {
    dryRun:      dryRun,
    scanned:     0,
    recovered:   0,          // pending order proven paid and repaired
    stillUnpaid: 0,          // Razorpay confirms nothing was captured
    unresolved:  0,          // could not ask Razorpay right now
    mismatched:  0           // captured, but NOT for the amount we recorded
  };
  const needsAttention = [];

  try {
    const now    = Date.now();
    const oldest = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const newest = new Date(now - MIN_AGE_MINUTES * 60 * 1000).toISOString();

    const candidates = await db.select("orders", {
      where: {
        payment_status: "pending",
        checkout_type:  "razorpay",
        created_at:     ["lte", newest]
      },
      order: { column: "created_at", ascending: false },
      limit: BATCH_LIMIT
    });

    const pending = candidates.filter(function (o) {
      return o.razorpay_order_id &&
             o.order_status !== "cancelled" &&
             o.created_at >= oldest;
    });

    summary.scanned = pending.length;

    for (let i = 0; i < pending.length; i++) {
      const order = pending[i];
      const result = await fetchOrderPayments(order.razorpay_order_id);

      if (result.error) {
        summary.unresolved++;
        needsAttention.push({ orderId: order.order_id, issue: "razorpay_unreachable", detail: result.error });
        continue;
      }

      const captured = result.payments.filter(function (p) { return p.status === "captured"; });
      if (!captured.length) {
        summary.stillUnpaid++;
        continue;
      }

      const match = captured.find(function (p) { return Number(p.amount) === order.amount_total * 100; });
      if (!match) {
        // Captured money that does not match our recorded total. Never guess —
        // this is exactly the case a human must look at.
        summary.mismatched++;
        needsAttention.push({
          orderId: order.order_id,
          issue: "amount_mismatch",
          detail: "captured " + captured.map(function (p) { return p.id + ":" + p.amount; }).join(", ") +
                  " vs expected " + (order.amount_total * 100)
        });
        console.error("[jobs/reconcile-payments] CRITICAL amount mismatch on", order.order_id);
        continue;
      }

      if (dryRun) {
        summary.recovered++;
        needsAttention.push({ orderId: order.order_id, issue: "would_recover", detail: match.id });
        continue;
      }

      const promoted = await repo.markOrderPaid(order, {
        paymentId:       match.id,
        razorpayOrderId: order.razorpay_order_id,
        signature:       null       // reconciled from Razorpay's API, not a checkout callback
      });

      if (promoted.alreadyPaid) continue;   // the webhook beat us to it

      summary.recovered++;
      console.warn("[jobs/reconcile-payments] recovered unconfirmed payment for", order.order_id);

      const items = await repo.getOrderItems(promoted.order.id);
      await Promise.all([
        messaging.send({
          channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
          subject: "NAFUME Order Paid (recovered by reconciliation) — " + promoted.order.order_id,
          body: messaging.orderPaidTeamEmail(promoted.order, items),
          relatedType: "order", relatedId: promoted.order.order_id, dedupe: true
        }),
        messaging.send({
          channel: "email", to: promoted.order.ship_email,
          subject: "Your NAFUME order " + promoted.order.order_id + " is confirmed",
          body: messaging.orderPaidCustomerEmail(promoted.order, items, SITE_URL),
          relatedType: "order", relatedId: promoted.order.order_id, dedupe: true
        })
      ]).catch(function (e) {
        console.error("[jobs/reconcile-payments] notifications failed:", e && e.message);
      });
    }

    return http.ok(res, {
      summary: summary,
      needsAttention: needsAttention,
      note: summary.mismatched > 0
        ? "One or more captured payments do not match the recorded order total. These were NOT changed — reconcile them by hand in the Razorpay dashboard."
        : undefined
    });

  } catch (err) {
    return http.handleError(res, err, "jobs/reconcile-payments");
  }
};
