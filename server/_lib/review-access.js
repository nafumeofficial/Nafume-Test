/*
 * api/_lib/review-access.js  —  who may review what, and when
 * ============================================================================
 * Shared by /api/reviews/eligibility and /api/reviews/submit so the rules are
 * checked identically in both places. Showing a form and accepting a submission
 * must never disagree about who is allowed.
 *
 * ACCESS — one of:
 *   - a session whose customer OWNS the order (orders.verified_owner_customer_id:
 *     placed while signed in, or placed with an email/phone they verified), or
 *   - the review-link token from the post-delivery review-request email. Only
 *     its SHA-256 hash is stored (review_requests.access_token_hash); it is
 *     bound to one order and expires.
 *   An order id plus a typed email/phone is NOT enough: order ids are short and
 *   contact details are widely known, and a review earns a reward.
 *   Every failure — unknown order, wrong token, someone else's session — gets
 *   the same generic 404, so this cannot be used to probe order ids.
 *
 * ELIGIBILITY — all of:
 *   - the order is PAID and not cancelled
 *   - a delivery has been RECORDED (delivered_at set, fulfilment "delivered")
 *   - the product was in that order
 *   - no review already exists for that (order, product) pair
 *
 * Eligibility starts the moment delivery is recorded. The review-request EMAIL
 * is a separate, later nudge (REVIEW_REQUEST_DELAY_DAYS after delivery); a
 * signed-in owner can review straight away.
 */
"use strict";

const crypto   = require("crypto");
const validate = require("./validate");
const auth     = require("./auth");
const repo     = require("./repo");
const db       = require("./db");

const NOT_FOUND = "We couldn't open a review for that order. Use the link in your review email, or sign in to the account the order belongs to.";

function hashToken(token) {
  return crypto.createHash("sha256").update("nafume-review-link|" + String(token)).digest("hex");
}

/* newReviewToken() -> { token, hash } — the token goes in the email link only. */
function newReviewToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token: token, hash: hashToken(token) };
}

/* resolveOrderAccess(req, { orderId, token })
   -> { ok:false, status, code, message } | { ok:true, order, items, session, via } */
async function resolveOrderAccess(req, input) {
  const orderId = validate.clean(input.orderId, 40);
  if (!orderId || !/^[A-Za-z0-9_-]{4,40}$/.test(orderId)) {
    return { ok: false, status: 400, code: "invalid_order_id", message: "Please enter a valid order ID." };
  }

  const denied = { ok: false, status: 404, code: "order_not_found", message: NOT_FOUND };

  const order = await repo.getOrderByOrderId(orderId);
  const session = await auth.getSession(req);

  let via = null;
  if (order && session && repo.customerOwnsOrder(session.customer, order)) via = "session";

  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (order && !via && /^[A-Za-z0-9_-]{32,64}$/.test(token)) {
    const request = await db.selectOne("review_requests", { access_token_hash: hashToken(token) });
    if (request && request.order_id === order.order_id &&
        (!request.access_token_expires_at || new Date(request.access_token_expires_at).getTime() > Date.now())) {
      via = "review_link";
    }
  }

  if (!order || !via) return denied;

  const items = await repo.getOrderItems(order.id);
  return { ok: true, order: order, items: items, session: session, via: via };
}

/* isDelivered(order) — a delivery has actually been recorded. */
function isDelivered(order) {
  return !!(order.delivered_at && order.fulfillment_status === "delivered" &&
            new Date(order.delivered_at).getTime() <= Date.now() + 5 * 60 * 1000);
}

/* reviewableProducts(order, items)
   -> { eligible, reason, message, products: [{ productId, name, reviewed }], delivered } */
async function reviewableProducts(order, items) {
  const base = { products: [], delivered: isDelivered(order) };

  if (order.order_status === "cancelled") {
    return Object.assign(base, { eligible: false, reason: "cancelled",
      message: "This order was cancelled, so it can't be reviewed." });
  }
  if (order.payment_status !== "paid") {
    return Object.assign(base, { eligible: false, reason: "not_paid",
      message: "This order has not been paid for, so it can't be reviewed yet." });
  }
  if (!base.delivered) {
    return Object.assign(base, { eligible: false, reason: "not_delivered",
      message: "You'll be able to review this order once it has been delivered." });
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
    delivered: true
  };
}

module.exports = { resolveOrderAccess, reviewableProducts, isDelivered, newReviewToken, hashToken, NOT_FOUND };
