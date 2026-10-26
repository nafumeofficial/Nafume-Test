/*
 * server/_lib/desk.js  —  send orders to the NAFUME Desk dashboard
 * ============================================================================
 * Every order that becomes real (a COD order, an order on WhatsApp, an online
 * order once PAID) is sent to the Desk dashboard (nafume-desk.pages.dev) so the
 * team sees it in one place.
 *
 * HOW IT STAYS RELIABLE
 *   queueOrder(orderId)  writes a row to `desk_events` FIRST, then makes one
 *   quick attempt to deliver. If the Desk is down or slow the row stays queued
 *   and the scheduled job (jobs/drain-desk) retries it. Nothing is lost and a
 *   checkout never fails because the dashboard is unreachable.
 *
 *   What is sent is always a fresh SNAPSHOT of the order taken at send time, so
 *   retries and repeats are harmless: the Desk treats the same order idempotently.
 *
 * SECURITY
 *   The request is signed:  HMAC-SHA256(DESK_INTAKE_SECRET, timestamp + "." + body).
 *   The secret never leaves the server and is never logged.
 *
 * Needs DESK_INTAKE_URL and DESK_INTAKE_SECRET; without both this is a no-op.
 */
"use strict";

const crypto = require("crypto");
const db     = require("./db");

const SEND_TIMEOUT_MS  = 3000;     // inline attempt while a customer waits
const DRAIN_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS     = 12;

function configured() {
  return !!(String(process.env.DESK_INTAKE_URL || "").trim() && String(process.env.DESK_INTAKE_SECRET || "").trim());
}

function signature(secret, timestamp, rawBody) {
  return crypto.createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
}

/* One signed delivery. Resolves { ok, status, error } — never throws. */
async function deliver(snapshot, timeoutMs) {
  const url    = String(process.env.DESK_INTAKE_URL).trim();
  const secret = String(process.env.DESK_INTAKE_SECRET).trim();
  const raw    = JSON.stringify({ event: "order.sync", order: snapshot });
  const ts     = String(Date.now());
  const ctrl   = new AbortController();
  const timer  = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nafume-timestamp": ts,
        "x-nafume-signature": signature(secret, ts, raw)
      },
      body: raw,
      signal: ctrl.signal
    });
    if (resp.ok) return { ok: true, status: resp.status };
    return { ok: false, status: resp.status, error: "Desk answered " + resp.status };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.name === "AbortError" ? "Desk timed out" : "Desk unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function snapshotFor(orderId) {
  const repo  = require("./repo");                       // lazy: repo requires this module
  const order = await repo.getOrderByOrderId(orderId);
  if (!order) return null;
  return repo.publicOrder(order, await repo.getOrderItems(order.id));
}

/* Records the order for the Desk and tries once. Safe to call anywhere; never
   throws, never blocks checkout for more than SEND_TIMEOUT_MS. */
async function queueOrder(orderId) {
  try {
    if (!configured() || !db.isConfigured()) return { queued: false };

    let ev = await db.selectOne("desk_events", { order_id: orderId, status: ["in", ["queued", "failed"]] });
    if (!ev) {
      const row = { id: db.newId(), order_id: orderId, status: "queued", attempts: 0, created_at: db.nowISO() };
      const inserted = await db.insert("desk_events", row);
      ev = (inserted && inserted[0]) || row;
    }
    return await attempt(ev, SEND_TIMEOUT_MS);
  } catch (err) {
    console.error("[desk] could not queue order", orderId, err && err.message);
    return { queued: false, error: "queue_failed" };
  }
}

