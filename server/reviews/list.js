/*
 * GET /api/reviews/list?productId=dark-oud  —  published reviews for a product
 * ============================================================================
 * Public and cacheable-ish, but deliberately narrow:
 *   - only status = 'published' rows are ever returned
 *   - the author's email is NEVER returned; the name is reduced to a first name
 *     plus an initial ("Ravi K."), which is what a storefront needs and no more
 *   - photos are returned as-is only for published (i.e. moderated) reviews
 *
 * Returns an average/count summary alongside the rows so product pages don't
 * have to compute it.
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const catalog  = require("../_lib/catalog");
const db       = require("../_lib/db");

const MAX_LIMIT = 50;

/* "Ravi Kumar" -> "Ravi K." — recognisable to the reviewer, not identifying. */
function displayName(name) {
  const parts = validate.clean(name, 120).split(" ").filter(Boolean);
  if (!parts.length) return "NAFUME Customer";
  if (parts.length === 1) return parts[0];
  return parts[0] + " " + parts[parts.length - 1].charAt(0).toUpperCase() + ".";
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "GET")) return;

  const productId = validate.clean((req.query && req.query.productId) || "", 60);
  if (!productId || !catalog.getProduct(productId)) {
    return http.fail(res, 400, "invalid_product", "Unknown product.");
  }

  if (!db.isConfigured()) {
    // Product pages must still render; say plainly that reviews are unavailable.
    return http.ok(res, { productId: productId, reviews: [], summary: null, storage: false });
  }

  const limit = Math.min(MAX_LIMIT,
    Math.max(1, parseInt((req.query && req.query.limit) || "20", 10) || 20));

  try {
    const rows = await db.select("reviews", {
      where: { product_id: productId, status: "published" },
      order: { column: "created_at", ascending: false },
      limit: limit
    });

    let sum = 0;
    const reviews = rows.map(function (r) {
      sum += r.rating;
      return {
        id:        r.id,
        rating:    r.rating,
        title:     r.title,
        body:      r.body,
        photo:     r.photo_data_url || null,
        author:    displayName(r.author_name),
        verified:  !!r.verified,
        createdAt: r.created_at
      };
    });

    return http.ok(res, {
      productId: productId,
      reviews:   reviews,
      summary: reviews.length
        ? { count: reviews.length, average: Math.round((sum / reviews.length) * 10) / 10 }
        : { count: 0, average: null }
    });

  } catch (err) {
    return http.handleError(res, err, "reviews/list");
  }
};
