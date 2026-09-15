/*
 * /api/admin/orders  —  internal order operations (list, mark shipped/delivered)
 * ============================================================================
 * AUTH  Authorization: Bearer <ADMIN_API_TOKEN>. Without ADMIN_API_TOKEN set the
 *       endpoint refuses every request — it is never open by default.
 *       Tokens are compared in constant time.
 *
 * This is what makes Phase 6 real: setting delivered_at here is the trigger the
 * review-request job waits on. Delivery status is an operational fact, so it is
 * recorded by staff (or, later, by a courier webhook posting to this endpoint),
 * never guessed by the site.
 *
 *   GET  /api/admin/orders?status=paid&limit=50
 *   POST /api/admin/orders   { orderId, action, ... }
 *        action = "mark_shipped"   { awb?, courierName?, shippedAt? }
 *              | "mark_delivered"  { deliveredAt? }
 *              | "set_tracking"    { awb, courierName }
 *              | "cancel"
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const repo      = require("../_lib/repo");
const db        = require("../_lib/db");
const discounts = require("../_lib/discounts");
const auth      = require("../_lib/auth");

/* Read per request; compared in constant time (see _lib/auth.js). */
function tokenMatches(req) { return auth.bearerMatches(req, ["ADMIN_API_TOKEN"]); }

/* Parses an optional ISO timestamp, refusing anything unparseable or absurdly
   far in the future (a typo'd delivery date would mis-schedule review requests). */
function parseTimestamp(value, fallbackNow) {
  if (value === undefined || value === null || value === "") return fallbackNow ? db.nowISO() : null;
  const t = new Date(value);
  if (isNaN(t.getTime())) return undefined;                       // signal "invalid"
  if (t.getTime() > Date.now() + 24 * 60 * 60 * 1000) return undefined;
  return t.toISOString();
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (!auth.anyConfigured(["ADMIN_API_TOKEN"])) {
    console.error("[admin/orders] refusing — ADMIN_API_TOKEN is not set");
    return http.fail(res, 503, "admin_not_configured",
      "Admin API is not configured. Set ADMIN_API_TOKEN to enable it.");
  }
  if (!tokenMatches(req)) {
    return http.fail(res, 401, "unauthorised", "Not authorised.");
  }
  if (!http.requireStorage(res)) return;

  try {
    /* ── list ───────────────────────────────────────────────────────────── */
    if (req.method === "GET") {
      const q      = req.query || {};
      const limit  = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
      const where  = {};
      if (q.status) where.payment_status = String(q.status);
      if (q.fulfillment) where.fulfillment_status = String(q.fulfillment);

      const orders = await db.select("orders", {
        where: where,
        order: { column: "created_at", ascending: false },
        limit: limit
      });

      const out = [];
      for (let i = 0; i < orders.length; i++) {
        const items = await repo.getOrderItems(orders[i].id);
        out.push(repo.publicOrder(orders[i], items));
      }
      return http.ok(res, { count: out.length, orders: out });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
    }

    /* ── mutate ─────────────────────────────────────────────────────────── */
    const body = await http.body(req, res);
    if (!body) return;

    const orderId = validate.clean(body.orderId, 40);
    const action  = validate.clean(body.action, 30);
    if (!orderId) return http.fail(res, 400, "missing_order_id", "orderId is required.");

    const order = await repo.getOrderByOrderId(orderId);
    if (!order) return http.fail(res, 404, "order_not_found", "No such order.");

    const now   = db.nowISO();
    const patch = { updated_at: now };

    switch (action) {
      case "mark_shipped": {
        const at = parseTimestamp(body.shippedAt, true);
        if (at === undefined) return http.fail(res, 400, "invalid_date", "shippedAt is not a valid date.");
        patch.shipped_at         = at;
        patch.fulfillment_status = "shipped";
        if (body.awb)         patch.awb          = validate.clean(body.awb, 60);
        if (body.courierName) patch.courier_name = validate.clean(body.courierName, 80);
        break;
      }
      case "mark_delivered": {
        const at = parseTimestamp(body.deliveredAt, true);
        if (at === undefined) return http.fail(res, 400, "invalid_date", "deliveredAt is not a valid date.");

        const isCod = order.payment_method === "cod";

        // A prepaid order must actually be paid before it can be delivered.
        // A COD order is the opposite case: delivery is WHEN it gets paid, so
        // requiring payment first would make COD orders undeliverable — and
        // would also exclude every COD customer from review requests, which
        // only consider paid orders.
        if (order.payment_status !== "paid" && !isCod) {
          return http.fail(res, 409, "not_paid",
            "Only a paid order can be marked delivered. For a prepaid order, confirm the payment first.");
        }
        if (order.order_status === "cancelled") {
          return http.fail(res, 409, "cancelled", "A cancelled order cannot be marked delivered.");
        }

        patch.delivered_at       = at;
        patch.fulfillment_status = "delivered";
        if (!order.shipped_at) patch.shipped_at = at;

        // Cash on Delivery: handing the parcel over IS the payment. Pass
        // codCollected:false for a delivery attempt where cash was refused.
        if (isCod && order.payment_status !== "paid" && body.codCollected !== false) {
          patch.payment_status = "paid";
          patch.paid_at        = at;
        }
        break;
      }
      case "set_tracking": {
        const awb = validate.clean(body.awb, 60);
        if (!awb) return http.fail(res, 400, "missing_awb", "awb is required.");
        patch.awb          = awb;
        patch.courier_name = validate.clean(body.courierName, 80) || order.courier_name;
        break;
      }
      case "cancel": {
        patch.order_status = "cancelled";
        // Hand the promo allowance back — a cancelled order must not leave the
        // customer holding a discount they never got to use.
        try { await discounts.releaseRedemption(order.order_id); }
        catch (e) { console.error("[admin/orders] discount release failed:", e && e.message); }
        break;
      }
      default:
        return http.fail(res, 400, "invalid_action",
          "action must be mark_shipped, mark_delivered, set_tracking or cancel.");
    }

    const updated = await db.update("orders", { where: { id: order.id }, set: patch });
    const fresh   = (updated && updated[0]) || order;
    const items   = await repo.getOrderItems(fresh.id);

    return http.ok(res, { order: repo.publicOrder(fresh, items) });

  } catch (err) {
    return http.handleError(res, err, "admin/orders");
  }
};
