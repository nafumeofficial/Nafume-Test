/*
 * test/check-live-services.js  —  verify REAL Supabase / Razorpay / Resend
 * ============================================================================
 *   node test/check-live-services.js
 *
 * The other suites run against the memory driver and a mocked HTTP boundary.
 * This one talks to the real services, and is the single command that turns
 * "code complete, live verification pending" into "verified".
 *
 * RUN IT AGAINST AN ISOLATED TEST PROJECT FIRST.
 *   Razorpay: rzp_test_… keys. Never live keys — this script creates a real
 *   Razorpay order (₹1, which is never paid and simply expires).
 *   Supabase: a separate TEST project. Every row it writes is clearly marked
 *   test data; the storage layer has no DELETE, so rows are marked and the
 *   exact cleanup SQL is printed.
 *
 * WHAT IT WILL NEVER DO
 *   - capture, charge, or refund money
 *   - read, modify or delete any row it did not create
 *   - email a real customer (the Resend check is opt-in and goes to an address
 *     you pass explicitly)
 *   - print a secret value
 *
 * Usage:
 *   Load your environment however you like, then:
 *     node test/check-live-services.js
 *     node test/check-live-services.js --email you@yourdomain.com   (also tests Resend + reads the delivery event)
 *     node test/check-live-services.js --keep                       (leaves test rows)
 *     node test/check-live-services.js --write-persistence-probe    (writes marked rows, prints a marker)
 *     node test/check-live-services.js --verify-persistence <marker> (after a restart/redeploy: rows still there?)
 *     node test/check-live-services.js --site https://<deployment>  (non-mutating checks of a deployment)
 */
"use strict";

const path = require("path");
const fs   = require("fs");

/* Loads a .env file if one is present, so the script works without a shell
   wrapper. Never printed, never logged. */
(function loadDotEnv() {
  const file = path.resolve(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) return;
    let value = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
  console.log("Loaded .env");
})();

const db          = require("../server/_lib/db");
const configCheck = require("../server/_lib/config-check");
const catalog     = require("../server/_lib/catalog");

const args      = process.argv.slice(2);
const KEEP      = args.indexOf("--keep") !== -1;
const emailArg  = args.indexOf("--email");
const TEST_EMAIL = emailArg !== -1 ? args[emailArg + 1] : null;
const siteArg   = args.indexOf("--site");
const SITE      = siteArg !== -1 ? String(args[siteArg + 1] || "").replace(/\/+$/, "") : null;
const WRITE_PROBE = args.indexOf("--write-persistence-probe") !== -1;
const verifyArg = args.indexOf("--verify-persistence");
const VERIFY_MARKER = verifyArg !== -1 ? args[verifyArg + 1] : null;

const TEST_MARKER = "livecheck-" + Date.now();
const created = { customers: [], orders: [], leads: [] };

let passed = 0, failed = 0, skipped = 0;
const notes = [];

function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (detail ? "\n        " + detail : "")); }
}
function skip(name, why) { skipped++; console.log("  SKIP  " + name + " — " + why); }
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length))); }

/* ── 1. configuration ────────────────────────────────────────────────────── */

function checkConfig() {
  section("Configuration");
  const report = configCheck.inspect();

  report.required.forEach(function (item) {
    ok(item.name + " is set", item.present, item.why);
  });

  console.log("\n  Optional integrations:");
  report.optional.forEach(function (item) {
    console.log("    " + (item.present ? "[ok]  " : "[--]  ") + item.name +
                (item.present ? "" : "   → " + item.withoutIt));
  });

  ok("storage driver is production-safe (supabase)", report.storage.productionSafe,
     "driver = " + report.storage.driver + (report.storage.warning ? " — " + report.storage.warning : ""));

  return report;
}

/* ── 2. Supabase ─────────────────────────────────────────────────────────── */

