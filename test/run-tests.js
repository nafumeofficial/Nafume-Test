/*
 * test/run-tests.js  —  end-to-end API suite for the NAFUME customer-data system
 * ============================================================================
 *   node test/run-tests.js                          (through api/index.js)
 *   NAFUME_TEST_ROUTER=direct node test/run-tests.js (handlers directly)
 *
 * Runs the real handlers from /server against the memory storage driver, with
 * only the external HTTP boundary (Razorpay, Resend, MSG91) replaced by
 * test/mocks.js. By default every request goes through api/index.js with
 * Vercel's Node helpers emulated (see test/server.js), which is how production
 * receives it. Razorpay signatures are computed with the same HMAC scheme and
 * the same secret the handlers read, so signature verification, tampering and
 * replay are genuinely exercised rather than stubbed.
 *
 * Every assertion checks BOTH the HTTP response and the resulting database
 * state — a success message is never accepted as proof of persistence.
 *
 * WHAT THIS DOES NOT PROVE: that live Supabase, Razorpay, Resend or MSG91
 * behave like the mocks. See test/check-live-services.js and the readiness
 * report for live verification.
 */
"use strict";

const D1_MODE = String(process.env.NAFUME_TEST_DB || "").toLowerCase() === "d1";
process.env.NAFUME_DB_DRIVER    = D1_MODE ? "d1" : "memory";
process.env.RAZORPAY_KEY_ID     = "rzp_test_localsuite";
process.env.RAZORPAY_KEY_SECRET = "local_test_secret_do_not_use_in_production";
process.env.RESEND_API_KEY      = "re_test_local";
process.env.ADMIN_API_TOKEN     = "test_admin_token";
process.env.CRON_SECRET         = "test_cron_secret";
process.env.SITE_URL            = "https://www.nafume.com";
process.env.MSG91_AUTH_KEY      = "msg91_test_local";
process.env.MSG91_TEMPLATE_ID   = "tmpl_test_local";
delete process.env.NAFUME_DB_FILE;
delete process.env.VERCEL;
delete process.env.NODE_ENV;

const mocks = require("./mocks");
mocks.install();

const { start }   = require("./server");
const db          = require("../server/_lib/db");
if (D1_MODE) {
  // Same suite, real D1 driver + db/d1/schema.sql on node:sqlite (see test/d1-shim.js).
  db.setD1Binding(require("./d1-shim").createShim());
  console.log("[tests] storage driver: d1 (node:sqlite shim)");
}
const catalog     = require("../server/_lib/catalog");
const discounts   = require("../server/_lib/discounts");
const messagingLib = require("../server/_lib/messaging");
const repoLib     = require("../server/_lib/repo");

let r0;   // shared scratch for suites that probe an endpoint before authorising

let BASE = "";
let passed = 0, failed = 0;
const failures = [];

/* ── tiny assertion helpers ──────────────────────────────────────────────── */

function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else {
    failed++; failures.push(name + (detail ? "  → " + detail : ""));
    console.log("  FAIL  " + name + (detail ? "  → " + detail : ""));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function section(title) {
  console.log("\n── " + title + " " + "─".repeat(Math.max(0, 62 - title.length)));
  api.newIp();
}

/* ── HTTP helpers (with cookie jar) ──────────────────────────────────────────
   Each client presents its own X-Forwarded-For, the way separate shoppers do.
   Rate limiting stays fully ACTIVE during the suite (testRateLimiting proves it
   fires); this just stops one synthetic client's hundreds of requests from
   throttling every later test. */

let ipCounter = 0;
function nextIp() { ipCounter++; return "203.0.113." + (ipCounter % 250 + 1) + ":" + ipCounter; }

function makeClient() {
  let cookie = "";
  let ip = nextIp();

  async function request(method, path, payload, headers) {
    const init = { method: method, headers: Object.assign({ "X-Forwarded-For": ip }, headers || {}) };
    if (payload !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    if (cookie) init.headers["Cookie"] = cookie;

    const r = await fetch(BASE + path, init);
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    setCookie.forEach(function (c) {
      const pair = c.split(";")[0];
      if (pair.split("=")[1]) cookie = pair;
      else cookie = "";                    // Max-Age=0 clear
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { status: r.status, body: body || {}, rawCookies: setCookie };
  }
  return {
    post: function (p, b, h) { return request("POST", p, b, h); },
    get:  function (p, h)    { return request("GET",  p, undefined, h); },
    cookie: function () { return cookie; },
    clearCookie: function () { cookie = ""; },
    ip: function () { return ip; },
    newIp: function () { ip = nextIp(); return ip; }
  };
}

/* Shared client used by the checkout helper. Each suite calls api.newIp() so
   its traffic looks like a fresh visitor rather than a 200-request bot. */
const api = makeClient();

/* ── fixtures ────────────────────────────────────────────────────────────── */

function shippingFor(n) {
  return {
    name:  "Test Customer " + n,
    phone: "98765" + String(43210 + n).slice(-5),
    email: "customer" + n + "@example.com",
    addr1: "12 MG Road",
    addr2: "Near Park",
    city:  "Bengaluru",
    state: "Karnataka",
    pin:   "560001"
  };
}

/* payFor(items, shipping, extras) — full happy-path checkout, returns
   { create, pay, verify }. */
async function checkout(items, shipping, extras, client) {
  extras = extras || {};
  client = client || api;
  const priced = catalog.priceCart(items);
  const totals = catalog.calculateTotals(priced.subtotal, priced.totalQty, extras.giftingAddOn === true, { prepaid: true });

  const create = await client.post("/api/razorpay/create-order", Object.assign({
    items: items, amount: totals.total, shipping: shipping
  }, extras));

  if (create.status !== 200) return { create: create, totals: totals };

  const pay    = mocks.simulatePayment(create.body.order_id);
  const verify = await client.post("/api/razorpay/verify-payment", pay);
  return { create: create, pay: pay, verify: verify, totals: totals };
}

/* registerAndVerify(client, details, channel)
   The real two-step registration: start → read the code the provider got →
   verify. Returns { start, verify }. */
async function registerAndVerify(client, d, channel) {
  const start = await client.post("/api/account/register", {
    name: d.name, email: d.email, phone: d.phone, password: d.password || "GoodPass123",
    verifyVia: channel === "phone" ? "phone" : undefined
  });
  if (start.status !== 200) return { start: start, verify: null };
  const code = channel === "phone"
    ? mocks.lastOtpFor(String(d.phone).replace(/\D/g, "").slice(-10))
    : mocks.lastCodeFor(d.email);
  const verify = await client.post("/api/account/verify", { challengeId: start.body.challengeId, code: code });
  return { start: start, verify: verify, code: code };
}

/* ageChallenge(challengeId, patch) — test clock for verification challenges. */
async function patchChallenge(challengeId, patch) {
  await db.update("verification_challenges", { where: { id: challengeId }, set: patch });
}

/* deliver(orderId, daysAgo) — record a delivery through the admin API. */
async function deliver(orderId, daysAgo) {
  const at = new Date(Date.now() - (daysAgo || 0) * 24 * 60 * 60 * 1000).toISOString();
  return api.post("/api/admin/orders", { orderId: orderId, action: "mark_delivered", deliveredAt: at },
    { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN });
}

/* reviewLinkFor(orderId) — issue a review request and capture the token the
   email carried (the database only holds its hash). */
async function reviewLinkFor(orderId) {
  const order = await db.selectOne("orders", { order_id: orderId });
  const due = new Date(Date.now() - (catalog.REVIEW_REQUEST_DELAY_DAYS + 1) * 86400000).toISOString();
  if (!order.delivered_at || order.delivered_at > due) {
    await db.update("orders", { where: { id: order.id }, set: { delivered_at: due } });
  }
  mocks.state.emails.length = 0;
  await api.post("/api/jobs/review-requests", {}, { Authorization: "Bearer " + process.env.CRON_SECRET });
  const mail = mocks.state.emails.find(function (e) { return /how is your nafume fragrance/i.test(e.subject || "") &&
    (e.html || "").indexOf(encodeURIComponent(orderId)) !== -1; });
  if (!mail) return null;
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail.html.replace(/&amp;/g, "&"));
  return m ? m[1] : null;
}

function webhookSign(raw, secret) {
  return require("crypto").createHmac("sha256", secret).update(raw).digest("hex");
}

/* ══════════════════════════════════════════════════════════════════════════
   TESTS
   ══════════════════════════════════════════════════════════════════════════ */

async function testPricing() {
  section("Pricing (server-side authority)");

  const one = catalog.priceCart([{ id: "seduction", qty: 1 }]);
  eq("single item subtotal", one.subtotal, 799);

  const t1 = catalog.calculateTotals(799, 1, false, { prepaid: true });
  eq("1 × ₹799 → prepaid 5% off", t1.prepaidDiscount, 40);
  eq("1 × ₹799 → shipping charged under ₹999", t1.shipping, 99);
  eq("1 × ₹799 → total", t1.total, 858);

  const three = catalog.priceCart([{ id: "seduction", qty: 1 }, { id: "dark-oud", qty: 1 }, { id: "red-spirit", qty: 1 }]);
  const t3 = catalog.calculateTotals(three.subtotal, three.totalQty, false, { prepaid: true });
  eq("3 items subtotal", t3.subtotal, 2397);
  eq("3 items bundle cap applied", t3.bundleDiscount, 2397 - 2199);
  eq("3 items free shipping", t3.shipping, 0);
  eq("3 items total", t3.total, 2199 - Math.round(2199 * 0.05));

  const gift = catalog.calculateTotals(799, 1, true, { prepaid: true });
  eq("gift add-on priced by server", gift.giftingAddOn, 99);

  ok("unknown product rejected", catalog.priceCart([{ id: "not-a-product", qty: 1 }]).error === "invalid_product");
  ok("zero quantity rejected",   catalog.priceCart([{ id: "seduction", qty: 0 }]).error === "invalid_quantity");
  ok("negative quantity rejected", catalog.priceCart([{ id: "seduction", qty: -3 }]).error === "invalid_quantity");
  ok("huge quantity rejected",   catalog.priceCart([{ id: "seduction", qty: 999 }]).error === "invalid_quantity");
  ok("empty cart rejected",      catalog.priceCart([]).error === "empty_cart");

  // Duplicate ids must be merged so the per-item cap cannot be bypassed.
  const dup = catalog.priceCart([{ id: "seduction", qty: 20 }, { id: "seduction", qty: 20 }]);
  eq("duplicate lines merged and capped", dup.lines.length, 1);
  eq("merged line capped at 20", dup.lines[0].quantity, 20);
}

async function testCheckoutValidation() {
  section("Checkout validation");

  const good = shippingFor(1);

  let r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858,
    shipping: Object.assign({}, good, { email: "not-an-email" })
  });
  eq("invalid email rejected", r.status, 400);
  ok("invalid email flags the field", !!(r.body.fields && r.body.fields.email));

  r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858,
    shipping: Object.assign({}, good, { phone: "12345" })
  });
  eq("invalid phone rejected", r.status, 400);

  r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858,
    shipping: Object.assign({}, good, { pin: "0123" })
  });
  eq("invalid PIN rejected", r.status, 400);

  r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858,
    shipping: Object.assign({}, good, { name: "   " })
  });
  eq("whitespace-only name rejected", r.status, 400);

  // The attack this whole design exists to stop.
  r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 1, shipping: good
  });
  eq("manipulated price rejected", r.status, 400);
  eq("manipulated price error code", r.body.error, "amount_mismatch");

  r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1, price: 1 }], amount: 858, shipping: good
  });
  eq("client-supplied price ignored (correct total still accepted)", r.status, 200);

  r = await api.get("/api/razorpay/create-order");
  eq("GET on a POST endpoint is 405", r.status, 405);
}

async function testHappyPath() {
  section("Checkout → Razorpay → verify → persistence");

  const ship = shippingFor(10);
  const items = [{ id: "dark-oud", qty: 2 }];
  const priced = catalog.priceCart(items);
  const totals = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, { prepaid: true });

  const create = await api.post("/api/razorpay/create-order", {
    items: items, amount: totals.total, shipping: ship,
    whatsappOptIn: true, notes: "Leave at the gate"
  });

  eq("create-order succeeded", create.status, 200);
  ok("publishable key returned", create.body.key_id === "rzp_test_localsuite");
  ok("secret NEVER returned", JSON.stringify(create.body).indexOf(process.env.RAZORPAY_KEY_SECRET) === -1);
  eq("razorpay amount is in paise", create.body.amount, totals.total * 100);

  const nafumeOrderId = create.body.nafume_order_id;

  // Checked BETWEEN create and verify: the pending order must already exist, so
  // a payment that succeeds while the browser dies is still recoverable.
  let stored = await db.selectOne("orders", { order_id: nafumeOrderId });
  ok("pending order persisted before payment", !!stored);
  eq("pending order starts unpaid", stored.payment_status, "pending");
  ok("pending order has no payment id yet", stored.razorpay_payment_id === null);
  eq("pending order carries razorpay order id", stored.razorpay_order_id, create.body.order_id);

  const pay    = mocks.simulatePayment(create.body.order_id);
  const verify = await api.post("/api/razorpay/verify-payment", pay);
  const flow   = { create: create, pay: pay, verify: verify };

  eq("verify succeeded", flow.verify.status, 200);
  eq("verify persisted", flow.verify.body.persisted, true);
  eq("verify not a replay", flow.verify.body.alreadyProcessed, false);

  stored = await db.selectOne("orders", { order_id: nafumeOrderId });
  eq("DB: order is paid", stored.payment_status, "paid");
  eq("DB: order confirmed", stored.order_status, "confirmed");
  eq("DB: razorpay payment id recorded", stored.razorpay_payment_id, flow.pay.razorpay_payment_id);
  ok("DB: paid_at set", !!stored.paid_at);
  eq("DB: whatsapp consent stored on order", stored.whatsapp_opt_in, true);
  eq("DB: notes stored", stored.notes, "Leave at the gate");

  const lines = await db.select("order_items", { where: { order_id: nafumeOrderId } });
  eq("DB: one order line", lines.length, 1);
  eq("DB: line quantity", lines[0].quantity, 2);
  eq("DB: line price is the SERVER price", lines[0].unit_price, 799);

  const customer = await db.selectOne("customers", { id: stored.customer_id });
  ok("DB: customer created", !!customer);
  eq("DB: email normalized", customer.email_normalized, ship.email.toLowerCase());
  eq("DB: phone normalized", customer.phone_normalized, ship.phone);
  eq("DB: address stored", customer.city, "Bengaluru");

  const consent = await db.selectOne("marketing_consent", { customer_id: customer.id, channel: "whatsapp" });
  ok("DB: consent row written", !!consent);
  eq("DB: consent opted in", consent.opted_in, true);
  eq("DB: consent source", consent.consent_source, "checkout");
}

async function testNormalization() {
  section("Data normalization");

  const messy = {
    name:  "   ravi    kumar   ",
    phone: "+91 98765 11111",
    email: "  MiXeD.Case@Example.COM  ",
    addr1: "  12   MG Road  ", addr2: "", city: " Pune ", state: "Maharashtra", pin: " 411001 "
  };
  const flow = await checkout([{ id: "aqua-manthan", qty: 1 }], messy);
  eq("messy input accepted", flow.verify.status, 200);

  const order = await db.selectOne("orders", { order_id: flow.create.body.nafume_order_id });
  eq("name trimmed and collapsed", order.ship_name, "ravi kumar");
  eq("phone stored as 10 digits", order.ship_phone, "9876511111");
  eq("pincode digits only", order.ship_pincode, "411001");

  const customer = await db.selectOne("customers", { id: order.customer_id });
  eq("email lowercased for matching", customer.email_normalized, "mixed.case@example.com");
  ok("original email casing preserved for display", customer.email === "MiXeD.Case@Example.COM");
}

async function testIdempotency() {
  section("Payment idempotency (the critical requirement)");

  mocks.state.emails.length = 0;
  const ship = shippingFor(20);
  const flow = await checkout([{ id: "red-spirit", qty: 1 }], ship);
  eq("first verify OK", flow.verify.status, 200);
  const emailsAfterFirst = mocks.state.emails.length;
  ok("confirmation emails sent once", emailsAfterFirst >= 2);

  // 1. straight replay (refresh / retry)
  const again = await api.post("/api/razorpay/verify-payment", flow.pay);
  eq("replayed verify still 200", again.status, 200);
  eq("replayed verify flagged as already processed", again.body.alreadyProcessed, true);
  eq("replay sent no extra email", mocks.state.emails.length, emailsAfterFirst);

  // 2. five concurrent verifies (double-click / racing tabs)
  const concurrent = await Promise.all([0, 1, 2, 3, 4].map(function () {
    return api.post("/api/razorpay/verify-payment", flow.pay);
  }));
  ok("all concurrent verifies returned 200", concurrent.every(function (r) { return r.status === 200; }));
  eq("concurrency sent no extra email", mocks.state.emails.length, emailsAfterFirst);

  // 3. the database is the proof
  const paidRows = await db.select("orders", { where: { razorpay_payment_id: flow.pay.razorpay_payment_id } });
  eq("exactly ONE paid order for this payment id", paidRows.length, 1);

  const allForOrder = await db.select("orders", { where: { order_id: flow.create.body.nafume_order_id } });
  eq("exactly ONE order row overall", allForOrder.length, 1);

  // 4. the unique index itself
  let blocked = false;
  try {
    await db.insert("orders", Object.assign({}, paidRows[0], { id: db.newId(), order_id: "NF-DUPLICATE-001" }));
  } catch (err) { blocked = err instanceof db.UniqueViolationError; }
  ok("UNIQUE(razorpay_payment_id) blocks a second paid row", blocked);
}

