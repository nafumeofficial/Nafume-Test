/*
 * POST /api/razorpay/verify-payment  —  verify the payment, then persist it as paid
 * ============================================================================
 * This is the ONLY place in the system allowed to mark an order paid.
 *
 * Three independent checks must all pass before a rupee is recognised:
 *   1. SIGNATURE — HMAC_SHA256(order_id + "|" + payment_id, RAZORPAY_KEY_SECRET)
 *      must equal razorpay_signature (constant-time compare). This proves the
 *      callback really came from Razorpay and was not forged by the browser.
 *   2. PAYMENT STATE — the payment is fetched back from Razorpay's API and must
 *      be captured/authorised, belong to the same order, and be for the same
 *      amount we recorded. A signature alone cannot prove the money settled.
 *   3. AMOUNT — must match the total this server computed at create-order time.
 *
 * IDEMPOTENCY (the requirement this endpoint exists to satisfy)
 *   Duplicate verification is normal: customers double-click, browsers retry,
 *   the success page gets refreshed. Every one of those paths is safe because
 *     - orders.razorpay_payment_id has a UNIQUE index, and
 *     - the paid transition is a CONDITIONAL update (payment_status = 'pending'),
 *       so the second caller updates zero rows and simply re-reads the same
 *       already-paid order.
 *   Confirmation emails are sent only on the transition, never on a repeat.
 *
 * PAYMENT SUCCEEDED BUT THE DATABASE DID NOT
 *   The customer's money is real regardless of our storage. This endpoint then
 *   returns success with `persisted: false`, logs a CRITICAL line containing the
 *   payment id, and queues an alert to the team. It never pretends the order was
 *   saved and never tells the customer the payment failed.
 *
 * Env vars: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SUPABASE_URL,
 *           SUPABASE_SERVICE_ROLE_KEY, optional RESEND_API_KEY.
 */
"use strict";

const crypto    = require("crypto");
const http      = require("../_lib/http");
const db        = require("../_lib/db");
const repo      = require("../_lib/repo");
const messaging = require("../_lib/messaging");

const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const SITE_URL   = (process.env.SITE_URL || "").replace(/\/+$/, "");

const RAZORPAY_ID_RE = /^[A-Za-z0-9_]{6,40}$/;

/* ── signature ───────────────────────────────────────────────────────────── */

function signatureIsValid(orderId, paymentId, signature) {
  const expected = crypto.createHmac("sha256", KEY_SECRET)
    .update(orderId + "|" + paymentId).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── Razorpay payment fetch ──────────────────────────────────────────────── */

async function fetchPayment(paymentId) {
  if (!KEY_ID || !KEY_SECRET) return { error: "not_configured" };
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const auth = Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64");
    const resp = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentId), {
      method: "GET",
      headers: { "Authorization": "Basic " + auth },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return { error: "fetch_failed_" + resp.status };
    return { payment: await resp.json() };
  } catch (err) {
    clearTimeout(timer);
    return { error: err.name === "AbortError" ? "timeout" : "network_error" };
  }
}

/* Best-effort: tag the Razorpay PAYMENT with our order id so the Dashboard
   links both records. Never throws, never affects the response. */
async function tagPaymentNotes(paymentId, nafumeOrderId) {
  if (!KEY_ID || !KEY_SECRET || !nafumeOrderId) return;
  try {
    const auth = Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64");
    await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentId), {
      method:  "PATCH",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body:    JSON.stringify({ notes: { nafumeOrderId: nafumeOrderId } })
    });
  } catch (err) {
    console.error("[razorpay/verify-payment] payment notes tag failed:", err.name);
  }
}

/* ── orphan alert ────────────────────────────────────────────────────────────
   A genuine payment we could not attach to an order. Loud log + queued email so
   it can be reconciled by hand. Must never throw. */
async function alertOrphanPayment(paymentId, rzpOrderId, reason) {
  console.error("[razorpay/verify-payment] CRITICAL unreconciled payment", paymentId, rzpOrderId, reason);
  try {
    await messaging.send({
      channel: "email",
      to: messaging.NOTIFY_TO,
      from: messaging.NOTIFY_FROM,
      subject: "NAFUME — payment needs manual reconciliation (" + paymentId + ")",
      body: "<p>A Razorpay payment verified successfully but could not be attached to an order.</p>" +
            "<p>Payment ID: <strong>" + messaging.escapeHtml(paymentId) + "</strong><br/>" +
            "Razorpay Order ID: <strong>" + messaging.escapeHtml(rzpOrderId) + "</strong><br/>" +
            "Reason: " + messaging.escapeHtml(reason) + "</p>" +
            "<p>Look this payment up in the Razorpay Dashboard and reconcile it manually.</p>",
      relatedType: "order",
      relatedId: paymentId
    });
  } catch (_) { /* the log line above is the durable record */ }
}

