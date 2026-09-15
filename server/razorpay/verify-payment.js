/*
 * POST /api/razorpay/verify-payment  —  the browser's checkout callback
 * ============================================================================
 * Razorpay Checkout hands the browser { razorpay_order_id, razorpay_payment_id,
 * razorpay_signature }. This endpoint decides what that means, and it never
 * takes the browser's word for anything:
 *
 *   1. SIGNATURE   HMAC_SHA256(order_id + "|" + payment_id, key secret), constant
 *                  time. Invalid → 400, nothing changes.
 *   2. ORDER       the Razorpay order id must belong to a local order.
 *   3. PAYMENT     fetched back from Razorpay's API. It must be on this Razorpay
 *                  order, for this order's exact amount and currency, and
 *                  CAPTURED. See _lib/payments.js.
 *
 * OUTCOMES
 *   200 paid                    captured and confirmed (or already confirmed)
 *   202 awaiting_verification   signature valid but capture not confirmed yet:
 *                               Razorpay says authorized/processing, or the
 *                               lookup failed or timed out. The order waits;
 *                               the webhook, the confirmation page's status
 *                               refresh, or reconciliation settles it.
 *   400 / 402                   signature invalid, payment failed, or the
 *                               payment does not match the order.
 *
 * IDEMPOTENCY
 *   The paid transition is one conditional UPDATE shared with the webhook and
 *   reconciliation (repo.markOrderPaid), and razorpay_payment_id is UNIQUE.
 *   Double clicks, refreshes, retries and a racing webhook all resolve to one
 *   paid order and one set of confirmation emails.
 *
 * Env vars: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SUPABASE_URL,
 *           SUPABASE_SERVICE_ROLE_KEY, optional RESEND_API_KEY.
 */
"use strict";

const http      = require("../_lib/http");
const db        = require("../_lib/db");
const repo      = require("../_lib/repo");
const payments  = require("../_lib/payments");
const messaging = require("../_lib/messaging");

const RAZORPAY_ID_RE = /^[A-Za-z0-9_]{6,40}$/;

const DO_NOT_PAY_AGAIN =
  " Please don't pay again — our team has been alerted and will contact you.";

