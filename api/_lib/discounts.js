/*
 * api/_lib/discounts.js  —  promo codes, server-authoritative
 * ============================================================================
 * The browser never decides a discount. It may SAY which code the customer
 * typed; everything else — whether the code exists, whether this customer is
 * allowed to use it, and how many rupees come off — is decided here, from the
 * database and the server-side price list.
 *
 * TWO CODES, TWO DIFFERENT ELIGIBILITY RULES
 *
 *   NAFUME10        "10% off your first order"
 *                   Handed out by the email-capture popup.
 *                   Eligible only if this customer identity (normalized email
 *                   or phone) has NO previous consumed order. A returning
 *                   customer is refused.
 *
 *   NAFUMEREVIEW    "10% off your next order"
 *                   Handed out after a review is submitted.
 *                   Allowance = number of reviews this customer has written.
 *                   Used = number of NAFUMEREVIEW redemptions they hold.
 *                   So one reward per review, and writing a second review earns
 *                   a second reward. Fabricating reviews is not a route to free
 *                   discounts: a review can only be submitted against a real
 *                   PAID order, one per (order, product).
 *
 * WHAT "CONSUMED" MEANS  (see redemptionConsumes below)
 *   A redemption row is created when the order is created, before payment. If
 *   every such row counted forever, an abandoned checkout would burn the
 *   customer's discount permanently. So a redemption counts against the
 *   allowance when its order is genuinely committed —
 *      paid, or a confirmed COD order, or still inside a short hold window —
 *   and stops counting once an unpaid attempt goes stale or is cancelled.
 *   The hold window is what stops someone opening twenty tabs at once.
 *
 * ROUNDING
 *   All money is whole rupees. Percentages are rounded with Math.round, exactly
 *   like the prepaid discount, so server and browser always agree to the rupee.
 */
"use strict";

const db      = require("./db");
const catalog = require("./catalog");
const validate = require("./validate");

/* Minutes an unpaid order holds its discount before the allowance is released. */
const HOLD_MINUTES = 30;

/* Razorpay will not accept an order below ₹1. */
const MIN_PAYABLE = 1;

/* ── the code list ───────────────────────────────────────────────────────────
   Codes live here, not in the database, because they are product decisions
   rather than data: adding one is a deploy, and that is a feature — nobody can
   mint a discount by writing a row. `redemptions` in the database records who
   used what.                                                                 */

const CODES = {
  NAFUME10: {
    code:        "NAFUME10",
    type:        "percentage",
    value:       catalog.POPUP_OFFER.percentOff,      // single source of truth
    label:       catalog.POPUP_OFFER.label,
    terms:       catalog.POPUP_OFFER.terms,
    rule:        "first_order",
    active:      true,
    minSubtotal: 0
  },
  NAFUMEREVIEW: {
    code:        "NAFUMEREVIEW",
    type:        "percentage",
    value:       catalog.REVIEW_OFFER.percentOff,
    label:       catalog.REVIEW_OFFER.label,
    terms:       catalog.REVIEW_OFFER.terms,
    rule:        "review_reward",
    active:      true,
    minSubtotal: 0
  }
};

/* Deliberately vague on the "why not". Saying "you have ordered before" would
   turn this endpoint into a way to test whether an email has shopped with
   NAFUME. Genuinely eligible customers never see it. */
const NOT_ELIGIBLE = "This code isn't available for this order.";
const NOT_FOUND    = "That code isn't valid. Please check and try again.";

/* normalizeCode — trims, uppercases, strips separators a customer might paste
   ("nafume-10", " nafume 10 "). Only A-Z0-9 survives. */
function normalizeCode(raw) {
  const s = String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 3 && s.length <= 32 ? s : null;
}

function getCode(raw) {
  const key = normalizeCode(raw);
  if (!key) return null;
  const def = Object.prototype.hasOwnProperty.call(CODES, key) ? CODES[key] : null;
  return (def && def.active) ? def : null;
}

/* ── redemption accounting ───────────────────────────────────────────────── */

/* redemptionConsumes(redemption, order)
   Whether this redemption still counts against the customer's allowance. */
function redemptionConsumes(redemption, order) {
  if (!redemption) return false;
  if (redemption.status === "released") return false;

  // No order attached yet (shouldn't happen) — treat the hold window as truth.
  if (!order) {
    return Date.now() - new Date(redemption.created_at).getTime() < HOLD_MINUTES * 60000;
  }
  if (order.order_status === "cancelled") return false;
  if (order.payment_status === "paid") return true;
  if (order.checkout_type === "cod") return true;      // confirmed, cash pending

  // An unpaid online attempt: holds the allowance briefly, then releases it.
  return Date.now() - new Date(order.created_at).getTime() < HOLD_MINUTES * 60000;
}