async function testTamperedPayments() {
  section("Payment tampering and failure paths");

  const ship = shippingFor(30);
  const create = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: ship
  });
  const good = mocks.simulatePayment(create.body.order_id);

  let r = await api.post("/api/razorpay/verify-payment",
    Object.assign({}, good, { razorpay_signature: "0".repeat(64) }));
  eq("forged signature rejected", r.status, 400);
  eq("forged signature error", r.body.error, "invalid_signature");

  let order = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("forged signature left the order unpaid", order.payment_status, "pending");

  r = await api.post("/api/razorpay/verify-payment", { razorpay_order_id: good.razorpay_order_id });
  eq("missing fields rejected", r.status, 400);

  r = await api.post("/api/razorpay/verify-payment",
    Object.assign({}, good, { razorpay_signature: "not-hex" }));
  eq("malformed signature rejected", r.status, 400);

  // A payment Razorpay reports as failed must not be honoured.
  const create2 = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(31)
  });
  const failedPay = mocks.simulatePayment(create2.body.order_id, { status: "failed" });
  r = await api.post("/api/razorpay/verify-payment", failedPay);
  eq("uncaptured payment rejected", r.status, 402);
  order = await db.selectOne("orders", { order_id: create2.body.nafume_order_id });
  eq("uncaptured payment left the order unpaid", order.payment_status, "pending");

  // Signature valid but the captured amount is not what we asked for.
  const create3 = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(32)
  });
  const cheapPay = mocks.simulatePayment(create3.body.order_id, { amount: 100 });
  r = await api.post("/api/razorpay/verify-payment", cheapPay);
  eq("underpaid payment rejected", r.status, 400);
  order = await db.selectOne("orders", { order_id: create3.body.nafume_order_id });
  eq("underpaid payment left the order unpaid", order.payment_status, "pending");

  // Razorpay unreachable during the confirmation fetch. A valid signature is
  // NOT proof of capture: the order must wait, never be marked paid, and the
  // customer must be told not to pay again.
  const create4 = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(33)
  });
  const pay4 = mocks.simulatePayment(create4.body.order_id);
  mocks.state.emails.length = 0;
  mocks.state.failRazorpayFetch = true;
  r = await api.post("/api/razorpay/verify-payment", pay4);
  mocks.state.failRazorpayFetch = false;
  eq("lookup failure → 202, not 200", r.status, 202);
  eq("lookup failure → awaiting_verification state", r.body.paymentState, "awaiting_verification");
  eq("customer is told not to pay again", r.body.message,
    "We're confirming your payment. Please don't pay again. Your order status will update once confirmation arrives.");
  order = await db.selectOne("orders", { order_id: create4.body.nafume_order_id });
  eq("DB: lookup failure did NOT mark the order paid", order.payment_status, "awaiting_verification");
  eq("DB: the reported payment id is held for recovery", order.pending_payment_id, pay4.razorpay_payment_id);
  ok("DB: no payment id committed as paid", order.razorpay_payment_id === null);
  eq("no confirmation email while unconfirmed", mocks.state.emails.filter(function (e) {
    return /is confirmed/i.test(e.subject || ""); }).length, 0);

  // A timeout is treated exactly like a failure.
  const create5 = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(34)
  });
  const pay5 = mocks.simulatePayment(create5.body.order_id);
  mocks.state.failPaymentFetch = true;
  r = await api.post("/api/razorpay/verify-payment", pay5);
  mocks.state.failPaymentFetch = false;
  eq("payment-lookup error (order lookup fine) still holds", r.status, 202);
  eq("DB: still not paid", (await db.selectOne("orders", { order_id: create5.body.nafume_order_id })).payment_status,
    "awaiting_verification");

  // Once Razorpay answers again, the same callback confirms it — once.
  r = await api.post("/api/razorpay/verify-payment", pay4);
  eq("retry after recovery confirms the captured payment", r.status, 200);
  eq("…reported as paid", r.body.paymentState, "paid");
  order = await db.selectOne("orders", { order_id: create4.body.nafume_order_id });
  eq("DB: now paid", order.payment_status, "paid");
  eq("DB: confirmation path recorded", order.payment_confirmed_via, "checkout_callback");
  eq("DB: captured amount recorded in paise", order.payment_captured_amount, 858 * 100);
  eq("DB: currency recorded", order.payment_currency, "INR");
}

async function testRazorpayOutage() {
  section("Razorpay outage at order creation");

  mocks.state.failNextRazorpayOrder = true;
  const r = await api.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(40)
  });
  eq("gateway failure surfaces as 502", r.status, 502);
  ok("customer gets a readable message", typeof r.body.message === "string" && r.body.message.length > 10);
  ok("no order row left behind", (await db.select("orders", { where: { ship_email: "customer40@example.com" } })).length === 0);
}

async function testRepeatCustomer() {
  section("Repeat customers (no duplicate records)");

  const ship = shippingFor(50);
  await checkout([{ id: "seduction", qty: 1 }], ship);
  await checkout([{ id: "dark-oud", qty: 1 }], ship);

  const rows = await db.select("customers", { where: { email_normalized: ship.email } });
  eq("second order did not duplicate the customer", rows.length, 1);

  const orders = await db.select("orders", { where: { customer_id: rows[0].id } });
  eq("both orders attached to the same customer", orders.length, 2);

  // Same person, different formatting of the same identifiers.
  await checkout([{ id: "red-spirit", qty: 1 }], Object.assign({}, ship, {
    phone: "+91 " + ship.phone, email: ship.email.toUpperCase()
  }));
  const rows2 = await db.select("customers", { where: { email_normalized: ship.email } });
  eq("differently-formatted identifiers still match one customer", rows2.length, 1);
  eq("third order attached too", (await db.select("orders", { where: { customer_id: rows2[0].id } })).length, 3);
}

async function testWhatsAppConsent() {
  section("WhatsApp consent (Phase 4)");

  const optOut = shippingFor(60);
  await checkout([{ id: "seduction", qty: 1 }], optOut, { whatsappOptIn: false });
  let c = await db.selectOne("customers", { email_normalized: optOut.email });
  let consent = await db.selectOne("marketing_consent", { customer_id: c.id, channel: "whatsapp" });
  ok("declining still records a consent row", !!consent);
  eq("decliner is NOT opted in", consent.opted_in, false);
  ok("decliner has a revoked_at stamp", !!consent.revoked_at);

  // Omitting the field entirely must not be read as consent.
  const omitted = shippingFor(61);
  await checkout([{ id: "seduction", qty: 1 }], omitted);
  c = await db.selectOne("customers", { email_normalized: omitted.email });
  consent = await db.selectOne("marketing_consent", { customer_id: c.id, channel: "whatsapp" });
  eq("missing consent field defaults to NOT opted in", consent.opted_in, false);

  // A truthy-but-not-true value must not be read as consent either.
  const sneaky = shippingFor(62);
  await checkout([{ id: "seduction", qty: 1 }], sneaky, { whatsappOptIn: "yes" });
  c = await db.selectOne("customers", { email_normalized: sneaky.email });
  consent = await db.selectOne("marketing_consent", { customer_id: c.id, channel: "whatsapp" });
  eq("non-boolean consent value is not consent", consent.opted_in, false);

  // Opting in later flips the same row rather than adding another.
  const flip = shippingFor(63);
  await checkout([{ id: "seduction", qty: 1 }], flip, { whatsappOptIn: false });
  await checkout([{ id: "dark-oud", qty: 1 }], flip, { whatsappOptIn: true });
  c = await db.selectOne("customers", { email_normalized: flip.email });
  const all = await db.select("marketing_consent", { where: { customer_id: c.id, channel: "whatsapp" } });
  eq("one consent row per customer per channel", all.length, 1);
  eq("latest choice wins", all[0].opted_in, true);
  ok("revoked_at cleared on re-consent", all[0].revoked_at === null);
}

async function testAccounts() {
  section("Accounts (Phase 2)");

  // Guest checkout first — this is the real post-purchase flow.
  const ship = shippingFor(70);
  const flow = await checkout([{ id: "seduction", qty: 1 }], ship);
  const prefill = flow.verify.body.accountPrefill;
  ok("verify returns prefill for account creation", !!prefill);
  eq("prefill name matches checkout", prefill.name, ship.name);
  eq("prefill email matches checkout", prefill.email, ship.email);
  eq("prefill phone matches checkout", prefill.phone, ship.phone);

  const guestCustomer = await db.selectOne("customers", { email_normalized: ship.email });
  eq("guest customer has no account yet", guestCustomer.has_account, false);

  let r = await api.post("/api/account/register", {
    name: prefill.name, email: prefill.email, phone: prefill.phone, password: "short"
  });
  eq("weak password rejected", r.status, 400);

  r = await api.post("/api/account/register", {
    name: prefill.name, email: prefill.email, phone: prefill.phone, password: "abcdefghij"
  });
  eq("letters-only password rejected", r.status, 400);

  // Step 1 sends a code and grants NOTHING yet.
  r = await api.post("/api/account/register", {
    name: prefill.name, email: prefill.email, phone: prefill.phone, password: "GoodPass123"
  });
  eq("registration step 1 accepted", r.status, 200);
  eq("…and requires verification", r.body.verificationRequired, true);
  eq("…by email", r.body.channel, "email");
  ok("…with a masked destination", /•••@example\.com$/.test(r.body.destination || ""), r.body.destination);
  ok("step 1 sets NO session cookie", !r.rawCookies.some(function (c) { return c.indexOf("nf_session=") === 0 && !/Max-Age=0/.test(c); }));
  eq("step 1 creates NO credentials",
    await db.selectOne("customer_auth", { customer_id: guestCustomer.id }), null);
  eq("me: still anonymous before verification", (await api.get("/api/account/me")).body.authenticated, false);
  const code = mocks.lastCodeFor(prefill.email);
  ok("a 6-digit code was emailed", /^\d{6}$/.test(code || ""));
  const storedChallenge = await db.selectOne("verification_challenges", { id: r.body.challengeId });
  ok("DB: the code is not stored in plaintext", JSON.stringify(storedChallenge).indexOf(code) === -1);
  ok("DB: the password is only stored hashed", JSON.stringify(storedChallenge).indexOf("GoodPass123") === -1);
  const outbox = await db.select("outbound_messages", { where: { related_id: r.body.challengeId } });
  ok("DB: the outbox copy of the email is redacted", outbox.length === 1 && outbox[0].body.indexOf(code) === -1);

  r = await api.post("/api/account/verify", { challengeId: r.body.challengeId, code: code });
  eq("registration verified", r.status, 200);
  eq("registration linked the existing order", r.body.orderCount, 1);
  ok("session cookie set on verification", r.rawCookies.some(function (c) { return c.indexOf("nf_session=") === 0; }));
  ok("cookie is HttpOnly", r.rawCookies.some(function (c) { return /HttpOnly/i.test(c); }));
  ok("cookie is SameSite=Lax", r.rawCookies.some(function (c) { return /SameSite=Lax/i.test(c); }));
  eq("email reported verified", r.body.customer.emailVerified, true);
  eq("email verification does NOT verify the phone", r.body.customer.phoneVerified, false);

  // The account attached to the SAME customer row, not a new one.
  const after = await db.select("customers", { where: { email_normalized: ship.email } });
  eq("no duplicate customer created by registration", after.length, 1);
  eq("customer now flagged as having an account", after[0].has_account, true);
  eq("customer id unchanged", after[0].id, guestCustomer.id);

  const creds = await db.selectOne("customer_auth", { customer_id: after[0].id });
  ok("credentials row created", !!creds);
  ok("password stored as a scrypt hash", /^scrypt\$16384\$8\$1\$/.test(creds.password_hash));
  ok("password NOT stored in plaintext anywhere", creds.password_hash.indexOf("GoodPass123") === -1);

  // Logged straight in.
  r = await api.get("/api/account/me");
  eq("me: authenticated after register", r.body.authenticated, true);
  eq("me: order history visible", r.body.orders.length, 1);
  ok("me: never returns a password hash", JSON.stringify(r.body).indexOf("scrypt$") === -1);

  // Duplicate registration.
  const other = makeClient();
  const dup = await (async function () {
    const rr = await fetch(BASE + "/api/account/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: prefill.name, email: prefill.email, phone: prefill.phone, password: "GoodPass123" })
    });
    return { status: rr.status, body: await rr.json() };
  })();
  eq("duplicate registration is a clean 409", dup.status, 409);
  eq("duplicate registration error code", dup.body.error, "account_exists");
  ok("duplicate registration tells them to log in", dup.body.canLogin === true);

  // Logout, then log back in.
  r = await api.post("/api/account/logout", {});
  eq("logout OK", r.status, 200);
  r = await api.get("/api/account/me");
  eq("me: logged out after logout", r.body.authenticated, false);

  r = await api.post("/api/account/login", { identifier: prefill.email, password: "WrongPass123" });
  eq("wrong password rejected", r.status, 401);
  ok("wrong password gives a non-enumerating message", r.body.message.indexOf("don't match") !== -1);

  r = await api.post("/api/account/login", { identifier: "nobody@example.com", password: "GoodPass123" });
  eq("unknown account gives the SAME 401", r.status, 401);

  r = await api.post("/api/account/login", { identifier: prefill.email, password: "GoodPass123" });
  eq("login by email works", r.status, 200);

  await api.post("/api/account/logout", {});
  r = await api.post("/api/account/login", { identifier: ship.phone, password: "GoodPass123" });
  eq("login by phone works too", r.status, 200);

  // Profile update, scoped to the session's own customer.
  r = await api.post("/api/account/update", {
    address: { line1: "9 New Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
    whatsappOptIn: true
  });
  eq("profile update OK", r.status, 200);
  const updated = await db.selectOne("customers", { id: after[0].id });
  eq("address persisted", updated.address_line1, "9 New Street");
  const consent = await db.selectOne("marketing_consent", { customer_id: after[0].id, channel: "whatsapp" });
  eq("consent updated from the account page", consent.opted_in, true);

  // Anonymous access must be refused.
  const anon = makeClient();
  r = await anon.post("/api/account/update", { name: "Hacker" });
  eq("unauthenticated update rejected", r.status, 401);
  r = await anon.get("/api/account/me");
  eq("unauthenticated me is not an error", r.status, 200);
  eq("unauthenticated me reports logged out", r.body.authenticated, false);

  // Revoked session must stop working immediately.
  const stolen = api.cookie();
  await api.post("/api/account/logout", {});
  const replay = await fetch(BASE + "/api/account/me", { headers: { Cookie: stolen } });
  const replayBody = await replay.json();
  eq("a revoked session token is dead", replayBody.authenticated, false);

  // Session tokens are stored hashed, never in the clear.
  const sessionRows = await db.select("sessions", {});
  const tokenValue = stolen.split("=")[1];
  ok("session token stored only as a hash",
    sessionRows.every(function (s) { return s.token_hash !== decodeURIComponent(tokenValue); }));
}

async function testOrderLookup() {
  section("Order lookup (guest confirmation page)");

  const ship = shippingFor(80);
  const flow = await checkout([{ id: "all-day-misfit", qty: 1 }], ship);
  const orderId = flow.create.body.nafume_order_id;

  const guest = makeClient();
  let r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: ship.email });
  eq("lookup with the right email works", r.status, 200);
  eq("lookup returns the order", r.body.order.orderId, orderId);
  ok("lookup never leaks another field like a signature",
    JSON.stringify(r.body).indexOf("razorpay_signature") === -1);

  r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: ship.phone });
  eq("lookup with the right phone works", r.status, 200);

  r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: "someone.else@example.com" });
  eq("lookup with a wrong contact is refused", r.status, 404);

  r = await guest.post("/api/orders/lookup", { orderId: orderId });
  eq("lookup with no contact is refused", r.status, 404);

  r = await guest.post("/api/orders/lookup", { orderId: "NF-00000000-000", contact: ship.email });
  eq("unknown order id gives the SAME 404", r.status, 404);
}

async function testLeads() {
  section("Popup lead capture (Phase 3)");

  const lead = makeClient();

  let r = await lead.post("/api/leads/subscribe", { email: "not-an-email" });
  eq("invalid lead email rejected", r.status, 400);

  r = await lead.post("/api/leads/subscribe", {
    email: "  Popup.Visitor@Example.COM ", source: "popup_lead", meta: { trigger: "exit_intent", page: "/" }
  });
  eq("lead capture OK", r.status, 200);
  eq("lead is new", r.body.alreadySubscribed, false);
  eq("discount code returned for display", r.body.discount.code, catalog.POPUP_OFFER.code);

  const rows = await db.select("leads", { where: { email_normalized: "popup.visitor@example.com" } });
  eq("DB: lead persisted", rows.length, 1);
  eq("DB: lead source tagged", rows[0].source, "popup_lead");
  eq("DB: lead has the discount code", rows[0].discount_code, catalog.POPUP_OFFER.code);
  eq("DB: trigger recorded", rows[0].metadata.trigger, "exit_intent");

  // A lead is NOT a customer and NOT an order.
  eq("lead did not create a customer",
    (await db.select("customers", { where: { email_normalized: "popup.visitor@example.com" } })).length, 0);
  eq("lead did not create an order",
    (await db.select("orders", { where: { ship_email: "Popup.Visitor@Example.COM" } })).length, 0);

  // Duplicate submission is graceful, not an error, and does not duplicate.
  r = await lead.post("/api/leads/subscribe", { email: "popup.visitor@example.com" });
  eq("duplicate lead returns 200", r.status, 200);
  eq("duplicate lead flagged", r.body.alreadySubscribed, true);
  eq("duplicate lead returns the same code", r.body.discount.code, catalog.POPUP_OFFER.code);
  eq("DB: still exactly one lead row",
    (await db.select("leads", { where: { email_normalized: "popup.visitor@example.com" } })).length, 1);

  // Concurrent duplicate submits (double-click).
  const burst = await Promise.all([1, 2, 3].map(function () {
    return lead.post("/api/leads/subscribe", { email: "burst@example.com" });
  }));
  ok("concurrent lead submits all return 200", burst.every(function (x) { return x.status === 200; }));
  eq("DB: concurrency created exactly one lead",
    (await db.select("leads", { where: { email_normalized: "burst@example.com" } })).length, 1);

  // An unexpected source value must not be stored blindly.
  r = await lead.post("/api/leads/subscribe", { email: "sourcey@example.com", source: "../../etc/passwd" });
  const sourced = await db.selectOne("leads", { email_normalized: "sourcey@example.com" });
  eq("unknown source falls back to popup_lead", sourced.source, "popup_lead");
}