/* ── handler ─────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "verify-payment", limit: 30, windowMs: 60000 })) return;

  if (!KEY_SECRET) {
    console.error("[razorpay/verify-payment] RAZORPAY_KEY_SECRET missing");
    return http.fail(res, 503, "payments_unavailable",
      "Payment verification is unavailable. Please contact support with your payment ID.");
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

  /* ── check 1: signature ─────────────────────────────────────────────── */
  let valid;
  try {
    valid = signatureIsValid(rzpOrderId, paymentId, signature);
  } catch (err) {
    return http.handleError(res, err, "razorpay/verify-payment");
  }
  if (!valid) {
    console.warn("[razorpay/verify-payment] signature mismatch");
    return http.fail(res, 400, "invalid_signature",
      "Payment could not be verified. If money was deducted, please contact support with your payment ID.");
  }

  /* ── check 2: payment state, straight from Razorpay ─────────────────── */
  const fetched = await fetchPayment(paymentId);
  if (fetched.payment) {
    const p = fetched.payment;
    if (p.order_id && p.order_id !== rzpOrderId) {
      console.warn("[razorpay/verify-payment] payment/order mismatch");
      return http.fail(res, 400, "payment_mismatch",
        "Payment could not be matched to your order. Please contact support with your payment ID.");
    }
    if (p.status !== "captured" && p.status !== "authorized") {
      return http.fail(res, 402, "payment_not_captured",
        "This payment has not completed. If money was deducted it will be refunded automatically.");
    }
  }
  // A failed fetch is NOT fatal: the signature already proves authenticity, and
  // refusing a genuine payment because our outbound call timed out would be worse.

  /* ── persistence ────────────────────────────────────────────────────── */
  if (!db.isConfigured()) {
    await alertOrphanPayment(paymentId, rzpOrderId, "database_not_configured");
    return http.json(res, 200, {
      success: true, persisted: false, razorpay_payment_id: paymentId,
      message: "Your payment is confirmed. Our team has been notified and will confirm your order shortly."
    });
  }

  try {
    const order = await repo.getOrderByRazorpayOrderId(rzpOrderId);

    if (!order) {
      // Could also be a duplicate call after the order id was rewritten — check
      // by payment id before declaring it an orphan.
      const byPayment = await repo.getOrderByPaymentId(paymentId);
      if (byPayment) {
        const items = await repo.getOrderItems(byPayment.id);
        return http.ok(res, {
          persisted: true, alreadyProcessed: true,
          order: repo.publicOrder(byPayment, items),
          accountPrefill: prefillFrom(byPayment)
        });
      }
      await alertOrphanPayment(paymentId, rzpOrderId, "no_matching_order");
      return http.json(res, 200, {
        success: true, persisted: false, razorpay_payment_id: paymentId,
        message: "Your payment is confirmed. Our team has been notified and will confirm your order shortly."
      });
    }

    /* ── check 3: amount ──────────────────────────────────────────────── */
    if (fetched.payment && Number(fetched.payment.amount) !== order.amount_total * 100) {
      console.error("[razorpay/verify-payment] amount mismatch for order", order.order_id);
      await alertOrphanPayment(paymentId, rzpOrderId, "amount_mismatch");
      return http.fail(res, 400, "amount_mismatch",
        "Payment amount could not be verified. Please contact support with your payment ID.");
    }

    const result = await repo.markOrderPaid(order, {
      paymentId:       paymentId,
      razorpayOrderId: rzpOrderId,
      signature:       signature
    });

    const items = await repo.getOrderItems(result.order.id);

    // Side effects only on the FIRST successful transition. A refresh or a
    // retried callback must not re-send confirmation emails.
    if (!result.alreadyPaid) {
      await Promise.all([
        tagPaymentNotes(paymentId, result.order.order_id),
        messaging.send({
          channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
          subject: "NAFUME Order Paid — " + result.order.order_id,
          body: messaging.orderPaidTeamEmail(result.order, items),
          relatedType: "order", relatedId: result.order.order_id, dedupe: true
        }),
        messaging.send({
          channel: "email", to: result.order.ship_email,
          subject: "Your NAFUME order " + result.order.order_id + " is confirmed",
          body: messaging.orderPaidCustomerEmail(result.order, items, SITE_URL),
          relatedType: "order", relatedId: result.order.order_id, dedupe: true
        })
      ]).catch(function (e) {
        // Notifications are best-effort; the payment is already recorded.
        console.error("[razorpay/verify-payment] post-payment notifications failed:", e && e.message);
      });
    }

    return http.ok(res, {
      persisted:        true,
      alreadyProcessed: result.alreadyPaid,
      order:            repo.publicOrder(result.order, items),
      accountPrefill:   prefillFrom(result.order)
    });

  } catch (err) {
    // The payment IS genuine — never report failure to the customer here.
    console.error("[razorpay/verify-payment] persistence failed:", err && err.message);
    await alertOrphanPayment(paymentId, rzpOrderId, "persistence_error");
    return http.json(res, 200, {
      success: true, persisted: false, razorpay_payment_id: paymentId,
      message: "Your payment is confirmed. Our team has been notified and will confirm your order shortly."
    });
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
