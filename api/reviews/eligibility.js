/*
 * POST /api/reviews/eligibility  —  can this person review this order?
 * ============================================================================
 * Called by the review form before rendering, so the customer is told up front
 * "already reviewed" / "not paid" instead of typing a review and being rejected.
 *
 * Body: { orderId, contact? }
 * Uses exactly the same rules as /api/reviews/submit (api/_lib/review-access.js).
 */
"use strict";

const http    = require("../_lib/http");
const catalog = require("../_lib/catalog");
const access  = require("../_lib/review-access");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "review-eligibility", limit: 60, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  try {
    const found = await access.resolveOrderAccess(req, body);
    if (!found.ok) return http.fail(res, found.status, found.code, found.message);

    const state = await access.reviewableProducts(found.order, found.items);

    return http.ok(res, {
      orderId:   found.order.order_id,
      eligible:  state.eligible,
      reason:    state.reason,
      message:   state.message,
      products:  state.products,
      delivered: state.delivered,
      deliveredAt: found.order.delivered_at,
      reward:    { code: catalog.REVIEW_OFFER.code, label: catalog.REVIEW_OFFER.label }
    });

  } catch (err) {
    return http.handleError(res, err, "reviews/eligibility");
  }
};
