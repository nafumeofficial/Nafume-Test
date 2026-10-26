/*
 * POST /api/orders/create-whatsapp  —  "Order on WhatsApp"
 * ============================================================================
 * The order is saved first (order_status = awaiting_whatsapp), then the
 * customer is sent to WhatsApp with the order number and details pre-filled.
 * Every order is therefore recorded even if the customer never presses Send;
 * staff confirm it with the admin action "confirm_whatsapp".
 *
 * Validation, server-side pricing, duplicate protection and promo handling are
 * shared with Cash on Delivery — see create-cod.js.
 */
"use strict";

module.exports = require("./create-cod").makeHandler("whatsapp");
