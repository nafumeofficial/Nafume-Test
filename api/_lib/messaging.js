/*
 * api/_lib/messaging.js  —  durable outbox for customer-facing messages
 * ============================================================================
 * Every email/WhatsApp message is WRITTEN DOWN first (outbound_messages, status
 * 'queued') and only then attempted with a provider. The row is updated to
 * 'sent' or 'failed' based on what actually happened.
 *
 * Why an outbox rather than a direct send:
 *   - When no provider is configured the message stays 'queued'. Nothing is
 *     lost, nothing is faked, and adding credentials later lets the same rows
 *     be drained. `sent: false` is reported honestly to the caller.
 *   - A provider outage becomes a retryable row instead of a silent gap.
 *
 * Providers currently wired:
 *   email     Resend REST API — set RESEND_API_KEY.  (already used by this repo)
 *   whatsapp  none. Messages are queued with channel 'whatsapp' and are NEVER
 *             marked sent. See docs/customer-data-system.md for what a provider
 *             integration needs to implement; do not mark anything sent until
 *             one exists.
 */
"use strict";

const db = require("./db");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_TO      = process.env.ORDER_NOTIFY_EMAIL_TO   || "nafume.official@gmail.com";
const NOTIFY_FROM    = process.env.ORDER_NOTIFY_EMAIL_FROM || "NAFUME Orders <onboarding@resend.dev>";
const CUSTOMER_FROM  = process.env.CUSTOMER_EMAIL_FROM     || NOTIFY_FROM;

function emailConfigured()    { return !!RESEND_API_KEY; }

/* ── WhatsApp adapter ────────────────────────────────────────────────────────
   No provider is integrated, and none is faked. This is the seam one goes in.

   TO ADD A PROVIDER (Gupshup, Interakt, Twilio, Meta Cloud API, …):
     1. Implement sendViaWhatsAppProvider() below. It must return
        { sent: true, id } or { sent: false, error }, and must never throw.
     2. Make whatsappConfigured() return true only when its credentials exist.
     3. Add the credential names to .env.example and api/_lib/config-check.js.
   Nothing else changes: send() already records every message in
   outbound_messages first, so queued messages start delivering the moment the
   adapter reports itself configured.

   THE CONSENT RULE — do not weaken this.
     TRANSACTIONAL messages are about an order the customer placed (confirmed,
     shipped, delivered). They are a service message and do not require
     marketing consent.
     MARKETING messages (recommendations, offers, launches) require an explicit,
     un-revoked WhatsApp opt-in.
   sendWhatsApp() below enforces that difference in code rather than trusting
   the caller to remember it, and marketing recipients must come from the
   whatsapp_broadcast_audience view (see db/schema.sql), never from the orders
   table.                                                                     */

function whatsappConfigured() {
  // No provider credentials exist in this repo. Returning false keeps every
  // WhatsApp message honestly 'queued' instead of claiming a delivery.
  return false;
}

async function sendViaWhatsAppProvider(/* to, body, kind */) {
  return { sent: false, error: "whatsapp_provider_not_configured" };
}

/* hasWhatsAppMarketingConsent(customerId) -> boolean
   The single source of truth for "may we market to this person on WhatsApp".
   An opt-in that was later revoked returns false immediately — consent is read
   live, never cached into an audience list that could go stale. */
async function hasWhatsAppMarketingConsent(customerId) {
  if (!customerId) return false;
  try {
    const row = await db.selectOne("marketing_consent", {
      customer_id: customerId, channel: "whatsapp"
    });
    return !!(row && row.opted_in === true && !row.revoked_at);
  } catch (err) {
    // Never assume consent when we cannot verify it.
    console.error("[messaging] consent lookup failed — treating as NOT consented:", err && err.message);
    return false;
  }
}

/* sendWhatsApp({ to, body, kind, customerId, relatedType, relatedId })
   kind: "transactional" | "marketing"   (required — no default, on purpose)

   A marketing message without verified consent is REFUSED and never queued, so
   it cannot be drained later by a future provider either. */
async function sendWhatsApp(msg) {
  const kind = msg && msg.kind;
  if (kind !== "transactional" && kind !== "marketing") {
    console.error("[messaging] sendWhatsApp requires kind 'transactional' or 'marketing'");
    return { queued: false, sent: false, reason: "missing_kind" };
  }

  if (kind === "marketing") {
    const consented = await hasWhatsAppMarketingConsent(msg.customerId);
    if (!consented) {
      // Not an error — the correct outcome for someone who did not opt in.
      return { queued: false, sent: false, reason: "no_marketing_consent" };
    }
  }

  return send({
    channel:     "whatsapp",
    to:          msg.to,
    subject:     kind,
    body:        msg.body,
    relatedType: msg.relatedType || null,
    relatedId:   msg.relatedId || null
  });
}