async function checkSupabase() {
  section("Supabase — connection, schema, write, read, update, constraints");

  if (!db.isConfigured() || db.driverName() !== "supabase") {
    skip("Supabase checks", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return false;
  }

  // Reachability + schema.
  const tables = ["customers", "orders", "order_items", "leads", "reviews",
                  "marketing_consent", "discount_redemptions", "rate_limits",
                  "outbound_messages", "review_requests", "quiz_responses",
                  "sessions", "customer_auth"];
  let schemaOk = true;
  for (let i = 0; i < tables.length; i++) {
    try {
      await db.select(tables[i], { limit: 1 });
    } catch (err) {
      schemaOk = false;
      ok("table '" + tables[i] + "' exists", false,
         "Run db/schema.sql in the Supabase SQL editor. (" + (err.detail || err.message) + ")");
    }
  }
  if (schemaOk) ok("all " + tables.length + " tables exist", true);
  if (!schemaOk) return false;

  // Migration 20260915_launch_readiness — new tables and columns.
  const probes = [
    ["verification_challenges", "id,live_key,code_hash,attempts,expires_at,consumed_at"],
    ["payment_events",          "id,event_key,processed_at"],
    ["orders",                  "id,verified_owner_customer_id,ship_email_normalized,pending_payment_id,payment_confirmed_via"],
    ["customers",               "id,email_verified_at,phone_verified_at"],
    ["review_requests",         "id,access_token_hash,access_token_expires_at"],
    ["discount_redemptions",    "id,allowance_slot,slot_key"],
    ["schema_migrations",       "version"]
  ];
  let migrationOk = true;
  for (const [table, columns] of probes) {
    try { await db.select(table, { columns: columns, limit: 1 }); }
    catch (err) {
      migrationOk = false;
      ok("migration object " + table + "(" + columns + ")", false,
         "Apply db/migrations/20260915_launch_readiness.sql. (" + (err.detail || err.message) + ")");
    }
  }
  if (migrationOk) {
    const applied = await db.selectOne("schema_migrations", { version: "20260915_launch_readiness" }).catch(function () { return null; });
    ok("migration 20260915_launch_readiness is recorded", !!applied);
    const viewLocked = await db.selectOne("schema_migrations", { version: "20261022_secure_broadcast_view" }).catch(function () { return null; });
    ok("migration 20261022_secure_broadcast_view is recorded", !!viewLocked,
       "Apply db/migrations/20261022_secure_broadcast_view.sql — until then the anon key can read whatsapp_broadcast_audience.");
  }
  if (!migrationOk) return false;

  // The CHECK constraint on payment_status.
  let checkBlocked = false;
  try {
    await db.insert("orders", {
      id: db.newId(), order_id: "NF-LIVECHECK-BADSTATUS-" + String(Date.now()).slice(-6),
      currency: "INR", amount_total: 1, payment_status: "definitely_not_a_status",
      order_status: "created", fulfillment_status: "unfulfilled", payment_method: "razorpay", checkout_type: "razorpay",
      ship_country: "India", created_at: db.nowISO(), updated_at: db.nowISO()
    });
  } catch (err) { checkBlocked = err instanceof db.DbError; }
  ok("orders.payment_status CHECK constraint is enforced", checkBlocked);

  // One live verification challenge per identifier.
  const liveKey = "account_register|email|" + TEST_MARKER + "@nafume-livecheck.invalid";
  const chRow = function () {
    return { id: db.newId(), purpose: "account_register", channel: "email",
             identifier: TEST_MARKER + "@nafume-livecheck.invalid", provider: "resend", payload: {},
             expires_at: new Date(Date.now() + 60000).toISOString(), live_key: liveKey,
             created_at: db.nowISO(), updated_at: db.nowISO(), last_sent_at: db.nowISO() };
  };
  let liveBlocked = false;
  try { await db.insert("verification_challenges", chRow()); await db.insert("verification_challenges", chRow()); }
  catch (err) { liveBlocked = err instanceof db.UniqueViolationError; }
  ok("UNIQUE live challenge per identifier is enforced", liveBlocked);

  // INSERT — clearly marked test data.
  const email = TEST_MARKER + "@nafume-livecheck.invalid";
  const customerId = db.newId();
  try {
    await db.insert("customers", {
      id: customerId, name: "NAFUME Live Check", email: email, email_normalized: email,
      phone: null, phone_normalized: null, country: "India",
      source: "live_check", has_account: false,
      created_at: db.nowISO(), updated_at: db.nowISO()
    });
    created.customers.push(customerId);
    ok("INSERT works", true);
  } catch (err) {
    ok("INSERT works", false, err.detail || err.message);
    return false;
  }

  // SELECT.
  const readBack = await db.selectOne("customers", { id: customerId });
  ok("SELECT returns the row just written", !!readBack && readBack.email_normalized === email);

  // UPDATE.
  await db.update("customers", { where: { id: customerId }, set: { name: "NAFUME Live Check 2" } });
  const updated = await db.selectOne("customers", { id: customerId });
  ok("UPDATE persists", updated && updated.name === "NAFUME Live Check 2");

  // UNIQUE constraint — the guarantee order idempotency rests on.
  let blocked = false;
  try {
    await db.insert("customers", {
      id: db.newId(), name: "duplicate", email: email, email_normalized: email,
      country: "India", source: "live_check", has_account: false,
      created_at: db.nowISO(), updated_at: db.nowISO()
    });
  } catch (err) {
    blocked = err instanceof db.UniqueViolationError;
  }
  ok("UNIQUE(email_normalized) is enforced by the database", blocked,
     "Without this, duplicate customers and duplicate paid orders become possible. Re-run db/schema.sql.");

  // Order + payment-id uniqueness — the payment idempotency guarantee.
  const orderUuid = db.newId();
  const orderId   = "NF-LIVECHECK-" + String(Date.now()).slice(-6);
  const fakePaymentId = "pay_livecheck" + String(Date.now()).slice(-8);
  try {
    await db.insert("orders", {
      id: orderUuid, order_id: orderId, customer_id: customerId,
      razorpay_order_id: "order_livecheck" + String(Date.now()).slice(-8),
      razorpay_payment_id: fakePaymentId,
      currency: "INR", amount_subtotal: 1, amount_total: 1,
      payment_status: "pending", order_status: "created",
      fulfillment_status: "unfulfilled", payment_method: "razorpay", checkout_type: "razorpay",
      ship_name: "Live Check", ship_email: email, ship_country: "India",
      created_at: db.nowISO(), updated_at: db.nowISO()
    });
    created.orders.push({ uuid: orderUuid, orderId: orderId });
    ok("orders INSERT works", true);
  } catch (err) {
    ok("orders INSERT works", false, err.detail || err.message);
  }

  let paymentBlocked = false;
  try {
    await db.insert("orders", {
      id: db.newId(), order_id: orderId + "-DUP", customer_id: customerId,
      razorpay_payment_id: fakePaymentId,
      currency: "INR", amount_subtotal: 1, amount_total: 1,
      payment_status: "paid", order_status: "confirmed",
      fulfillment_status: "unfulfilled", payment_method: "razorpay", checkout_type: "razorpay",
      ship_name: "Live Check", ship_email: email, ship_country: "India",
      created_at: db.nowISO(), updated_at: db.nowISO()
    });
    created.orders.push({ uuid: null, orderId: orderId + "-DUP" });
  } catch (err) {
    paymentBlocked = err instanceof db.UniqueViolationError;
  }
  ok("UNIQUE(razorpay_payment_id) is enforced — duplicate paid orders are impossible", paymentBlocked,
     "This is the constraint that makes payment processing idempotent. Re-run db/schema.sql.");

  // Conditional update — the pending→paid transition.
  const promoted = await db.update("orders", {
    where: { id: orderUuid, payment_status: "pending" },
    set:   { payment_status: "paid", paid_at: db.nowISO() }
  });
  ok("conditional UPDATE (pending → paid) affects exactly one row",
     Array.isArray(promoted) && promoted.length === 1, "got " + (promoted ? promoted.length : "null"));

  const again = await db.update("orders", {
    where: { id: orderUuid, payment_status: "pending" },
    set:   { payment_status: "paid" }
  });
  ok("the same conditional UPDATE a second time affects ZERO rows (idempotency)",
     Array.isArray(again) && again.length === 0, "got " + (again ? again.length : "null"));

  return true;
}

/* ── 3. Razorpay ─────────────────────────────────────────────────────────── */

async function checkRazorpay() {
  section("Razorpay — credentials, order creation, signature scheme");

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    skip("Razorpay checks", "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    return;
  }

  const isTestKey = /^rzp_test_/.test(keyId);
  if (!isTestKey) {
    notes.push("RAZORPAY_KEY_ID is a LIVE key. This script only creates an unpaid ₹1 order, " +
               "but run it with test keys the first time.");
    console.log("  NOTE  live key detected — creating one unpaid ₹1 order only");
  }

  const auth = Buffer.from(keyId + ":" + keySecret).toString("base64");

  // Credentials — a 401 here means the keys are wrong or swapped.
  let resp;
  try {
    resp = await fetch("https://api.razorpay.com/v1/orders?count=1", {
      method: "GET", headers: { "Authorization": "Basic " + auth }
    });
  } catch (err) {
    ok("Razorpay API reachable", false, err.message);
    return;
  }
  ok("Razorpay credentials accepted", resp.status !== 401,
     resp.status === 401 ? "401 Unauthorized — check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET." : "");
  if (resp.status === 401) return;

  // Create a real ₹1 order. Never paid; Razorpay expires it.
  const receipt = "NF-LIVECHECK-" + String(Date.now()).slice(-8);
  let order = null;
  try {
    const createResp = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body: JSON.stringify({
        amount: 100, currency: "INR", receipt: receipt, payment_capture: 1,
        notes: { source: "nafume-live-check", note: "automated check — not a customer order" }
      })
    });
    if (createResp.ok) order = await createResp.json();
    else notes.push("Razorpay order creation returned HTTP " + createResp.status);
  } catch (err) {
    notes.push("Razorpay order creation failed: " + err.message);
  }

  ok("order creation works (₹1 test order, never paid)", !!(order && order.id),
     "This is exactly what /api/razorpay/create-order does at checkout.");
  if (order && order.id) {
    console.log("        created " + order.id + " — it will expire unpaid; no money moves");
  }

  // Signature scheme — the same verifier the endpoint uses, run against the
  // real secret. (Only proves our code and secret agree; a real Checkout
  // payment is still needed to prove Razorpay signs the same way.)
  const crypto   = require("crypto");
  const payments = require("../server/_lib/payments");
  const sampleOrder = (order && order.id) || "order_sample";
  const signature = crypto.createHmac("sha256", keySecret).update(sampleOrder + "|pay_sample").digest("hex");
  ok("verify-payment's signature check accepts a correctly signed sample",
     payments.checkoutSignatureValid(sampleOrder, "pay_sample", signature));
  ok("…and rejects a tampered one",
     !payments.checkoutSignatureValid(sampleOrder, "pay_other", signature));

  // Fetching the order's payments is what reconciliation and status refresh do.
  if (order && order.id) {
    const listed = await payments.fetchOrderPayments(order.id);
    ok("order payments can be listed (reconciliation path)", listed.ok === true, listed.reason || "");
  }

  // Webhook secret.
  if (process.env.RAZORPAY_WEBHOOK_SECRET) {
    ok("RAZORPAY_WEBHOOK_SECRET is set", true);
    console.log("        Confirm in the Razorpay dashboard: Account & Settings → Webhooks →");
    console.log("        URL = <your-domain>/api/razorpay/webhook");
    console.log("        events = payment.captured, order.paid, payment.authorized, payment.failed");
  } else {
    skip("webhook secret", "RAZORPAY_WEBHOOK_SECRET not set — payments abandoned mid-redirect " +
         "will only be recovered by /api/jobs/reconcile-payments");
  }
}

