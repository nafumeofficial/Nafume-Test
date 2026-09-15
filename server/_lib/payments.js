/*
 * api/_lib/payments.js  —  deciding whether an online order is really paid
 * ============================================================================
 * Shared by every path that can confirm a Razorpay payment:
 *   /api/razorpay/verify-payment   the browser's checkout callback
 *   /api/razorpay/webhook          Razorpay → server, independent of the browser
 *   /api/jobs/reconcile-payments   the scheduled safety net
 *   /api/orders/lookup             confirmation-page status refresh
 * so the rules cannot drift between them.
 *
 * THE RULE
 *   An order is marked paid only when Razorpay's own API, asked directly with
 *   the key secret, reports a payment that is
 *     - status "captured"            (authorized is NOT paid — Razorpay:
 *                                     "deliver the products … only after the
 *                                     payment is captured")
 *     - on this order's Razorpay order id
 *     - for exactly this order's amount (paise) and currency
 *   A valid checkout signature proves the callback came from Razorpay Checkout;
 *   it does not prove capture. A lookup that fails or times out proves nothing,
 *   so the order waits in `awaiting_verification` for the webhook, a status
 *   refresh, or reconciliation to settle it.
 */
"use strict";

const crypto    = require("crypto");
const repo      = require("./repo");
const messaging = require("./messaging");

const API_BASE   = "https://api.razorpay.com/v1";
const TIMEOUT_MS = 8000;

function keyId()     { return process.env.RAZORPAY_KEY_ID; }
function keySecret() { return process.env.RAZORPAY_KEY_SECRET; }
function siteUrl()   { return (process.env.SITE_URL || "").replace(/\/+$/, ""); }

function configured() { return !!(keyId() && keySecret()); }