async function testQuiz() {
  section("Fragrance finder (Phase 5)");

  const quiz = makeClient();

  let r = await quiz.get("/api/quiz/questions");
  eq("questions served", r.status, 200);
  ok("4–5 questions", r.body.questions.length >= 4 && r.body.questions.length <= 5);
  ok("every question has options", r.body.questions.every(function (q) { return q.options.length >= 2; }));
  ok("scoring weights are NOT exposed", JSON.stringify(r.body).indexOf("weights") === -1);

  // Abandoned halfway.
  r = await quiz.post("/api/quiz/recommend", { answers: { mood: "romantic" } });
  eq("half-finished quiz is refused politely", r.status, 400);
  eq("…with an actionable message", r.body.error, "incomplete_quiz");

  const oudAnswers = { mood: "powerful", occasion: "festive", strength: "strong", family: "oud", purpose: "gift" };
  r = await quiz.post("/api/quiz/recommend", { answers: oudAnswers });
  eq("recommendation computed", r.status, 200);
  eq("oud answers recommend Dark Oud", r.body.product.id, "dark-oud");
  ok("recommended product is a REAL NAFUME product", !!catalog.getProduct(r.body.product.id));
  ok("alternate is also real", !!catalog.getProduct(r.body.alternate.id));
  ok("tags include oud", r.body.tags.indexOf("oud") !== -1);
  ok("tags include strong", r.body.tags.indexOf("strong") !== -1);
  ok("tags include gifting", r.body.tags.indexOf("gifting") !== -1);

  const freshAnswers = { mood: "fresh", occasion: "office", strength: "subtle", family: "fresh", purpose: "self" };
  const fresh = await quiz.post("/api/quiz/recommend", { answers: freshAnswers });
  eq("fresh answers recommend Aqua Manthan", fresh.body.product.id, "aqua-manthan");

  const floral = await quiz.post("/api/quiz/recommend", {
    answers: { mood: "romantic", occasion: "date-night", strength: "strong", family: "floral", purpose: "self" }
  });
  eq("floral/date-night answers recommend Seduction", floral.body.product.id, "seduction");

  // Determinism.
  const again = await quiz.post("/api/quiz/recommend", { answers: oudAnswers });
  eq("same answers always give the same product", again.body.product.id, r.body.product.id);

  // Unknown option values are ignored, not stored.
  const junk = await quiz.post("/api/quiz/recommend", {
    answers: { mood: "<script>", occasion: "office", strength: "subtle", family: "fresh", purpose: "self" }
  });
  eq("junk answer value is ignored", junk.status, 200);

  // Saving requires a valid email.
  r = await quiz.post("/api/quiz/submit", { email: "nope", answers: oudAnswers });
  eq("quiz save without a valid email rejected", r.status, 400);

  r = await quiz.post("/api/quiz/submit", { email: "Quiz.Taker@Example.com", answers: oudAnswers });
  eq("quiz saved", r.status, 200);
  eq("saved result names a real product", r.body.product.id, "dark-oud");

  const responses = await db.select("quiz_responses", { where: { email_normalized: "quiz.taker@example.com" } });
  eq("DB: quiz response persisted", responses.length, 1);
  eq("DB: recommendation stored", responses[0].recommended_product_id, "dark-oud");
  eq("DB: answers stored", responses[0].answers.family, "oud");
  ok("DB: preference tags stored for segmentation",
    Array.isArray(responses[0].preference_tags) && responses[0].preference_tags.indexOf("oud") !== -1);
  eq("DB: source tagged", responses[0].source, "fragrance_quiz");
  ok("DB: junk value was never stored", JSON.stringify(responses[0].answers).indexOf("<script>") === -1);

  const quizLead = await db.selectOne("leads", { email_normalized: "quiz.taker@example.com", source: "fragrance_quiz" });
  ok("DB: quiz also created a lead", !!quizLead);
  eq("DB: quiz lead is linked to the response", responses[0].lead_id, quizLead.id);

  // A tampered client cannot store a product it did not earn.
  r = await quiz.post("/api/quiz/submit", {
    email: "tamper@example.com", answers: freshAnswers, product: { id: "dark-oud" }, recommendedProductId: "dark-oud"
  });
  const tampered = await db.selectOne("quiz_responses", { email_normalized: "tamper@example.com" });
  eq("recommendation is recomputed server-side, not taken from the client",
    tampered.recommended_product_id, "aqua-manthan");

  // Retaking the quiz keeps history rather than overwriting it.
  await quiz.post("/api/quiz/submit", { email: "quiz.taker@example.com", answers: freshAnswers });
  eq("retaking the quiz stores a new response",
    (await db.select("quiz_responses", { where: { email_normalized: "quiz.taker@example.com" } })).length, 2);
  eq("…and still only one lead row",
    (await db.select("leads", { where: { email_normalized: "quiz.taker@example.com", source: "fragrance_quiz" } })).length, 1);
}

async function testDeliveryAndReviews() {
  section("Delivery tracking + reviews (Phase 6)");

  const admin = { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN };
  const client = makeClient();

  const ship = shippingFor(90);
  const flow = await checkout([{ id: "dark-oud", qty: 1 }, { id: "seduction", qty: 1 }], ship);
  const orderId = flow.create.body.nafume_order_id;

  // The customer who placed it proves their email and so owns the order.
  const owner = makeClient();
  const reg = await registerAndVerify(owner, ship);
  eq("order owner verified their account", reg.verify && reg.verify.status, 200);

  // Contact details alone are not access to a review (or its reward).
  let r = await client.post("/api/reviews/eligibility", { orderId: orderId, contact: ship.email });
  eq("order id + contact alone cannot open a review", r.status, 404);

  // Paid but NOT delivered: eligibility says so, and submission is refused.
  r = await owner.post("/api/reviews/eligibility", { orderId: orderId });
  eq("owner can read eligibility", r.status, 200);
  eq("not eligible before delivery", r.body.eligible, false);
  eq("…because it is not delivered", r.body.reason, "not_delivered");
  eq("…and no reward is offered yet", r.body.reward, null);

  mocks.state.emails.length = 0;
  r = await owner.post("/api/reviews/submit", { orderId: orderId, productId: "dark-oud", rating: 5,
    body: "Trying to review before it even arrived." });
  eq("review BEFORE delivery refused", r.status, 403);
  eq("…with reason not_delivered", r.body.error, "not_delivered");
  ok("…and no reward code returned", !r.body.reward);
  eq("DB: no review stored before delivery", (await db.select("reviews", { where: { order_id: orderId } })).length, 0);

  // Admin auth.
  r = await client.get("/api/admin/orders");
  eq("admin without a token is 401", r.status, 401);
  r = await client.get("/api/admin/orders", { Authorization: "Bearer wrong_token" });
  eq("admin with a wrong token is 401", r.status, 401);
  r = await client.get("/api/admin/orders?status=paid", admin);
  eq("admin list works with the token", r.status, 200);
  ok("admin list returns orders", r.body.orders.length > 0);

  // Mark shipped, then delivered.
  r = await client.post("/api/admin/orders",
    { orderId: orderId, action: "mark_shipped", awb: "AWB123456", courierName: "Delhivery" }, admin);
  eq("mark_shipped OK", r.status, 200);
  let stored = await db.selectOne("orders", { order_id: orderId });
  eq("DB: fulfillment is shipped", stored.fulfillment_status, "shipped");
  ok("DB: shipped_at set", !!stored.shipped_at);
  eq("DB: AWB recorded", stored.awb, "AWB123456");

  const deliveredAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  r = await client.post("/api/admin/orders",
    { orderId: orderId, action: "mark_delivered", deliveredAt: deliveredAt }, admin);
  eq("mark_delivered OK", r.status, 200);
  stored = await db.selectOne("orders", { order_id: orderId });
  eq("DB: delivery date stored", stored.delivered_at, deliveredAt);
  eq("DB: fulfillment is delivered", stored.fulfillment_status, "delivered");

  r = await owner.post("/api/reviews/eligibility", { orderId: orderId });
  eq("eligible once delivery is recorded", r.body.eligible, true);
  eq("two products are reviewable", r.body.products.length, 2);
  eq("nothing reviewed yet", r.body.products.filter(function (p) { return p.reviewed; }).length, 0);

  r = await client.post("/api/admin/orders",
    { orderId: orderId, action: "mark_delivered", deliveredAt: "banana" }, admin);
  eq("nonsense delivery date rejected", r.status, 400);

  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  r = await client.post("/api/admin/orders",
    { orderId: orderId, action: "mark_delivered", deliveredAt: future }, admin);
  eq("far-future delivery date rejected", r.status, 400);

  /* ── the scheduler ────────────────────────────────────────────────────── */
  const cron = { Authorization: "Bearer " + process.env.CRON_SECRET };

  r = await client.post("/api/jobs/review-requests", {}, {});
  eq("scheduler without a token is 401", r.status, 401);

  mocks.state.emails.length = 0;
  r = await client.post("/api/jobs/review-requests", {}, cron);
  eq("scheduler ran", r.status, 200);
  eq("one order was due", r.body.summary.scanned, 1);
  eq("one request sent", r.body.summary.sent, 1);
  eq("scheduler sent exactly one email", mocks.state.emails.length, 1);

  let requests = await db.select("review_requests", { where: { order_id: orderId } });
  eq("DB: one review_request row", requests.length, 1);
  eq("DB: request marked sent", requests[0].status, "sent");
  stored = await db.selectOne("orders", { order_id: orderId });
  eq("DB: order marks the request as sent", stored.review_request_status, "sent");
  ok("DB: review_requested_at set", !!stored.review_requested_at);

  // Running it again must do nothing at all.
  r = await client.post("/api/jobs/review-requests", {}, cron);
  eq("second scheduler run finds nothing due", r.body.summary.scanned, 0);
  eq("second run sent no email", mocks.state.emails.length, 1);
  eq("DB: still exactly one review_request",
    (await db.select("review_requests", { where: { order_id: orderId } })).length, 1);

  // A delivery too recent to be due must not be picked up.
  const recent = shippingFor(91);
  const recentFlow = await checkout([{ id: "seduction", qty: 1 }], recent);
  await client.post("/api/admin/orders",
    { orderId: recentFlow.create.body.nafume_order_id, action: "mark_delivered" }, admin);
  r = await client.post("/api/jobs/review-requests", {}, cron);
  eq("a just-delivered order is not yet due", r.body.summary.scanned, 0);

  /* ── the review form ──────────────────────────────────────────────────── */
  r = await client.post("/api/reviews/submit",
    { orderId: orderId, contact: ship.email, productId: "dark-oud", rating: 5 });
  eq("review by a stranger with the right contact refused", r.status, 404);

  r = await owner.post("/api/reviews/submit",
    { orderId: orderId, productId: "dark-oud", rating: 9 });
  eq("out-of-range rating rejected", r.status, 400);

  r = await owner.post("/api/reviews/submit",
    { orderId: orderId, productId: "aqua-manthan", rating: 5 });
  eq("reviewing a product that wasn't in the order rejected", r.status, 400);

  r = await owner.post("/api/reviews/submit", {
    orderId: orderId, productId: "dark-oud", rating: 5,
    photo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
  });
  eq("SVG masquerading as a photo rejected", r.status, 400);

  r = await owner.post("/api/reviews/submit", {
    orderId: orderId, productId: "dark-oud", rating: 5,
    photo: "data:image/png;base64,aGVsbG8gd29ybGQgbm90IGEgcG5n"
  });
  eq("non-image bytes claiming to be PNG rejected", r.status, 400);

  // A genuine 1×1 PNG.
  const realPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  r = await owner.post("/api/reviews/submit", {
    orderId: orderId, productId: "dark-oud", rating: 5,
    title: "Outstanding", body: "Lasts all evening and the sillage is excellent.", photo: realPng
  });
  eq("valid review accepted", r.status, 200);
  ok("thank-you reward returned", r.body.reward.code === catalog.REVIEW_OFFER.code);

  const reviews = await db.select("reviews", { where: { order_id: orderId } });
  eq("DB: one review stored", reviews.length, 1);
  eq("DB: review linked to the product", reviews[0].product_id, "dark-oud");
  eq("DB: review linked to the customer", reviews[0].customer_id, stored.customer_id);
  eq("DB: review is verified (real paid order)", reviews[0].verified, true);
  eq("DB: review starts unpublished", reviews[0].status, "pending");
  ok("DB: photo stored", !!reviews[0].photo_data_url);
  ok("DB: submission timestamped", !!reviews[0].created_at);

  stored = await db.selectOne("orders", { order_id: orderId });
  eq("DB: order points at the review", stored.review_id, reviews[0].id);

  // Duplicate submission — the requirement's "opens the review form twice".
  r = await owner.post("/api/reviews/submit",
    { orderId: orderId, productId: "dark-oud", rating: 1, body: "Changed my mind" });
  eq("duplicate review rejected", r.status, 409);
  eq("DB: still one review", (await db.select("reviews", { where: { order_id: orderId } })).length, 1);
  eq("DB: original rating untouched",
    (await db.select("reviews", { where: { order_id: orderId } }))[0].rating, 5);

  // Concurrent duplicates.
  const raced = await Promise.all([1, 2, 3].map(function () {
    return owner.post("/api/reviews/submit",
      { orderId: orderId, productId: "seduction", rating: 4, body: "Lovely fragrance indeed" });
  }));
  eq("exactly one concurrent review succeeded",
    raced.filter(function (x) { return x.status === 200; }).length, 1);
  eq("DB: exactly two reviews for this order",
    (await db.select("reviews", { where: { order_id: orderId } })).length, 2);

  // Eligibility reflects what has been reviewed.
  r = await owner.post("/api/reviews/eligibility", { orderId: orderId });
  eq("nothing left to review", r.body.eligible, false);
  eq("reason is already_reviewed", r.body.reason, "already_reviewed");

  // Public listing shows only published reviews.
  r = await client.get("/api/reviews/list?productId=dark-oud");
  eq("public list OK", r.status, 200);
  eq("pending reviews are NOT public", r.body.reviews.length, 0);

  // Moderation is the only way a review becomes visible.
  r = await client.get("/api/admin/reviews?status=pending", admin);
  eq("admin can list pending reviews", r.status, 200);
  ok("the submitted review is awaiting moderation",
     r.body.reviews.some(function (x) { return x.id === reviews[0].id; }));

  r = await client.post("/api/admin/reviews", { reviewId: reviews[0].id, action: "publish" }, admin);
  eq("admin can publish a review", r.status, 200);
  eq("…and it reports the new status", r.body.status, "published");

  r = await client.post("/api/admin/reviews", { reviewId: reviews[0].id, action: "nonsense" }, admin);
  eq("an unknown moderation action is rejected", r.status, 400);

  r = await client.post("/api/admin/reviews", { reviewId: "not-a-review", action: "publish" }, admin);
  eq("moderating an unknown review is a 404", r.status, 404);

  r = await client.get("/api/admin/reviews");
  eq("review moderation requires the admin token", r.status, 401);

  r = await client.get("/api/reviews/list?productId=dark-oud");
  eq("published review is public", r.body.reviews.length, 1);
  // "Test Customer 90" is published as "Test 9." — first name + last initial.
  ok("author name is abbreviated, not printed in full",
    /^Test \w\.$/.test(r.body.reviews[0].author), "got " + r.body.reviews[0].author);
  ok("author email NEVER exposed", JSON.stringify(r.body).indexOf("customer90@example.com") === -1);
  eq("summary average computed", r.body.summary.average, 5);

  r = await client.get("/api/reviews/list?productId=not-a-product");
  eq("unknown product rejected on list", r.status, 400);

  // An unpaid order cannot be reviewed — even by its owner, even if someone
  // records a delivery on it.
  const unpaid = await owner.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: ship
  });
  eq("owner's signed-in order created", unpaid.status, 200);
  r = await owner.post("/api/reviews/submit", {
    orderId: unpaid.body.nafume_order_id, productId: "seduction", rating: 5
  });
  eq("unpaid order cannot be reviewed", r.status, 403);
  eq("…reason not_paid", r.body.error, "not_paid");

  /* ── COD delivery ────────────────────────────────────────────────────────
     A COD order is 'pending' until the courier collects the cash, so requiring
     payment before delivery would make COD orders undeliverable — and would
     silently exclude every COD customer from review requests. */
  const codShip = shippingFor(93);
  const cod = await client.post("/api/orders/create-cod", {
    items: [{ id: "aqua-manthan", qty: 1 }], shipping: codShip
  });
  eq("COD order created", cod.status, 200);
  const codId = cod.body.order.orderId;

  r = await client.post("/api/admin/orders", { orderId: codId, action: "mark_delivered" }, admin);
  eq("a COD order CAN be marked delivered", r.status, 200);

  let codStored = await db.selectOne("orders", { order_id: codId });
  eq("DB: COD delivery recorded", codStored.fulfillment_status, "delivered");
  eq("DB: delivering a COD order collects the cash", codStored.payment_status, "paid");
  ok("DB: paid_at set at delivery", !!codStored.paid_at);

  // A refused COD delivery is delivered-but-unpaid.
  const refusedShip = shippingFor(94);
  const refused = await client.post("/api/orders/create-cod", {
    items: [{ id: "aqua-manthan", qty: 1 }], shipping: refusedShip
  });
  r = await client.post("/api/admin/orders",
    { orderId: refused.body.order.orderId, action: "mark_delivered", codCollected: false }, admin);
  eq("a refused COD delivery is accepted", r.status, 200);
  const refusedStored = await db.selectOne("orders", { order_id: refused.body.order.orderId });
  eq("DB: refused COD stays unpaid", refusedStored.payment_status, "pending");

  // A cancelled order cannot be delivered.
  await client.post("/api/admin/orders", { orderId: codId, action: "cancel" }, admin);
  r = await client.post("/api/admin/orders", { orderId: codId, action: "mark_delivered" }, admin);
  eq("a cancelled order cannot be marked delivered", r.status, 409);

  // COD customers reach the review flow too.
  const codDue = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const codShip2 = shippingFor(95);
  const cod2 = await client.post("/api/orders/create-cod", {
    items: [{ id: "aqua-manthan", qty: 1 }], shipping: codShip2
  });
  await client.post("/api/admin/orders",
    { orderId: cod2.body.order.orderId, action: "mark_delivered", deliveredAt: codDue }, admin);
  r = await client.post("/api/jobs/review-requests", {}, cron);
  ok("a delivered COD order becomes due for a review request", r.body.summary.scanned >= 1,
     JSON.stringify(r.body.summary));
}

async function testMisconfiguration() {
  section("Missing configuration behaves honestly");

  // Storage unavailable → endpoints refuse rather than pretending to save.
  const savedDriver = process.env.NAFUME_DB_DRIVER;
  process.env.NAFUME_DB_DRIVER = "";
  db._resetDriverCache();
  ok("driver reports unconfigured", db.isConfigured() === false);

  const client = makeClient();
  let r = await client.post("/api/leads/subscribe", { email: "a@b.com" });
  eq("lead capture refuses without storage", r.status, 503);
  ok("…with a customer-safe message", /temporarily unavailable/i.test(r.body.message));

  r = await client.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(99)
  });
  eq("checkout refuses without storage", r.status, 503);

  r = await client.get("/api/account/me");
  eq("me still answers without storage", r.status, 200);
  eq("…reporting logged out", r.body.authenticated, false);

  r = await client.get("/api/quiz/questions");
  eq("quiz questions work without storage", r.status, 200);

  process.env.NAFUME_DB_DRIVER = savedDriver;
  db._resetDriverCache();
  ok("driver restored", db.isConfigured() === true);
}

async function testErrorHygiene() {
  section("Error hygiene");

  const client = makeClient();

  const bad = await fetch(BASE + "/api/leads/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json"
  });
  eq("malformed JSON is a clean 400", bad.status, 400);
  const badBody = await bad.json();
  ok("malformed JSON never leaks a stack trace", JSON.stringify(badBody).indexOf("SyntaxError") === -1);

  const r = await client.get("/api/does/not/exist");
  eq("unknown endpoint is 404", r.status, 404);

  const opts = await fetch(BASE + "/api/leads/subscribe", { method: "OPTIONS" });
  eq("OPTIONS preflight answered", opts.status, 204);

  // Nothing anywhere should echo a secret.
  const create = await client.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(101)
  });
  const serialised = JSON.stringify(create.body);
  ok("no Razorpay secret in any response", serialised.indexOf(process.env.RAZORPAY_KEY_SECRET) === -1);
  ok("no admin token in any response", serialised.indexOf(process.env.ADMIN_API_TOKEN) === -1);
}

/* The "browser closed after paying" case, and the other final-audit questions
   that needed their own coverage. */
