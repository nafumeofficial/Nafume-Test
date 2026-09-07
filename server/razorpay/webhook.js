/*
 * POST /api/razorpay/webhook  —  server-to-server payment reconciliation
 * ============================================================================
 * WHY THIS EXISTS
 *   The normal flow marks an order paid from the browser's callback into
 *   /api/razorpay/verify-payment. That callback is not guaranteed to happen:
 *   the customer can pay and then close the tab, lose signal, or have the
 *   browser killed by the OS. Razorpay has their money; our database still says
 *   `pending`.
 *
 *   Razorpay calls this endpoint independently of the browser, so the order is
 *   reconciled even when nobody is there to report back.
 *
 * HOW IT IS SECURED — two layers
 *   1. SIGNATURE. Razorpay signs the raw request body:
 *        HMAC_SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET) === x-razorpay-signature
 *      Verified strictly whenever the raw body is readable. Some hosting
 *      runtimes pre-parse JSON and consume the stream; re-serialising a parsed
 *      object does NOT reproduce the exact bytes, so a mismatch there would be
 *      meaningless. In that case this check is skipped — and layer 2 is what
 *      actually makes forgery impossible.
 *   2. INDEPENDENT CONFIRMATION. Whatever the request claims, the payment is
 *      fetched back from Razorpay's own API using RAZORPAY_KEY_SECRET and must
 *      be captured, belong to the order we think it does, and be for the exact
 *      amount this server computed at checkout. A forged webhook naming a
 *      payment id that does not exist, is not captured, or is for a different
 *      amount is rejected.
 *
 * Marking paid reuses repo.markOrderPaid(), so the webhook and the browser
 * callback racing each other is safe: whichever arrives second updates zero
 * rows and the order is promoted exactly once.
 *
 * SETUP
 *   Razorpay Dashboard → Settings → Webhooks → Add New Webhook
 *     URL     https://<your-domain>/api/razorpay/webhook
 *     Secret  paste the same value you set as RAZORPAY_WEBHOOK_SECRET
 *     Events  payment.captured   (payment.failed is accepted and ignored)
 *
 * Always returns 200 for events we understand but choose not to act on —
 * a non-2xx makes Razorpay retry, and retrying an event we deliberately
 * ignored achieves nothing.
 */
"use strict";

const crypto    = require("crypto");
const http      = require("../_lib/http");
const db        = require("../_lib/db");
const repo      = require("../_lib/repo");
const messaging = require("../_lib/messaging");

const KEY_ID         = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const SITE_URL       = (process.env.SITE_URL || "").replace(/\/+$/, "");

const MAX_BODY = 256 * 1024;

/* readRawBody(req) -> { raw, parsed } | null
   Returns the exact bytes when the stream has not already been consumed. */
function readRawBody(req) {
  return new Promise(function (resolve) {
    if (req.body !== undefined && req.body !== null && typeof req.body !== "string") {
      return resolve({ raw: null, parsed: req.body });          // pre-parsed by the runtime
    }
    if (typeof req.body === "string") {
      try { return resolve({ raw: req.body, parsed: JSON.parse(req.body) }); }
      catch (_) { return resolve(null); }
    }

    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return resolve(null); }
      chunks.push(c);
    });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({ raw: "", parsed: {} });
      try { resolve({ raw: raw, parsed: JSON.parse(raw) }); }
      catch (_) { resolve(null); }
    });
    req.on("error", function () { resolve(null); });
  });
}

