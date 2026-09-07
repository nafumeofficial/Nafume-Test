/*
 * POST /api/leads/subscribe  —  email capture (exit-intent / scroll popup)
 * ============================================================================
 * Stores the visitor as a LEAD, never as a customer and never as an order. A
 * lead row means "this person gave us an email and has not bought yet".
 *
 * Duplicate emails are handled gracefully: leads has UNIQUE(email_normalized,
 * source), so re-subscribing refreshes the existing row and returns the SAME
 * discount code the visitor was given the first time, with alreadySubscribed:
 * true. It is a 200, not an error — the visitor did nothing wrong.
 *
 * Body: { email, source?, meta? }
 * Response always carries the discount code so the UI can show it immediately,
 * whether or not an email provider is configured.
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const messaging = require("../_lib/messaging");
const db        = require("../_lib/db");

const ALLOWED_SOURCES = ["popup_lead", "footer", "fragrance_quiz"];

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "lead", limit: 25, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "lead-ip", limit: 20, windowMs: 30 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  const emailNorm = validate.normalizeEmail(body.email);
  if (!emailNorm) {
    return http.fail(res, 400, "invalid_email", "Please enter a valid email address.",
      { fields: { email: "Please enter a valid email address." } });
  }

  const source = ALLOWED_SOURCES.indexOf(String(body.source || "")) !== -1
    ? String(body.source) : "popup_lead";

  const offer = catalog.POPUP_OFFER;

  // Only a small, fixed set of context fields is stored — never arbitrary
  // client-supplied JSON, and never anything identifying beyond the email.
  const meta = {
    trigger: ["exit_intent", "scroll", "manual"].indexOf(String((body.meta || {}).trigger)) !== -1
      ? String(body.meta.trigger) : "unknown",
    page: validate.clean((body.meta || {}).page, 120) || null
  };

  try {
    const now = db.nowISO();
    const existing = await db.selectOne("leads", { email_normalized: emailNorm, source: source });

    if (existing) {
      await db.update("leads", {
        where: { id: existing.id },
        set:   { updated_at: now, metadata: Object.assign({}, existing.metadata, meta) }
      });
      return http.ok(res, {
        alreadySubscribed: true,
        discount: {
          code: existing.discount_code || offer.code,
          label: existing.discount_label || offer.label,
          terms: offer.terms
        },
        emailed: false,
        message: "You're already on the list — here's your code again."
      });
    }

    const row = {
      id:               db.newId(),
      email:            validate.displayEmail(body.email),
      email_normalized: emailNorm,
      source:           source,
      discount_code:    offer.code,
      discount_label:   offer.label,
      metadata:         meta,
      converted_at:     null,
      created_at:       now,
      updated_at:       now
    };

    try {
      await db.insert("leads", row);
    } catch (err) {
      if (err instanceof db.UniqueViolationError) {
        // Raced with another submit of the same address — treat as a duplicate.
        return http.ok(res, {
          alreadySubscribed: true,
          discount: { code: offer.code, label: offer.label, terms: offer.terms },
          emailed: false,
          message: "You're already on the list — here's your code again."
        });
      }
      throw err;
    }

    // Emailing the code is a bonus; the code is shown on screen regardless, so
    // a missing provider never blocks the capture. `emailed` reports the truth.
    const mail = await messaging.send({
      channel: "email",
      to: row.email,
      subject: "Your " + offer.percentOff + "% off NAFUME code",
      body: messaging.leadDiscountEmail(offer),
      relatedType: "lead",
      relatedId: row.id
    });

    return http.ok(res, {
      alreadySubscribed: false,
      discount: { code: offer.code, label: offer.label, terms: offer.terms },
      emailed: mail.sent === true,
      message: "Your discount code is ready."
    });

  } catch (err) {
    return http.handleError(res, err, "leads/subscribe");
  }
};