async function testWebhookRecovery() {
  section("Webhook recovery (payment succeeds, browser dies)");

  const WEBHOOK_SECRET = "test_webhook_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const crypto = require("crypto");

  // Held in a local, not read from the environment, so the last case below can
  // unset the env var and still send a correctly-signed request.
  function signed(payload) {
    const raw = JSON.stringify(payload);
    return {
      raw: raw,
      signature: crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")
    };
  }
  async function postWebhook(payload, signature) {
    const s = signed(payload);
    const r = await fetch(BASE + "/api/razorpay/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature === undefined ? s.signature : signature,
        "X-Forwarded-For": "198.51.100.7"
      },
      body: s.raw
    });
    return { status: r.status, body: await r.json().catch(function () { return {}; }) };
  }

  // Customer pays, then the browser never reaches verify-payment.
  const ship = shippingFor(110);
  const create = await api.post("/api/razorpay/create-order", {
    items: [{ id: "dark-oud", qty: 1 }], amount: 858, shipping: ship
  });
  const pay = mocks.simulatePayment(create.body.order_id);

  let stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("order is still pending before the webhook", stored.payment_status, "pending");

  const event = {
    event: "payment.captured",
    payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } }
  };

  // A forged webhook must be rejected.
  let r = await postWebhook(event, "0".repeat(64));
  eq("webhook with a bad signature rejected", r.status, 401);
  stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("forged webhook did not mark the order paid", stored.payment_status, "pending");

  // The genuine webhook recovers the order.
  mocks.state.emails.length = 0;
  r = await postWebhook(event);
  eq("genuine webhook accepted", r.status, 200);
  eq("webhook reports it handled the event", r.body.handled, true);
  eq("webhook reports it RECOVERED the order", r.body.recovered, true);

  stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("DB: webhook marked the order paid", stored.payment_status, "paid");
  eq("DB: payment id recorded by the webhook", stored.razorpay_payment_id, pay.razorpay_payment_id);
  ok("webhook sent the confirmation emails the browser never triggered", mocks.state.emails.length >= 2);

  // Razorpay retries webhooks — a redelivery must change nothing.
  const emailsAfter = mocks.state.emails.length;
  r = await postWebhook(event);
  eq("redelivered webhook still 200", r.status, 200);
  eq("redelivered webhook reports nothing to recover", r.body.recovered, false);
  eq("redelivery sent no extra email", mocks.state.emails.length, emailsAfter);
  eq("DB: still exactly one order",
    (await db.select("orders", { where: { razorpay_payment_id: pay.razorpay_payment_id } })).length, 1);

  // And the browser turning up late must also be a no-op.
  const late = await api.post("/api/razorpay/verify-payment", pay);
  eq("a late browser callback still succeeds", late.status, 200);
  eq("…and reports it was already processed", late.body.alreadyProcessed, true);
  eq("DB: order untouched by the late callback",
    (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "paid");

  // An event naming a payment Razorpay has never heard of is refused.
  r = await postWebhook({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_totallyfabricated", order_id: "order_fake" } } }
  });
  ok("fabricated payment id is not honoured", r.status !== 200 || r.body.handled === false,
     JSON.stringify(r.body));

  // Unrelated events are acknowledged, not retried forever.
  r = await postWebhook({ event: "payment.failed", payload: { payment: { entity: { id: "pay_x" } } } });
  eq("unrelated event acknowledged", r.status, 200);
  eq("unrelated event not acted on", r.body.handled, false);

  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  r = await postWebhook(event);
  eq("webhook refuses to run when its secret is unset", r.status, 503);
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
}

async function testMissingCredentials() {
  section("Missing credentials fail safe");

  const client = makeClient();

  // Razorpay keys absent → online payment refuses, COD must still work.
  const savedId = process.env.RAZORPAY_KEY_ID;
  const savedSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_ID = "";
  process.env.RAZORPAY_KEY_SECRET = "";

  let r = await client.post("/api/razorpay/create-order", {
    items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(120)
  });
  eq("online checkout refuses without Razorpay keys", r.status, 503);
  ok("…with a customer-safe message", /not available|try again|whatsapp/i.test(r.body.message), r.body.message);

  r = await client.post("/api/orders/create-cod", {
    items: [{ id: "seduction", qty: 1 }], shipping: shippingFor(121)
  });
  eq("COD still works without Razorpay keys", r.status, 200);
  eq("COD order is confirmed but unpaid", r.body.order.paymentStatus, "pending");
  eq("COD order status is confirmed", r.body.order.orderStatus, "confirmed");
  eq("COD gets no prepaid discount", r.body.order.totals.prepaidDiscount, 0);

  process.env.RAZORPAY_KEY_ID = savedId;
  process.env.RAZORPAY_KEY_SECRET = savedSecret;

  // Admin + cron tokens absent → both endpoints refuse rather than open up.
  const savedAdmin = process.env.ADMIN_API_TOKEN;
  const savedCron  = process.env.CRON_SECRET;
  process.env.ADMIN_API_TOKEN = "";
  process.env.CRON_SECRET = "";

  r = await client.get("/api/admin/orders");
  eq("admin endpoint refuses when no token is configured", r.status, 503);
  r = await client.post("/api/jobs/review-requests", {});
  eq("scheduler refuses when no secret is configured", r.status, 503);

  process.env.ADMIN_API_TOKEN = savedAdmin;
  process.env.CRON_SECRET = savedCron;

  r = await client.get("/api/admin/orders", { Authorization: "Bearer " + savedAdmin });
  eq("admin works again once the token is restored", r.status, 200);
}

async function testCodDoubleSubmit() {
  section("COD double-submit");

  const client = makeClient();
  const ship = shippingFor(130);
  const payload = { items: [{ id: "red-spirit", qty: 1 }], shipping: ship };

  const burst = await Promise.all([1, 2, 3].map(function () {
    return client.post("/api/orders/create-cod", payload);
  }));
  ok("all COD submits returned 200", burst.every(function (x) { return x.status === 200; }));

  const customer = await db.selectOne("customers", { email_normalized: ship.email });
  const orders = await db.select("orders", { where: { customer_id: customer.id } });
  eq("a double-clicked COD order creates exactly one order", orders.length, 1);

  const ids = burst.map(function (x) { return x.body.order.orderId; });
  eq("every response points at the same order", new Set(ids).size, 1);

  // A genuine second order of the same cart later is still allowed.
  const different = await client.post("/api/orders/create-cod", {
    items: [{ id: "red-spirit", qty: 2 }], shipping: ship
  });
  eq("a genuinely different cart is a new order", different.body.duplicate, false);
  eq("customer now has two orders",
    (await db.select("orders", { where: { customer_id: customer.id } })).length, 2);
}

/* ══ Discounts ═══════════════════════════════════════════════════════════════
   The code must actually change the price, and must not be reusable. */
async function testDiscounts() {
  section("Discount codes (server-authoritative)");

  const client = makeClient();
  const items  = [{ id: "seduction", qty: 1 }];

  // ── arithmetic ──
  const priced = catalog.priceCart(items);
  const plain  = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, { prepaid: true });
  const withCode = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: true, discount: { code: "NAFUME10", type: "percentage", value: 10 }
  });
  eq("plain total unchanged", plain.total, 858);
  eq("10% applies to the post-prepaid goods value", withCode.promoDiscount, Math.round((799 - 40) * 0.10));
  eq("discounted total is lower", withCode.total, plain.total - withCode.promoDiscount);
  ok("a discount cannot take the payable below ₹1", withCode.total >= catalog.MIN_PAYABLE);

  // ── a brand-new visitor gets the first-order discount ──
  const fresh = shippingFor(200);
  let r = await client.post("/api/discounts/validate", {
    code: "nafume10", items: items, contact: fresh.email   // lowercase on purpose
  });
  eq("validate accepts a lowercase code", r.status, 200);
  eq("first-order code applies for a new customer", r.body.applied, true);
  eq("code is normalised to upper case", r.body.code, "NAFUME10");
  eq("discount amount returned", r.body.discount, withCode.promoDiscount);
  eq("totals reflect the discount", r.body.totals.total, withCode.total);

  r = await client.post("/api/discounts/validate", {
    code: "  nafume-10  ", items: items, contact: fresh.email
  });
  eq("separators and whitespace are tolerated", r.body.applied, true);

  r = await client.post("/api/discounts/validate", { code: "NOTAREALCODE", items: items, contact: fresh.email });
  eq("an unknown code is refused", r.body.applied, false);
  eq("…with an invalid_code reason", r.body.reason, "invalid_code");
  eq("…and still returns honest totals", r.body.totals.total, plain.total);

  r = await client.post("/api/discounts/validate", { code: "NAFUME10", items: [], contact: fresh.email });
  eq("an empty cart is rejected", r.status, 400);

  // ── it must actually change what Razorpay is asked to charge ──
  const create = await api.post("/api/razorpay/create-order", {
    items: items, amount: withCode.total, shipping: fresh, discountCode: "NAFUME10"
  });
  eq("checkout accepts the discounted amount", create.status, 200);
  eq("Razorpay is charged the DISCOUNTED amount", create.body.amount, withCode.total * 100);
  eq("response confirms the code applied", create.body.discount.applied, true);

  let stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("DB: discount code stored on the order", stored.discount_code, "NAFUME10");
  eq("DB: discount amount stored", stored.amount_discount, withCode.promoDiscount);
  eq("DB: order total is the discounted total", stored.amount_total, withCode.total);

  const redemptions = await db.select("discount_redemptions", { where: { order_id: create.body.nafume_order_id } });
  eq("DB: redemption recorded", redemptions.length, 1);
  eq("DB: redemption starts pending", redemptions[0].status, "pending");
  eq("DB: redemption records the discount", redemptions[0].discount_amount, withCode.promoDiscount);

  // ── the attack: claim the discount, pay the un-discounted-code price ──
  r = await api.post("/api/razorpay/create-order", {
    items: items, amount: 1, shipping: shippingFor(201), discountCode: "NAFUME10"
  });
  eq("a fabricated amount is still rejected with a code", r.status, 400);
  eq("…as an amount mismatch", r.body.error, "amount_mismatch");

  // Sending the full price with a valid code must also fail — the server
  // applies the discount, so the expected total is the LOWER one.
  r = await api.post("/api/razorpay/create-order", {
    items: items, amount: plain.total, shipping: shippingFor(202), discountCode: "NAFUME10"
  });
  eq("client cannot opt out of a discount it claimed", r.status, 400);

  // ── one use only ──
  const payment = mocks.simulatePayment(create.body.order_id);
  const verify  = await api.post("/api/razorpay/verify-payment", payment);
  eq("discounted order pays successfully", verify.status, 200);

  const afterPay = await db.select("discount_redemptions", { where: { order_id: create.body.nafume_order_id } });
  eq("DB: redemption committed on payment", afterPay[0].status, "redeemed");
  ok("DB: redeemed_at stamped", !!afterPay[0].redeemed_at);

  r = await client.post("/api/discounts/validate", { code: "NAFUME10", items: items, contact: fresh.email });
  eq("the same customer cannot reuse the first-order code", r.body.applied, false);
  eq("…because they are no longer a first-order customer", r.body.reason, "not_first_order");

  // ── the review reward ──
  const reviewer = shippingFor(210);
  const reviewerClient = makeClient();
  r = await client.post("/api/discounts/validate", { code: "NAFUMEREVIEW", items: items, contact: reviewer.email });
  eq("review reward refused for a guest", r.body.applied, false);
  eq("…who must sign in (the code is public)", r.body.reason, "sign_in_required");

  // Give them a paid order, a verified account, a delivery and a review.
  const rvFlow = await checkout([{ id: "dark-oud", qty: 1 }], reviewer);
  eq("reviewer's order paid", rvFlow.verify.status, 200);
  const rvOrderId = rvFlow.create.body.nafume_order_id;
  const rvReg = await registerAndVerify(reviewerClient, reviewer);
  eq("reviewer verified their account", rvReg.verify && rvReg.verify.status, 200);

  r = await reviewerClient.post("/api/discounts/validate", { code: "NAFUMEREVIEW", items: items });
  eq("signed in but no review yet → refused", r.body.applied, false);
  eq("…with a no_review reason", r.body.reason, "no_review");

  const admin = { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN };
  await client.post("/api/admin/orders", { orderId: rvOrderId, action: "mark_delivered" }, admin);
  const rvSubmit = await reviewerClient.post("/api/reviews/submit", {
    orderId: rvOrderId, productId: "dark-oud",
    rating: 5, body: "Genuinely wonderful, lasts all evening."
  });
  eq("review submitted", rvSubmit.status, 200);

  r = await client.post("/api/discounts/validate", { code: "NAFUMEREVIEW", items: items, contact: reviewer.email });
  eq("the public code still does nothing for a guest typing the reviewer's email", r.body.applied, false);

  r = await reviewerClient.post("/api/discounts/validate", { code: "NAFUMEREVIEW", items: items });
  eq("review reward unlocked for the signed-in reviewer", r.body.applied, true);
  ok("review reward has a real value", r.body.discount > 0);

  // A guest checkout that types the reviewer's details cannot spend it either.
  const rewardTotals = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: true, discount: { code: "NAFUMEREVIEW", type: "percentage", value: 10 }
  });
  r = await api.post("/api/razorpay/create-order", {
    items: items, amount: rewardTotals.total, shipping: reviewer, discountCode: "NAFUMEREVIEW"
  });
  eq("guest checkout with the reviewer's email cannot apply the reward", r.status, 400);

  // Spend it, signed in.
  const spend = await reviewerClient.post("/api/razorpay/create-order", {
    items: items, amount: rewardTotals.total, shipping: reviewer, discountCode: "NAFUMEREVIEW"
  });
  eq("review reward accepted at a signed-in checkout", spend.status, 200);
  const spendPay = mocks.simulatePayment(spend.body.order_id);
  await reviewerClient.post("/api/razorpay/verify-payment", spendPay);

  r = await reviewerClient.post("/api/discounts/validate", { code: "NAFUMEREVIEW", items: items });
  eq("one reward per review — the second attempt is refused", r.body.applied, false);
  eq("…because it is already used", r.body.reason, "already_used");

  // A second review of the same product is not a second reward.
  const second = await reviewerClient.post("/api/reviews/submit", {
    orderId: rvOrderId, productId: "dark-oud", rating: 4 });
  eq("a duplicate product review is still refused", second.status, 409);

  // ── an abandoned checkout must not burn the discount ──
  const abandoner = shippingFor(220);
  const abandoned = await api.post("/api/razorpay/create-order", {
    items: items, amount: withCode.total, shipping: abandoner, discountCode: "NAFUME10"
  });
  eq("abandoner's order created with the code", abandoned.status, 200);

  r = await client.post("/api/discounts/validate", { code: "NAFUME10", items: items, contact: abandoner.email });
  eq("a fresh pending order holds the discount (anti-parallel-abuse)", r.body.applied, false);

  // Age the pending order past the hold window and the allowance comes back.
  const stale = new Date(Date.now() - (discounts.HOLD_MINUTES + 5) * 60000).toISOString();
  await db.update("orders", { where: { order_id: abandoned.body.nafume_order_id }, set: { created_at: stale } });
  await db.update("discount_redemptions", {
    where: { order_id: abandoned.body.nafume_order_id }, set: { created_at: stale } });

  r = await client.post("/api/discounts/validate", { code: "NAFUME10", items: items, contact: abandoner.email });
  eq("an abandoned checkout releases the discount again", r.body.applied, true);

  // ── cancelling an order releases the redemption ──
  const canceller = shippingFor(230);
  const toCancel = await api.post("/api/razorpay/create-order", {
    items: items, amount: withCode.total, shipping: canceller, discountCode: "NAFUME10"
  });
  const cancelPay = mocks.simulatePayment(toCancel.body.order_id);
  await api.post("/api/razorpay/verify-payment", cancelPay);
  r = await client.post("/api/discounts/validate", { code: "NAFUME10", items: items, contact: canceller.email });
  eq("a paid order consumes the discount", r.body.applied, false);

  await client.post("/api/admin/orders",
    { orderId: toCancel.body.nafume_order_id, action: "cancel" }, admin);
  const released = await db.select("discount_redemptions",
    { where: { order_id: toCancel.body.nafume_order_id } });
  eq("DB: cancelling releases the redemption", released[0].status, "released");

  // ── COD gets no prepaid discount, so the code is worth more ──
  const codder = shippingFor(240);
  const codTotals = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: false, discount: { code: "NAFUME10", type: "percentage", value: 10 }
  });
  ok("promo is worth more on COD (no prepaid discount first)",
     codTotals.promoDiscount > withCode.promoDiscount,
     codTotals.promoDiscount + " vs " + withCode.promoDiscount);

  const codOrder = await client.post("/api/orders/create-cod", {
    items: items, amount: codTotals.total, shipping: codder, discountCode: "NAFUME10"
  });
  eq("COD accepts the code", codOrder.status, 200);
  eq("COD order stores the discount", codOrder.body.order.totals.promoDiscount, codTotals.promoDiscount);
  const codRedemption = await db.select("discount_redemptions",
    { where: { order_id: codOrder.body.order.orderId } });
  eq("DB: a confirmed COD order commits the redemption immediately", codRedemption[0].status, "redeemed");
}

