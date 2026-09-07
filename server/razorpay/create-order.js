/*
 * POST /api/razorpay/create-order  —  create a Razorpay order + persist the customer
 * ============================================================================
 * Runs server-side only. RAZORPAY_KEY_SECRET is NEVER exposed to the browser —
 * only the publishable key_id is returned (safe for Razorpay Checkout JS).
 *
 * WHAT THIS ENDPOINT IS RESPONSIBLE FOR
 *   1. Validating the shipping details the customer typed on the website.
 *   2. Recomputing the payable amount from api/_lib/catalog.js — the client's
 *      `amount` is only ever COMPARED, never used to charge. A tampered
 *      frontend price cannot produce a cheaper Razorpay order.
 *   3. Creating the Razorpay order.
 *   4. Persisting the customer + a `pending` order + the WhatsApp consent
 *      decision, BEFORE the customer is sent to the payment sheet. That means a
 *      payment which succeeds while the browser dies is still reconcilable:
 *      the Razorpay receipt and notes carry our order id.
 *
 * Nothing here marks anything paid. Only verify-payment.js may do that.
 *
 * Env vars (Vercel → Settings → Environment Variables — never in frontend files):
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (see db/schema.sql)
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const repo      = require("../_lib/repo");
const discounts = require("../_lib/discounts");
const auth      = require("../_lib/auth");

const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const RAZORPAY_TIMEOUT_MS = 10000;

async function createRazorpayOrder(amountPaise, receipt, notes) {
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, RAZORPAY_TIMEOUT_MS);
  const auth  = Buffer.from(KEY_ID + ":" + KEY_SECRET).toString("base64");

  try {
    const resp = await fetch("https://api.razorpay.com/v1/orders", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + auth },
      body: JSON.stringify({
        amount:          amountPaise,
        currency:        "INR",
        receipt:         receipt,
        payment_capture: 1,
        notes:           notes
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      // Razorpay's own error text can contain account detail — log the status only.
      console.error("[razorpay/create-order] Razorpay API error", resp.status);
      return { error: "razorpay_error" };
    }
    return { order: await resp.json() };
  } catch (err) {
    clearTimeout(timer);
    console.error("[razorpay/create-order] request failed:", err.name);
    return { error: err.name === "AbortError" ? "razorpay_timeout" : "razorpay_unreachable" };
  }
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "create-order", limit: 40, windowMs: 60000 })) return;

  if (!KEY_ID || !KEY_SECRET) {
    console.error("[razorpay/create-order] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing");
    return http.fail(res, 503, "payments_unavailable",
      "Online payment is not available right now. Please try again shortly or contact us on WhatsApp.");
  }
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "create-order-ip", limit: 30, windowMs: 15 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  /* ── 1. shipping details ──────────────────────────────────────────────── */
  const shipping = validate.validateShipping(body.shipping || body);
  if (!shipping.valid) {
    return http.fail(res, 400, "invalid_shipping", shipping.message, { fields: shipping.errors });
  }

  /* ── 2. authoritative pricing ─────────────────────────────────────────── */
  const priced = catalog.priceCart(body.items);
  if (priced.error) {
    return http.fail(res, 400, priced.error, priced.message);
  }

  const giftingRequested = body.giftingAddOn === true;

  /* ── 2b. promo code — re-validated here from scratch ──────────────────────
     Whatever the browser was shown, eligibility and the rupee amount are
     decided again now, against the database. A code the customer is not
     entitled to is simply dropped and the order proceeds at full price rather
     than failing — refusing the whole checkout over a stale code would cost a
     sale for no security benefit. The response reports what actually applied. */
  let discountQuote = null;
  const requestedCode = validate.clean(body.discountCode, 40);
  if (requestedCode) {
    try {
      const session = await auth.getSession(req);
      discountQuote = await discounts.quote(requestedCode, {
        priced:        priced,
        prepaid:       true,
        giftingAddOn:  giftingRequested,
        identityInput: {
          customerId:      session ? session.customer.id : null,
          emailNormalized: shipping.value.emailNormalized,
          phoneNormalized: shipping.value.phoneNormalized
        }
      });
    } catch (err) {
      return http.handleError(res, err, "razorpay/create-order");
    }
  }

  const totals = (discountQuote && discountQuote.ok)
    ? discountQuote.totals
    : catalog.calculateTotals(priced.subtotal, priced.totalQty, giftingRequested, { prepaid: true });

  const clientAmount = Number(body.amount);
  if (!Number.isFinite(clientAmount) || clientAmount <= 0) {
    return http.fail(res, 400, "invalid_amount", "Invalid order amount.");
  }
  if (clientAmount !== totals.total) {
    // Never log the attempted values — just flag the mismatch.
    console.warn("[razorpay/create-order] client/server amount mismatch — rejected");
    return http.fail(res, 400, "amount_mismatch",
      requestedCode
        ? "Your total changed — the promo code may no longer apply. Please refresh your cart and try again."
        : "Order amount could not be verified. Please refresh your cart and try again.");
  }
  if (totals.total < catalog.MIN_PAYABLE) {
    return http.fail(res, 400, "invalid_amount", "Invalid order amount.");
  }

  const whatsappOptIn = body.whatsappOptIn === true;
  const notes         = validate.cleanMultiline(body.notes, 500);
  const orderId       = repo.generateOrderId();

  /* ── 3. Razorpay order ────────────────────────────────────────────────── */
  const rzp = await createRazorpayOrder(totals.total * 100, orderId, { nafumeOrderId: orderId });
  if (rzp.error || !rzp.order || !rzp.order.id) {
    return http.fail(res, 502, "razorpay_error",
      "Could not start payment right now. Please try again in a moment.");
  }

  /* ── 4. persist customer + pending order ──────────────────────────────── */
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
      source:          "checkout"
    });

    const created = await repo.createPendingOrder({
      orderId:         orderId,
      customerId:      found.customer.id,
      razorpayOrderId: rzp.order.id,
      shipping:        shipping.value,
      lines:           priced.lines,
      totals:          totals,
      whatsappOptIn:   whatsappOptIn,
      notes:           notes,
      offers:          buildOfferSummary(totals)
    });

    // Record the redemption against the real order. UNIQUE(code, order_id)
    // makes this idempotent; markRedeemed() promotes it once payment lands.
    if (discountQuote && discountQuote.ok) {
      await discounts.recordRedemption({
        code:            discountQuote.code,
        customerId:      found.customer.id,
        orderId:         orderId,
        orderUuid:       created.id,
        subtotalBefore:  totals.subtotal,
        discountAmount:  totals.promoDiscount,
        finalAmount:     totals.total
      });
    }

    // Consent is recorded either way — an explicit "no" is data too, and it
    // revokes any earlier opt-in for this customer.
    await repo.setMarketingConsent(found.customer.id, "whatsapp", whatsappOptIn, "checkout");

  } catch (err) {
    // No payment has been taken at this point — failing here is safe. The
    // unpaid Razorpay order simply expires.
    return http.handleError(res, err, "razorpay/create-order");
  }

  /* ── 5. response ──────────────────────────────────────────────────────── */
  return http.ok(res, {
    nafume_order_id: orderId,
    order_id:        rzp.order.id,
    amount:          rzp.order.amount,
    currency:        rzp.order.currency,
    key_id:          KEY_ID,
    totals: {
      subtotal:        totals.subtotal,
      bundleDiscount:  totals.bundleDiscount,
      prepaidDiscount: totals.prepaidDiscount,
      promoCode:       totals.promoCode || null,
      promoDiscount:   totals.promoDiscount || 0,
      giftingAddOn:    totals.giftingAddOn,
      shipping:        totals.shipping,
      total:           totals.total
    },
    // Tells the UI honestly whether the code the customer typed survived
    // server-side re-validation.
    discount: requestedCode
      ? {
          requested: requestedCode.toUpperCase(),
          applied:   !!(discountQuote && discountQuote.ok),
          amount:    (discountQuote && discountQuote.ok) ? totals.promoDiscount : 0,
          reason:    (discountQuote && !discountQuote.ok) ? discountQuote.reason : null
        }
      : null
  });
};

