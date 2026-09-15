/*
 * /api/admin/reviews  —  review moderation
 * ============================================================================
 * AUTH  Authorization: Bearer <ADMIN_API_TOKEN>, compared in constant time.
 *       Without ADMIN_API_TOKEN set the endpoint refuses every request.
 *
 * WHY THIS IS REQUIRED, not optional
 *   /api/reviews/submit stores every review as `pending`, and
 *   /api/reviews/list only ever returns `published`. Without a way to approve
 *   them, no customer review would ever appear on the storefront — the review
 *   feature would collect data and show nothing.
 *
 *   Moderation is a deliberate choice: reviews are free-text and optional
 *   photos written by strangers, and they go on product pages.
 *
 *   GET  /api/admin/reviews?status=pending&limit=50
 *   POST /api/admin/reviews  { reviewId, action }
 *        action = "publish" | "hide" | "pending"
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const db       = require("../_lib/db");
const auth     = require("../_lib/auth");

const STATUSES = ["pending", "published", "hidden"];

/* Read per request; compared in constant time (see _lib/auth.js). */
function tokenMatches(req) { return auth.bearerMatches(req, ["ADMIN_API_TOKEN"]); }

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!auth.anyConfigured(["ADMIN_API_TOKEN"])) {
    console.error("[admin/reviews] refusing — ADMIN_API_TOKEN is not set");
    return http.fail(res, 503, "admin_not_configured",
      "Admin API is not configured. Set ADMIN_API_TOKEN to enable it.");
  }
  if (!tokenMatches(req)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!http.requireStorage(res)) return;

  try {
    /* ── list ───────────────────────────────────────────────────────────── */
    if (req.method === "GET") {
      const q      = req.query || {};
      const limit  = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
      const where  = {};
      if (q.status && STATUSES.indexOf(String(q.status)) !== -1) where.status = String(q.status);
      if (q.productId) where.product_id = String(q.productId);

      const rows = await db.select("reviews", {
        where: where,
        order: { column: "created_at", ascending: false },
        limit: limit
      });

      // Staff moderating a review do need the author's identity — that is the
      // point of moderation — but nothing beyond it.
      return http.ok(res, {
        count: rows.length,
        reviews: rows.map(function (r) {
          return {
            id: r.id, orderId: r.order_id, productId: r.product_id, productName: r.product_name,
            rating: r.rating, title: r.title, body: r.body, photo: r.photo_data_url || null,
            authorName: r.author_name, authorEmail: r.author_email,
            verified: !!r.verified, status: r.status,
            createdAt: r.created_at, updatedAt: r.updated_at
          };
        })
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
    }

    /* ── moderate ───────────────────────────────────────────────────────── */
    const body = await http.body(req, res);
    if (!body) return;

    const reviewId = validate.clean(body.reviewId, 60);
    const action   = validate.clean(body.action, 20);
    if (!reviewId) return http.fail(res, 400, "missing_review_id", "reviewId is required.");

    const map = { publish: "published", hide: "hidden", pending: "pending" };
    const status = map[action];
    if (!status) {
      return http.fail(res, 400, "invalid_action", "action must be publish, hide or pending.");
    }

    const review = await db.selectOne("reviews", { id: reviewId });
    if (!review) return http.fail(res, 404, "review_not_found", "No such review.");

    const rows = await db.update("reviews", {
      where: { id: reviewId },
      set:   { status: status, updated_at: db.nowISO() }
    });
    const updated = (rows && rows[0]) || Object.assign({}, review, { status: status });

    return http.ok(res, { reviewId: updated.id, status: updated.status });

  } catch (err) {
    return http.handleError(res, err, "admin/reviews");
  }
};