/* ── 4. Resend ───────────────────────────────────────────────────────────── */

async function checkResend() {
  section("Resend — credentials and (optionally) one real send");

  if (!process.env.RESEND_API_KEY) {
    skip("Resend checks", "RESEND_API_KEY not set — email is queued in outbound_messages, never faked");
    return;
  }

  let resp;
  try {
    resp = await fetch("https://api.resend.com/domains", {
      method: "GET", headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY }
    });
  } catch (err) {
    ok("Resend API reachable", false, err.message);
    return;
  }
  ok("Resend credentials accepted", resp.status !== 401,
     resp.status === 401 ? "401 Unauthorized — check RESEND_API_KEY." : "");
  if (resp.status === 401) return;

  if (resp.ok) {
    const data = await resp.json().catch(function () { return null; });
    const domains = (data && data.data) || [];
    const verified = domains.filter(function (d) { return d.status === "verified"; });
    ok("at least one verified sending domain", verified.length > 0,
       "Without a verified domain, Resend's sandbox sender only delivers to your own " +
       "Resend account address — real customers will not receive order confirmations. " +
       "Add one under Resend → Domains, then set CUSTOMER_EMAIL_FROM to an address on it.");
    if (verified.length) console.log("        verified: " + verified.map(function (d) { return d.name; }).join(", "));
  }

  if (!TEST_EMAIL) {
    skip("live send", "pass --email you@yourdomain.com to send one real test message");
    return;
  }

  const messaging = require("../server/_lib/messaging");
  const result = await messaging.send({
    channel: "email", to: TEST_EMAIL,
    subject: "NAFUME live-service check",
    body: "<p>This is an automated NAFUME configuration check. If you received it, " +
          "order confirmations and review requests will reach customers too.</p>",
    relatedType: "livecheck", relatedId: TEST_MARKER
  });
  ok("a real email was ACCEPTED by Resend (not yet proof of delivery)", result.sent === true,
     result.sent ? "" : "reason: " + result.reason);
  if (!result.sent || !result.providerMessageId) return;

  // Acceptance is not receipt. Ask Resend what happened to it.
  let lastEvent = null;
  for (let i = 0; i < 10 && (!lastEvent || lastEvent === "queued" || lastEvent === "sent"); i++) {
    await new Promise(function (r) { setTimeout(r, 3000); });
    try {
      const ev = await fetch("https://api.resend.com/emails/" + encodeURIComponent(result.providerMessageId), {
        headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY }
      });
      if (ev.ok) lastEvent = ((await ev.json()) || {}).last_event || null;
    } catch (_) { /* keep polling */ }
  }
  console.log("        Resend last_event for this message: " + (lastEvent || "unknown"));
  ok("Resend reports the message as delivered", lastEvent === "delivered",
     "last_event = " + lastEvent + ". 'bounced'/'complained' mean it did not arrive; anything else — check the inbox for " +
     TEST_EMAIL + " and the Resend dashboard.");
}

