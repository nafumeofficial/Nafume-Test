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

const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "create-cod", limit: 25, windowMs: 60000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "create-cod-ip", limit: 20, windowMs: 15 * 60 * 1000 })) return;

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

  /* Promo code — re-validated server-side, exactly as in the Razorpay path.
     `prepaid: false` matters: a COD order gets no prepaid discount, so the
     promo is calculated on a larger base and the arithmetic must not be
     borrowed from the online quote. */
  let discountQuote = null;
  const requestedCode = validate.clean(body.discountCode, 40);
  if (requestedCode) {
    try {
      const session = await auth.getSession(req);
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
      return http.handleError(res, err, "orders/create-cod");
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
    const found = await repo.findOrCreateCustomer({
      name:            shipping.value.name,
      email:           shipping.value.email,
      emailNormalized: shipping.value.emailNormalized,
      phone:           shipping.value.phone,
      phoneNormalized: shipping.value.phoneNormalized,
      line1:           shipping.value.line1,
      line2:           shipping.value.line2,
      city:            shipping.value.city,
      state:           shipping.value.state,
      pincode:         shipping.value.pincode,
      source:          "checkout_cod"
    });

    /* ── duplicate guard ─────────────────────────────────────────────────
       A double-click sends two identical requests moments apart. Rather than
       creating two orders, return the one that already exists.              */
    const recent = await db.select("orders", {
      where: { customer_id: found.customer.id, checkout_type: "cod" },
      order: { column: "created_at", ascending: false },
      limit: 3
    });
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i];
      if (new Date(r.created_at).getTime() < cutoff) continue;
      if (r.amount_total !== totals.total) continue;
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
        payment_method: "cod",
        checkout_type:  "cod",
        order_status:   "confirmed",
        payment_status: "pending",
        updated_at:     db.nowISO()
      }
    });
    const finalOrder = (updated && updated[0]) || order;

    // A confirmed COD order commits the discount immediately — there is no
    // later payment event to hook, and the customer is getting the goods.
    if (discountQuote && discountQuote.ok) {
      await discounts.recordRedemption({
        code:           discountQuote.code,
        customerId:     found.customer.id,
        orderId:        orderId,
        orderUuid:      finalOrder.id,
        subtotalBefore: totals.subtotal,
        discountAmount: totals.promoDiscount,
        finalAmount:    totals.total
      });
      await discounts.markRedeemed(orderId);
    }

    await repo.setMarketingConsent(found.customer.id, "whatsapp", whatsappOptIn, "checkout");

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
      message: "Your Cash on Delivery order is confirmed."
    });

  } catch (err) {
    return http.handleError(res, err, "orders/create-cod");
  }
};