function signatureMatches(raw, header) {
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(header || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function fetchPayment(paymentId) {
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const auth = Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64");
    const resp = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentId), {
      method: "GET", headers: { "Authorization": "Basic " + auth }, signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;

  if (!WEBHOOK_SECRET) {
    console.error("[razorpay/webhook] refusing — RAZORPAY_WEBHOOK_SECRET is not set");
    return http.fail(res, 503, "webhook_not_configured",
      "Webhook is not configured. Set RAZORPAY_WEBHOOK_SECRET to enable it.");
  }
  if (!KEY_ID || !KEY_SECRET) {
    console.error("[razorpay/webhook] refusing — Razorpay API credentials missing");
    return http.fail(res, 503, "payments_unavailable", "Payment verification is unavailable.");
  }

  const body = await readRawBody(req);
  if (!body) return http.fail(res, 400, "invalid_json", "Malformed webhook body.");

  /* ── layer 1: signature (when the raw bytes are available) ────────────── */
  if (body.raw !== null) {
    if (!signatureMatches(body.raw, req.headers["x-razorpay-signature"])) {
      console.warn("[razorpay/webhook] signature mismatch — rejected");
      return http.fail(res, 401, "invalid_signature", "Invalid webhook signature.");
    }
  } else {
    console.warn("[razorpay/webhook] raw body unavailable — relying on Razorpay API confirmation");
  }

  const event   = String((body.parsed && body.parsed.event) || "");
  const payload = (body.parsed && body.parsed.payload) || {};
  const entity  = (payload.payment && payload.payment.entity) || null;

  // Acknowledge anything we do not act on, so Razorpay stops retrying it.
  if (event !== "payment.captured" || !entity || !entity.id) {
    return http.ok(res, { handled: false, event: event || null });
  }
  if (!db.isConfigured()) {
    console.error("[razorpay/webhook] database not configured — cannot reconcile", entity.id);
    return http.ok(res, { handled: false, reason: "storage_unavailable" });
  }

  try {
    /* ── layer 2: ask Razorpay directly ────────────────────────────────── */
    const payment = await fetchPayment(entity.id);
    if (!payment) {
      // Could not confirm right now — a non-2xx makes Razorpay retry, which is
      // exactly what we want for a transient outage.
      console.error("[razorpay/webhook] could not confirm payment with Razorpay", entity.id);
      return http.fail(res, 503, "confirmation_failed", "Could not confirm the payment. Retry later.");
    }
    if (payment.status !== "captured") {
      return http.ok(res, { handled: false, reason: "not_captured", status: payment.status });
    }

    const order = await repo.getOrderByRazorpayOrderId(payment.order_id);
    if (!order) {
      console.error("[razorpay/webhook] CRITICAL no local order for payment", payment.id, payment.order_id);
      return http.ok(res, { handled: false, reason: "no_matching_order" });
    }
    if (Number(payment.amount) !== order.amount_total * 100) {
      console.error("[razorpay/webhook] amount mismatch for", order.order_id);
      return http.ok(res, { handled: false, reason: "amount_mismatch" });
    }

    const result = await repo.markOrderPaid(order, {
      paymentId:       payment.id,
      razorpayOrderId: payment.order_id,
      signature:       null            // this path is authorised by the webhook, not a checkout signature
    });

    // Only when the WEBHOOK is the one that recovered the order — i.e. the
    // browser never made it back — send the confirmations it would have sent.
    if (!result.alreadyPaid) {
      console.warn("[razorpay/webhook] recovered an order the browser never confirmed:", result.order.order_id);
      const items = await repo.getOrderItems(result.order.id);
      await Promise.all([
        messaging.send({
          channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
          subject: "NAFUME Order Paid (recovered by webhook) — " + result.order.order_id,
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
        console.error("[razorpay/webhook] notifications failed:", e && e.message);
      });
    }

    return http.ok(res, {
      handled: true,
      orderId: result.order.order_id,
      recovered: !result.alreadyPaid       // false = the browser had already confirmed it
    });

  } catch (err) {
    // 5xx so Razorpay retries — losing a captured payment is far worse than a
    // duplicate delivery, which markOrderPaid() already handles safely.
    console.error("[razorpay/webhook] processing failed:", err && err.message);
    return http.fail(res, 503, "processing_failed", "Could not process the webhook. Retry later.");
  }
};
