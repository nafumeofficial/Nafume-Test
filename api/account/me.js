/*
 * GET /api/account/me  —  the signed-in customer and their order history
 * ============================================================================
 * Returns 200 with { authenticated: false } rather than 401 when there is no
 * session, so the account page can render its logged-out view without treating
 * a normal visit as an error.
 *
 * Only ever returns data belonging to the session's own customer, through the
 * publicCustomer/publicOrder projections (no password hashes, no internal ids).
 */
"use strict";

const http = require("../_lib/http");
const auth = require("../_lib/auth");
const repo = require("../_lib/repo");
const db   = require("../_lib/db");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "GET")) return;

  if (!db.isConfigured()) {
    return http.ok(res, { authenticated: false, storage: false, customer: null, orders: [] });
  }

  try {
    const session = await auth.getSession(req);
    if (!session) {
      return http.ok(res, { authenticated: false, customer: null, orders: [] });
    }

    const orders = await repo.getOrdersForCustomer(session.customer.id, 50);

    // One item query per order is fine at this volume; orders are capped at 50
    // and this is a single customer's own history.
    const withItems = [];
    for (let i = 0; i < orders.length; i++) {
      const items = await repo.getOrderItems(orders[i].id);
      withItems.push(repo.publicOrder(orders[i], items));
    }

    const consent = await repo.getConsent(session.customer.id, "whatsapp");

    return http.ok(res, {
      authenticated: true,
      customer: auth.publicCustomer(session.customer),
      orders:   withItems,
      consent:  { whatsapp: !!(consent && consent.opted_in && !consent.revoked_at) }
    });

  } catch (err) {
    return http.handleError(res, err, "account/me");
  }
};
