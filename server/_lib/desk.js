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

module.exports = { configured, queueOrder, drain, backlog, signature, MAX_ATTEMPTS };