async function attempt(ev, timeoutMs) {
  const snap = await snapshotFor(ev.order_id);
  if (!snap) {
    await db.update("desk_events", { where: { id: ev.id }, set: { status: "failed", last_error: "order not found", attempts: MAX_ATTEMPTS } });
    return { queued: true, sent: false, error: "order_not_found" };
  }
  // Claim the attempt first, so two runs cannot both count it.
  const attempts = (ev.attempts || 0) + 1;
  await db.update("desk_events", { where: { id: ev.id }, set: { attempts: attempts } });
  const result = await deliver(snap, timeoutMs);
  if (result.ok) {
    await db.update("desk_events", { where: { id: ev.id }, set: { status: "sent", sent_at: db.nowISO(), last_error: null } });
    return { queued: true, sent: true };
  }
  await db.update("desk_events", { where: { id: ev.id }, set: {
    status: attempts >= MAX_ATTEMPTS ? "failed" : "queued", last_error: result.error || "failed" } });
  console.error("[desk] delivery failed for", ev.order_id, "-", result.error);
  return { queued: true, sent: false, error: result.error };
}

/* ── Desk → website: shipping and status updates ────────────────────────────
   The team ships and delivers orders in the Desk. The website asks the Desk what
   changed on recent website orders and applies it, so the customer's "Track
   order" page shows the courier and tracking number.

   RULES
     * Orders only move FORWARD. A later state on the website is never undone.
     * Cancelling in the Desk cancels on the website only while nothing has been
       shipped. If the customer already paid online, the payment stays recorded as
       paid: the refund is a manual decision.
     * A website order waiting for WhatsApp confirmation is confirmed when the Desk
       moves it past "New".
     * The request is signed like the order delivery, with its own prefix so a
       signature for one purpose cannot be reused for the other.             */

function pullUrl() {
  return String(process.env.DESK_INTAKE_URL || "").trim().replace(/\/intake\/?$/, "/web-updates");
}

async function fetchUpdates(timeoutMs) {
  const secret = String(process.env.DESK_INTAKE_SECRET).trim();
  const since  = new Date(Date.now() - 30 * 864e5).toISOString();
  const ts     = String(Date.now());
  const sig    = crypto.createHmac("sha256", secret).update("desk-pull." + ts + "." + since).digest("hex");
  const ctrl   = new AbortController();
  const timer  = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    const resp = await fetch(pullUrl() + "?since=" + encodeURIComponent(since), {
      method: "GET",
      headers: { "x-nafume-timestamp": ts, "x-nafume-signature": sig },
      signal: ctrl.signal
    });
    if (!resp.ok) return { ok: false, error: "Desk answered " + resp.status };
    const body = await resp.json().catch(function () { return null; });
    if (!body || !Array.isArray(body.orders)) return { ok: false, error: "Desk sent an unexpected reply" };
    return { ok: true, orders: body.orders };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "Desk timed out" : "Desk unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function validIso(v) {
  const t = Date.parse(v);
  return isFinite(t) && t <= Date.now() + 24 * 3600 * 1000 ? new Date(t).toISOString() : null;
}

