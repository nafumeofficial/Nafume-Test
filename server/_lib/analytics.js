/*
 * server/_lib/analytics.js  —  server-side Google Analytics purchase
 * ============================================================================
 * Backstop for the browser's `purchase` event: a customer who pays and then
 * closes the tab before the confirmation page loads is still counted.
 *
 * It only works for visitors who accepted the cookie banner, because it needs
 * their GA visitor id (the `_ga` cookie), which the browser sends with the
 * checkout request. No id, no event — never an invented one. GA counts a
 * purchase once per transaction_id, so this and the browser event do not double.
 *
 * Needs GA_API_SECRET (wrangler secret) and GA_MEASUREMENT_ID (defaults to the
 * site's id). With no secret it does nothing.
 */
"use strict";

const MEASUREMENT_ID = "G-XH88TWQ621";

/* "GA1.1.123456789.1700000000" -> "123456789.1700000000" */
function clientIdFromReq(req) {
  try {
    const raw = String((req && req.headers && req.headers.cookie) || "");
    const m = /(?:^|;\s*)_ga=GA\d+\.\d+\.(\d{4,12}\.\d{8,12})(?:;|$)/.exec(raw);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

async function sendPurchase(order, items) {
  const secret = process.env.GA_API_SECRET;
  const cid = order && order.ga_client_id;
  if (!secret || !cid || order.ga_sent_at) return false;
  const body = {
    client_id: cid,
    events: [{
      name: "purchase",
      params: {
        transaction_id: String(order.order_id),
        currency: "INR",
        value: Number(order.amount_total) || 0,
        payment_type: "online",
        items: (items || []).map(function (i) {
          return { item_id: String(i.product_id || i.sku || i.name), item_name: String(i.name || i.product_id),
                   item_brand: "NAFUME", price: Number(i.unit_price || i.price) || 0, quantity: Number(i.quantity || i.qty) || 1 };
        })
      }
    }]
  };
  const url = "https://www.google-analytics.com/mp/collect?measurement_id=" +
    encodeURIComponent(process.env.GA_MEASUREMENT_ID || MEASUREMENT_ID) + "&api_secret=" + encodeURIComponent(secret);
  const resp = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  return resp.status >= 200 && resp.status < 300;
}

module.exports = { clientIdFromReq, sendPurchase };
