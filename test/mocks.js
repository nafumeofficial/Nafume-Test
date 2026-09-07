/*
 * test/mocks.js  —  stand-in for the external HTTP services
 * ============================================================================
 * Replaces global fetch ONLY for api.razorpay.com and api.resend.com. Every
 * other request (including the local test server) passes straight through, and
 * the handler code under test is not modified in any way — the substitution
 * happens at the network boundary, which is exactly the boundary a real
 * integration test cannot cross without live credentials.
 *
 * The Razorpay mock implements the real signature scheme with the same secret
 * the handlers read from the environment, so signature verification, tampering
 * and replay are all exercised for real rather than stubbed out.
 */
"use strict";

const crypto = require("crypto");

const realFetch = globalThis.fetch;

const state = {
  orders:   new Map(),   // order_id -> { id, amount, currency, receipt, notes, status }
  payments: new Map(),   // payment_id -> { id, order_id, amount, status, notes }
  emails:   [],          // every email the code tried to send
  seq:      0,
  failNextRazorpayOrder: false,
  failRazorpayFetch:     false,
  failResend:            false
};

function nextId(prefix) { state.seq++; return prefix + String(Date.now()).slice(-8) + String(state.seq).padStart(4, "0"); }

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

/* ── Razorpay ────────────────────────────────────────────────────────────── */

async function razorpay(urlStr, opts) {
  const u      = new URL(urlStr);
  const method = (opts && opts.method) || "GET";
  const body   = opts && opts.body ? JSON.parse(opts.body) : {};

  // Every real call is Basic-authed; reject anything that isn't, so a missing
  // credential shows up as a test failure instead of silently "working".
  const auth = (opts && opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "";
  if (!/^Basic /.test(auth)) return jsonResponse(401, { error: { description: "auth missing" } });

  if (u.pathname === "/v1/orders" && method === "POST") {
    if (state.failNextRazorpayOrder) {
      state.failNextRazorpayOrder = false;
      return jsonResponse(500, { error: { description: "simulated failure" } });
    }
    const order = {
      id:       nextId("order_"),
      amount:   body.amount,
      currency: body.currency || "INR",
      receipt:  body.receipt,
      notes:    body.notes || {},
      status:   "created"
    };
    state.orders.set(order.id, order);
    return jsonResponse(200, order);
  }

  // GET /v1/orders/:id/payments — what the reconciliation job asks for when it
  // wants to know whether an order was ever actually paid.
  const orderPaymentsMatch = /^\/v1\/orders\/([A-Za-z0-9_]+)\/payments$/.exec(u.pathname);
  if (orderPaymentsMatch && method === "GET") {
    if (state.failRazorpayFetch) return jsonResponse(502, { error: { description: "simulated" } });
    const orderId = orderPaymentsMatch[1];
    if (!state.orders.has(orderId)) return jsonResponse(404, { error: { description: "order not found" } });
    const items = [];
    state.payments.forEach(function (p) { if (p.order_id === orderId) items.push(p); });
    return jsonResponse(200, { entity: "collection", count: items.length, items: items });
  }

  const payMatch = /^\/v1\/payments\/([A-Za-z0-9_]+)$/.exec(u.pathname);
  if (payMatch) {
    const id = payMatch[1];
    if (method === "GET") {
      if (state.failRazorpayFetch) return jsonResponse(502, { error: { description: "simulated" } });
      const p = state.payments.get(id);
      if (!p) return jsonResponse(404, { error: { description: "payment not found" } });
      return jsonResponse(200, p);
    }
    if (method === "PATCH") {
      const p = state.payments.get(id);
      if (p) p.notes = Object.assign({}, p.notes, body.notes || {});
      return jsonResponse(200, p || {});
    }
  }

  return jsonResponse(404, { error: { description: "unmocked razorpay route " + method + " " + u.pathname } });
}

/* simulatePayment(razorpayOrderId, opts)
   Produces exactly what Razorpay Checkout hands the browser on success,
   including a genuine HMAC signature over "order_id|payment_id". */
function simulatePayment(razorpayOrderId, opts) {
  opts = opts || {};
  const order = state.orders.get(razorpayOrderId);
  if (!order) throw new Error("simulatePayment: unknown razorpay order " + razorpayOrderId);

  const paymentId = opts.paymentId || nextId("pay_");
  const payment = {
    id:       paymentId,
    order_id: razorpayOrderId,
    amount:   opts.amount !== undefined ? opts.amount : order.amount,
    currency: order.currency,
    status:   opts.status || "captured",
    method:   "upi",
    notes:    {}
  };
  state.payments.set(paymentId, payment);

  const secret = process.env.RAZORPAY_KEY_SECRET;
  const signature = crypto.createHmac("sha256", secret)
    .update(razorpayOrderId + "|" + paymentId).digest("hex");

  return {
    razorpay_order_id:   razorpayOrderId,
    razorpay_payment_id: paymentId,
    razorpay_signature:  signature
  };
}

/* ── Resend ──────────────────────────────────────────────────────────────── */

async function resend(urlStr, opts) {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  state.emails.push({ to: body.to, subject: body.subject, from: body.from, at: Date.now() });
  if (state.failResend) return jsonResponse(500, { message: "simulated" });
  return jsonResponse(200, { id: nextId("email_") });
}

/* ── install ─────────────────────────────────────────────────────────────── */

function install() {
  globalThis.fetch = async function (input, init) {
    const target = typeof input === "string" ? input : (input && input.url) || "";
    if (target.indexOf("https://api.razorpay.com") === 0) return razorpay(target, init);
    if (target.indexOf("https://api.resend.com")   === 0) return resend(target, init);
    return realFetch(input, init);
  };
}
function uninstall() { globalThis.fetch = realFetch; }

function reset() {
  state.orders.clear();
  state.payments.clear();
  state.emails.length = 0;
  state.failNextRazorpayOrder = false;
  state.failRazorpayFetch = false;
  state.failResend = false;
}

module.exports = { install, uninstall, reset, simulatePayment, state };
