/*
 * POST /api/discounts/validate  —  quote a promo code without committing to it
 * ============================================================================
 * Powers the "Apply" button at checkout. It answers "would this code work, and
 * what would I pay?" and writes nothing at all — no redemption is recorded
 * until an order actually exists.
 *
 * The response is a full authoritative totals breakdown, so the cart summary
 * can show real numbers rather than guessing. Those numbers are still only for
 * DISPLAY: /api/razorpay/create-order and /api/orders/create-cod each redo this
 * entire calculation from scratch and ignore whatever the browser sends.
 *
 * Body: { code, items, giftingAddOn?, paymentMethod?, contact? }
 *   contact — the email or phone typed into the checkout form. Needed because
 *   eligibility depends on who is ordering, and a guest has no session.
 *   A signed-in customer's session takes priority over anything sent here.
 *
 * ANTI-PROBING
 *   Rate limited per IP and, more importantly, per contact identity, so this
 *   cannot be used to enumerate codes or to test which email addresses have
 *   ordered before. Ineligibility messages are deliberately non-specific.
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const catalog   = require("../_lib/catalog");
const discounts = require("../_lib/discounts");
const auth      = require("../_lib/auth");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "discount-validate", limit: 30, windowMs: 60000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const rawCode = validate.clean(body.code, 40);
  if (!rawCode) {
    return http.fail(res, 400, "missing_code", "Please enter a promo code.");
  }

  // Durable, cross-instance guard against brute-forcing the code list.
  if (!await http.durableLimit(req, res, {
    key: "discount-validate", limit: 40, windowMs: 10 * 60 * 1000
  })) return;

  const priced = catalog.priceCart(body.items);
  if (priced.error) return http.fail(res, 400, priced.error, priced.message);

  try {
    const session = await auth.getSession(req);
    const prepaid = !/cod|cash|whatsapp/i.test(String(body.paymentMethod || "online"));

    const result = await discounts.quote(rawCode, {
      priced:       priced,
      prepaid:      prepaid,
      giftingAddOn: body.giftingAddOn === true,
      identityInput: {
        customerId: session ? session.customer.id : null,
        contact:    validate.clean(body.contact, 254)
      }
    });

    if (!result.ok) {
      // 200, not 4xx: "this code doesn't apply to you" is a normal answer to a
      // normal question, and the UI needs the un-discounted totals either way.
      return http.ok(res, {
        applied: false,
        reason:  result.reason,
        message: result.message || discounts.NOT_FOUND,
        totals:  publicTotals(result.totals)
      });
    }

    return http.ok(res, {
      applied:  true,
      code:     result.code,
      label:    result.label,
      terms:    result.terms,
      discount: result.discount,
      totals:   publicTotals(result.totals),
      message:  result.label + " applied."
    });

  } catch (err) {
    return http.handleError(res, err, "discounts/validate");
  }
};

/* Only the numbers the cart needs to render. */
function publicTotals(t) {
  return {
    subtotal:        t.subtotal,
    bundleDiscount:  t.bundleDiscount,
    prepaidDiscount: t.prepaidDiscount,
    promoCode:       t.promoCode || null,
    promoDiscount:   t.promoDiscount || 0,
    giftingAddOn:    t.giftingAddOn,
    shipping:        t.shipping,
    total:           t.total
  };
}