/* ── 4b. persistence across restarts / redeploys ────────────────────────────
   Run --write-persistence-probe, restart or redeploy, then
   --verify-persistence <marker>. Proves the rows live in Postgres, not memory. */
async function writePersistenceProbe() {
  section("Persistence probe — write");
  if (db.driverName() !== "supabase") { skip("persistence probe", "Supabase is not configured"); return; }
  const email = TEST_MARKER + "@nafume-livecheck.invalid";
  const customerId = db.newId();
  const leadId = db.newId();
  const now = db.nowISO();
  await db.insert("customers", { id: customerId, name: "NAFUME Persistence Probe", email: email, email_normalized: email,
    country: "India", source: "live_check", has_account: false, created_at: now, updated_at: now });
  await db.insert("leads", { id: leadId, email: email, email_normalized: email, source: "popup_lead",
    discount_code: "NAFUME10", metadata: { trigger: "manual", page: "live-check" }, created_at: now, updated_at: now });
  await db.insert("quiz_responses", { id: db.newId(), email: email, email_normalized: email, customer_id: customerId,
    lead_id: leadId, answers: { family: "oud" }, recommended_product_id: "dark-oud", preference_tags: ["oud"],
    source: "fragrance_quiz", created_at: now });
  await db.insert("marketing_consent", { id: db.newId(), customer_id: customerId, channel: "whatsapp", opted_in: false,
    consent_source: "checkout", consent_at: now, revoked_at: now, updated_at: now });
  ok("probe rows written (customer, lead, quiz response, consent)", true);
  console.log("\n  MARKER: " + TEST_MARKER);
  console.log("  Now restart / redeploy, then run:");
  console.log("    node test/check-live-services.js --verify-persistence " + TEST_MARKER);
}

