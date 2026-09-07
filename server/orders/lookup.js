/*
 * POST /api/orders/lookup  —  fetch one order (confirmation page, guest tracking)
 * ============================================================================
 * Two ways to be authorised for an order, and you need exactly one of them:
 *   a) a session whose customer owns the order, or
 *   b) the order id PLUS the email or phone the order was placed with.
 *
 * (b) exists because guests never create an account and still need their
 * confirmation page to work. It is not a weak check: the order id is random and
 * the contact detail must match the order exactly. Both wrong-id and
 * wrong-contact return the same 404, so the endpoint cannot be used to test
 * whether an order id exists.
 *
 * Body: { orderId, contact? }
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const auth     = require("../_lib/auth");
const repo     = require("../_lib/repo");
const db       = require("../_lib/db");

const NOT_FOUND = "We couldn't find that order. Please check the order ID and the email or phone used to place it.";

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  // Tighter than most: this is the one endpoint where guessing has any value.
  // Still generous enough for carrier NAT — the real defence is that both the
  // random order id AND a matching contact detail are required.
  if (!http.rateLimit(req, res, { key: "order-lookup", limit: 40, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const orderId = validate.clean(body.orderId, 40);
  if (!orderId || !/^[A-Za-z0-9_-]{4,40}$/.test(orderId)) {
    return http.fail(res, 400, "invalid_order_id", "Please enter a valid order ID.");
  }

  try {
    const order = await repo.getOrderByOrderId(orderId);
    if (!order) return http.fail(res, 404, "order_not_found", NOT_FOUND);

    /* ── (a) session ownership ──────────────────────────────────────────── */
    let authorised = false;
    const session = await auth.getSession(req);
    if (session && order.customer_id && session.customer.id === order.customer_id) {
      authorised = true;
    }

    /* ── (b) matching contact detail ────────────────────────────────────── */
    if (!authorised) {
      const raw   = validate.clean(body.contact, 254);
      const email = validate.normalizeEmail(raw);
      const phone = validate.normalizePhone(raw);
      if (email && order.ship_email && validate.normalizeEmail(order.ship_email) === email) authorised = true;
      if (phone && order.ship_phone && validate.normalizePhone(order.ship_phone) === phone) authorised = true;
    }

    if (!authorised) {
      // Same response as "no such order" — never confirm that an id is real.
      return http.fail(res, 404, "order_not_found", NOT_FOUND);
    }

    const items = await repo.getOrderItems(order.id);
    const review = order.review_id
      ? await db.selectOne("reviews", { id: order.review_id })
      : null;

    return http.ok(res, {
      order: repo.publicOrder(order, items),
      reviewSubmitted: !!review
    });

  } catch (err) {
    return http.handleError(res, err, "orders/lookup");
  }
};