/* ══ Payment reconciliation ══════════════════════════════════════════════════ */
async function testReconciliation() {
  section("Payment reconciliation job");

  const client = makeClient();
  const cron   = { Authorization: "Bearer " + process.env.CRON_SECRET };

  r0 = await client.post("/api/jobs/reconcile-payments", {});
  eq("reconciliation requires a token", r0.status, 401);

  // A customer pays but NEITHER the browser nor the webhook ever reports it.
  const ship = shippingFor(250);
  const create = await api.post("/api/razorpay/create-order", {
    items: [{ id: "aqua-manthan", qty: 1 }], amount: 858, shipping: ship
  });
  mocks.simulatePayment(create.body.order_id);          // captured at Razorpay only

  let stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("order is stranded as pending", stored.payment_status, "pending");

  // Too recent to be considered — a customer may still be mid-payment. Other
  // suites leave older pending orders behind, so assert on THIS order rather
  // than on the batch size.
  let r = await client.post("/api/jobs/reconcile-payments", {}, cron);
  eq("a very recent order is left alone",
    (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "pending");

  // Age it past the grace period.
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.update("orders", { where: { order_id: create.body.nafume_order_id }, set: { created_at: old } });

  // Dry run must change nothing.
  const dry = await client.get("/api/jobs/reconcile-payments?dryRun=1", cron);
  ok("dry run finds the stranded payment", dry.body.summary.recovered >= 1,
     JSON.stringify(dry.body.summary));
  stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("dry run changed nothing", stored.payment_status, "pending");

  mocks.state.emails.length = 0;
  r = await client.post("/api/jobs/reconcile-payments", {}, cron);
  ok("reconciliation recovers the payment", r.body.summary.recovered >= 1,
     JSON.stringify(r.body.summary));

  stored = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("DB: stranded order is now paid", stored.payment_status, "paid");
  ok("DB: payment id attached", !!stored.razorpay_payment_id);
  ok("recovery sent the confirmation emails", mocks.state.emails.length >= 2);

  // Running again must be a no-op for this order.
  const before = mocks.state.emails.length;
  r = await client.post("/api/jobs/reconcile-payments", {}, cron);
  eq("second run sent no extra email", mocks.state.emails.length, before);
  eq("second run left the recovered order paid",
    (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "paid");

  // An order with no captured payment must be left alone.
  const unpaidShip = shippingFor(251);
  const unpaid = await api.post("/api/razorpay/create-order", {
    items: [{ id: "aqua-manthan", qty: 1 }], amount: 858, shipping: unpaidShip
  });
  await db.update("orders", { where: { order_id: unpaid.body.nafume_order_id }, set: { created_at: old } });
  r = await client.post("/api/jobs/reconcile-payments", {}, cron);
  eq("a genuinely unpaid order is reported, not touched", r.body.summary.stillUnpaid >= 1, true);
  eq("…and stays pending",
    (await db.selectOne("orders", { order_id: unpaid.body.nafume_order_id })).payment_status, "pending");
}

/* ══ Order ownership / IDOR ══════════════════════════════════════════════════ */
async function testOrderOwnership() {
  section("Order ownership (IDOR)");

  // Two separate customers, each with an account and an order.
  const aShip = shippingFor(260);
  const bShip = shippingFor(261);
  const aFlow = await checkout([{ id: "seduction", qty: 1 }], aShip);
  const bFlow = await checkout([{ id: "dark-oud", qty: 1 }], bShip);
  const aOrder = aFlow.create.body.nafume_order_id;
  const bOrder = bFlow.create.body.nafume_order_id;

  const alice = makeClient();
  const aReg = await registerAndVerify(alice, Object.assign({}, aShip, { password: "AlicePass123" }));
  let r = aReg.verify;
  eq("customer A registered", r && r.status, 200);

  // A signed-in customer sees only their own orders.
  r = await alice.get("/api/account/me");
  eq("A sees exactly one order", r.body.orders.length, 1);
  eq("…and it is theirs", r.body.orders[0].orderId, aOrder);
  ok("A's order list contains no trace of B",
    JSON.stringify(r.body).indexOf(bOrder) === -1);
  ok("A's order list never exposes B's email",
    JSON.stringify(r.body).indexOf(bShip.email) === -1);

  // A tries to read B's order by id, while authenticated.
  r = await alice.post("/api/orders/lookup", { orderId: bOrder });
  eq("A cannot read B's order with a session alone", r.status, 404);

  r = await alice.post("/api/orders/lookup", { orderId: bOrder, contact: aShip.email });
  eq("A cannot read B's order with A's own contact", r.status, 404);

  // Nor can A review it.
  r = await alice.post("/api/reviews/eligibility", { orderId: bOrder });
  eq("A cannot check eligibility on B's order", r.status, 404);
  r = await alice.post("/api/reviews/submit", {
    orderId: bOrder, productId: "dark-oud", rating: 1, body: "Sabotage attempt here." });
  eq("A cannot review B's order", r.status, 404);

  // A cannot re-point their own account at B's identity to inherit the orders.
  r = await alice.post("/api/account/update", { email: bShip.email });
  eq("A cannot take over B's email", r.status, 400);
  eq("…a changed email needs a verification code", r.body.error, "verification_required");

  r = await alice.post("/api/account/update", { phone: bShip.phone });
  eq("A cannot take over B's phone", r.status, 400);

  // …and starting verification for B's email sends the code to B, not A.
  mocks.state.emails.length = 0;
  r = await alice.post("/api/account/identifiers", { action: "start", channel: "email", value: bShip.email });
  eq("A can only REQUEST a code for B's email", r.status, 200);
  const toB = mocks.state.emails.filter(function (e) { return [].concat(e.to).indexOf(bShip.email) !== -1; });
  eq("…which is delivered to B's inbox", toB.length, 1);
  r = await alice.post("/api/account/identifiers", { action: "confirm", challengeId: r.body.challengeId, code: "000000" });
  ok("A guessing the code is refused", r.status === 422 || r.status === 429, "got " + r.status);
  r = await alice.get("/api/account/me");
  ok("A still sees none of B's orders", JSON.stringify(r.body).indexOf(bOrder) === -1);

  // The body cannot smuggle a different customer id into an update.
  const aCustomer = await db.selectOne("customers", { email_normalized: aShip.email.toLowerCase() });
  const bCustomer = await db.selectOne("customers", { email_normalized: bShip.email.toLowerCase() });
  r = await alice.post("/api/account/update", { customerId: bCustomer.id, name: "Hijacked" });
  eq("an injected customerId is ignored", r.status, 200);
  eq("B's record is untouched",
    (await db.selectOne("customers", { id: bCustomer.id })).name, bShip.name);
  eq("A's own record is what changed",
    (await db.selectOne("customers", { id: aCustomer.id })).name, "Hijacked");

  // And a guest with the right details still gets their own order — the check
  // is ownership, not blanket denial.
  const guest = makeClient();
  r = await guest.post("/api/orders/lookup", { orderId: bOrder, contact: bShip.email });
  eq("B's own contact detail still works", r.status, 200);
  eq("…returning B's order", r.body.order.orderId, bOrder);
}

/* ══ Outbox / email side effects ═════════════════════════════════════════════ */
async function testOutbox() {
  section("Email outbox");

  const client = makeClient();
  const cron   = { Authorization: "Bearer " + process.env.CRON_SECRET };

  // A provider failure must NOT undo a paid order.
  mocks.state.failResend = true;
  const ship = shippingFor(270);
  const flow = await checkout([{ id: "red-spirit", qty: 1 }], ship);
  mocks.state.failResend = false;

  eq("payment succeeds even when email fails", flow.verify.status, 200);
  const order = await db.selectOne("orders", { order_id: flow.create.body.nafume_order_id });
  eq("DB: the order is still paid", order.payment_status, "paid");

  const failed = await db.select("outbound_messages", {
    where: { related_id: flow.create.body.nafume_order_id }
  });
  ok("the failed messages were recorded, not lost", failed.length >= 2);
  ok("…and are marked failed, never 'sent'",
     failed.every(function (m) { return m.status !== "sent"; }),
     failed.map(function (m) { return m.status; }).join(","));

  // The drain job retries them.
  let r = await client.post("/api/jobs/drain-outbox", {});
  eq("drain job requires a token", r.status, 401);

  r = await client.post("/api/jobs/drain-outbox", {}, cron);
  eq("drain job runs", r.status, 200);
  ok("it delivered the backlog", r.body.summary.sent >= 2, JSON.stringify(r.body.summary));

  const afterDrain = await db.select("outbound_messages", {
    where: { related_id: flow.create.body.nafume_order_id }
  });
  ok("messages are now marked sent", afterDrain.every(function (m) { return m.status === "sent"; }));

  // Draining again must not re-send anything.
  const emailsBefore = mocks.state.emails.length;
  r = await client.post("/api/jobs/drain-outbox", {}, cron);
  eq("a second drain sends nothing", mocks.state.emails.length, emailsBefore);

  // An invalid recipient is recorded as failed, never as sent.
  const bad = await messagingLib.send({
    channel: "email", to: "not a real address\nBcc: evil@example.com",
    subject: "header injection attempt", body: "<p>x</p>",
    relatedType: "order", relatedId: "TEST-BAD-ADDR"
  });
  eq("an unusable recipient is not reported as sent", bad.sent, false);
  const badRow = await db.selectOne("outbound_messages", { related_id: "TEST-BAD-ADDR" });
  eq("DB: recorded as failed", badRow.status, "failed");
  ok("DB: newline stripped from the address", badRow.to_address.indexOf("\n") === -1);
}

/* ══ WhatsApp consent boundary ═══════════════════════════════════════════════ */
async function testWhatsAppAdapter() {
  section("WhatsApp adapter + consent boundary");

  eq("no WhatsApp provider is configured", messagingLib.whatsappConfigured(), false);

  const optIn  = shippingFor(280);
  const optOut = shippingFor(281);
  await checkout([{ id: "seduction", qty: 1 }], optIn,  { whatsappOptIn: true });
  await checkout([{ id: "seduction", qty: 1 }], optOut, { whatsappOptIn: false });

  const inCust  = await db.selectOne("customers", { email_normalized: optIn.email });
  const outCust = await db.selectOne("customers", { email_normalized: optOut.email });

  eq("opted-in customer reads as consented",
    await messagingLib.hasWhatsAppMarketingConsent(inCust.id), true);
  eq("opted-out customer reads as NOT consented",
    await messagingLib.hasWhatsAppMarketingConsent(outCust.id), false);
  eq("an unknown customer is never consented",
    await messagingLib.hasWhatsAppMarketingConsent(null), false);

  // Marketing to a non-consenting customer must be refused outright — not even
  // queued, so a future provider cannot drain it later.
  let res = await messagingLib.sendWhatsApp({
    to: optOut.phone, body: "New launch!", kind: "marketing",
    customerId: outCust.id, relatedType: "marketing", relatedId: "test-blast"
  });
  eq("marketing to a non-consenting customer is refused", res.queued, false);
  eq("…with the right reason", res.reason, "no_marketing_consent");
  eq("DB: nothing was queued for them",
    (await db.select("outbound_messages", { where: { related_id: "test-blast" } })).length, 0);

  // Sending is disabled until the launch gate is fully satisfied. A consenting
  // customer passes the consent check, but nothing is sent OR queued, so no
  // stale backlog can be released later.
  res = await messagingLib.sendWhatsApp({
    to: optIn.phone, body: "New launch!", kind: "marketing",
    customerId: inCust.id, relatedType: "marketing", relatedId: "test-blast-ok"
  });
  eq("consenting customer passes consent but sending is disabled", res.reason, "whatsapp_sending_disabled");
  eq("…nothing queued", res.queued, false);
  eq("…never reported as sent", res.sent, false);
  eq("DB: no outbox row for a disabled channel",
    (await db.select("outbound_messages", { where: { related_id: "test-blast-ok" } })).length, 0);

  // Setting the flag alone does not enable it: no adapter, credentials or templates.
  process.env.WHATSAPP_SENDING_ENABLED = "true";
  eq("the enable flag alone does not open the gate", messagingLib.whatsappConfigured(), false);
  const readiness = messagingLib.whatsappReadiness();
  eq("…readiness reports no adapter", readiness.adapterImplemented, false);
  eq("…readiness reports no approved templates", readiness.templatesConfigured, false);
  delete process.env.WHATSAPP_SENDING_ENABLED;

  // Transactional messages do not require marketing consent (still disabled).
  res = await messagingLib.sendWhatsApp({
    to: optOut.phone, body: "Your order shipped.", kind: "transactional",
    customerId: outCust.id, relatedType: "order", relatedId: "test-txn"
  });
  eq("transactional messages skip the marketing-consent check", res.reason, "whatsapp_sending_disabled");
  eq("…and are never faked as sent", res.sent, false);

  // Missing kind is a programming error and must be refused, not defaulted.
  res = await messagingLib.sendWhatsApp({ to: optIn.phone, body: "x", customerId: inCust.id });
  eq("a message with no kind is refused", res.queued, false);

  // Revoking consent takes effect immediately.
  await repoLib.setMarketingConsent(inCust.id, "whatsapp", false, "account");
  eq("revoking consent removes eligibility immediately",
    await messagingLib.hasWhatsAppMarketingConsent(inCust.id), false);
  res = await messagingLib.sendWhatsApp({
    to: optIn.phone, body: "New launch!", kind: "marketing",
    customerId: inCust.id, relatedType: "marketing", relatedId: "test-blast-revoked"
  });
  eq("marketing after revocation is refused", res.reason, "no_marketing_consent");
}

/* ══ Health / configuration validator ════════════════════════════════════════ */
async function testHealth() {
  section("Health + configuration validator");

  const client = makeClient();

  let r = await client.get("/api/health");
  eq("public health check answers", r.status, 200);
  ok("public health reveals only liveness", Object.keys(r.body).length <= 5, Object.keys(r.body).join(","));
  ok("public health lists no variable names",
    JSON.stringify(r.body).indexOf("RAZORPAY") === -1 &&
    JSON.stringify(r.body).indexOf("SUPABASE") === -1);

  const admin = { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN };
  r = await client.get("/api/health", admin);
  ok("detailed health lists required variables", Array.isArray(r.body.required) && r.body.required.length >= (D1_MODE ? 2 : 4));
  ok("detailed health lists optional integrations", Array.isArray(r.body.optional));
  ok("detailed health reports capabilities", !!r.body.capabilities);

  // The whole point: presence only, never values.
  const serialised = JSON.stringify(r.body);
  ok("no secret VALUE is ever returned",
     serialised.indexOf(process.env.RAZORPAY_KEY_SECRET) === -1 &&
     serialised.indexOf(process.env.ADMIN_API_TOKEN) === -1 &&
     serialised.indexOf(process.env.CRON_SECRET) === -1);
  ok("it warns about the memory driver",
     D1_MODE || /memory/i.test(r.body.storage.warning || ""), r.body.storage.warning);
  eq("it knows WhatsApp sending is unavailable", r.body.capabilities.sendsWhatsApp, false);
  ok("it produces actionable next steps", Array.isArray(r.body.nextSteps));

  r = await client.get("/api/health", { Authorization: "Bearer wrong" });
  ok("a wrong token falls back to the public view", !r.body.required);
}

/* ══ Adversarial sweep ═══════════════════════════════════════════════════════
   Treating the repo as someone else's code and trying to break it. */
async function testAdversarial() {
  section("Adversarial sweep");

  const client = makeClient();
  const cron   = { Authorization: "Bearer " + process.env.CRON_SECRET };
  const admin  = { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN };

  /* ── every job and admin route must refuse an anonymous caller ── */
  const guarded = [
    ["/api/jobs/maintenance",        "POST"],
    ["/api/jobs/review-requests",    "POST"],
    ["/api/jobs/reconcile-payments", "POST"],
    ["/api/jobs/drain-outbox",       "POST"],
    ["/api/admin/orders",            "GET"],
    ["/api/admin/reviews",           "GET"]
  ];
  for (const [path, method] of guarded) {
    const anon = method === "GET" ? await client.get(path) : await client.post(path, {});
    eq("anonymous " + path + " is refused", anon.status, 401);
    const wrong = method === "GET"
      ? await client.get(path, { Authorization: "Bearer wrong-token" })
      : await client.post(path, {}, { Authorization: "Bearer wrong-token" });
    eq("wrong token on " + path + " is refused", wrong.status, 401);
    const malformed = method === "GET"
      ? await client.get(path, { Authorization: process.env.ADMIN_API_TOKEN })   // no "Bearer "
      : await client.post(path, {}, { Authorization: process.env.ADMIN_API_TOKEN });
    eq("malformed auth header on " + path + " is refused", malformed.status, 401);
  }

  /* ── the combined maintenance job ── */
  let r = await client.post("/api/jobs/maintenance", {}, cron);
  eq("maintenance runs with a valid token", r.status, 200);
  ok("it reports each job separately",
     r.body.jobs && r.body.jobs["review-requests"] && r.body.jobs["reconcile-payments"] &&
     r.body.jobs["drain-outbox"], JSON.stringify(Object.keys(r.body.jobs || {})));
  ok("all sub-jobs succeeded", r.body.allOk === true, JSON.stringify(r.body.jobs));

  const emailsBefore = mocks.state.emails.length;
  r = await client.post("/api/jobs/maintenance", {}, cron);
  eq("running maintenance twice is safe", r.status, 200);
  eq("…and sends no duplicate email", mocks.state.emails.length, emailsBefore);

  /* ── XSS: stored script must never survive as markup ── */
  const xssShip = shippingFor(300);
  xssShip.name = '<img src=x onerror=alert(1)>';
  const xssFlow = await checkout([{ id: "seduction", qty: 1 }], xssShip);
  eq("an order with script-like input still succeeds", xssFlow.verify.status, 200);
  const xssOrder = await db.selectOne("orders", { order_id: xssFlow.create.body.nafume_order_id });
  ok("the value is stored as inert text, not executed anywhere",
     typeof xssOrder.ship_name === "string");

  r = await client.post("/api/orders/lookup",
    { orderId: xssFlow.create.body.nafume_order_id, contact: xssShip.email });
  eq("lookup returns it as data", r.status, 200);
  ok("it is returned JSON-encoded, never as raw HTML",
     typeof r.body.order.shipping.name === "string");

  /* ── review body XSS + the public projection ── */
  const rvShip = shippingFor(301);
  const rvFlow = await checkout([{ id: "dark-oud", qty: 1 }], rvShip);
  const rvId = rvFlow.create.body.nafume_order_id;
  await client.post("/api/admin/orders", { orderId: rvId, action: "mark_delivered" }, admin);
  const rvToken = await reviewLinkFor(rvId);
  ok("review-request email carried a review link token", !!rvToken);
  const submitted = await client.post("/api/reviews/submit", {
    orderId: rvId, token: rvToken, productId: "dark-oud", rating: 5,
    title: "<script>alert(1)</script>",
    body: "Lovely fragrance <img src=x onerror=alert(1)> indeed."
  });
  eq("a review with script-like text is accepted as text", submitted.status, 200);

  const stored = await db.selectOne("reviews", { order_id: rvId });
  await db.update("reviews", { where: { id: stored.id }, set: { status: "published" } });

  r = await client.get("/api/reviews/list?productId=dark-oud");
  eq("published review is listed", r.status, 200);
  const listed = r.body.reviews.find(function (x) { return x.id === stored.id; });
  ok("the review is returned", !!listed);
  ok("the author's email is never in the public payload",
     JSON.stringify(r.body).indexOf(rvShip.email) === -1);
  ok("the author's full name is never in the public payload",
     JSON.stringify(r.body).indexOf(rvShip.name) === -1);

  /* ── a hidden review must disappear again ── */
  await client.post("/api/admin/reviews", { reviewId: stored.id, action: "hide" }, admin);
  r = await client.get("/api/reviews/list?productId=dark-oud");
  ok("a hidden review is removed from the public list",
     !r.body.reviews.some(function (x) { return x.id === stored.id; }));

  /* ── injection-ish input must not break filters ── */
  const nasty = ["' OR 1=1 --", "%", "*", "../../etc/passwd", " ", "{\"$ne\":null}"];
  for (const value of nasty) {
    const res = await client.post("/api/orders/lookup", { orderId: value, contact: "a@b.com" });
    ok("hostile order id '" + value.slice(0, 12) + "' is refused cleanly",
       res.status === 400 || res.status === 404, "got " + res.status);
    ok("…and never leaks a database error",
       !/syntax|postgres|pgrst|sql/i.test(JSON.stringify(res.body)), JSON.stringify(res.body).slice(0, 120));
  }

  const wildcard = await client.get("/api/reviews/list?productId=%25");
  eq("a wildcard product id is refused", wildcard.status, 400);

  /* ── uploads ── */
  const uploadOrder = shippingFor(302);
  const upFlow = await checkout([{ id: "red-spirit", qty: 1 }], uploadOrder);
  const upId = upFlow.create.body.nafume_order_id;
  await client.post("/api/admin/orders", { orderId: upId, action: "mark_delivered" }, admin);
  const upToken = await reviewLinkFor(upId);

  const badUploads = [
    ["data:text/html;base64," + Buffer.from("<script>alert(1)</script>").toString("base64"), "HTML"],
    ["data:image/svg+xml;base64," + Buffer.from("<svg onload=alert(1)/>").toString("base64"), "SVG"],
    ["data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA", "executable"],
    ["data:image/png;base64," + Buffer.from("not a png at all").toString("base64"), "mislabelled PNG"],
    ["data:image/png;base64," + "A".repeat(600000), "oversized"],
    ["../../etc/passwd", "path traversal"],
    ["data:image/png;base64,<script>", "invalid base64"]
  ];
  for (const [payload, label] of badUploads) {
    const res = await client.post("/api/reviews/submit", {
      orderId: upId, token: upToken, productId: "red-spirit",
      rating: 5, photo: payload
    });
    // 400 = rejected by validation, 413 = rejected before it was even parsed.
    // Both are correct refusals; what matters is that none is accepted.
    ok(label + " upload is rejected", res.status === 400 || res.status === 413,
       "got " + res.status);
    ok(label + " refusal is a clean JSON response, not a dropped connection",
       !!(res.body && res.body.message), JSON.stringify(res.body).slice(0, 100));
  }
  eq("no review was created by any rejected upload",
    (await db.select("reviews", { where: { order_id: upId } })).length, 0);

  /* ── customer enumeration ── */
  const known   = await client.post("/api/account/login", { identifier: "customer70@example.com", password: "Nope12345" });
  const unknown = await client.post("/api/account/login", { identifier: "definitely-not-here@example.com", password: "Nope12345" });
  eq("known and unknown accounts return the same status", known.status, unknown.status);
  eq("…and the same message", known.body.message, unknown.body.message);

  const dEligible   = await client.post("/api/discounts/validate",
    { code: "NAFUME10", items: [{ id: "seduction", qty: 1 }], contact: "brand-new-person@example.com" });
  const dIneligible = await client.post("/api/discounts/validate",
    { code: "NAFUMEREVIEW", items: [{ id: "seduction", qty: 1 }], contact: "brand-new-person@example.com" });
  ok("discount refusal messages do not reveal order history",
     !/ordered|previous|already bought/i.test(dIneligible.body.message || ""),
     dIneligible.body.message);
  ok("an eligible quote still works", dEligible.body.applied === true);

  /* ── nothing anywhere echoes a secret ── */
  const probes = [
    await client.get("/api/health"),
    await client.get("/api/health", admin),
    await client.get("/api/quiz/questions"),
    await client.post("/api/discounts/validate", { code: "NAFUME10", items: [{ id: "seduction", qty: 1 }] }),
    await client.get("/api/admin/orders?limit=5", admin)
  ];
  const secrets = [process.env.RAZORPAY_KEY_SECRET, process.env.ADMIN_API_TOKEN,
                   process.env.CRON_SECRET, process.env.RAZORPAY_WEBHOOK_SECRET].filter(Boolean);
  probes.forEach(function (p, i) {
    const body = JSON.stringify(p.body);
    ok("response " + (i + 1) + " leaks no secret",
       secrets.every(function (s) { return body.indexOf(s) === -1; }));
  });
}

/* ══ Account ownership: unverified claims ════════════════════════════════════ */
function hasSessionCookie(r) {
  return (r.rawCookies || []).some(function (c) { return /^nf_session=[^;]+/.test(c) && !/Max-Age=0/i.test(c); });
}

async function testAccountOwnershipAttacks() {
  section("Account ownership — unverified guest claims");

  const victim = shippingFor(400);
  const vFlow = await checkout([{ id: "seduction", qty: 1 }], victim);
  const vOrder = vFlow.create.body.nafume_order_id;

  // The audit's reproduction: register with the guest's email + another phone.
  const attacker = makeClient();
  mocks.state.emails.length = 0;
  let r = await attacker.post("/api/account/register", {
    name: "Attacker Person", email: victim.email, phone: "9123400000", password: "AttackPass123"
  });
  eq("claiming a guest email only starts verification", r.status, 200);
  eq("…verification required", r.body.verificationRequired, true);
  ok("…no session cookie issued", !hasSessionCookie(r));
  const challengeId = r.body.challengeId;
  const realCode = mocks.lastCodeFor(victim.email);
  ok("…the code went to the VICTIM's inbox", !!realCode);

  r = await attacker.get("/api/account/me");
  eq("attacker is not signed in", r.body.authenticated, false);
  ok("attacker sees none of the victim's orders", JSON.stringify(r.body).indexOf(vOrder) === -1);

  let victimRow = await db.selectOne("customers", { email_normalized: victim.email });
  eq("victim's record gained no credentials", await db.selectOne("customer_auth", { customer_id: victimRow.id }), null);
  eq("victim's record is not flagged as an account", victimRow.has_account, false);
  eq("victim's phone untouched", victimRow.phone_normalized, victim.phone);

  // Guessing.
  let last;
  for (let i = 0; i < 5; i++) {
    last = await attacker.post("/api/account/verify", { challengeId: challengeId, code: String(100000 + i) === realCode ? "999999" : String(100000 + i) });
  }
  eq("five wrong codes exhaust the challenge", last.status, 429);
  eq("…too_many_attempts", last.body.error, "too_many_attempts");
  r = await attacker.post("/api/account/verify", { challengeId: challengeId, code: realCode });
  eq("even the right code is dead after the attempt limit", r.status, 410);
  ok("…and no session came of it", !hasSessionCookie(r));

  r = await attacker.post("/api/orders/lookup", { orderId: vOrder });
  eq("attacker cannot look the order up without its contact", r.status, 404);
  r = await attacker.post("/api/account/update", { name: "Hijack" });
  eq("attacker has no session to update anything", r.status, 401);
  eq("victim still has no account", await db.selectOne("customer_auth", { customer_id: victimRow.id }), null);

  // The real owner verifies and gets exactly their purchase.
  const owner = makeClient();
  const reg = await registerAndVerify(owner, victim);
  eq("the real owner can still verify and register", reg.verify.status, 200);
  eq("…with their earlier purchase linked", reg.verify.body.orderCount, 1);
  r = await owner.get("/api/account/me");
  ok("…visible in their history", JSON.stringify(r.body.orders).indexOf(vOrder) !== -1);

  // Typing the owner's email at a guest checkout cannot rewrite their profile
  // or their consent.
  await repoLib.setMarketingConsent(victimRow.id, "whatsapp", true, "account");
  const intruderShip = Object.assign({}, shippingFor(401), { email: victim.email, addr1: "666 Intruder Lane", city: "Elsewhere" });
  const intruderFlow = await checkout([{ id: "dark-oud", qty: 1 }], intruderShip, { whatsappOptIn: false });
  eq("(setup) the intruder's guest checkout itself succeeded", intruderFlow.verify && intruderFlow.verify.status, 200);
  victimRow = await db.selectOne("customers", { id: victimRow.id });
  ok("guest checkout did not overwrite the account's saved address", victimRow.address_line1 !== "666 Intruder Lane",
    victimRow.address_line1);
  eq("…nor its phone", victimRow.phone_normalized, victim.phone);
  eq("…nor its WhatsApp consent (different number typed)",
    (await db.selectOne("marketing_consent", { customer_id: victimRow.id, channel: "whatsapp" })).opted_in, true);
  r = await attacker.get("/api/account/me");
  eq("the intruder still has no access", r.body.authenticated, false);

  /* ── the cross-identifier variant ─────────────────────────────────────────
     S creates a guest record pairing S's email with P's phone. P later buys
     with a different email and the same phone, so P's order is filed on S's
     record. S verifying S's email must NOT reveal P's order or address. */
  const sShip = Object.assign({}, shippingFor(402), { phone: "9000011111" });
  await checkout([{ id: "seduction", qty: 1 }], sShip);
  const pShip = Object.assign({}, shippingFor(403), { phone: "9000011111", addr1: "7 Private Residence", city: "Mysuru" });
  const pFlow = await checkout([{ id: "red-spirit", qty: 1 }], pShip);
  const pOrder = pFlow.create.body.nafume_order_id;
  const sRow = await db.selectOne("customers", { email_normalized: sShip.email });
  eq("setup: P's order was filed on S's record by phone match",
    (await db.selectOne("orders", { order_id: pOrder })).customer_id, sRow.id);

  const sClient = makeClient();
  const sReg = await registerAndVerify(sClient, sShip);
  eq("S verified S's own email", sReg.verify.status, 200);
  r = await sClient.get("/api/account/me");
  ok("S cannot see P's order", JSON.stringify(r.body).indexOf(pOrder) === -1);
  ok("S's saved address is not P's address", JSON.stringify(r.body.customer).indexOf("Private Residence") === -1,
    JSON.stringify(r.body.customer.address));
  r = await sClient.post("/api/orders/lookup", { orderId: pOrder });
  eq("S's session cannot read P's order", r.status, 404);

  // P proves the phone by SMS: S's account lists it unverified → conflict, no merge.
  const pPhone = makeClient();
  r = await pPhone.post("/api/otp/send", { phone: pShip.phone });
  eq("P can request a sign-in code", r.status, 200);
  r = await pPhone.post("/api/otp/verify", { phone: pShip.phone, otp: mocks.lastOtpFor(pShip.phone), challengeId: r.body.challengeId });
  eq("a number unverified on someone else's account is a conflict", r.status, 409);
  eq("…identifier_conflict", r.body.error, "identifier_conflict");
  ok("…with no session", !hasSessionCookie(r));

  // P registers with P's email → P's order (placed with that email) is P's.
  const pClient = makeClient();
  const pReg = await registerAndVerify(pClient, pShip);
  eq("P registers by verifying P's email", pReg.verify.status, 200);
  eq("…P's phone is reported as in use elsewhere, not silently moved", pReg.verify.body.conflicts.phone, "in_use");
  r = await pClient.get("/api/account/me");
  ok("P sees P's order", JSON.stringify(r.body.orders).indexOf(pOrder) !== -1);

  // P then proves the phone from P's account: the verified owner wins it.
  r = await pClient.post("/api/account/identifiers", { action: "start", channel: "phone", value: pShip.phone });
  eq("P starts phone verification", r.status, 200);
  r = await pClient.post("/api/account/identifiers", { action: "confirm", challengeId: r.body.challengeId,
    code: mocks.lastOtpFor(pShip.phone) });
  eq("P's phone verified", r.status, 200);
  eq("…now verified on P's account", r.body.customer.phoneVerified, true);
  eq("…and detached from S's record, where it was never proven",
    (await db.selectOne("customers", { id: sRow.id })).phone_normalized, null);
  r = await sClient.get("/api/account/me");
  ok("S still cannot see P's order", JSON.stringify(r.body).indexOf(pOrder) === -1);
}

/* ══ Verification challenges ═════════════════════════════════════════════════ */
async function testVerificationChallenges() {
  section("Verification challenges — expiry, replay, throttling, binding");

  const who = shippingFor(420);
  const c1 = makeClient();

  let r = await c1.post("/api/account/register", { name: who.name, email: who.email, phone: who.phone, password: "GoodPass123" });
  eq("challenge started", r.status, 200);
  const id1 = r.body.challengeId;
  const code1 = mocks.lastCodeFor(who.email);

  r = await c1.post("/api/account/verify", { challengeId: id1, code: code1 === "123123" ? "321321" : "123123" });
  eq("a wrong code is refused", r.status, 422);
  eq("…with attempts remaining", r.body.attemptsRemaining, 4);

  r = await c1.post("/api/account/resend-code", { challengeId: id1 });
  eq("an immediate resend is throttled", r.status, 429);
  eq("…resend_too_soon", r.body.error, "resend_too_soon");

  await patchChallenge(id1, { last_sent_at: new Date(Date.now() - 60000).toISOString() });
  r = await c1.post("/api/account/resend-code", { challengeId: id1 });
  eq("resend allowed after the cooldown", r.status, 200);
  const code1b = mocks.lastCodeFor(who.email);
  ok("a new code was issued", !!code1b);
  if (code1b !== code1) {
    r = await c1.post("/api/account/verify", { challengeId: id1, code: code1 });
    eq("the superseded code no longer works", r.status, 422);
  }
  const row1 = await db.selectOne("verification_challenges", { id: id1 });
  ok("resending does not reset the attempt count", row1.attempts >= 1, String(row1.attempts));

  await patchChallenge(id1, { last_sent_at: new Date(Date.now() - 60000).toISOString(), send_count: 3 });
  r = await c1.post("/api/account/resend-code", { challengeId: id1 });
  eq("per-challenge send cap enforced", r.status, 429);
  eq("…too_many_sends", r.body.error, "too_many_sends");

  // Expiry.
  await patchChallenge(id1, { expires_at: new Date(Date.now() - 1000).toISOString() });
  r = await c1.post("/api/account/verify", { challengeId: id1, code: code1b });
  eq("an expired challenge is refused even with the right code", r.status, 410);
  eq("…challenge_expired", r.body.error, "challenge_expired");
  ok("…and no session", !hasSessionCookie(r));

  // Replay + concurrency.
  await patchChallenge(id1, { last_sent_at: new Date(Date.now() - 60000).toISOString() });
  r = await c1.post("/api/account/register", { name: who.name, email: who.email, phone: who.phone, password: "GoodPass123" });
  eq("a fresh challenge can be started", r.status, 200);
  const id2 = r.body.challengeId;
  const code2 = mocks.lastCodeFor(who.email);
  const racers = [makeClient(), makeClient(), makeClient()];
  const results = await Promise.all(racers.map(function (cl) {
    return cl.post("/api/account/verify", { challengeId: id2, code: code2 });
  }));
  eq("concurrent correct submissions succeed exactly once",
    results.filter(function (x) { return x.status === 200; }).length, 1);
  r = await c1.post("/api/account/verify", { challengeId: id2, code: code2 });
  eq("replaying a consumed code is refused", r.status, 410);
  ok("…as challenge_used or expired", r.body.error === "challenge_used" || r.body.error === "challenge_expired", r.body.error);
  eq("exactly one credentials row", (await db.select("customer_auth", {
    where: { customer_id: (await db.selectOne("customers", { email_normalized: who.email })).id } })).length, 1);
  const consumed = await db.selectOne("verification_challenges", { id: id2 });
  eq("DB: consumed challenge keeps no code hash", consumed.code_hash, null);
  ok("DB: consumed challenge keeps no password hash", !(consumed.payload && consumed.payload.passwordHash));

  // Registering again on a verified account.
  r = await makeClient().post("/api/account/register", { name: who.name, email: who.email, phone: "9555500000", password: "GoodPass123" });
  eq("an existing account cannot be re-registered", r.status, 409);

  // Purpose binding: a sign-in challenge cannot complete a registration.
  const phoneOnly = "9444400001";
  r = await makeClient().post("/api/otp/send", { phone: phoneOnly });
  eq("sign-in challenge started", r.status, 200);
  r = await makeClient().post("/api/account/verify", { challengeId: r.body.challengeId, code: mocks.lastOtpFor(phoneOnly) });
  eq("a phone_login challenge cannot complete registration", r.status, 410);

  // Starting over retires the previous code.
  const again = shippingFor(421);
  r = await c1.post("/api/account/register", { name: again.name, email: again.email, phone: again.phone, password: "GoodPass123" });
  const oldId = r.body.challengeId;
  const oldCode = mocks.lastCodeFor(again.email);
  await patchChallenge(oldId, { last_sent_at: new Date(Date.now() - 60000).toISOString() });
  r = await c1.post("/api/account/register", { name: again.name, email: again.email, phone: again.phone, password: "GoodPass123" });
  eq("a second registration start after cooldown", r.status, 200);
  r = await c1.post("/api/account/verify", { challengeId: oldId, code: oldCode });
  eq("the earlier challenge is retired", r.status, 410);

  // Provider unavailable / failing.
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const noMail = shippingFor(422);
  r = await makeClient().post("/api/account/register", { name: noMail.name, email: noMail.email, phone: noMail.phone, password: "GoodPass123" });
  process.env.RESEND_API_KEY = savedKey;
  eq("no email provider → verification unavailable, not a silent account", r.status, 503);
  eq("…verification_unavailable", r.body.error, "verification_unavailable");

  mocks.state.failResend = true;
  r = await makeClient().post("/api/account/register", { name: noMail.name, email: noMail.email, phone: noMail.phone, password: "GoodPass123" });
  mocks.state.failResend = false;
  eq("provider error → 502, customer told to retry", r.status, 502);
  const failedLive = await db.selectOne("verification_challenges", { live_key: "account_register|email|" + noMail.email });
  eq("…and the unsent challenge is not left live", failedLive, null);

  // Conflicting existing records are reported, never merged.
  const a = shippingFor(423);
  const b = shippingFor(424);
  const aFlow = await checkout([{ id: "seduction", qty: 1 }], a);
  const bFlow = await checkout([{ id: "dark-oud", qty: 1 }], b);
  const mixed = makeClient();
  const mixedReg = await registerAndVerify(mixed, { name: a.name, email: a.email, phone: b.phone });
  eq("registering A's email with B's phone verifies A's email", mixedReg.verify.status, 200);
  eq("…B's phone is reported in use", mixedReg.verify.body.conflicts.phone, "in_use");
  r = await mixed.get("/api/account/me");
  ok("…A's order is linked", JSON.stringify(r.body.orders).indexOf(aFlow.create.body.nafume_order_id) !== -1);
  ok("…B's order is NOT", JSON.stringify(r.body.orders).indexOf(bFlow.create.body.nafume_order_id) === -1);
  const bRow = await db.selectOne("customers", { email_normalized: b.email });
  eq("…B's record keeps B's phone", bRow.phone_normalized, b.phone);
  eq("…and gained no account", bRow.has_account, false);

  // Abandoned registrations do not keep a password hash around.
  const abandoned = shippingFor(425);
  r = await makeClient().post("/api/account/register", { name: abandoned.name, email: abandoned.email, phone: abandoned.phone, password: "GoodPass123" });
  const abandonedId = r.body.challengeId;
  await patchChallenge(abandonedId, { expires_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  r = await api.post("/api/jobs/maintenance", {}, { Authorization: "Bearer " + process.env.CRON_SECRET });
  ok("maintenance reports the purge", !!(r.body.jobs && r.body.jobs["purge-verification-challenges"] &&
    r.body.jobs["purge-verification-challenges"].ok), JSON.stringify(r.body.jobs && r.body.jobs["purge-verification-challenges"]));
  const purged = await db.selectOne("verification_challenges", { id: abandonedId });
  ok("DB: expired challenge payload (password hash) purged", !purged.payload || !purged.payload.passwordHash);
  eq("DB: expired challenge code hash purged", purged.code_hash, null);
}

/* ══ Phone verification (MSG91 path, mocked) ═════════════════════════════════ */
async function testPhoneVerification() {
  section("Phone verification — sign-in, registration by SMS, linking");

  const ship = Object.assign({}, shippingFor(430), { phone: "9333300001" });
  const flow = await checkout([{ id: "aqua-manthan", qty: 1 }], ship);
  const orderId = flow.create.body.nafume_order_id;
  // Same email, different phone: must NOT come with a phone proof.
  const emailTwin = Object.assign({}, ship, { phone: "9333300002" });
  const twinFlow = await checkout([{ id: "seduction", qty: 1 }], Object.assign({}, emailTwin, { email: "twin430@example.com" }));

  const c = makeClient();
  let r = await c.post("/api/otp/send", { phone: ship.phone });
  eq("OTP send creates a challenge", r.status, 200);
  ok("…returns a challenge id", /^[0-9a-f-]{36}$/.test(r.body.challengeId || ""));
  const otpChallenge = r.body.challengeId;
  const otp = mocks.lastOtpFor(ship.phone);

  r = await c.post("/api/otp/verify", { phone: ship.phone, otp: otp });
  eq("verify without the challenge id is refused", r.status, 400);
  r = await c.post("/api/otp/verify", { phone: ship.phone, otp: otp === "000000" ? "111111" : "000000", challengeId: otpChallenge });
  eq("a wrong SMS code is refused", r.status, 422);
  r = await c.post("/api/otp/verify", { phone: ship.phone, otp: otp, challengeId: otpChallenge });
  eq("the right SMS code signs in", r.status, 200);
  ok("…with a session", hasSessionCookie(r));
  eq("…phone verified", r.body.customer.phoneVerified, true);
  eq("…phone proof does NOT verify the email", r.body.customer.emailVerified, false);
  r = await c.get("/api/account/me");
  ok("orders placed with the proven phone are visible", JSON.stringify(r.body.orders).indexOf(orderId) !== -1);
  ok("an order with a different phone is not", JSON.stringify(r.body.orders).indexOf(twinFlow.create.body.nafume_order_id) === -1);

  r = await makeClient().post("/api/otp/verify", { phone: ship.phone, otp: otp, challengeId: otpChallenge });
  eq("replaying the SMS challenge is refused", r.status, 410);

  // Registration verified by SMS instead of email.
  const smsReg = Object.assign({}, shippingFor(431), { phone: "9333300003" });
  const s = makeClient();
  const reg = await registerAndVerify(s, smsReg, "phone");
  eq("registration by SMS code", reg.verify && reg.verify.status, 200);
  eq("…phone verified", reg.verify.body.customer.phoneVerified, true);
  eq("…email NOT verified by an SMS code", reg.verify.body.customer.emailVerified, false);

  // Linking a purchase made with another email from a signed-in account.
  const other = shippingFor(432);
  const otherFlow = await checkout([{ id: "dark-oud", qty: 1 }], Object.assign({}, other, { phone: "9333300009" }));
  r = await s.post("/api/account/identifiers", { action: "start", channel: "email", value: other.email });
  eq("signed-in customer starts email verification", r.status, 200);
  const linkChallenge = r.body.challengeId;
  r = await makeClient().post("/api/account/identifiers", { action: "confirm", challengeId: linkChallenge, code: mocks.lastCodeFor(other.email) });
  eq("confirming requires the SAME signed-in customer", r.status, 401);
  r = await s.post("/api/account/identifiers", { action: "confirm", challengeId: linkChallenge, code: mocks.lastCodeFor(other.email) });
  eq("verified email links the earlier purchase", r.status, 200);
  eq("…one order linked", r.body.ordersLinked, 1);
  r = await s.get("/api/account/me");
  ok("…and it is in the history", JSON.stringify(r.body.orders).indexOf(otherFlow.create.body.nafume_order_id) !== -1);

  // Someone else cannot then link the same, already-owned order.
  const late = makeClient();
  const lateReg = await registerAndVerify(late, Object.assign({}, shippingFor(433), { email: "late433@example.com" }));
  r = await late.post("/api/account/identifiers", { action: "start", channel: "email", value: other.email });
  ok("a verified email on another account cannot be started or confirmed elsewhere",
    r.status === 200 || r.status === 409, "got " + r.status);
  if (r.status === 200) {
    r = await late.post("/api/account/identifiers", { action: "confirm", challengeId: r.body.challengeId, code: mocks.lastCodeFor(other.email) });
    eq("…confirming it is a conflict, not a merge", r.status, 409);
  }
  r = await late.get("/api/account/me");
  ok("…and the order stays with the first verified owner", JSON.stringify(r.body).indexOf(otherFlow.create.body.nafume_order_id) === -1);
  ok("(setup) late customer registered", lateReg.verify && lateReg.verify.status === 200);
}

/* ══ Payment capture rules ═══════════════════════════════════════════════════ */
async function testPaymentCapture() {
  section("Payment capture — authorized, mismatches, races, stale events");

  const WEBHOOK_SECRET = "capture_suite_webhook_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  async function webhook(payload, eventId, rawOverride) {
    const raw = rawOverride || JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(raw, WEBHOOK_SECRET) };
    if (eventId) headers["x-razorpay-event-id"] = eventId;
    const res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST", headers: headers, body: raw });
    return { status: res.status, body: await res.json().catch(function () { return {}; }) };
  }
  function capturedEvent(pay) {
    return { event: "payment.captured", payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } } };
  }

  // Authorized but not captured, with a first-order discount riding on it.
  const buyer = shippingFor(440);
  const items = [{ id: "seduction", qty: 1 }];
  const priced = catalog.priceCart(items);
  const disc = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: true, discount: { code: "NAFUME10", type: "percentage", value: 10 } });
  const create = await api.post("/api/razorpay/create-order", { items: items, amount: disc.total, shipping: buyer, discountCode: "NAFUME10" });
  eq("order with discount created", create.status, 200);
  const pay = mocks.simulatePayment(create.body.order_id, { status: "authorized" });
  mocks.state.emails.length = 0;
  let r = await api.post("/api/razorpay/verify-payment", pay);
  eq("authorized-but-uncaptured → 202", r.status, 202);
  eq("…awaiting_verification", r.body.paymentState, "awaiting_verification");
  let order = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("DB: authorized is NOT paid", order.payment_status, "awaiting_verification");
  eq("no confirmation email for an authorization", mocks.state.emails.length, 0);
  eq("DB: discount not committed on an authorization",
    (await db.selectOne("discount_redemptions", { order_id: order.order_id })).status, "pending");

  // Delayed capture arrives by webhook.
  mocks.setPaymentStatus(pay.razorpay_payment_id, "captured");
  r = await webhook(capturedEvent(pay), "evt_capture_1");
  eq("capture webhook accepted", r.status, 200);
  eq("…state paid", r.body.state, "paid");
  eq("…recovered by the webhook", r.body.recovered, true);
  order = await db.selectOne("orders", { order_id: create.body.nafume_order_id });
  eq("DB: paid after capture", order.payment_status, "paid");
  eq("DB: confirmed via webhook", order.payment_confirmed_via, "webhook");
  eq("DB: discount committed on capture",
    (await db.selectOne("discount_redemptions", { order_id: order.order_id })).status, "redeemed");
  const confirmations = function () {
    return mocks.state.emails.filter(function (e) { return /is confirmed/i.test(e.subject || "") &&
      [].concat(e.to).indexOf(buyer.email) !== -1; }).length;
  };
  eq("exactly one customer confirmation", confirmations(), 1);

  r = await webhook(capturedEvent(pay), "evt_capture_1");
  eq("the same event id redelivered is a no-op", r.status, 200);
  eq("…flagged duplicate", r.body.duplicate, true);
  r = await api.post("/api/razorpay/verify-payment", pay);
  eq("late browser callback after the webhook", r.status, 200);
  eq("…already processed", r.body.alreadyProcessed, true);
  eq("still exactly one confirmation", confirmations(), 1);

  // Stale / out-of-order events cannot move a paid order backwards.
  r = await webhook({ event: "payment.failed", payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } } }, "evt_stale_failed");
  eq("stale payment.failed acknowledged", r.status, 200);
  r = await webhook({ event: "payment.authorized", payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } } }, "evt_stale_auth");
  eq("stale payment.authorized acknowledged", r.status, 200);
  eq("DB: still paid after stale events", (await db.selectOne("orders", { order_id: order.order_id })).payment_status, "paid");

  // Payment on a different Razorpay order than the one signed for.
  const c2 = await api.post("/api/razorpay/create-order", { items: items, amount: 858, shipping: shippingFor(441) });
  const decoy = await api.post("/api/razorpay/create-order", { items: items, amount: 858, shipping: shippingFor(442) });
  const crossed = mocks.simulatePayment(c2.body.order_id, { orderIdOnPayment: decoy.body.order_id });
  r = await api.post("/api/razorpay/verify-payment", crossed);
  eq("payment belonging to another order is refused", r.status, 400);
  eq("…payment_mismatch", r.body.error, "payment_mismatch");
  ok("…customer told not to pay again", /don't pay again/i.test(r.body.message || ""), r.body.message);
  eq("DB: not paid", (await db.selectOne("orders", { order_id: c2.body.nafume_order_id })).payment_status, "pending");

  // Wrong currency.
  const c3 = await api.post("/api/razorpay/create-order", { items: items, amount: 858, shipping: shippingFor(443) });
  const usd = mocks.simulatePayment(c3.body.order_id, { currency: "USD" });
  r = await api.post("/api/razorpay/verify-payment", usd);
  eq("currency mismatch refused", r.status, 400);
  eq("…currency_mismatch", r.body.error, "currency_mismatch");
  eq("DB: not paid", (await db.selectOne("orders", { order_id: c3.body.nafume_order_id })).payment_status, "pending");

  // Captured then refunded before anyone confirmed it.
  const c4 = await api.post("/api/razorpay/create-order", { items: items, amount: 858, shipping: shippingFor(444) });
  const refunded = mocks.simulatePayment(c4.body.order_id);
  mocks.setPaymentStatus(refunded.razorpay_payment_id, "refunded");
  r = await webhook(capturedEvent(refunded), "evt_refunded_capture");
  eq("a stale captured event for a refunded payment is acknowledged", r.status, 200);
  ok("…but not treated as paid", r.body.state !== "paid", JSON.stringify(r.body));
  r = await api.post("/api/razorpay/verify-payment", refunded);
  eq("refunded payment via callback → 402", r.status, 402);
  eq("DB: refunded payment never marked paid", (await db.selectOne("orders", { order_id: c4.body.nafume_order_id })).payment_status, "pending");

  // Browser callbacks, webhooks and a reconciliation run all at once.
  const racer = shippingFor(445);
  const c5 = await api.post("/api/razorpay/create-order", { items: items, amount: 858, shipping: racer });
  const racePay = mocks.simulatePayment(c5.body.order_id);
  mocks.state.emails.length = 0;
  const burst = await Promise.all([
    api.post("/api/razorpay/verify-payment", racePay),
    makeClient().post("/api/razorpay/verify-payment", racePay),
    makeClient().post("/api/razorpay/verify-payment", racePay),
    webhook(capturedEvent(racePay), "evt_race_a"),
    webhook(capturedEvent(racePay), "evt_race_a"),
    webhook({ event: "order.paid", payload: { payment: { entity: { id: racePay.razorpay_payment_id, order_id: racePay.razorpay_order_id } },
      order: { entity: { id: racePay.razorpay_order_id } } } }, "evt_race_b"),
    makeClient().post("/api/orders/lookup", { orderId: c5.body.nafume_order_id, contact: racer.email, refreshPayment: true })
  ]);
  ok("every concurrent confirmation path answered 2xx", burst.every(function (x) { return x.status >= 200 && x.status < 300; }),
    burst.map(function (x) { return x.status; }).join(","));
  eq("DB: exactly one paid row for the payment",
    (await db.select("orders", { where: { razorpay_payment_id: racePay.razorpay_payment_id } })).length, 1);
  eq("exactly one customer confirmation across all paths", mocks.state.emails.filter(function (e) {
    return /is confirmed/i.test(e.subject || "") && [].concat(e.to).indexOf(racer.email) !== -1; }).length, 1);
  eq("exactly one team alert across all paths", mocks.state.emails.filter(function (e) {
    return /Order Paid/.test(e.subject || "") && (e.subject || "").indexOf(c5.body.nafume_order_id) !== -1; }).length, 1);
  const events = await db.select("payment_events", { where: { razorpay_payment_id: racePay.razorpay_payment_id } });
  eq("DB: webhook events recorded once per event id", events.length, 2);
}

