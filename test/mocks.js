/*
 * test/mocks.js  —  stand-in for the external HTTP services
 * ============================================================================
 * Replaces global fetch ONLY for api.razorpay.com, api.resend.com and
 * control.msg91.com. Every other request (including the local test server)
 * passes straight through, and the handler code under test is not modified in
 * any way — the substitution happens at the network boundary, which is exactly
 * the boundary a real integration test cannot cross without live credentials.
 *
 * The Razorpay mock implements the real signature scheme with the same secret
 * the handlers read from the environment, so signature verification, tampering
 * and replay are all exercised for real rather than stubbed out.
 *
 * THESE ARE MOCKS. Passing tests prove the code's decisions given these
 * responses; they do not prove the live providers behave the same way.
 */
"use strict";

const crypto = require("crypto");

const realFetch = globalThis.fetch;

const state = {
  orders:   new Map(),   // order_id -> { id, amount, currency, receipt, notes, status }
  payments: new Map(),   // payment_id -> { id, order_id, amount, currency, status, notes }
  emails:   [],          // every email the code tried to send (incl. html)
  sms:      [],          // every MSG91 OTP send
  otps:     new Map(),   // mobile -> { otp, verified, expiresAt }
  seq:      0,
  failNextRazorpayOrder: false,
  failRazorpayFetch:     false,     // both payment and order-payment lookups
  failPaymentFetch:      false,     // GET /v1/payments/:id only
  failOrderPaymentsFetch:false,     // GET /v1/orders/:id/payments only
  razorpayFetchDelayMs:  0,
  failResend:            false,
  failMsg91:             false,
  resendIdempotency:     new Map()  // Idempotency-Key -> response id
};

function nextId(prefix) { state.seq++; return prefix + String(Date.now()).slice(-8) + String(state.seq).padStart(4, "0"); }

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

function headerOf(opts, name) {
  const h = (opts && opts.headers) || {};
  const key = Object.keys(h).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
  return key ? h[key] : "";
}

/* ── Razorpay ────────────────────────────────────────────────────────────── */

