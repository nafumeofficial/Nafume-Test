/*
 * POST /api/checkout/save-cart  —  remember a cart against an email, for a reminder
 * ============================================================================
 * Called by the checkout page once a valid email has been typed. The cart is
 * RE-PRICED here from the server catalogue; the browser's prices are never
 * stored. Safe to call repeatedly — it refreshes one row per email.
 *
 * Body: { email, name?, cart: [{ id, qty }] }
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const abandoned = require("../_lib/abandoned");
const db        = require("../_lib/db");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "save-cart", limit: 20, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "save-cart-ip", limit: 30, windowMs: 30 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  const emailNorm = validate.normalizeEmail(body.email);
  if (!emailNorm) return http.fail(res, 400, "invalid_email", "Please enter a valid email address.");

  const priced = catalog.priceCart(body.cart);
  if (priced.error) return http.fail(res, 400, priced.error, priced.message);

  try {
    const now = db.nowISO();
    const cart = {
      kind:        "abandoned_checkout",
      name:        validate.clean(body.name, 80) || null,
      items:       priced.lines.map(function (l) { return { productId: l.productId, name: l.productName, quantity: l.quantity }; }),
      subtotal:    priced.subtotal,
      savedAt:     now,
      remindedAt:  null,
      unsubscribed: false
    };

    const existing = await db.selectOne("leads", { email_normalized: emailNorm, source: abandoned.SOURCE });
    if (existing) {
      const prev = existing.metadata || {};
      if (prev.unsubscribed) return http.ok(res, { saved: false });          // they opted out: respect it, say nothing
      const recent = prev.remindedAt && (Date.parse(now) - Date.parse(prev.remindedAt)) < abandoned.REREMIND_AFTER_MS;
      cart.remindedAt = recent ? prev.remindedAt : null;                     // at most one reminder a week
      await db.update("leads", { where: { id: existing.id }, set: { metadata: cart, updated_at: now, converted_at: null } });
      return http.ok(res, { saved: true });
    }

    await db.insert("leads", {
      id: db.newId(), email: validate.displayEmail(body.email), email_normalized: emailNorm,
      source: abandoned.SOURCE, discount_code: null, discount_label: null,
      metadata: cart, converted_at: null, created_at: now, updated_at: now
    });
    return http.ok(res, { saved: true });
  } catch (err) {
    if (err instanceof db.UniqueViolationError) return http.ok(res, { saved: true });   // raced with ourselves
    return http.handleError(res, err, "checkout/save-cart");
  }
};