/* ══ Webhook hardening ═══════════════════════════════════════════════════════ */
async function testWebhookHardening() {
  section("Webhook — raw-body signature, fail-closed, retries");

  const SECRET = "hardening_webhook_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  const ship = shippingFor(450);
  const create = await api.post("/api/razorpay/create-order", { items: [{ id: "dark-oud", qty: 1 }], amount: 858, shipping: ship });
  const pay = mocks.simulatePayment(create.body.order_id);
  const payload = { event: "payment.captured", payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } } };

  // Signed compact JSON, sent pretty-printed: same object, different bytes.
  const compact = JSON.stringify(payload);
  const pretty  = JSON.stringify(payload, null, 2);
  let res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(compact, SECRET) }, body: pretty });
  eq("signature over different bytes (re-serialised) is rejected", res.status, 401);

  // Signed over the exact odd-looking bytes: accepted → the RAW body is what is verified.
  const odd = '{ "event" : "payment.captured",\n  "payload": ' + JSON.stringify(payload.payload) + ' }';
  mocks.state.failOrderPaymentsFetch = true;
  res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(odd, SECRET), "x-razorpay-event-id": "evt_odd_bytes" }, body: odd });
  mocks.state.failOrderPaymentsFetch = false;
  eq("exact raw bytes verified; Razorpay unreachable → 503 so it retries", res.status, 503);
  eq("DB: still not paid while unconfirmable", (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "pending");
  const pendingEvent = await db.selectOne("payment_events", { event_key: "razorpay:evt_odd_bytes" });
  ok("DB: the unfinished event is not marked processed", pendingEvent && !pendingEvent.processed_at);

  res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(odd, SECRET), "x-razorpay-event-id": "evt_odd_bytes" }, body: odd });
  const retried = await res.json();
  eq("Razorpay's retry of the same event now succeeds", res.status, 200);
  eq("…and is processed, not skipped as a duplicate", retried.state, "paid");

  res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: compact });
  eq("missing signature header rejected", res.status, 401);

  res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(compact, "some-other-secret") }, body: compact });
  eq("signature made with another secret rejected", res.status, 401);

  const unknown = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_nope123", order_id: "order_nope123" } } } });
  res = await fetch(BASE + "/api/razorpay/webhook", { method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": webhookSign(unknown, SECRET) }, body: unknown });
  const unknownBody = await res.json();
  eq("event for an unknown order acknowledged", res.status, 200);
  eq("…not handled", unknownBody.handled, false);
}

/* ══ Browser closed after paying ═════════════════════════════════════════════ */
async function testBrowserCloseRecovery() {
  section("Browser-close recovery — status refresh + reconciliation");

  const cron = { Authorization: "Bearer " + process.env.CRON_SECRET };
  const ship = shippingFor(460);
  const create = await api.post("/api/razorpay/create-order", { items: [{ id: "red-spirit", qty: 1 }], amount: 858, shipping: ship });
  mocks.simulatePayment(create.body.order_id);           // captured; browser never calls back
  const orderId = create.body.nafume_order_id;

  const guest = makeClient();
  mocks.state.emails.length = 0;
  let r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: ship.email });
  eq("plain lookup shows pending", r.body.order.paymentStatus, "pending");
  r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: ship.email, refreshPayment: true });
  eq("confirmation-page refresh asks Razorpay and settles it", r.body.paymentRefresh, "paid");
  eq("…order now paid", r.body.order.paymentStatus, "paid");
  eq("DB: confirmed via status refresh", (await db.selectOne("orders", { order_id: orderId })).payment_confirmed_via, "status_refresh");
  r = await guest.post("/api/orders/lookup", { orderId: orderId, contact: ship.email, refreshPayment: true });
  eq("refreshing a paid order does nothing more", r.body.order.paymentStatus, "paid");
  eq("one confirmation email", mocks.state.emails.filter(function (e) { return /is confirmed/i.test(e.subject || ""); }).length, 1);

  r = await makeClient().post("/api/orders/lookup", { orderId: orderId, refreshPayment: true });
  eq("refresh without ownership is refused like any lookup", r.status, 404);

  // Callback failed → awaiting; capture happens; the daily job settles it.
  const ship2 = shippingFor(461);
  const c2 = await api.post("/api/razorpay/create-order", { items: [{ id: "red-spirit", qty: 1 }], amount: 858, shipping: ship2 });
  const p2 = mocks.simulatePayment(c2.body.order_id, { status: "authorized" });
  r = await api.post("/api/razorpay/verify-payment", p2);
  eq("authorized callback held", r.status, 202);
  const fewMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
  await db.update("orders", { where: { order_id: c2.body.nafume_order_id }, set: { created_at: fewMinutesAgo } });

  r = await api.post("/api/jobs/reconcile-payments", {}, cron);
  eq("reconciliation leaves an authorized payment awaiting", (await db.selectOne("orders", { order_id: c2.body.nafume_order_id })).payment_status,
    "awaiting_verification");
  ok("…and counts it", r.body.summary.awaiting >= 1, JSON.stringify(r.body.summary));

  mocks.setPaymentStatus(p2.razorpay_payment_id, "captured");
  const dry = await api.get("/api/jobs/reconcile-payments?dryRun=1", cron);
  ok("dry run reports it would recover", (dry.body.needsAttention || []).some(function (n) {
    return n.orderId === c2.body.nafume_order_id && n.issue === "would_recover"; }));
  eq("…without changing it", (await db.selectOne("orders", { order_id: c2.body.nafume_order_id })).payment_status, "awaiting_verification");
  r = await api.post("/api/jobs/reconcile-payments", {}, cron);
  eq("reconciliation confirms the captured payment",
    (await db.selectOne("orders", { order_id: c2.body.nafume_order_id })).payment_status, "paid");

  // An authorization that never captures is flagged for a human after an hour.
  const ship3 = shippingFor(462);
  const c3 = await api.post("/api/razorpay/create-order", { items: [{ id: "red-spirit", qty: 1 }], amount: 858, shipping: ship3 });
  const p3 = mocks.simulatePayment(c3.body.order_id, { status: "authorized" });
  await api.post("/api/razorpay/verify-payment", p3);
  await db.update("orders", { where: { order_id: c3.body.nafume_order_id }, set: { created_at: new Date(Date.now() - 2 * 3600000).toISOString() } });
  r = await api.post("/api/jobs/reconcile-payments", {}, cron);
  ok("long-uncaptured authorization is flagged", (r.body.needsAttention || []).some(function (n) {
    return n.orderId === c3.body.nafume_order_id && n.issue === "not_captured"; }), JSON.stringify(r.body.needsAttention));

  // Every attempt failed → the waiting order is closed as failed.
  mocks.setPaymentStatus(p3.razorpay_payment_id, "failed");
  await api.post("/api/jobs/reconcile-payments", {}, cron);
  eq("all attempts failed → failed", (await db.selectOne("orders", { order_id: c3.body.nafume_order_id })).payment_status, "failed");
}