/* ── HTML helpers ────────────────────────────────────────────────────────── */

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }

/* safeAddress(value, channel) -> a usable recipient, or null.

   Two jobs, and both matter:
     1. Header injection — a CR/LF in an address could append headers such as
        Bcc:. Control characters are stripped before anything else happens.
     2. Actual validity — stripping newlines out of
        "someone@x.com\nBcc: evil@y.com" leaves a non-empty string that is not
        an address. Passing that to a provider is at best a wasted call and at
        worst a smuggling attempt, so the result must still parse as a real
        address for the channel before it is accepted.
   Anything that fails is recorded as a failed message rather than attempted. */
function safeAddress(v, channel) {
  // Strip ASCII control characters (CR, LF, NUL, ...) - the header-injection
  // vector - before anything else is considered.
  const cleaned = String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned || cleaned.length > 254) return null;

  if (channel === "whatsapp") {
    const digits = cleaned.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 ? digits : null;
  }

  // Email: exactly one @, no spaces, a dotted domain. Mirrors
  // api/_lib/validate.js so an address accepted at checkout is accepted here.
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(cleaned)) return null;
  return cleaned;
}

/* ── outbox ──────────────────────────────────────────────────────────────── */

/* queue(msg) -> row
   msg = { channel, to, subject, body, relatedType, relatedId } */
async function queue(msg) {
  const channel = msg.channel === "whatsapp" ? "whatsapp" : "email";
  const to = safeAddress(msg.to, channel);
  const row = {
    id:                  db.newId(),
    channel:             msg.channel === "whatsapp" ? "whatsapp" : "email",
    to_address:          to || "",
    subject:             msg.subject || null,
    body:                msg.body || null,
    status:              "queued",
    provider:            null,
    provider_message_id: null,
    error:               to ? null : "invalid_recipient",
    related_type:        msg.relatedType || null,
    related_id:          msg.relatedId ? String(msg.relatedId) : null,
    attempts:            0,
    created_at:          db.nowISO(),
    sent_at:             null
  };
  if (!to) row.status = "failed";

  const inserted = await db.insert("outbound_messages", row);
  return (inserted && inserted[0]) || row;
}

async function markSent(id, provider, providerMessageId) {
  await db.update("outbound_messages", {
    where: { id: id },
    set:   { status: "sent", provider: provider, provider_message_id: providerMessageId || null,
             sent_at: db.nowISO(), attempts: 1, error: null }
  });
}
async function markFailed(id, reason) {
  await db.update("outbound_messages", {
    where: { id: id },
    set:   { status: "failed", attempts: 1, error: String(reason || "").slice(0, 300) }
  });
}

/* ── Resend ──────────────────────────────────────────────────────────────── */

async function sendViaResend(to, subject, html, from) {
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + RESEND_API_KEY
      },
      body: JSON.stringify({ from: from || CUSTOMER_FROM, to: [to], subject: subject, html: html }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const payload = await resp.json().catch(function () { return null; });
    if (!resp.ok) {
      return { sent: false, error: "resend_" + resp.status };
    }
    return { sent: true, id: payload && payload.id ? payload.id : null };
  } catch (err) {
    clearTimeout(timer);
    return { sent: false, error: err.name === "AbortError" ? "timeout" : "network_error" };
  }
}

/* alreadySent(msg) — has this exact message already gone out?
   Guards against a retried request re-emailing a customer. Keyed on
   (related_type, related_id, subject), which is precise enough to stop a
   duplicate order confirmation while still allowing genuinely different
   messages about the same order (confirmation, then shipped, then review). */
async function alreadySent(msg) {
  if (!msg.relatedType || !msg.relatedId || !msg.dedupe) return false;
  try {
    const rows = await db.select("outbound_messages", {
      where: {
        related_type: msg.relatedType,
        related_id:   String(msg.relatedId),
        subject:      msg.subject || null,
        status:       "sent"
      },
      limit: 1
    });
    return rows.length > 0;
  } catch (_) {
    return false;   // never block a send because the check failed
  }
}

/* ── public send ─────────────────────────────────────────────────────────────
   Never throws. Always records the attempt. Returns { queued, sent, reason }.

   Email is a SIDE EFFECT, never part of the transaction. Every caller treats a
   false return as information, not as a failure to undo an order — a paid order
   stays paid whether or not its confirmation email leaves the building.       */

