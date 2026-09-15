/*
 * POST /api/razorpay/webhook  —  server-to-server payment confirmation
 * ============================================================================
 * WHY THIS EXISTS
 *   The browser callback (/api/razorpay/verify-payment) is not guaranteed: the
 *   customer can pay and close the tab, lose signal, or have the browser
 *   killed. Razorpay calls this endpoint independently of the browser.
 *
 * SECURITY
 *   1. SIGNATURE over the RAW BODY. HMAC_SHA256(raw bytes, webhook secret) must
 *      equal X-Razorpay-Signature. Razorpay: "ensure that the webhook body
 *      passed as an argument is the raw webhook request body. Do not parse or
 *      cast the webhook request body." The raw bytes are read from the request
 *      stream BEFORE req.body is touched (Vercel's Node helpers buffer the body
 *      and replay it to stream listeners). If the raw bytes are not available
 *      the request is REFUSED — a parsed object is never re-serialised and
 *      "verified".
 *   2. CURRENT STATE FROM RAZORPAY. Even a genuine event can be stale (a
 *      payment captured then refunded, events arriving out of order), so the
 *      order's payments are fetched from Razorpay's API and the shared rules in
 *      _lib/payments.js decide: captured + same order + same amount + same
 *      currency, or nothing.
 *
 * IDEMPOTENCY
 *   - payment_events.event_key is UNIQUE (x-razorpay-event-id): a redelivered
 *     event that was already processed is acknowledged without work.
 *   - Marking paid is the same conditional UPDATE every other path uses, so a
 *     racing browser callback, a duplicate delivery and reconciliation promote
 *     the order exactly once and send confirmation emails once.
 *   - A paid order is never moved backwards by any event.
 *
 * SETUP
 *   Razorpay Dashboard → Account & Settings → Webhooks → Add New Webhook
 *     URL     https://<your-domain>/api/razorpay/webhook
 *     Secret  the same value as RAZORPAY_WEBHOOK_SECRET
 *     Events  payment.captured, order.paid, payment.authorized, payment.failed
 *   Test mode and Live mode webhooks are configured separately.
 *
 * Responses: 2xx for anything handled or deliberately ignored; 401 for a bad
 * signature; 5xx when confirmation could not be completed and Razorpay should
 * retry.
 */
"use strict";

const http      = require("../_lib/http");
const db        = require("../_lib/db");
const repo      = require("../_lib/repo");
const payments  = require("../_lib/payments");

const MAX_BODY = 256 * 1024;

const HANDLED_EVENTS = ["payment.captured", "order.paid", "payment.authorized", "payment.failed"];

/* readRawBody(req) -> Promise<Buffer|null>
   Reads the exact request bytes from the stream. Deliberately does not look at
   req.body first: on Vercel that getter parses JSON, which is not what the
   signature covers. Resolves null when the stream is unusable. */
function readRawBody(req) {
  return new Promise(function (resolve) {
    let size = 0;
    let done = false;
    const chunks = [];
    // A stream that was already consumed elsewhere never emits 'end'. Give up
    // rather than hang, and let the caller refuse the request.
    const timer = setTimeout(function () { finish(null); }, 5000);
    function finish(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }

    try {
      req.on("data", function (c) {
        size += c.length;
        if (size > MAX_BODY) { finish(null); return; }
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      });
      req.on("end", function () { finish(Buffer.concat(chunks)); });
      req.on("error", function () { finish(null); });
      if (typeof req.resume === "function") req.resume();
    } catch (_) {
      finish(null);
    }
  });
}

async function recordEvent(eventId, eventType, paymentId, orderId) {
  if (!eventId) return { duplicate: false, row: null };
  const row = {
    id: db.newId(), event_key: "razorpay:" + eventId, provider: "razorpay",
    event_type: eventType || null, razorpay_payment_id: paymentId || null,
    razorpay_order_id: orderId || null, outcome: null,
    received_at: db.nowISO(), processed_at: null, attempts: 1
  };
  try {
    await db.insert("payment_events", row);
    return { duplicate: false, row: row };
  } catch (err) {
    if (!(err instanceof db.UniqueViolationError)) throw err;
    const existing = await db.selectOne("payment_events", { event_key: row.event_key });
    if (existing && existing.processed_at) return { duplicate: true, row: existing };
    // Seen before but never finished (e.g. a timeout mid-processing): process
    // again — every step below is idempotent.
    if (existing) {
      await db.update("payment_events", { where: { id: existing.id },
        set: { attempts: (existing.attempts || 1) + 1 } });
    }
    return { duplicate: false, row: existing };
  }
}