async function razorpay(urlStr, opts) {
  const u      = new URL(urlStr);
  const method = (opts && opts.method) || "GET";
  const body   = opts && opts.body ? JSON.parse(opts.body) : {};

  // Every real call is Basic-authed; reject anything that isn't, so a missing
  // credential shows up as a test failure instead of silently "working".
  if (!/^Basic /.test(headerOf(opts, "Authorization"))) {
    return jsonResponse(401, { error: { description: "auth missing" } });
  }
  if (state.razorpayFetchDelayMs && method === "GET") {
    await new Promise(function (r) { setTimeout(r, state.razorpayFetchDelayMs); });
  }

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

  const orderPaymentsMatch = /^\/v1\/orders\/([A-Za-z0-9_]+)\/payments$/.exec(u.pathname);
  if (orderPaymentsMatch && method === "GET") {
    if (state.failRazorpayFetch || state.failOrderPaymentsFetch) {
      return jsonResponse(502, { error: { description: "simulated" } });
    }
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
      if (state.failRazorpayFetch || state.failPaymentFetch) {
        return jsonResponse(502, { error: { description: "simulated" } });
      }
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
   including a genuine HMAC signature over "order_id|payment_id".
   opts: { status: captured|authorized|failed|refunded, amount, currency,
           paymentId, orderIdOnPayment }                                     */
function simulatePayment(razorpayOrderId, opts) {
  opts = opts || {};
  const order = state.orders.get(razorpayOrderId);
  if (!order) throw new Error("simulatePayment: unknown razorpay order " + razorpayOrderId);

  const paymentId = opts.paymentId || nextId("pay_");
  const payment = {
    id:       paymentId,
    entity:   "payment",
    order_id: opts.orderIdOnPayment || razorpayOrderId,
    amount:   opts.amount !== undefined ? opts.amount : order.amount,
    currency: opts.currency || order.currency,
    status:   opts.status || "captured",
    amount_refunded: 0,
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

/* setPaymentStatus(paymentId, status) — e.g. an authorized payment that
   Razorpay later auto-captures, or a captured payment later refunded. */
function setPaymentStatus(paymentId, status) {
  const p = state.payments.get(paymentId);
  if (!p) throw new Error("setPaymentStatus: unknown payment " + paymentId);
  p.status = status;
  if (status === "refunded") p.amount_refunded = p.amount;
  return p;
}

/* ── Resend ──────────────────────────────────────────────────────────────── */

async function resend(urlStr, opts) {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  const key = headerOf(opts, "Idempotency-Key");
  if (key && state.resendIdempotency.has(key)) {
    return jsonResponse(200, { id: state.resendIdempotency.get(key) });
  }
  state.emails.push({
    to: body.to, subject: body.subject, from: body.from, html: body.html,
    idempotencyKey: key || null, at: Date.now()
  });
  if (state.failResend) return jsonResponse(500, { message: "simulated" });
  const id = nextId("email_");
  if (key) state.resendIdempotency.set(key, id);
  return jsonResponse(200, { id: id });
}

/* lastCodeFor(address) — the 6-digit code in the newest verification email. */
function lastCodeFor(address) {
  const want = String(address).toLowerCase();
  for (let i = state.emails.length - 1; i >= 0; i--) {
    const e = state.emails[i];
    const to = [].concat(e.to || []).map(function (x) { return String(x).toLowerCase(); });
    if (to.indexOf(want) === -1 || !/verification code/i.test(e.subject || "")) continue;
    const m = /(\d{6})<\/p>/.exec(e.html || "");
    if (m) return m[1];
  }
  return null;
}

/* ── MSG91 ───────────────────────────────────────────────────────────────── */

async function msg91(urlStr, opts) {
  const u = new URL(urlStr);
  if (!headerOf(opts, "authkey")) return jsonResponse(401, { type: "error", message: "authkey missing" });
  if (state.failMsg91) return jsonResponse(500, { type: "error", message: "simulated" });

  if (u.pathname === "/api/v5/otp" && (opts.method || "GET") === "POST") {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    state.otps.set(body.mobile, { otp: otp, verified: false, expiresAt: Date.now() + (body.otp_expiry || 5) * 60000 });
    state.sms.push({ mobile: body.mobile, template: body.template_id, at: Date.now() });
    return jsonResponse(200, { type: "success", request_id: nextId("req_") });
  }
  if (u.pathname === "/api/v5/otp/verify") {
    const mobile = u.searchParams.get("mobile");
    const otp = u.searchParams.get("otp");
    const rec = state.otps.get(mobile);
    if (!rec) return jsonResponse(200, { type: "error", message: "OTP not found" });
    if (rec.verified) return jsonResponse(200, { type: "error", message: "Mobile no. already verified" });
    if (Date.now() > rec.expiresAt) return jsonResponse(200, { type: "error", message: "OTP expired" });
    if (rec.otp !== otp) return jsonResponse(200, { type: "error", message: "OTP not match" });
    rec.verified = true;
    return jsonResponse(200, { type: "success", message: "OTP verified success" });
  }
  return jsonResponse(404, { type: "error", message: "unmocked msg91 route" });
}

function lastOtpFor(digits) {
  const rec = state.otps.get("91" + digits);
  return rec ? rec.otp : null;
}

/* ── install ─────────────────────────────────────────────────────────────── */

function install() {
  globalThis.fetch = async function (input, init) {
    const target = typeof input === "string" ? input : (input && input.url) || "";
    if (target.indexOf("https://api.razorpay.com") === 0)  return razorpay(target, init);
    if (target.indexOf("https://api.resend.com") === 0)    return resend(target, init);
    if (target.indexOf("https://control.msg91.com") === 0) return msg91(target, init || {});
    return realFetch(input, init);
  };
}
function uninstall() { globalThis.fetch = realFetch; }

function reset() {
  state.orders.clear();
  state.payments.clear();
  state.emails.length = 0;
  state.sms.length = 0;
  state.otps.clear();
  state.resendIdempotency.clear();
  state.failNextRazorpayOrder = false;
  state.failRazorpayFetch = false;
  state.failPaymentFetch = false;
  state.failOrderPaymentsFetch = false;
  state.razorpayFetchDelayMs = 0;
  state.failResend = false;
  state.failMsg91 = false;
}

module.exports = {
  install, uninstall, reset, simulatePayment, setPaymentStatus,
  lastCodeFor, lastOtpFor, state
};
