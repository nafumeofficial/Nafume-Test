/*
 * POST /api/orders/create-cod  —  Cash-on-Delivery order
 * ============================================================================
 * WHY THIS EXISTS
 *   Cash on Delivery used to be handled by the "send the order to WhatsApp"
 *   flow. That flow is gone — WhatsApp is no longer where an order is created —
 *   but COD itself is far too important in India to drop with it. This endpoint
 *   keeps COD as a first-class option while making it a REAL order: validated,
 *   priced server-side, and written to the database like any other.
 *
 * Differences from the Razorpay path:
 *   - no prepaid discount (it is, by definition, not a prepaid order — this
 *     matches js/commerce/offer-service.js calculatePrepaidDiscount())
 *   - payment_status stays 'pending' until the courier remits the cash; the
 *     order_status is 'confirmed' because the order itself is real
 *
 * Double-submit protection: an identical cart from the same customer inside
 * DUPLICATE_WINDOW_MS returns the ORIGINAL order instead of creating a second
 * one, so a double-click or a retried request cannot produce two orders.
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const repo      = require("../_lib/repo");
const db        = require("../_lib/db");
const discounts = require("../_lib/discounts");
const auth      = require("../_lib/auth");
const checkout  = require("../_lib/checkout");

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/* The same checks, pricing and duplicate protection serve two kinds of
   "pay later" order. They differ only in what state the order is saved in:
     cod       real and confirmed at once; cash is collected on delivery.
     whatsapp  saved as awaiting_whatsapp; the customer sends the order on
               WhatsApp and staff confirm it (admin action "confirm_whatsapp").
               Its promo code is only held until then, not spent.            */
const MODES = {
  cod: {
    name: "create-cod", source: "checkout_cod", checkoutType: "cod", paymentMethod: "cod",
    orderStatus: "confirmed", redeemNow: true,
    message: "Your Cash on Delivery order is confirmed."
  },
  whatsapp: {
    name: "create-whatsapp", source: "checkout_whatsapp", checkoutType: "whatsapp", paymentMethod: "whatsapp",
    orderStatus: "awaiting_whatsapp", redeemNow: false,
    message: "Your order is saved. Send it on WhatsApp so we can confirm it."
  }
};

function whatsappNumber() {
  const n = String(process.env.WHATSAPP_ORDER_NUMBER || "918595862227").replace(/\D/g, "");
  return n || "918595862227";
}

/* The pre-filled message the customer sends. Built on the server from the
   SAVED order, so it always shows the real order number, items and total. */
function buildWhatsAppMessage(order, items) {
  const lines = (items || []).map(function (i, n) {
    return (n + 1) + ". " + i.product_name + " x " + i.quantity + " = Rs " + i.line_total;
  }).join("\n");
  const address = [order.ship_line1, order.ship_line2, order.ship_city, order.ship_state, order.ship_pincode]
    .filter(Boolean).join(", ");
  return "NAFUME Order " + order.order_id + "\n\n" +
    "Name: " + (order.ship_name || "") + "\n" +
    "Phone: " + (order.ship_phone || "") + "\n\n" +
    "Address: " + address + "\n\n" +
    "Items:\n" + lines + "\n\n" +
    "Total: Rs " + order.amount_total + "\n\n" +
    "Please confirm my order. Thank you!";
}