/* countRedemptions(code, customerId) -> number consumed right now */
async function countRedemptions(code, customerId) {
  if (!customerId) return 0;
  const rows = await db.select("discount_redemptions", {
    where: { code: code, customer_id: customerId }
  });
  if (!rows.length) return 0;

  let consumed = 0;
  for (let i = 0; i < rows.length; i++) {
    const order = rows[i].order_id
      ? await db.selectOne("orders", { order_id: rows[i].order_id })
      : null;
    if (redemptionConsumes(rows[i], order)) consumed++;
  }
  return consumed;
}

/* hasPreviousOrder(customerId) — any order that counts as "has shopped before".
   A cancelled or abandoned attempt does not make someone a returning customer. */
async function hasPreviousOrder(customerId) {
  if (!customerId) return false;
  const rows = await db.select("orders", { where: { customer_id: customerId } });
  return rows.some(function (o) {
    if (o.order_status === "cancelled") return false;
    return o.payment_status === "paid" || o.checkout_type === "cod";
  });
}

/* reviewAllowance(customerId, customerEmailNormalized)
   How many NAFUMEREVIEW rewards this customer has earned = reviews written.
   Matched by customer_id, with a fallback to author_email for a review left
   before the customer record was linked. Hidden (rejected) reviews still count:
   the reward was promised at submission time and withdrawing it after the fact
   would be a poor experience for an honest customer. */
async function reviewAllowance(customerId, emailNormalized) {
  const seen = {};
  let count = 0;

  if (customerId) {
    const byId = await db.select("reviews", { where: { customer_id: customerId } });
    byId.forEach(function (r) { if (!seen[r.id]) { seen[r.id] = true; count++; } });
  }
  if (emailNormalized) {
    const all = await db.select("reviews", {});
    all.forEach(function (r) {
      if (seen[r.id]) return;
      if (r.author_email && validate.normalizeEmail(r.author_email) === emailNormalized) {
        seen[r.id] = true; count++;
      }
    });
  }
  return count;
}

/* ── eligibility ─────────────────────────────────────────────────────────────
   identity = { customerId, emailNormalized, phoneNormalized }
   Returns { eligible: true } or { eligible: false, reason, message }.        */

async function checkEligibility(def, identity, priced) {
  if (priced.subtotal < (def.minSubtotal || 0)) {
    return {
      eligible: false, reason: "min_subtotal",
      message: "This code needs a cart of at least ₹" + def.minSubtotal + "."
    };
  }

  // A guest with no matching customer record is, by definition, a first-time
  // customer. NAFUME10 is fine; NAFUMEREVIEW cannot be (no reviews exist).
  const customerId = identity.customerId || null;

  if (def.rule === "first_order") {
    if (customerId) {
      if (await hasPreviousOrder(customerId)) {
        return { eligible: false, reason: "not_first_order", message: NOT_ELIGIBLE };
      }
      if (await countRedemptions(def.code, customerId) >= 1) {
        return { eligible: false, reason: "already_used", message: NOT_ELIGIBLE };
      }
    }
    return { eligible: true };
  }

  if (def.rule === "review_reward") {
    if (!customerId) {
      return { eligible: false, reason: "no_review", message: NOT_ELIGIBLE };
    }
    const earned = await reviewAllowance(customerId, identity.emailNormalized);
    if (earned < 1) {
      return { eligible: false, reason: "no_review", message: NOT_ELIGIBLE };
    }
    const used = await countRedemptions(def.code, customerId);
    if (used >= earned) {
      return { eligible: false, reason: "already_used", message: NOT_ELIGIBLE };
    }
    return { eligible: true };
  }

  return { eligible: false, reason: "unknown_rule", message: NOT_ELIGIBLE };
}

/* ── identity resolution ─────────────────────────────────────────────────────
   Works for a signed-in customer AND for a guest who has only typed their
   contact details into the checkout form. Never creates a customer — quoting a
   discount must not write anything. */
