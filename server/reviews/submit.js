/*
 * POST /api/reviews/submit  —  post-delivery review
 * ============================================================================
 * Body: { orderId, token?, productId, rating, title?, body?, photo? }
 *
 * ACCESS + ELIGIBILITY: api/_lib/review-access.js — the order's verified owner
 * (session) or the review-link token from the review-request email, and the
 * order must be paid and DELIVERED. Nothing is inserted and no reward is shown
 * unless every check passes.
 *
 * DUPLICATES: reviews has UNIQUE(order_id, product_id). Opening the form twice,
 * double-clicking submit, or replaying the request all resolve to the same
 * single review — the second attempt gets a friendly 409 rather than a second
 * row. The database constraint is the guarantee; the pre-check is only there to
 * produce a nicer message.
 *
 * PHOTOS: optional, accepted as a data URL and validated in
 * api/_lib/validate.js — MIME allowlist (jpeg/png/webp), magic-number check
 * against the declared type, and a hard size cap. SVG and HTML are rejected
 * outright, so a "photo" cannot carry script.
 *
 * MODERATION: reviews land as status 'pending'. Nothing a stranger typed is
 * published on the storefront until someone approves it in admin/reviews-admin.
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const access    = require("../_lib/review-access");
const db        = require("../_lib/db");

const RATING_MIN = 1;
const RATING_MAX = 5;

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "review-submit", limit: 20, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "review-submit-ip", limit: 15, windowMs: 30 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  /* ── ownership ────────────────────────────────────────────────────────── */
  let found;
  try {
    found = await access.resolveOrderAccess(req, body);
  } catch (err) {
    return http.handleError(res, err, "reviews/submit");
  }
  if (!found.ok) return http.fail(res, found.status, found.code, found.message);

  const order = found.order;
  const items = found.items;

  /* ── eligibility first: paid, delivered, not cancelled ────────────────── */
  let state;
  try {
    state = await access.reviewableProducts(order, items);
  } catch (err) {
    return http.handleError(res, err, "reviews/submit");
  }
  if (!state.eligible && state.reason !== "already_reviewed") {
    return http.fail(res, 403, state.reason, state.message);
  }

  /* ── field validation ─────────────────────────────────────────────────── */
  const e = validate.collector();

  const productId = validate.clean(body.productId, 60);
  const inOrder   = items.find(function (i) { return i.product_id === productId; });
  if (!inOrder) e.add("productId", "Please choose a product from this order.");

  const rating = parseInt(body.rating, 10);
  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    e.add("rating", "Please give a rating from 1 to 5 stars.");
  }

  const title = validate.clean(body.title, 120);
  const text  = validate.cleanMultiline(body.body, 3000);
  if (text.length > 0 && text.length < 10) {
    e.add("body", "Please write at least a few words, or leave the review text empty.");
  }

  const photo = validate.validateImageDataUrl(body.photo);
  if (!photo.valid) e.add("photo", photo.message);

  if (e.has()) {
    return http.fail(res, 400, "invalid_input", e.first(), { fields: e.errors });
  }

  try {
    const target = state.products.find(function (p) { return p.productId === productId; });
    if (target && target.reviewed) {
      return http.fail(res, 409, "already_reviewed",
        "You've already reviewed this product for this order. Thank you!");
    }

    /* ── insert ─────────────────────────────────────────────────────────── */
    const now = db.nowISO();
    const row = {
      id:             db.newId(),
      order_id:       order.order_id,
      order_uuid:     order.id,
      customer_id:    order.customer_id || null,
      product_id:     productId,
      product_name:   inOrder.product_name,
      rating:         rating,
      title:          title || null,
      body:           text || null,
      photo_data_url: photo.value,
      author_name:    order.ship_name || null,
      author_email:   order.ship_email || null,
      verified:       true,          // tied to a real paid, delivered order
      access_method:  found.via,     // session | review_link
      status:         "pending",     // published only after moderation
      created_at:     now,
      updated_at:     now
    };

    try {
      await db.insert("reviews", row);
    } catch (err) {
      if (err instanceof db.UniqueViolationError) {
        // The constraint caught a race the pre-check could not.
        return http.fail(res, 409, "already_reviewed",
          "You've already reviewed this product for this order. Thank you!");
      }
      throw err;
    }

    /* ── close the loop on the order ────────────────────────────────────── */
    await db.update("orders", {
      where: { id: order.id },
      set:   { review_id: row.id, review_request_status: "sent", updated_at: now }
    });
    await db.update("review_requests", {
      where: { order_id: order.order_id },
      set:   { status: "sent", updated_at: now }
    });

    return http.ok(res, {
      reviewId: row.id,
      status:   "pending_moderation",
      reward:   {
        code:  catalog.REVIEW_OFFER.code,
        label: catalog.REVIEW_OFFER.label,
        terms: catalog.REVIEW_OFFER.terms,
        // The code is redeemed against the account that owns this order.
        howToUse: found.via === "session"
          ? "Use it at checkout while signed in to this account."
          : "To use it, sign in (or create your account) with the email or phone used for this order, then apply it at checkout."
      },
      message: "Thank you — your review has been received and will appear once approved."
    });

  } catch (err) {
    return http.handleError(res, err, "reviews/submit");
  }
};