function makeHandler(mode) {
  const M = MODES[mode];
  return async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: M.name, limit: 25, windowMs: 60000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: M.name + "-ip", limit: 20, windowMs: 15 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  /* ── validation ───────────────────────────────────────────────────────── */
  const shipping = validate.validateShipping(body.shipping || body);
  if (!shipping.valid) {
    return http.fail(res, 400, "invalid_shipping", shipping.message, { fields: shipping.errors });
  }

  const priced = catalog.priceCart(body.items);
  if (priced.error) return http.fail(res, 400, priced.error, priced.message);

  const giftingRequested = body.giftingAddOn === true;

  let session;
  try {
    session = await auth.getSession(req);
  } catch (err) {
    return http.handleError(res, err, "orders/" + M.name);
  }

  /* Promo code — re-validated server-side, exactly as in the Razorpay path.
     `prepaid: false` matters: a COD order gets no prepaid discount, so the
     promo is calculated on a larger base and the arithmetic must not be
     borrowed from the online quote. */
  let discountQuote = null;
  const requestedCode = validate.clean(body.discountCode, 40);
  if (requestedCode) {
    try {
      discountQuote = await discounts.quote(requestedCode, {
        priced:        priced,
        prepaid:       false,
        giftingAddOn:  giftingRequested,
        identityInput: {
          customerId:      session ? session.customer.id : null,
          emailNormalized: shipping.value.emailNormalized,
          phoneNormalized: shipping.value.phoneNormalized
        }
      });
    } catch (err) {
      return http.handleError(res, err, "orders/" + M.name);
    }
  }

  const totals = (discountQuote && discountQuote.ok)
    ? discountQuote.totals
    : catalog.calculateTotals(priced.subtotal, priced.totalQty, giftingRequested, { prepaid: false });

  // The amount is informational for COD (nothing is charged online now), but it
  // is still checked so the customer is never shown one total and billed another.
  const clientAmount = Number(body.amount);
  if (Number.isFinite(clientAmount) && clientAmount !== totals.total) {
    return http.fail(res, 400, "amount_mismatch",
      "Order amount could not be verified. Please refresh your cart and try again.");
  }

  const whatsappOptIn = body.whatsappOptIn === true;
  const notes         = validate.cleanMultiline(body.notes, 500);

  try {
    const placed = await checkout.checkoutCustomer(session, shipping.value, M.source);
    const found  = { customer: placed.customer };
    const s      = shipping.value;

    /* ── duplicate guard ─────────────────────────────────────────────────
       A double-click sends two identical requests moments apart. Rather than
       creating two orders, return the one that already exists — but only when
       EVERY typed detail matches, so this can never hand one person's order
       (and address) back to someone who merely typed the same email.        */
    const recent = await db.select("orders", {
      where: { customer_id: found.customer.id, checkout_type: M.checkoutType },
      order: { column: "created_at", ascending: false },
      limit: 3
    });
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i];
      if (new Date(r.created_at).getTime() < cutoff) continue;
      if (r.amount_total !== totals.total) continue;
      if (r.ship_phone !== s.phone || (r.ship_email_normalized || "") !== (s.emailNormalized || "") ||
          r.ship_line1 !== s.line1 || r.ship_pincode !== s.pincode || r.ship_name !== s.name ||
          (r.placed_by_customer_id || null) !== (placed.sessionCustomerId || null)) continue;
      const items = await repo.getOrderItems(r.id);
      const sameCart = items.length === priced.lines.length && priced.lines.every(function (l) {
        return items.some(function (it) {
          return it.product_id === l.productId && it.quantity === l.quantity;
        });
      });
      if (sameCart) {
        return http.ok(res, {
          duplicate: true,
          order: repo.publicOrder(r, items),
          accountPrefill: {
            name: r.ship_name, email: r.ship_email, phone: r.ship_phone, orderId: r.order_id
          },
          message: "This order was already placed."
        });
      }
    }

    const orderId = repo.generateOrderId();
    const order = await repo.createPendingOrder({
      orderId:       orderId,
      customerId:    found.customer.id,
      placedByCustomerId: placed.sessionCustomerId,
      verifiedOwnerCustomerId: repo.ownerAtCreation(found.customer, s, placed.sessionCustomerId),
      shipping:      shipping.value,
      lines:         priced.lines,
      totals:        totals,
      whatsappOptIn: whatsappOptIn,
      notes:         notes,
      offers:        []
    });

    // COD-specific state: the order is real and confirmed; only the money is
    // still outstanding.
    const updated = await db.update("orders", {
      where: { id: order.id },
      set: {
        payment_method: M.paymentMethod,
        checkout_type:  M.checkoutType,
        order_status:   M.orderStatus,
        payment_status: "pending",
        updated_at:     db.nowISO()
      }
    });
    const finalOrder = (updated && updated[0]) || order;

    // A confirmed COD order commits the discount immediately — there is no
    // later payment event to hook, and the customer is getting the goods.
    if (discountQuote && discountQuote.ok) {
      const claim = await discounts.recordRedemption({
        code:           discountQuote.code,
        customerId:     discountQuote.identity.customerId || found.customer.id,
        orderId:        orderId,
        orderUuid:      finalOrder.id,
        subtotalBefore: totals.subtotal,
        discountAmount: totals.promoDiscount,
        finalAmount:    totals.total,
        allowance:      discountQuote.allowance
      });
      if (!claim.ok) {
        await discounts.cancelUnpaidOrder(finalOrder.id);
        return http.fail(res, 409, "discount_unavailable",
          "That code was just used on another order. Please refresh your cart and try again.");
      }
      // A WhatsApp order is not confirmed yet, so its code stays pending (held
      // for a short while) and is spent only when staff confirm the order.
      if (M.redeemNow) await discounts.markRedeemed(orderId);
    }

    if (placed.recordConsent) {
      await repo.setMarketingConsent(found.customer.id, "whatsapp", whatsappOptIn, "checkout");
    }

    const items = await repo.getOrderItems(finalOrder.id);

    return http.ok(res, {
      duplicate: false,
      order: repo.publicOrder(finalOrder, items),
      accountPrefill: {
        name:    finalOrder.ship_name,
        email:   finalOrder.ship_email,
        phone:   finalOrder.ship_phone,
        orderId: finalOrder.order_id
      },
      discount: requestedCode
        ? {
            requested: requestedCode.toUpperCase(),
            applied:   !!(discountQuote && discountQuote.ok),
            amount:    (discountQuote && discountQuote.ok) ? totals.promoDiscount : 0,
            reason:    (discountQuote && !discountQuote.ok) ? discountQuote.reason : null
          }
        : null,
      whatsapp: mode === "whatsapp"
        ? (function () {
            const text = buildWhatsAppMessage(finalOrder, items);
            return { number: whatsappNumber(), message: text,
                     url: "https://wa.me/" + whatsappNumber() + "?text=" + encodeURIComponent(text) };
          })()
        : undefined,
      message: M.message
    });

  } catch (err) {
    return http.handleError(res, err, "orders/" + M.name);
  }
  };
}

module.exports = makeHandler("cod");
module.exports.makeHandler = makeHandler;