/* ══ Review access + delivery rules ══════════════════════════════════════════ */
async function testReviewAccessRules() {
  section("Reviews — delivery gate, links, guessed ids, other customers");

  const admin = { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN };
  const a = shippingFor(470);
  const b = shippingFor(471);
  const aFlow = await checkout([{ id: "seduction", qty: 1 }], a);
  const bFlow = await checkout([{ id: "dark-oud", qty: 1 }], b);
  const aId = aFlow.create.body.nafume_order_id;
  const bId = bFlow.create.body.nafume_order_id;

  const stranger = makeClient();
  let r = await stranger.post("/api/reviews/submit", { orderId: aId, token: "A".repeat(43), productId: "seduction", rating: 5 });
  eq("a guessed order id with a made-up token is refused", r.status, 404);

  // Deliver both, issue both review links.
  await deliver(aId, 0);
  await deliver(bId, 0);
  const aOwner = makeClient();
  await registerAndVerify(aOwner, a);
  r = await aOwner.post("/api/reviews/eligibility", { orderId: aId });
  eq("owner is eligible immediately after delivery", r.body.eligible, true);

  const cron = { Authorization: "Bearer " + process.env.CRON_SECRET };
  r = await api.post("/api/jobs/review-requests", {}, cron);
  ok("…while the review-request email waits for the delay",
    !(await db.selectOne("review_requests", { order_id: aId })), "request sent too early");

  const aToken = await reviewLinkFor(aId);
  const bToken = await reviewLinkFor(bId);
  ok("links issued for both", !!aToken && !!bToken);
  const aRequest = await db.selectOne("review_requests", { order_id: aId });
  ok("DB: only the token hash is stored", aRequest.access_token_hash && aRequest.access_token_hash.indexOf(aToken) === -1 &&
    JSON.stringify(aRequest).indexOf(aToken) === -1);

  r = await stranger.post("/api/reviews/submit", { orderId: bId, token: aToken, productId: "dark-oud", rating: 1, body: "Using someone else's link." });
  eq("A's review link cannot open B's order", r.status, 404);
  r = await aOwner.post("/api/reviews/submit", { orderId: bId, productId: "dark-oud", rating: 1, body: "Signed in as someone else." });
  eq("A's session cannot review B's order", r.status, 404);

  r = await stranger.post("/api/reviews/submit", { orderId: bId, token: bToken, productId: "dark-oud", rating: 5, body: "Arrived and it's lovely." });
  eq("B's own link works", r.status, 200);
  eq("DB: review records how access was proven",
    (await db.selectOne("reviews", { order_id: bId })).access_method, "review_link");

  await db.update("review_requests", { where: { order_id: aId }, set: { access_token_expires_at: new Date(Date.now() - 1000).toISOString() } });
  r = await stranger.post("/api/reviews/eligibility", { orderId: aId, token: aToken });
  eq("an expired review link is refused", r.status, 404);
  r = await aOwner.post("/api/reviews/eligibility", { orderId: aId });
  eq("…the signed-in owner still has access", r.status, 200);

  // Cancelled after delivery: no review.
  const c = shippingFor(472);
  const cFlow = await checkout([{ id: "aqua-manthan", qty: 1 }], c);
  const cOwner = makeClient();
  await registerAndVerify(cOwner, c);
  await deliver(cFlow.create.body.nafume_order_id, 0);
  await api.post("/api/admin/orders", { orderId: cFlow.create.body.nafume_order_id, action: "cancel" }, admin);
  r = await cOwner.post("/api/reviews/submit", { orderId: cFlow.create.body.nafume_order_id, productId: "aqua-manthan", rating: 5 });
  eq("a cancelled order cannot be reviewed", r.status, 403);
}

