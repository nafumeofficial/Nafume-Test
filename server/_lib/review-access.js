/*
 * api/_lib/review-access.js  —  who may review what
 * ============================================================================
 * Shared by /api/reviews/eligibility and /api/reviews/submit so the rules are
 * checked identically in both places. Showing a form and accepting a submission
 * must never disagree about who is allowed.
 *
 * A review is allowed when ALL of these hold:
 *   - the order exists and is PAID (an unpaid order is not a purchase)
 *   - the requester proves ownership: an authenticated session that owns the
 *     order, OR the email/phone the order was placed with
 *   - the product was actually in that order
 *   - no review already exists for that (order, product) pair
 *
 * Every failure returns the same generic not-found shape when the requester
 * failed to prove ownership, so this cannot be used to probe order ids.
 */
"use strict";

const validate = require("./validate");
const auth     = require("./auth");
const repo     = require("./repo");
const db       = require("./db");

const NOT_FOUND = "We couldn't find that order. Please check the order ID and the email or phone used to place it.";

/* resolveOrderAccess(req, { orderId, contact })
   -> { ok:false, status, code, message } | { ok:true, order, items, session } */
async function resolveOrderAccess(req, input) {
  const orderId = validate.clean(input.orderId, 40);
  if (!orderId || !/^[A-Za-z0-9_-]{4,40}$/.test(orderId)) {
    return { ok: false, status: 400, code: "invalid_order_id", message: "Please enter a valid order ID." };
  }

  const order = await repo.getOrderByOrderId(orderId);
  if (!order) return { ok: false, status: 404, code: "order_not_found", message: NOT_FOUND };

  let authorised = false;
  const session = await auth.getSession(req);
  if (session && order.customer_id && session.customer.id === order.customer_id) authorised = true;

  if (!authorised) {
    const raw   = validate.clean(input.contact, 254);
    const email = validate.normalizeEmail(raw);
    const phone = validate.normalizePhone(raw);
    if (email && order.ship_email && validate.normalizeEmail(order.ship_email) === email) authorised = true;
    if (phone && order.ship_phone && validate.normalizePhone(order.ship_phone) === phone) authorised = true;
  }

  if (!authorised) return { ok: false, status: 404, code: "order_not_found", message: NOT_FOUND };

  const items = await repo.getOrderItems(order.id);
  return { ok: true, order: order, items: items, session: session };
}

/* reviewableProducts(order, items)
   -> { eligible, reason, products: [{ productId, name, reviewed }] } */
async function reviewableProducts(order, items) {
  if (order.payment_status !== "paid") {
    return {
      eligible: false,
      reason: "not_paid",
      message: "This order has not been paid for, so it can't be reviewed yet.",
      products: []
    };
  }

  const existing = await db.select("reviews", { where: { order_id: order.order_id } });
  const reviewedIds = existing.map(function (r) { return r.product_id; });

  const products = items.map(function (i) {
    return {
      productId: i.product_id,
      name:      i.product_name,
      reviewed:  reviewedIds.indexOf(i.product_id) !== -1
    };
  });

  const remaining = products.filter(function (p) { return !p.reviewed; });

  return {
    eligible:  remaining.length > 0,
    reason:    remaining.length > 0 ? null : "already_reviewed",
    message:   remaining.length > 0
      ? null
      : "You've already reviewed everything in this order. Thank you!",
    products:  products,
    delivered: !!order.delivered_at
  };
}

module.exports = { resolveOrderAccess, reviewableProducts, NOT_FOUND };
