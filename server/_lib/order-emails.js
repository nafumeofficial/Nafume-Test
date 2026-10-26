/*
 * server/_lib/order-emails.js  —  the emails around an order's life
 * ============================================================================
 *   sendReceived(order)    COD / WhatsApp order placed: the customer gets it, and
 *                          so does the team (online orders have their own paid emails)
 *   sendConfirmed(order)   a WhatsApp order the team has confirmed
 *   sendShipped(order)     the order has shipped (courier + tracking number)
 *
 * Every send is written to the outbox FIRST (see messaging.send), so a provider
 * hiccup never loses an email: the retry job delivers it later. These helpers
 * never throw and never make a customer wait more than a few seconds, and
 * `dedupe` stops the same message going out twice for the same order.
 */
"use strict";

const messaging = require("./messaging");
const repo      = require("./repo");

const MAX_WAIT_MS = 4000;

function siteUrl() { return (process.env.SITE_URL || "").replace(/\/+$/, ""); }

/* Wait for the sends, but only briefly: anything slower stays in the outbox. */
async function settle(promises) {
  let timer;
  const cap = new Promise(function (resolve) { timer = setTimeout(resolve, MAX_WAIT_MS); });
  try { await Promise.race([Promise.allSettled(promises), cap]); } finally { clearTimeout(timer); }
}

async function sendReceived(order) {
  try {
    if (!order || !messaging.emailConfigured()) return;
    const items = await repo.getOrderItems(order.id);
    const wa = order.payment_method === "whatsapp";
    const jobs = [
      messaging.send({
        channel: "email", to: messaging.NOTIFY_TO, from: messaging.NOTIFY_FROM,
        subject: (wa ? "NAFUME WhatsApp order " : "NAFUME COD order ") + order.order_id,
        body: messaging.orderReceivedTeamEmail(order, items),
        relatedType: "order", relatedId: order.order_id, dedupe: true
      })
    ];
    if (order.ship_email) {
      jobs.push(messaging.send({
        channel: "email", to: order.ship_email,
        subject: wa ? "One last step for your NAFUME order " + order.order_id
                    : "We've received your NAFUME order " + order.order_id,
        body: messaging.orderReceivedCustomerEmail(order, items, siteUrl()),
        relatedType: "order", relatedId: order.order_id, dedupe: true
      }));
    }
    await settle(jobs);
  } catch (err) {
    console.error("[order-emails] received failed:", err && err.message);
  }
}

async function sendConfirmed(order) {
  try {
    if (!order || !order.ship_email || !messaging.emailConfigured()) return;
    const items = await repo.getOrderItems(order.id);
    await settle([messaging.send({
      channel: "email", to: order.ship_email,
      subject: "Your NAFUME order " + order.order_id + " is confirmed",
      body: messaging.orderConfirmedCustomerEmail(order, items, siteUrl()),
      relatedType: "order", relatedId: order.order_id, dedupe: true
    })]);
  } catch (err) {
    console.error("[order-emails] confirmed failed:", err && err.message);
  }
}

async function sendShipped(order) {
  try {
    if (!order || !order.ship_email || !messaging.emailConfigured()) return;
    await settle([messaging.send({
      channel: "email", to: order.ship_email,
      subject: "Your NAFUME order " + order.order_id + " has shipped",
      body: messaging.orderShippedCustomerEmail(order, siteUrl()),
      relatedType: "order", relatedId: order.order_id, dedupe: true
    })]);
  } catch (err) {
    console.error("[order-emails] shipped failed:", err && err.message);
  }
}

module.exports = { sendReceived, sendConfirmed, sendShipped };
