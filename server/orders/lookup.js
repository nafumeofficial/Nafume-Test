/*
 * POST /api/orders/lookup  —  fetch one order (confirmation page, guest tracking)
 * ============================================================================
 * Two ways to be authorised for an order, and you need exactly one of them:
 *   a) a session whose customer OWNS the order (placed it while signed in, or
 *      verified the email/phone it was placed with), or
 *   b) the order id PLUS the email or phone the order was placed with — the
 *      guest confirmation / tracking path.
 *
 * Wrong id and wrong contact return the same 404, so the endpoint cannot be
 * used to test whether an order id exists. Failed guesses are also throttled
 * per order id in the database, so rotating IPs does not buy more attempts.
 *
 * Body: { orderId, contact?, refreshPayment? }
 *   refreshPayment: true — for an online order still waiting on payment
 *   confirmation, ask Razorpay now (the confirmation page polls this so a
 *   customer whose callback was interrupted sees "paid" without waiting for the
 *   webhook or the daily job). Uses the same capture rules as every other path.
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const auth     = require("../_lib/auth");
const repo     = require("../_lib/repo");
const payments = require("../_lib/payments");
const db       = require("../_lib/db");

const NOT_FOUND = "We couldn't find that order. Please check the order ID and the email or phone used to place it.";

/* At most one Razorpay status check per order per this many seconds. */
const REFRESH_INTERVAL_SECONDS = 10;

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  // Tighter than most: this is the one endpoint where guessing has any value.
  if (!http.rateLimit(req, res, { key: "order-lookup", limit: 40, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const orderId = validate.clean(body.orderId, 40);
  if (!orderId || !/^[A-Za-z0-9_-]{4,40}$/.test(orderId)) {
    return http.fail(res, 400, "invalid_order_id", "Please enter a valid order ID.");
  }

  try {
    let order = await repo.getOrderByOrderId(orderId);

    /* ── (a) session ownership ──────────────────────────────────────────── */
    let authorised = false;
    const session = await auth.getSession(req);
    if (order && session && repo.customerOwnsOrder(session.customer, order)) authorised = true;

    /* ── (b) matching contact detail ────────────────────────────────────── */
    if (order && !authorised) {
      const raw   = validate.clean(body.contact, 254);
      const email = validate.normalizeEmail(raw);
      const phone = validate.normalizePhone(raw);
      if (email && order.ship_email && validate.normalizeEmail(order.ship_email) === email) authorised = true;
      if (phone && order.ship_phone && validate.normalizePhone(order.ship_phone) === phone) authorised = true;
    }

    if (!authorised) {
      // Count the miss against this order id across every instance and IP.
      const budget = await http.consume("order-lookup-miss|" + orderId.toUpperCase(), 20, 60 * 60 * 1000);
      if (!budget.allowed) {
        res.setHeader("Retry-After", String(budget.retryAfterSeconds));
        return http.fail(res, 429, "rate_limited", http.MESSAGES.rate_limited,
          { retryAfterSeconds: budget.retryAfterSeconds });
      }
      // Same response as "no such order" — never confirm that an id is real.
      return http.fail(res, 404, "order_not_found", NOT_FOUND);
    }

    /* ── optional payment status refresh ────────────────────────────────── */
    let refreshed = null;
    if (body.refreshPayment === true && order.checkout_type === "razorpay" &&
        repo.OPEN_PAYMENT_STATES.indexOf(order.payment_status) !== -1 && order.razorpay_order_id &&
        payments.configured()) {
      const slot = await http.consume("payment-refresh|" + order.order_id, 1, REFRESH_INTERVAL_SECONDS * 1000);
      if (slot.allowed) {
        const settled = await payments.settleOrder(order, { via: "status_refresh" });
        order = settled.order || order;
        refreshed = settled.state;
      } else {
        refreshed = "throttled";
      }
    }

    const items = await repo.getOrderItems(order.id);
    const review = order.review_id
      ? await db.selectOne("reviews", { id: order.review_id })
      : null;

    return http.ok(res, {
      order: repo.publicOrder(order, items),
      reviewSubmitted: !!review,
      paymentRefresh: refreshed,
      message: order.payment_status === "awaiting_verification" ? payments.AWAITING_MESSAGE : undefined
    });

  } catch (err) {
    return http.handleError(res, err, "orders/lookup");
  }
};