/* Human-readable applied-offer list stored on the order for the admin view. */
function buildOfferSummary(totals) {
  const out = [];
  if (totals.bundleDiscount > 0) {
    out.push({ offerId: "buy-any-3", label: "Buy any 3 × 50ml at ₹" + catalog.OFFER_RULES.buyAny3.bundlePrice,
               amount: -totals.bundleDiscount, type: "discount" });
  }
  if (totals.prepaidDiscount > 0) {
    out.push({ offerId: "prepaid", label: "Extra " + catalog.OFFER_RULES.prepaidDiscount.value + "% off on prepaid orders",
               amount: -totals.prepaidDiscount, type: "discount" });
  }
  if (totals.promoDiscount > 0 && totals.promoCode) {
    out.push({ offerId: "promo-" + totals.promoCode.toLowerCase(),
               label: "Promo code " + totals.promoCode,
               amount: -totals.promoDiscount, type: "discount" });
  }
  if (totals.giftingAddOn > 0) {
    out.push({ offerId: "gift-packaging", label: "Premium gift packaging",
               amount: totals.giftingAddOn, type: "addon" });
  }
  if (totals.shipping === 0 && totals.subtotal > 0) {
    out.push({ offerId: "free-shipping", label: "Free shipping above ₹" + catalog.OFFER_RULES.freeShippingThreshold,
               amount: 0, type: "shipping" });
  }
  return out;
}

// Exported for the local test harness (test/api-tests.js).
module.exports.buildOfferSummary = buildOfferSummary;