async function resolveIdentity(input) {
  input = input || {};
  if (input.customerId) {
    const c = await db.selectOne("customers", { id: input.customerId });
    if (c) {
      return {
        customerId: c.id,
        emailNormalized: c.email_normalized || null,
        phoneNormalized: c.phone_normalized || null
      };
    }
  }

  const emailNormalized = input.emailNormalized || validate.normalizeEmail(input.contact) || null;
  const phoneNormalized = input.phoneNormalized || validate.normalizePhone(input.contact) || null;

  let customer = null;
  if (emailNormalized) customer = await db.selectOne("customers", { email_normalized: emailNormalized });
  if (!customer && phoneNormalized) customer = await db.selectOne("customers", { phone_normalized: phoneNormalized });

  return {
    customerId: customer ? customer.id : null,
    emailNormalized: emailNormalized,
    phoneNormalized: phoneNormalized
  };
}

/* ── quoting ─────────────────────────────────────────────────────────────────
   quote(rawCode, { items, giftingAddOn, prepaid, identityInput })
   The one function both /api/discounts/validate and the two order endpoints
   call, so a quote and a charge can never disagree.

   Resolves to:
     { ok: false, reason, message, totals }              — no discount applied
     { ok: true, code, label, discount, totals, identity } — applied
   `totals` is ALWAYS the authoritative breakdown, discount included or not. */
async function quote(rawCode, opts) {
  opts = opts || {};
  const priced = opts.priced;
  const prepaid = opts.prepaid !== false;
  const gifting = opts.giftingAddOn === true;

  const base = catalog.calculateTotals(priced.subtotal, priced.totalQty, gifting, { prepaid: prepaid });

  const raw = String(rawCode == null ? "" : rawCode).trim();
  if (!raw) return { ok: false, reason: "no_code", message: null, totals: base };

  const def = getCode(raw);
  if (!def) return { ok: false, reason: "invalid_code", message: NOT_FOUND, totals: base };

  const identity = await resolveIdentity(opts.identityInput);
  const eligibility = await checkEligibility(def, identity, priced);
  if (!eligibility.eligible) {
    return {
      ok: false, reason: eligibility.reason, message: eligibility.message,
      totals: base, code: def.code
    };
  }

  const totals = catalog.calculateTotals(priced.subtotal, priced.totalQty, gifting, {
    prepaid: prepaid,
    discount: { code: def.code, type: def.type, value: def.value }
  });

  if (totals.promoDiscount <= 0) {
    return { ok: false, reason: "no_effect", message: NOT_ELIGIBLE, totals: base, code: def.code };
  }

  return {
    ok: true,
    code:     def.code,
    label:    def.label,
    terms:    def.terms,
    discount: totals.promoDiscount,
    totals:   totals,
    identity: identity
  };
}

/* ── recording a redemption ──────────────────────────────────────────────────
   Called only once an order row exists, so a redemption is always traceable to
   a real order. UNIQUE(code, order_id) makes a retried write a no-op rather
   than a second consumption. */
async function recordRedemption(input) {
  const now = db.nowISO();
  const row = {
    id:              db.newId(),
    code:            input.code,
    customer_id:     input.customerId || null,
    order_id:        input.orderId,
    order_uuid:      input.orderUuid || null,
    review_id:       input.reviewId || null,
    subtotal_before: input.subtotalBefore,
    discount_amount: input.discountAmount,
    final_amount:    input.finalAmount,
    status:          "pending",
    created_at:      now,
    updated_at:      now,
    redeemed_at:     null
  };
  try {
    const inserted = await db.insert("discount_redemptions", row);
    return (inserted && inserted[0]) || row;
  } catch (err) {
    if (err instanceof db.UniqueViolationError) {
      return db.selectOne("discount_redemptions", { code: input.code, order_id: input.orderId });
    }
    throw err;
  }
}

/* markRedeemed(orderId) — promotes any redemption on this order to 'redeemed'.
   Called when the order becomes paid (or a COD order is confirmed). Safe to
   call repeatedly. */
async function markRedeemed(orderId) {
  if (!orderId) return;
  await db.update("discount_redemptions", {
    where: { order_id: orderId, status: "pending" },
    set:   { status: "redeemed", redeemed_at: db.nowISO(), updated_at: db.nowISO() }
  });
}

/* releaseRedemption(orderId) — hands the allowance back when an order is
   cancelled, so a customer is never left holding a burnt discount. */
async function releaseRedemption(orderId) {
  if (!orderId) return;
  await db.update("discount_redemptions", {
    where: { order_id: orderId },
    set:   { status: "released", updated_at: db.nowISO() }
  });
}

module.exports = {
  CODES, HOLD_MINUTES, MIN_PAYABLE,
  normalizeCode, getCode,
  resolveIdentity, checkEligibility, quote,
  recordRedemption, markRedeemed, releaseRedemption,
  countRedemptions, hasPreviousOrder, reviewAllowance,
  NOT_ELIGIBLE, NOT_FOUND
};