/* applyUpdate(u) -> "applied" | "unchanged" | "skipped"   (never throws on bad data) */
async function applyUpdate(u) {
  const repo = require("./repo");
  const discounts = require("./discounts");
  if (!u || typeof u.orderId !== "string") return "skipped";
  const order = await repo.getOrderByOrderId(u.orderId);
  if (!order) return "skipped";
  if (order.order_status === "cancelled") return "unchanged";

  const now   = db.nowISO();
  const patch = {};
  const status = String(u.status || "");
  const wasUnfulfilled = order.fulfillment_status === "unfulfilled";

  // Cancelled in the Desk
  if (status === "cancelled") {
    if (order.fulfillment_status !== "unfulfilled") return "unchanged";     // already on its way
    patch.order_status = "cancelled";
    if (order.payment_status === "paid") patch.payment_note = "cancelled in the Desk; refund if needed";
    patch.updated_at = now;
    await db.update("orders", { where: { id: order.id }, set: patch });
    try { await discounts.releaseRedemption(order.order_id); } catch (e) { console.error("[desk] release failed:", e && e.message); }
    return "applied";
  }

  // WhatsApp order: the Desk moving it past "New" means staff confirmed it
  const past = ["confirmed", "packed", "shipped", "delivered"].indexOf(status) !== -1;
  let confirmedNow = false;
  if (order.order_status === "awaiting_whatsapp" && past) { patch.order_status = "confirmed"; confirmedNow = true; }

  // Money received outside Razorpay (COD cash, UPI arranged on WhatsApp)
  if (u.paid === true && order.payment_status !== "paid" && order.payment_method !== "razorpay") {
    patch.payment_status = "paid"; patch.paid_at = now;
    patch.payment_confirmed_via = "desk"; patch.payment_note = "marked paid in the Desk";
  }

  // Shipping details
  if (status === "shipped" || status === "delivered") {
    const awb = typeof u.awb === "string" ? u.awb.trim().slice(0, 60) : "";
    const courier = typeof u.courier === "string" ? u.courier.trim().slice(0, 80) : "";
    if (awb && awb !== order.awb) patch.awb = awb;
    if (courier && courier !== order.courier_name) patch.courier_name = courier;
    if (!order.shipped_at) patch.shipped_at = validIso(u.shippedAt) || validIso(u.deliveredAt) || now;
    if (wasUnfulfilled) patch.fulfillment_status = "shipped";
  }
  if (status === "delivered" && order.fulfillment_status !== "delivered") {
    patch.fulfillment_status = "delivered";
    patch.delivered_at = validIso(u.deliveredAt) || now;
  }

  if (!Object.keys(patch).length) return "unchanged";
  patch.updated_at = now;
  const rows = await db.update("orders", { where: { id: order.id }, set: patch });
  if (confirmedNow) {
    try { await discounts.markRedeemed(order.order_id); } catch (e) { console.error("[desk] redeem failed:", e && e.message); }
  }
  // Customer emails for what just changed (each is sent at most once per order).
  const emails = require("./order-emails");
  const fresh = (rows && rows[0]) || order;
  if (confirmedNow) await emails.sendConfirmed(fresh);
  if (status === "shipped" && wasUnfulfilled) await emails.sendShipped(fresh);
  return "applied";
}

/* Asks the Desk what changed and applies it. Used by jobs/drain-desk. */
async function pullUpdates() {
  const summary = { fetched: 0, applied: 0, unchanged: 0, skipped: 0 };
  if (!configured()) { summary.note = "DESK_INTAKE_URL / DESK_INTAKE_SECRET not set"; return summary; }
  const got = await fetchUpdates(DRAIN_TIMEOUT_MS);
  if (!got.ok) { summary.error = got.error; console.error("[desk] could not read updates -", got.error); return summary; }
  summary.fetched = got.orders.length;
  for (let i = 0; i < got.orders.length; i++) {
    try { summary[await applyUpdate(got.orders[i])]++; }
    catch (err) { summary.skipped++; console.error("[desk] update failed for", got.orders[i] && got.orders[i].orderId, err && err.message); }
  }
  return summary;
}

/* Retries everything still queued. Used by jobs/drain-desk. */
async function drain(limit) {
  const summary = { scanned: 0, sent: 0, failed: 0, givenUp: 0 };
  if (!configured()) { summary.note = "DESK_INTAKE_URL / DESK_INTAKE_SECRET not set"; return summary; }
  const rows = await db.select("desk_events", {
    where: { status: "queued" }, order: { column: "created_at", ascending: true }, limit: limit || 40 });
  for (let i = 0; i < rows.length; i++) {
    summary.scanned++;
    if ((rows[i].attempts || 0) >= MAX_ATTEMPTS) { summary.givenUp++; continue; }
    const r = await attempt(rows[i], DRAIN_TIMEOUT_MS);
    if (r.sent) summary.sent++; else summary.failed++;
  }
  return summary;
}

async function backlog() {
  if (!db.isConfigured()) return null;
  try { return { queued: await db.count("desk_events", { where: { status: "queued" } }),
                failed: await db.count("desk_events", { where: { status: "failed" } }) }; }
  catch (_) { return null; }
}

module.exports = { configured, queueOrder, drain, pullUpdates, applyUpdate, backlog, signature, MAX_ATTEMPTS };