function awaiting(res, order, paymentId, reason) {
  return http.json(res, 202, {
    success:          true,
    paymentState:     "awaiting_verification",
    persisted:        !!order,
    alreadyProcessed: false,
    razorpay_payment_id: paymentId,
    reason:           reason || null,
    message:          payments.AWAITING_MESSAGE,
    order:            order ? repo.publicOrder(order, null) : null,
    accountPrefill:   order ? prefillFrom(order) : null
  });
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "verify-payment", limit: 30, windowMs: 60000 })) return;

  if (!payments.configured()) {
    console.error("[razorpay/verify-payment] Razorpay credentials missing");
    return http.fail(res, 503, "payments_unavailable",
      "Payment verification is unavailable right now." + DO_NOT_PAY_AGAIN);
  }

  const body = await http.body(req, res);
  if (!body) return;

  const rzpOrderId = String(body.razorpay_order_id   || "").trim();
  const paymentId  = String(body.razorpay_payment_id || "").trim();
  const signature  = String(body.razorpay_signature  || "").trim();

  if (!rzpOrderId || !paymentId || !signature) {
    return http.fail(res, 400, "missing_fields", "Payment details are incomplete.");
  }
  if (!RAZORPAY_ID_RE.test(rzpOrderId) || !RAZORPAY_ID_RE.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return http.fail(res, 400, "invalid_fields", "Payment details are not valid.");
  }

  /* ── 1. signature ─────────────────────────────────────────────────────── */
  if (!payments.checkoutSignatureValid(rzpOrderId, paymentId, signature)) {
    console.warn("[razorpay/verify-payment] signature mismatch");
    return http.fail(res, 400, "invalid_signature",
      "Payment could not be verified. If money was deducted, please contact support with your payment ID.");
  }

  /* ── 2. the local order ───────────────────────────────────────────────── */
  if (!db.isConfigured()) {
    await payments.alertTeam("NAFUME — payment reported while storage is unavailable (" + paymentId + ")",
      "<p>Payment ID <strong>" + messaging.escapeHtml(paymentId) + "</strong> on Razorpay order " +
      messaging.escapeHtml(rzpOrderId) + " was reported by a customer while the database was not configured. " +
      "Confirm it in the Razorpay dashboard.</p>", paymentId);
    return awaiting(res, null, paymentId, "storage_unavailable");
  }

  let order;
  try {
    order = await repo.getOrderByRazorpayOrderId(rzpOrderId);
    if (!order) {
      const byPayment = await repo.getOrderByPaymentId(paymentId);
      if (byPayment && byPayment.razorpay_order_id === rzpOrderId) order = byPayment;
    }
  } catch (err) {
    console.error("[razorpay/verify-payment] order lookup failed:", err && err.message);
    await payments.alertTeam("NAFUME — payment could not be matched: storage error (" + paymentId + ")",
      "<p>Payment ID <strong>" + messaging.escapeHtml(paymentId) + "</strong> — database error during verification. " +
      "Reconciliation will retry; check the Razorpay dashboard if it persists.</p>", paymentId);
    return awaiting(res, null, paymentId, "storage_error");
  }

  if (!order) {
    await payments.alertTeam("NAFUME — payment with no matching order (" + paymentId + ")",
      "<p>A correctly signed payment <strong>" + messaging.escapeHtml(paymentId) + "</strong> names Razorpay order " +
      messaging.escapeHtml(rzpOrderId) + ", which does not exist locally. Reconcile it by hand.</p>", paymentId);
    return http.fail(res, 404, "order_not_found",
      "We couldn't match this payment to an order." + DO_NOT_PAY_AGAIN,
      { razorpay_payment_id: paymentId });
  }

  try {
    // Already settled — a refresh, double-click, or the webhook got there first.
    if (order.payment_status === "paid") {
      const items = await repo.getOrderItems(order.id);
      if (order.razorpay_payment_id && order.razorpay_payment_id !== paymentId) {
        await payments.alertTeam("NAFUME — second payment on an already-paid order (" + order.order_id + ")",
          "<p>Order <strong>" + messaging.escapeHtml(order.order_id) + "</strong> is paid by " +
          messaging.escapeHtml(order.razorpay_payment_id) + " and the customer reported another payment " +
          messaging.escapeHtml(paymentId) + ". Check for a duplicate charge.</p>", order.order_id);
      }
      return http.ok(res, {
        paymentState: "paid", persisted: true, alreadyProcessed: true,
        order: repo.publicOrder(order, items), accountPrefill: prefillFrom(order)
      });
    }

    /* ── 3. ask Razorpay ─────────────────────────────────────────────────── */
    const fetched = await payments.fetchPayment(paymentId);
    if (!fetched.ok) {
      // Lookup failure is not evidence of payment. Hold, never mark paid.
      console.warn("[razorpay/verify-payment] payment lookup failed:", fetched.reason, order.order_id);
      const held = await repo.markAwaitingVerification(order, { paymentId: paymentId, note: "lookup_" + fetched.reason });
      return awaiting(res, held, paymentId, "lookup_failed");
    }

    const verdict = payments.evaluatePayment(order, fetched.payment);

    if (verdict.outcome === "captured") {
      const done  = await payments.confirmCaptured(order, fetched.payment, "checkout_callback", signature);
      const items = await repo.getOrderItems(done.order.id);
      return http.ok(res, {
        paymentState: "paid", persisted: true, alreadyProcessed: !done.transitioned,
        order: repo.publicOrder(done.order, items), accountPrefill: prefillFrom(done.order)
      });
    }

    if (verdict.outcome === "authorized" || verdict.outcome === "processing") {
      const held = await repo.markAwaitingVerification(order, {
        paymentId: paymentId, note: "razorpay_status_" + fetched.payment.status
      });
      return awaiting(res, held, paymentId, "not_captured");
    }

    if (verdict.outcome === "mismatch") {
      console.error("[razorpay/verify-payment] payment does not match order", order.order_id, verdict.reason);
      await payments.alertTeam("NAFUME — payment does not match its order (" + order.order_id + ")",
        "<p>Payment <strong>" + messaging.escapeHtml(paymentId) + "</strong> failed the " +
        messaging.escapeHtml(verdict.reason) + " check for order " + messaging.escapeHtml(order.order_id) +
        ". The order was NOT marked paid. Reconcile it in the Razorpay dashboard.</p>", order.order_id);
      const code = verdict.reason === "amount_mismatch" ? "amount_mismatch"
                 : verdict.reason === "currency_mismatch" ? "currency_mismatch" : "payment_mismatch";
      return http.fail(res, 400, code,
        "We couldn't match this payment to your order." + DO_NOT_PAY_AGAIN,
        { razorpay_payment_id: paymentId });
    }

    // failed / refunded
    return http.fail(res, 402, "payment_not_captured",
      "This payment did not complete. If money was deducted, it will be refunded automatically.",
      { razorpay_payment_id: paymentId });

  } catch (err) {
    // Something broke after a correctly signed callback. The money may be real:
    // hold the customer on "confirming", never on "failed" or "paid".
    console.error("[razorpay/verify-payment] verification failed:", err && err.message);
    await payments.alertTeam("NAFUME — payment verification error (" + paymentId + ")",
      "<p>Verification of payment <strong>" + messaging.escapeHtml(paymentId) + "</strong> for order " +
      messaging.escapeHtml(order.order_id) + " threw an error. Reconciliation will retry.</p>", order.order_id);
    return awaiting(res, null, paymentId, "verification_error");
  }
};

/* Fields handed back so account creation can be pre-filled without the customer
   retyping anything. Contains only what this customer just typed themselves. */
function prefillFrom(order) {
  return {
    name:    order.ship_name  || "",
    email:   order.ship_email || "",
    phone:   order.ship_phone || "",
    orderId: order.order_id
  };
}