function safeEqualHex(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex), "utf8");
  const b = Buffer.from(String(givenHex || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Standard Checkout: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
function checkoutSignatureValid(razorpayOrderId, paymentId, signature) {
  if (!keySecret()) return false;
  const expected = crypto.createHmac("sha256", keySecret())
    .update(razorpayOrderId + "|" + paymentId).digest("hex");
  return safeEqualHex(expected, signature);
}

/* Webhooks: HMAC_SHA256(raw request body bytes, webhook secret). The body must
   be the exact bytes received — a parsed and re-serialised object does not
   reproduce them. */
function webhookSignatureValid(rawBody, signature, secret) {
  if (!secret || typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

async function razorpayGet(path) {
  if (!configured()) return { ok: false, reason: "not_configured" };
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const auth = Buffer.from(keyId() + ":" + keySecret()).toString("base64");
    const resp = await fetch(API_BASE + path, {
      method: "GET", headers: { "Authorization": "Basic " + auth }, signal: ctrl.signal
    });
    clearTimeout(timer);
    if (resp.status === 404) return { ok: false, reason: "not_found" };
    if (!resp.ok) return { ok: false, reason: "http_" + resp.status };
    return { ok: true, data: await resp.json() };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: err && err.name === "AbortError" ? "timeout" : "network_error" };
  }
}

async function fetchPayment(paymentId) {
  const r = await razorpayGet("/payments/" + encodeURIComponent(paymentId));
  return r.ok ? { ok: true, payment: r.data } : r;
}

async function fetchOrderPayments(razorpayOrderId) {
  const r = await razorpayGet("/orders/" + encodeURIComponent(razorpayOrderId) + "/payments");
  if (!r.ok) return r;
  return { ok: true, payments: Array.isArray(r.data && r.data.items) ? r.data.items : [] };
}

/* evaluatePayment(order, payment)
   -> { outcome, reason }
      outcome: "captured" | "authorized" | "processing" | "failed" |
               "refunded" | "mismatch"                                      */
function evaluatePayment(order, payment) {
  if (!payment || !payment.id) return { outcome: "mismatch", reason: "no_payment" };
  if (!order.razorpay_order_id || payment.order_id !== order.razorpay_order_id) {
    return { outcome: "mismatch", reason: "order_mismatch" };
  }
  const expectedPaise = Number(order.amount_total) * 100;
  if (Number(payment.amount) !== expectedPaise) {
    return { outcome: "mismatch", reason: "amount_mismatch" };
  }
  const expectedCurrency = String(order.currency || "INR").toUpperCase();
  if (String(payment.currency || "").toUpperCase() !== expectedCurrency) {
    return { outcome: "mismatch", reason: "currency_mismatch" };
  }
  switch (payment.status) {
    case "captured":   return { outcome: payment.amount_refunded > 0 ? "refunded" : "captured", reason: null };
    case "authorized": return { outcome: "authorized", reason: "not_captured" };
    case "created":
    case "pending":    return { outcome: "processing", reason: "not_captured" };
    case "failed":     return { outcome: "failed", reason: payment.error_code || "failed" };
    case "refunded":   return { outcome: "refunded", reason: "refunded" };
    default:           return { outcome: "processing", reason: "status_" + payment.status };
  }
}

/* confirmCaptured(order, payment, via, signature) -> { order, transitioned }
   Marks paid (conditionally, see repo.markOrderPaid) and — only for the single
   caller that actually made the transition — sends the confirmation emails. */
async function confirmCaptured(order, payment, via, signature) {
  const result = await repo.markOrderPaid(order, {
    paymentId:       payment.id,
    razorpayOrderId: payment.order_id,
    signature:       signature || null,
    amount:          payment.amount,
    currency:        payment.currency,
    via:             via
  });

  if (!result.alreadyPaid) {
    await sendPaidNotifications(result.order, via);
  }
  return { order: result.order, transitioned: !result.alreadyPaid };
}

async function sendPaidNotifications(order, via) {
  try {
    const items = await repo.getOrderItems(order.id);
    const label = via === "webhook" ? " (recovered by webhook)"
                : via === "reconciliation" ? " (recovered by reconciliation)"
                : "";
    await Promise.all([
      messaging.send({
        channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
        subject: "NAFUME Order Paid" + label + " — " + order.order_id,
        body: messaging.orderPaidTeamEmail(order, items),
        relatedType: "order", relatedId: order.order_id, dedupe: true
      }),
      messaging.send({
        channel: "email", to: order.ship_email,
        subject: "Your NAFUME order " + order.order_id + " is confirmed",
        body: messaging.orderPaidCustomerEmail(order, items, siteUrl()),
        relatedType: "order", relatedId: order.order_id, dedupe: true
      })
    ]);
    if (order.order_status === "cancelled") {
      await alertTeam("NAFUME — payment captured on a CANCELLED order (" + order.order_id + ")",
        "<p>Order <strong>" + messaging.escapeHtml(order.order_id) + "</strong> was cancelled but a captured " +
        "payment has now been confirmed. Refund it or reinstate the order.</p>", order.order_id);
    }
  } catch (e) {
    // Notifications are best-effort; the payment is already recorded.
    console.error("[payments] post-payment notifications failed:", e && e.message);
  }
}

/* settleOrder(order, opts) -> { state, order, detail }
   Asks Razorpay about every payment on this order and applies the result.
   Used by the webhook fallback, status refresh and reconciliation.
     state: "paid" | "awaiting_verification" | "unpaid" | "failed" |
            "mismatch" | "unreachable"                                      */
async function settleOrder(order, opts) {
  opts = opts || {};
  if (order.payment_status === "paid") return { state: "paid", order: order };
  if (!order.razorpay_order_id) return { state: "unpaid", order: order };

  const listed = await fetchOrderPayments(order.razorpay_order_id);
  if (!listed.ok) return { state: "unreachable", order: order, detail: listed.reason };

  const evaluated = listed.payments.map(function (p) { return { payment: p, result: evaluatePayment(order, p) }; });
  const captured  = evaluated.find(function (e) { return e.result.outcome === "captured"; });

  if (captured) {
    if (opts.dryRun) return { state: "paid", order: order, detail: captured.payment.id, dryRun: true };
    const done = await confirmCaptured(order, captured.payment, opts.via || "reconciliation", null);
    return { state: "paid", order: done.order, transitioned: done.transitioned, detail: captured.payment.id };
  }

  const mismatched = evaluated.filter(function (e) {
    return e.result.outcome === "mismatch" && (e.payment.status === "captured" || e.payment.status === "authorized");
  });
  if (mismatched.length) {
    return {
      state: "mismatch", order: order,
      detail: mismatched.map(function (e) { return e.payment.id + ":" + e.result.reason; }).join(", ")
    };
  }

  const pendingCapture = evaluated.find(function (e) {
    return e.result.outcome === "authorized" || e.result.outcome === "processing";
  });
  if (pendingCapture) {
    if (!opts.dryRun) {
      order = await repo.markAwaitingVerification(order, {
        paymentId: pendingCapture.payment.id, note: "razorpay_status_" + pendingCapture.payment.status
      });
    }
    return { state: "awaiting_verification", order: order, detail: pendingCapture.payment.status };
  }

  if (evaluated.length && evaluated.every(function (e) {
    return e.result.outcome === "failed" || e.result.outcome === "refunded";
  })) {
    if (!opts.dryRun && order.payment_status === "awaiting_verification") {
      order = await repo.noteFailedPayment(order, "all_attempts_failed");
    }
    return { state: "failed", order: order };
  }

  return { state: "unpaid", order: order };
}

/* alertTeam — a loud log line plus a queued email. Never throws. */
async function alertTeam(subject, html, relatedId) {
  console.error("[payments] ALERT " + subject);
  try {
    await messaging.send({
      channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
      subject: subject, body: html, relatedType: "payment_alert", relatedId: relatedId || null
    });
  } catch (_) { /* the log line above is the durable record */ }
}

const AWAITING_MESSAGE =
  "We're confirming your payment. Please don't pay again. Your order status will update once confirmation arrives.";

module.exports = {
  configured, checkoutSignatureValid, webhookSignatureValid,
  fetchPayment, fetchOrderPayments, evaluatePayment,
  confirmCaptured, settleOrder, alertTeam,
  AWAITING_MESSAGE
};