async function verifyPersistence(marker) {
  section("Persistence probe — verify " + marker);
  if (db.driverName() !== "supabase") { skip("persistence verify", "Supabase is not configured"); return; }
  const email = marker + "@nafume-livecheck.invalid";
  const customer = await db.selectOne("customers", { email_normalized: email });
  ok("customer survived", !!customer);
  ok("lead survived", !!(await db.selectOne("leads", { email_normalized: email, source: "popup_lead" })));
  ok("quiz response survived", !!(await db.selectOne("quiz_responses", { email_normalized: email })));
  ok("consent record survived", !!(customer && await db.selectOne("marketing_consent", { customer_id: customer.id, channel: "whatsapp" })));
  console.log("  Remove the probe rows with:");
  console.log("    DELETE FROM quiz_responses    WHERE email_normalized = '" + email + "';");
  console.log("    DELETE FROM leads             WHERE email_normalized = '" + email + "';");
  console.log("    DELETE FROM customers         WHERE email_normalized = '" + email + "';  -- cascades consent");
}

/* ── 4c. a deployment, checked from outside (read-only) ─────────────────── */
async function checkSite(site) {
  section("Deployment " + site + " — read-only checks");
  async function req(pathname, init) {
    try {
      const r = await fetch(site + pathname, Object.assign({ redirect: "manual" }, init || {}));
      let body = null;
      try { body = await r.json(); } catch (_) {}
      return { status: r.status, body: body };
    } catch (err) { return { status: 0, error: err.message }; }
  }

  let r = await req("/api/health");
  ok("public health answers", r.status === 200, "HTTP " + r.status);
  ok("…and reports storage configured", !!(r.body && r.body.storage === true), JSON.stringify(r.body));

  if (process.env.ADMIN_API_TOKEN) {
    r = await req("/api/health", { headers: { Authorization: "Bearer " + process.env.ADMIN_API_TOKEN } });
    const probe = r.body && r.body.storage && r.body.storage.probe;
    ok("detailed health: database reachable", !!(probe && probe.reachable), JSON.stringify(probe));
    ok("detailed health: migration applied", !!(probe && probe.migrationApplied), JSON.stringify(probe));
    ok("detailed health: storage driver is supabase", !!(r.body && r.body.storage && r.body.storage.driver === "supabase"));
    if (r.body && r.body.nextSteps && r.body.nextSteps.length) {
      console.log("        nextSteps:\n          - " + r.body.nextSteps.join("\n          - "));
    }
  } else {
    skip("detailed health", "ADMIN_API_TOKEN not set locally");
  }

  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_livecheckbad", order_id: "order_livecheckbad" } } } });
  r = await req("/api/razorpay/webhook", { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": "0".repeat(64) }, body: raw });
  ok("webhook endpoint rejects a bad signature (401, not 500/503)", r.status === 401,
     "HTTP " + r.status + (r.status === 503 ? " — RAZORPAY_WEBHOOK_SECRET or Razorpay keys not set on the deployment" : "") +
     (r.status === 500 ? " — raw body unavailable on this runtime; webhooks would never verify" : ""));

  r = await req("/api/jobs/maintenance", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  ok("scheduled job refuses an anonymous caller", r.status === 401, "HTTP " + r.status);
  r = await req("/api/admin/orders");
  ok("admin API refuses an anonymous caller", r.status === 401, "HTTP " + r.status);

  for (const p of ["/server/_lib/db.js", "/db/schema.sql", "/test/run-tests.js", "/CUSTOMER-DATA-AUDIT.md"]) {
    const s = await req(p);
    ok("source file " + p + " is not publicly served", s.status !== 200, "HTTP " + s.status);
  }
}

/* ── 5. pricing agreement ────────────────────────────────────────────────── */

function checkPricing() {
  section("Pricing + discount arithmetic");

  const priced = catalog.priceCart([{ id: "seduction", qty: 1 }]);
  const totals = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, { prepaid: true });
  ok("single-item total is ₹858 (799 − 5% prepaid + 99 shipping)", totals.total === 858,
     "got " + totals.total + " — check that server/_lib/catalog.js and js/commerce/config.js agree");

  const withPromo = catalog.calculateTotals(priced.subtotal, priced.totalQty, false, {
    prepaid: true, discount: { code: "NAFUME10", type: "percentage", value: 10 }
  });
  ok("NAFUME10 reduces the payable amount", withPromo.total < totals.total,
     withPromo.total + " vs " + totals.total);
  ok("a discount can never take the payable below ₹1", withPromo.total >= catalog.MIN_PAYABLE);
}

/* ── cleanup ─────────────────────────────────────────────────────────────── */

async function cleanup() {
  if (KEEP) {
    console.log("\n--keep given: test rows left in place (marker " + TEST_MARKER + ")");
    return;
  }
  section("Cleanup");
  let removed = 0;

  // Deletes ONLY rows this run created, by id. Nothing else is ever touched.
  for (const order of created.orders) {
    try {
      if (order.uuid) await db.update("orders", { where: { id: order.uuid }, set: { order_status: "cancelled" } });
      removed++;
    } catch (_) {}
  }
  for (const id of created.customers) {
    try {
      await db.update("customers", { where: { id: id }, set: { name: "deleted-livecheck" } });
      removed++;
    } catch (_) {}
  }

  console.log("  Marked " + removed + " test record(s) as cancelled/deleted.");
  console.log("  The storage driver has no DELETE verb, so remove them fully with:");
  console.log("    DELETE FROM orders                  WHERE order_id LIKE 'NF-LIVECHECK-%';");
  console.log("    DELETE FROM verification_challenges WHERE identifier LIKE 'livecheck-%@nafume-livecheck.invalid';");
  console.log("    DELETE FROM customers               WHERE source = 'live_check';");
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  console.log("NAFUME — live service check");
  console.log("Marker for anything written: " + TEST_MARKER);

  if (VERIFY_MARKER) {
    await verifyPersistence(VERIFY_MARKER);
  } else {
    const report = checkConfig();
    checkPricing();

    if (report.missingRequired.length) {
      console.log("\n  Required variables are missing — skipping the live checks that need them.");
    }

    const supabaseOk = await checkSupabase();
    await checkRazorpay();
    await checkResend();
    if (WRITE_PROBE) await writePersistenceProbe();
    if (SITE) await checkSite(SITE);

    if (supabaseOk) await cleanup();
  }

  console.log("\n" + "═".repeat(70));
  console.log("  " + passed + " passed, " + failed + " failed, " + skipped + " skipped");
  if (notes.length) {
    console.log("\nNotes:");
    notes.forEach(function (n) { console.log("  • " + n); });
  }
  if (failed === 0 && skipped === 0) {
    console.log("\n  All live services verified. The ⚠️ rows in the verification matrix become ✅.");
  } else if (failed === 0) {
    console.log("\n  Everything configured passed. Skipped items need their credentials before they can be verified.");
  } else {
    console.log("\n  Fix the failures above before going live.");
  }
  console.log("═".repeat(70));
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (err) {
  console.error("live check crashed:", err);
  process.exit(1);
});