async function send(msg) {
  if (await alreadySent(msg)) {
    return { queued: true, sent: true, reason: "already_sent", duplicate: true };
  }

  let row;
  try {
    row = await queue(msg);
  } catch (err) {
    // The outbox itself is unavailable — say so instead of silently dropping.
    console.error("[messaging] could not queue message:", err && err.message);
    return { queued: false, sent: false, reason: "outbox_unavailable" };
  }

  if (row.status === "failed") return { queued: true, sent: false, reason: "invalid_recipient", id: row.id };

  if (row.channel === "whatsapp") {
    if (!whatsappConfigured()) {
      // Left queued on purpose. Nothing claims a delivery that did not happen,
      // and the row is ready to drain the moment a provider is wired up.
      return { queued: true, sent: false, reason: "whatsapp_provider_not_configured", id: row.id };
    }
    const wa = await sendViaWhatsAppProvider(row.to_address, row.body, row.subject);
    try {
      if (wa.sent) await markSent(row.id, "whatsapp", wa.id);
      else await markFailed(row.id, wa.error);
    } catch (_) {}
    return { queued: true, sent: wa.sent, reason: wa.sent ? null : wa.error, id: row.id };
  }
  if (!emailConfigured()) {
    return { queued: true, sent: false, reason: "email_provider_not_configured", id: row.id };
  }

  const result = await sendViaResend(row.to_address, row.subject, row.body, msg.from);
  try {
    if (result.sent) await markSent(row.id, "resend", result.id);
    else await markFailed(row.id, result.error);
  } catch (_) { /* the send outcome matters more than the bookkeeping */ }

  return { queued: true, sent: result.sent, reason: result.sent ? null : result.error, id: row.id };
}

/* deliverQueuedRow(row)
   Retries one already-persisted outbox row. Used by /api/jobs/drain-outbox to
   deliver messages that were queued while no provider was configured, or that
   failed a transient provider error. Never throws. */
async function deliverQueuedRow(row) {
  if (!row || !row.to_address) return { sent: false, reason: "invalid_recipient" };

  if (row.channel === "whatsapp") {
    if (!whatsappConfigured()) return { sent: false, reason: "whatsapp_provider_not_configured" };
    const wa = await sendViaWhatsAppProvider(row.to_address, row.body, row.subject);
    try {
      if (wa.sent) await markSent(row.id, "whatsapp", wa.id);
      else await markFailed(row.id, wa.error);
    } catch (_) {}
    return { sent: wa.sent, reason: wa.sent ? null : wa.error };
  }

  if (!emailConfigured()) return { sent: false, reason: "email_provider_not_configured" };

  const result = await sendViaResend(row.to_address, row.subject, row.body, null);
  try {
    if (result.sent) await markSent(row.id, "resend", result.id);
    else await markFailed(row.id, result.error);
  } catch (_) {}
  return { sent: result.sent, reason: result.sent ? null : result.error };
}

/* ── templates ───────────────────────────────────────────────────────────── */

const BRAND_WRAP = function (inner) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;' +
         'color:#222;line-height:1.6;">' + inner +
         '<hr style="border:none;border-top:1px solid #eee;margin:28px 0 14px;"/>' +
         '<p style="font-size:11px;color:#999;">NAFUME Artisan Luxe · ' +
         'You are receiving this because you shopped with or subscribed to NAFUME.</p></div>';
};

function orderPaidTeamEmail(order, items) {
  const rows = (items || []).map(function (i) {
    return '<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">' +
      escapeHtml(i.product_name) + ' &times; ' + escapeHtml(i.quantity) +
      '</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">' +
      money(i.line_total) + '</td></tr>';
  }).join("");

  const address = [order.ship_line1, order.ship_line2, order.ship_city,
                   order.ship_state, order.ship_pincode].filter(Boolean).map(escapeHtml).join(", ");

  return BRAND_WRAP(
    '<h2 style="color:#111;">NAFUME Order Paid — Razorpay</h2>' +
    '<p style="font-size:13px;color:#555;">Order ID: <strong>' + escapeHtml(order.order_id) + '</strong><br/>' +
    'Razorpay Payment ID: <strong>' + escapeHtml(order.razorpay_payment_id) + '</strong></p>' +
    '<h3 style="margin-bottom:4px;">Customer</h3>' +
    '<p style="font-size:13px;margin-top:0;">' +
      'Name: ' + escapeHtml(order.ship_name) + '<br/>' +
      'Phone: ' + escapeHtml(order.ship_phone) + '<br/>' +
      'Email: ' + escapeHtml(order.ship_email) + '<br/>' +
      'Address: ' + address + '<br/>' +
      'WhatsApp marketing opt-in: <strong>' + (order.whatsapp_opt_in ? "YES" : "NO") + '</strong>' +
    '</p>' +
    '<h3 style="margin-bottom:4px;">Items</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' + rows + '</table>' +
    '<p style="font-size:14px;font-weight:bold;text-align:right;margin-top:10px;">Total Paid: ' +
      money(order.amount_total) + '</p>' +
    '<p style="font-size:12px;color:#888;">Payment verified server-side. Please process and dispatch.</p>'
  );
}