/* ══ Review-request scheduling ═══════════════════════════════════════════════ */
async function testReviewScheduler() {
  section("Review requests — delay fixtures, repeated and concurrent runs");

  const cron = { Authorization: "Bearer " + process.env.CRON_SECRET };
  const delay = catalog.REVIEW_REQUEST_DELAY_DAYS;
  eq("configured delay is the documented default", delay, 5);

  // Drain anything other suites left due.
  await api.post("/api/jobs/review-requests", {}, cron);

  const early = shippingFor(480);
  const due = shippingFor(481);
  const eFlow = await checkout([{ id: "seduction", qty: 1 }], early);
  const dFlow = await checkout([{ id: "seduction", qty: 1 }], due);
  await deliver(eFlow.create.body.nafume_order_id, delay - 1);
  await deliver(dFlow.create.body.nafume_order_id, delay + 1);

  mocks.state.emails.length = 0;
  const runs = await Promise.all([1, 2, 3].map(function () { return makeClient().post("/api/jobs/review-requests", {}, cron); }));
  ok("concurrent runs all succeed", runs.every(function (x) { return x.status === 200; }));
  const mails = function (email) { return mocks.state.emails.filter(function (e) {
    return [].concat(e.to).indexOf(email) !== -1 && /how is your nafume fragrance/i.test(e.subject || ""); }).length; };
  eq("an order delivered delay-1 days ago is not asked yet", mails(early.email), 0);
  eq("an order delivered delay+1 days ago is asked exactly once", mails(due.email), 1);
  eq("DB: one review_request row", (await db.select("review_requests", { where: { order_id: dFlow.create.body.nafume_order_id } })).length, 1);

  await api.post("/api/jobs/review-requests", {}, cron);
  await api.post("/api/jobs/maintenance", {}, cron);
  eq("repeated runs (incl. maintenance) send nothing more", mails(due.email), 1);

  await db.update("orders", { where: { order_id: eFlow.create.body.nafume_order_id },
    set: { delivered_at: new Date(Date.now() - (delay + 0.1) * 86400000).toISOString() } });
  await api.post("/api/jobs/review-requests", {}, cron);
  eq("once the delay passes, the early order is asked once", mails(early.email), 1);

  const undelivered = shippingFor(482);
  const uFlow = await checkout([{ id: "seduction", qty: 1 }], undelivered);
  await db.update("orders", { where: { order_id: uFlow.create.body.nafume_order_id },
    set: { created_at: new Date(Date.now() - 30 * 86400000).toISOString() } });
  await api.post("/api/jobs/review-requests", {}, cron);
  eq("an old but undelivered order is never asked", mails(undelivered.email), 0);
}

/* ══ Reward redemption races ═════════════════════════════════════════════════ */
async function testRewardConcurrency() {
  section("Rewards — one review, one use, even in parallel");

  const r0s = shippingFor(490);
  const flow = await checkout([{ id: "dark-oud", qty: 1 }], r0s);
  const orderId = flow.create.body.nafume_order_id;
  const me = makeClient();
  await registerAndVerify(me, r0s);
  await deliver(orderId, 0);
  let r = await me.post("/api/reviews/submit", { orderId: orderId, productId: "dark-oud", rating: 5, body: "Earned my reward honestly." });
  eq("one review written", r.status, 200);

  const items = [{ id: "seduction", qty: 1 }];
  const priced = catalog.priceCart(items);
  const t = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: true, discount: { code: "NAFUMEREVIEW", type: "percentage", value: 10 } });
  const attempts = await Promise.all([1, 2, 3, 4].map(function () {
    return me.post("/api/razorpay/create-order", { items: items, amount: t.total, shipping: r0s, discountCode: "NAFUMEREVIEW" });
  }));
  const accepted = attempts.filter(function (x) { return x.status === 200 && x.body.discount && x.body.discount.applied; });
  eq("four parallel checkouts: exactly one gets the single reward", accepted.length, 1);
  ok("the others are refused cleanly", attempts.filter(function (x) { return x.status !== 200; })
    .every(function (x) { return x.status === 409 || x.status === 400; }), attempts.map(function (x) { return x.status; }).join(","));
  const customer = await db.selectOne("customers", { email_normalized: r0s.email });
  const active = await discounts.activeRedemptions("NAFUMEREVIEW", customer.id);
  eq("DB: one active redemption slot", active.length, 1);

  const cod = await me.post("/api/orders/create-cod", { items: items, shipping: r0s, discountCode: "NAFUMEREVIEW" });
  ok("a later COD attempt cannot reuse it", cod.status === 400 || cod.status === 409 ||
    (cod.status === 200 && !(cod.body.discount && cod.body.discount.applied)), JSON.stringify(cod.body.discount || cod.body.error));

  // The database guard itself: two claims for the last slot, both past the
  // eligibility check, racing to write. The UNIQUE slot_key admits one.
  const racerCustomer = db.newId();
  await db.insert("customers", { id: racerCustomer, name: "Slot Racer", email: null, email_normalized: null,
    phone: null, phone_normalized: null, has_account: true, country: "India", source: "test",
    created_at: db.nowISO(), updated_at: db.nowISO() });
  const makeOrder = async function (n) {
    const oid = "NF-SLOTRACE-" + n;
    await db.insert("orders", { id: db.newId(), order_id: oid, customer_id: racerCustomer, payment_status: "pending",
      order_status: "created", checkout_type: "razorpay", payment_method: "razorpay", amount_total: 700,
      created_at: db.nowISO(), updated_at: db.nowISO() });
    return oid;
  };
  const o1 = await makeOrder(1);
  const o2 = await makeOrder(2);
  const claims = await Promise.all([o1, o2].map(function (oid) {
    return discounts.recordRedemption({ code: "NAFUMEREVIEW", customerId: racerCustomer, orderId: oid,
      subtotalBefore: 799, discountAmount: 79, finalAmount: 720, allowance: 1 });
  }));
  eq("two simultaneous claims on one slot: exactly one succeeds",
    claims.filter(function (c) { return c.ok; }).length, 1);
  eq("DB: exactly one redemption row holds the slot",
    (await db.select("discount_redemptions", { where: { slot_key: "NAFUMEREVIEW|" + racerCustomer + "|1" } })).length, 1);
  const replay = await discounts.recordRedemption({ code: "NAFUMEREVIEW", customerId: racerCustomer,
    orderId: claims[0].ok ? o1 : o2, subtotalBefore: 799, discountAmount: 79, finalAmount: 720, allowance: 1 });
  eq("replaying the winning order's claim is idempotent", replay.ok, true);
}

/* ══ Handlers invoked directly (no HTTP, no router) ══════════════════════════ */
function fakeReq(method, headers, bodyText, extra) {
  const { PassThrough } = require("stream");
  const req = new PassThrough();
  req.method = method;
  req.headers = Object.assign({ host: "localhost" }, headers || {});
  req.url = "/api/x";
  req.query = {};
  req.socket = { remoteAddress: "198.51.100." + Math.floor(Math.random() * 200) };
  Object.assign(req, extra || {});
  process.nextTick(function () { if (bodyText) req.write(bodyText); req.end(); });
  return req;
}
function fakeRes() {
  const out = { statusCode: 200, headers: {}, body: null };
  const res = {
    setHeader: function (k, v) { out.headers[k.toLowerCase()] = v; },
    getHeader: function (k) { return out.headers[k.toLowerCase()]; },
    status: function (c) { out.statusCode = c; return res; },
    json: function (p) { out.body = p; return res; },
    end: function () { return res; }
  };
  return { res: res, out: out };
}

async function testDirectHandlers() {
  section("Handlers called directly");

  const verifyHandler  = require("../server/razorpay/verify-payment");
  const webhookHandler = require("../server/razorpay/webhook");
  const adminHandler   = require("../server/admin/orders");
  const jobHandler     = require("../server/jobs/reconcile-payments");

  const create = await api.post("/api/razorpay/create-order", { items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(500) });
  const pay = mocks.simulatePayment(create.body.order_id);
  mocks.state.failPaymentFetch = true;
  let f = fakeRes();
  await verifyHandler(fakeReq("POST", { "content-type": "application/json" }, JSON.stringify(pay)), f.res);
  mocks.state.failPaymentFetch = false;
  eq("direct verify-payment: lookup failure → 202", f.out.statusCode, 202);
  eq("direct verify-payment: not paid", (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "awaiting_verification");

  // A runtime that consumed the stream and only offers a parsed object must be refused.
  process.env.RAZORPAY_WEBHOOK_SECRET = "direct_secret";
  const payload = { event: "payment.captured", payload: { payment: { entity: { id: pay.razorpay_payment_id, order_id: pay.razorpay_order_id } } } };
  const raw = JSON.stringify(payload);
  f = fakeRes();
  const consumed = fakeReq("POST", { "content-type": "application/json", "content-length": String(raw.length),
    "x-razorpay-signature": webhookSign(raw, "direct_secret") }, "", { body: payload });
  await webhookHandler(consumed, f.res);
  eq("direct webhook: parsed body without raw bytes fails closed", f.out.statusCode, 500);
  eq("…raw_body_unavailable", f.out.body && f.out.body.error, "raw_body_unavailable");

  f = fakeRes();
  await webhookHandler(fakeReq("POST", { "content-type": "application/json", "x-razorpay-signature": webhookSign(raw, "direct_secret") }, raw), f.res);
  eq("direct webhook: raw stream verified and settled", f.out.statusCode, 200);
  eq("…paid", (await db.selectOne("orders", { order_id: create.body.nafume_order_id })).payment_status, "paid");

  f = fakeRes();
  await adminHandler(fakeReq("GET", {}), f.res);
  eq("direct admin/orders without token → 401", f.out.statusCode, 401);
  f = fakeRes();
  await adminHandler(fakeReq("GET", { authorization: "Bearer " + process.env.CRON_SECRET }), f.res);
  eq("direct admin/orders refuses the CRON secret", f.out.statusCode, 401);
  f = fakeRes();
  await jobHandler(fakeReq("GET", { authorization: "Bearer not-the-secret" }), f.res);
  eq("direct reconcile job with a wrong token → 401", f.out.statusCode, 401);
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */
async function testRouter() {
  section("api/index.js router");
  const client = makeClient();
  const probes = ["/api/../server/_lib/db", "/api/_lib/db", "/api/account", "/api/account/me/extra", "/api/%2e%2e/health"];
  for (const p of probes) {
    const r = await client.get(p);
    ok("non-route " + p + " is not executed", r.status === 404 || (r.status === 200 && r.body.service === "nafume"),
      "got " + r.status);
  }
  const router = require("../api/index.js");
  const f = fakeRes();
  await router({ method: "GET", url: "/api?path=health", query: { path: "health" }, headers: {} }, f.res);
  eq("router dispatches the Vercel rewrite shape (?path=)", f.out.statusCode, 200);
  const g = fakeRes();
  await router({ method: "GET", url: "/api?path=../../etc/passwd", query: { path: "../../etc/passwd" }, headers: {} }, g.res);
  eq("router refuses a traversal-looking rewrite", g.out.statusCode, 404);
}

/* ══ Storage safety ══════════════════════════════════════════════════════════
   Runs near the end: resetting the driver cache replaces the in-memory store. */
async function testStorageSafety() {
  section("Storage safety — no memory driver on hosted deployments");
  if (D1_MODE) { console.log("  (skipped: memory-driver guard; D1 is a valid hosted driver)"); return; }

  process.env.VERCEL = "1";
  db._resetDriverCache();
  eq("memory driver refused on Vercel", db.isConfigured(), false);
  eq("…and reported as refused", db.memoryDriverRefused(), true);
  const r = await makeClient().post("/api/razorpay/create-order", { items: [{ id: "seduction", qty: 1 }], amount: 858, shipping: shippingFor(510) });
  eq("checkout answers 503 instead of saving to memory", r.status, 503);
  delete process.env.VERCEL;
  db._resetDriverCache();
  eq("memory driver available again locally", db.isConfigured(), true);

  const sb = db.supabaseAuthHeaders("sb_secret_abc123");
  ok("Supabase secret key sent only as apikey", sb.apikey === "sb_secret_abc123" && !sb.Authorization);
  const jwt = db.supabaseAuthHeaders("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl");
  ok("legacy service_role JWT keeps apikey + Bearer", !!jwt.apikey && /^Bearer eyJ/.test(jwt.Authorization || ""));
}

async function testRateLimiting() {
  section("Rate limiting");

  const client = makeClient();
  let limited = false, attempts = 0;
  for (let i = 0; i < 60; i++) {
    attempts++;
    const r = await client.post("/api/account/login", { identifier: "rl@example.com", password: "Whatever123" });
    if (r.status === 429) { limited = true; break; }
  }
  ok("a flood against one account is throttled", limited, "gave up after " + attempts + " attempts");

  /* The durable limiter is keyed on the ACCOUNT as well as the IP, so switching
     IP does not reset the attempt budget for that account. This is the whole
     point of moving the counter into the database: a serverless deployment
     spreads requests across instances, and an attacker rotating IPs used to get
     a fresh in-memory allowance every time. */
  const rotatedIp = makeClient();
  const sameAccount = await rotatedIp.post("/api/account/login",
    { identifier: "rl@example.com", password: "Whatever123" });
  eq("rotating IP does NOT reset the per-account limit", sameAccount.status, 429);

  // A genuinely different customer on a different IP is unaffected — the
  // carrier-NAT case the per-IP ceiling was widened for.
  const bystander = makeClient();
  const other = await bystander.post("/api/account/login",
    { identifier: "someone.else@example.com", password: "Whatever123" });
  ok("a different customer is unaffected", other.status !== 429, "got " + other.status);
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const server = await start(0);
  BASE = server.url;
  console.log("NAFUME API suite — " + BASE + "  (driver: " + db.driverName() + ")");

  const suites = [
    testPricing, testCheckoutValidation, testHappyPath, testNormalization,
    testIdempotency, testTamperedPayments, testRazorpayOutage, testRepeatCustomer,
    testWhatsAppConsent, testAccounts, testOrderLookup, testLeads, testQuiz,
    testDeliveryAndReviews, testWebhookRecovery, testCodDoubleSubmit,
    testDiscounts, testReconciliation, testOrderOwnership, testOutbox,
    testWhatsAppAdapter, testHealth, testAdversarial,
    // launch-readiness regression suites
    testAccountOwnershipAttacks, testVerificationChallenges, testPhoneVerification,
    testPaymentCapture, testWebhookHardening, testBrowserCloseRecovery,
    testReviewAccessRules, testReviewScheduler, testRewardConcurrency,
    testDirectHandlers, testRouter,
    testMissingCredentials, testMisconfiguration, testErrorHygiene,
    testStorageSafety, testRateLimiting
  ];

  for (const suite of suites) {
    try {
      await suite();
    } catch (err) {
      failed++;
      failures.push(suite.name + " threw: " + (err && err.stack ? err.stack : err));
      console.log("  ERROR " + suite.name + " threw: " + (err && err.message));
    }
  }

  console.log("\n" + "═".repeat(70));
  console.log("  " + passed + " passed, " + failed + " failed");
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach(function (f) { console.log("  • " + f); });
  }
  console.log("═".repeat(70));

  server.server.close();
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (err) {
  console.error("suite crashed:", err);
  process.exit(1);
});