async function finishEvent(row, outcome) {
  if (!row) return;
  try {
    await db.update("payment_events", { where: { id: row.id },
      set: { outcome: outcome, processed_at: db.nowISO() } });
  } catch (err) {
    console.error("[razorpay/webhook] could not record event outcome:", err && err.message);
  }
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[razorpay/webhook] refusing — RAZORPAY_WEBHOOK_SECRET is not set");
    return http.fail(res, 503, "webhook_not_configured",
      "Webhook is not configured. Set RAZORPAY_WEBHOOK_SECRET to enable it.");
  }
  if (!payments.configured()) {
    console.error("[razorpay/webhook] refusing — Razorpay API credentials missing");
    return http.fail(res, 503, "payments_unavailable", "Payment verification is unavailable.");
  }

  const raw = await readRawBody(req);
  const contentLength = parseInt(String((req.headers && req.headers["content-length"]) || "0"), 10) || 0;
  if (!raw || (raw.length === 0 && contentLength > 0)) {
    // Fail closed. A 5xx makes Razorpay retry, and the log makes it visible.
    console.error("[razorpay/webhook] raw request body unavailable — refusing to verify a re-serialised body");
    return http.fail(res, 500, "raw_body_unavailable", "Webhook body could not be read.");
  }

  /* ── 1. signature over the raw bytes ──────────────────────────────────── */
  if (!payments.webhookSignatureValid(raw, req.headers["x-razorpay-signature"], webhookSecret)) {
    console.warn("[razorpay/webhook] signature mismatch — rejected");
    return http.fail(res, 401, "invalid_signature", "Invalid webhook signature.");
  }

  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch (_) { return http.fail(res, 400, "invalid_json", "Malformed webhook body."); }

  const event   = String((parsed && parsed.event) || "");
  const payload = (parsed && parsed.payload) || {};
  const paymentEntity = (payload.payment && payload.payment.entity) || null;
  const orderEntity   = (payload.order && payload.order.entity) || null;
  const eventId = String((req.headers && req.headers["x-razorpay-event-id"]) || "").trim().slice(0, 100);

  if (HANDLED_EVENTS.indexOf(event) === -1) {
    return http.ok(res, { handled: false, event: event || null });
  }

  const rzpOrderId = (paymentEntity && paymentEntity.order_id) || (orderEntity && orderEntity.id) || null;
  const paymentId  = (paymentEntity && paymentEntity.id) || null;

  if (!db.isConfigured()) {
    // Cannot record anything — ask Razorpay to retry once storage is back.
    console.error("[razorpay/webhook] database not configured — cannot reconcile", paymentId);
    return http.fail(res, 503, "storage_unavailable", "Storage unavailable. Retry later.");
  }

  let recorded;
  try {
    recorded = await recordEvent(eventId, event, paymentId, rzpOrderId);
    if (recorded.duplicate) {
      return http.ok(res, { handled: true, duplicate: true, outcome: recorded.row.outcome || null });
    }

    const order = rzpOrderId ? await repo.getOrderByRazorpayOrderId(rzpOrderId) : null;
    if (!order) {
      console.error("[razorpay/webhook] CRITICAL no local order for event", event, paymentId, rzpOrderId);
      await finishEvent(recorded.row, "no_matching_order");
      return http.ok(res, { handled: false, reason: "no_matching_order" });
    }

    if (order.payment_status === "paid") {
      await finishEvent(recorded.row, "already_paid");
      return http.ok(res, { handled: true, orderId: order.order_id, recovered: false, state: "paid" });
    }

    if (event === "payment.failed") {
      // An attempt failed; the customer may still pay with another attempt.
      // Reconciliation / status refresh decide what the order finally is.
      await finishEvent(recorded.row, "failed_attempt_noted");
      return http.ok(res, { handled: true, orderId: order.order_id, state: order.payment_status });
    }

    /* ── 2. authoritative state from Razorpay ─────────────────────────── */
    const settled = await payments.settleOrder(order, { via: "webhook" });

    if (settled.state === "unreachable") {
      console.error("[razorpay/webhook] could not confirm with Razorpay", order.order_id, settled.detail);
      // Leave the event unprocessed so the retry is not treated as a duplicate.
      return http.fail(res, 503, "confirmation_failed", "Could not confirm the payment. Retry later.");
    }
    if (settled.state === "mismatch") {
      await payments.alertTeam("NAFUME — webhook payment does not match its order (" + order.order_id + ")",
        "<p>Order " + order.order_id + ": " + String(settled.detail) + ". Not marked paid.</p>", order.order_id);
    }

    await finishEvent(recorded.row, settled.state);
    return http.ok(res, {
      handled:   true,
      orderId:   order.order_id,
      state:     settled.state,
      recovered: settled.state === "paid" && settled.transitioned === true
    });

  } catch (err) {
    // 5xx so Razorpay retries — every step above is idempotent.
    console.error("[razorpay/webhook] processing failed:", err && err.message);
    return http.fail(res, 503, "processing_failed", "Could not process the webhook. Retry later.");
  }
};