function orderPaidCustomerEmail(order, items, siteUrl) {
  const rows = (items || []).map(function (i) {
    return '<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">' +
      escapeHtml(i.product_name) + ' &times; ' + escapeHtml(i.quantity) +
      '</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;">' +
      money(i.line_total) + '</td></tr>';
  }).join("");

  const link = siteUrl
    ? '<p style="margin:22px 0;"><a href="' + escapeHtml(siteUrl) + '/pages/order/confirmation?orderId=' +
      encodeURIComponent(order.order_id) + '" style="background:#111;color:#fff;padding:12px 22px;' +
      'text-decoration:none;font-size:13px;letter-spacing:.08em;">VIEW YOUR ORDER</a></p>'
    : "";

  return BRAND_WRAP(
    '<h2 style="color:#111;">Thank you for your order</h2>' +
    '<p style="font-size:14px;">Hi ' + escapeHtml(order.ship_name || "there") + ', your payment has been ' +
    'confirmed and your NAFUME order is being prepared.</p>' +
    '<p style="font-size:13px;color:#555;">Order ID: <strong>' + escapeHtml(order.order_id) + '</strong></p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' + rows + '</table>' +
    '<p style="font-size:14px;font-weight:bold;text-align:right;margin-top:10px;">Total Paid: ' +
      money(order.amount_total) + '</p>' + link +
    '<p style="font-size:12px;color:#888;">We dispatch within 24 hours and will share tracking as soon as it ships.</p>'
  );
}

function leadDiscountEmail(offer) {
  return BRAND_WRAP(
    '<h2 style="color:#111;">Here is your ' + escapeHtml(offer.percentOff) + '% off</h2>' +
    '<p style="font-size:14px;">Use this code at checkout on your first NAFUME order:</p>' +
    '<p style="font-size:24px;letter-spacing:.18em;font-weight:bold;background:#faf6ef;' +
    'padding:16px;text-align:center;border:1px dashed #C5A059;">' + escapeHtml(offer.code) + '</p>' +
    '<p style="font-size:12px;color:#888;">' + escapeHtml(offer.terms) + '</p>'
  );
}

function quizResultEmail(result) {
  const p = result.product;
  return BRAND_WRAP(
    '<h2 style="color:#111;">Your fragrance match: ' + escapeHtml(p.shortName) + '</h2>' +
    '<p style="font-size:14px;">' + escapeHtml(p.blurb) + '</p>' +
    '<p style="font-size:13px;color:#555;">Based on your answers we also think you would enjoy <strong>' +
      escapeHtml(result.alternate.shortName) + '</strong>.</p>' +
    '<p style="font-size:12px;color:#888;">Your preferences: ' +
      escapeHtml((result.tags || []).join(", ")) + '</p>'
  );
}

function reviewRequestEmail(order, reviewUrl) {
  return BRAND_WRAP(
    '<h2 style="color:#111;">How is your NAFUME fragrance?</h2>' +
    '<p style="font-size:14px;">Hi ' + escapeHtml(order.ship_name || "there") + ', your order ' +
    '<strong>' + escapeHtml(order.order_id) + '</strong> was delivered a few days ago. ' +
    'Would you tell us what you think?</p>' +
    '<p style="margin:22px 0;"><a href="' + escapeHtml(reviewUrl) + '" style="background:#111;color:#fff;' +
    'padding:12px 22px;text-decoration:none;font-size:13px;letter-spacing:.08em;">WRITE A REVIEW</a></p>' +
    '<p style="font-size:13px;color:#555;">Leave a review and we will send you a discount code for your next order.</p>'
  );
}

module.exports = {
  send, queue, deliverQueuedRow, escapeHtml, money,
  sendWhatsApp, hasWhatsAppMarketingConsent,
  emailConfigured, whatsappConfigured,
  NOTIFY_TO, NOTIFY_FROM, CUSTOMER_FROM,
  orderPaidTeamEmail, orderPaidCustomerEmail,
  leadDiscountEmail, quizResultEmail, reviewRequestEmail
};
