/*
 * api/_lib/repo.js  —  domain data access (customers, orders, consent, reviews)
 * ============================================================================
 * All multi-step database work lives here so endpoints stay thin and the same
 * rules (customer de-duplication, order ownership, order idempotency, safe
 * projections) apply everywhere.
 *
 * OWNERSHIP MODEL
 *   A customer row is matched from whatever a shopper TYPES at checkout, so
 *   `orders.customer_id` is a bookkeeping link, not proof of anything. The only
 *   thing that lets a signed-in customer see an order is
 *   `orders.verified_owner_customer_id`, which is set when:
 *     - the order was placed from that customer's authenticated session, or
 *     - the customer proved control of the email/phone the order was placed
 *       with (verification code), see linkOwnedOrders().
 */
"use strict";

const db       = require("./db");
const validate = require("./validate");

/* ── customers ───────────────────────────────────────────────────────────────
   Repeat-customer matching, in priority order:
     1. normalized email  (strongest signal — unique per person in practice)
     2. normalized phone
   Both columns are UNIQUE in the database, so two concurrent checkouts racing
   to create the same customer resolve to one row: the loser catches the unique
   violation and re-reads the winner's row.                                    */

/* isClaimed(customer) — has anyone proven control of this record? A claimed
   record (an account, or any verified identifier) is never modified by an
   unauthenticated checkout: typed details cannot rewrite someone's profile. */
function isClaimed(c) {
  return !!(c && (c.has_account || c.email_verified_at || c.phone_verified_at));
}

/* mergeMissing(existing, incoming)
   Refreshes the profile of an UNCLAIMED guest record from its newest checkout.
   Identifiers are never filled in or overwritten here: attaching a typed email
   or phone to an existing record is how one person's details used to end up on
   another person's record. */
function mergeMissing(existing, incoming) {
  const patch = {};
  if (isClaimed(existing)) return patch;

  ["name", "address_line1", "address_line2", "city", "state", "pincode"].forEach(function (col) {
    const v = incoming[col];
    if (v !== undefined && v !== null && String(v).trim() !== "" && v !== existing[col]) {
      patch[col] = v;
    }
  });

  if (Object.keys(patch).length) patch.updated_at = db.nowISO();
  return patch;
}

/* findCustomer(emailNormalized, phoneNormalized) -> row | null */
async function findCustomer(emailNormalized, phoneNormalized) {
  if (emailNormalized) {
    const byEmail = await db.selectOne("customers", { email_normalized: emailNormalized });
    if (byEmail) return byEmail;
  }
  if (phoneNormalized) {
    const byPhone = await db.selectOne("customers", { phone_normalized: phoneNormalized });
    if (byPhone) return byPhone;
  }
  return null;
}

async function getCustomerById(id) {
  if (!id) return null;
  return db.selectOne("customers", { id: id });
}

async function hasCredentials(customerId) {
  if (!customerId) return false;
  return !!(await db.selectOne("customer_auth", { customer_id: customerId }));
}

/* findOrCreateCustomer(input) -> { customer, created }
   `input` uses the normalized shape produced by validate.validateShipping().
   Used for GUEST checkout only — a signed-in checkout uses the session's own
   customer and never matches by typed details. */
async function findOrCreateCustomer(input) {
  input = input || {};
  const emailNorm = input.emailNormalized || null;
  const phoneNorm = input.phoneNormalized || null;

  const incoming = {
    name:             input.name || null,
    email:            input.email || null,
    email_normalized: emailNorm,
    phone:            input.phone || null,
    phone_normalized: phoneNorm,
    address_line1:    input.line1 || null,
    address_line2:    input.line2 || null,
    city:             input.city || null,
    state:            input.state || null,
    pincode:          input.pincode || null,
    has_account:      input.hasAccount === true
  };

  const existing = await findCustomer(emailNorm, phoneNorm);
  if (existing) {
    const patch = mergeMissing(existing, incoming);
    if (Object.keys(patch).length) {
      const updated = await db.update("customers", { where: { id: existing.id }, set: patch });
      return { customer: (updated && updated[0]) || Object.assign({}, existing, patch), created: false };
    }
    return { customer: existing, created: false };
  }

  const now = db.nowISO();
  const row = Object.assign({
    id:                db.newId(),
    country:           "India",
    source:            input.source || "checkout",
    email_verified_at: null,
    phone_verified_at: null,
    created_at:        now,
    updated_at:        now
  }, incoming);

  try {
    const inserted = await db.insert("customers", row);
    return { customer: (inserted && inserted[0]) || row, created: true };
  } catch (err) {
    if (err instanceof db.UniqueViolationError) {
      // Lost a race — the other request created this customer a moment ago.
      const winner = await findCustomer(emailNorm, phoneNorm);
      if (winner) return { customer: winner, created: false };
    }
    throw err;
  }
}

async function updateCustomer(customerId, patch) {
  const set = Object.assign({}, patch, { updated_at: db.nowISO() });
  const rows = await db.update("customers", { where: { id: customerId }, set: set });
  return (rows && rows[0]) || null;
}

/* ── marketing consent ───────────────────────────────────────────────────────
   Explicit per-channel record with its own timestamp and capture source. A
   customer who does not tick the box gets opted_in=false written down — an
   absent row and a declined row are both "not opted in", and a later decline
   revokes an earlier opt-in rather than leaving stale consent behind.        */
async function setMarketingConsent(customerId, channel, optedIn, source) {
  if (!customerId) return null;
  const now = db.nowISO();
  const existing = await db.selectOne("marketing_consent", { customer_id: customerId, channel: channel });

  if (existing) {
    const patch = {
      opted_in:       !!optedIn,
      consent_source: source,
      updated_at:     now
    };
    // consent_at marks when consent was GIVEN; revoked_at when it was withdrawn.
    if (optedIn && !existing.opted_in) patch.consent_at = now;
    patch.revoked_at = optedIn ? null : (existing.revoked_at || now);

    const rows = await db.update("marketing_consent",
      { where: { id: existing.id }, set: patch });
    return (rows && rows[0]) || null;
  }

  const row = {
    id:             db.newId(),
    customer_id:    customerId,
    channel:        channel,
    opted_in:       !!optedIn,
    consent_source: source,
    consent_at:     now,
    revoked_at:     optedIn ? null : now,
    updated_at:     now
  };
  try {
    const inserted = await db.insert("marketing_consent", row);
    return (inserted && inserted[0]) || row;
  } catch (err) {
    if (err instanceof db.UniqueViolationError) {
      const rows = await db.update("marketing_consent",
        { where: { customer_id: customerId, channel: channel },
          set: { opted_in: !!optedIn, consent_source: source, updated_at: now,
                 revoked_at: optedIn ? null : now } });
      return (rows && rows[0]) || null;
    }
    throw err;
  }
}

async function getConsent(customerId, channel) {
  if (!customerId) return null;
  return db.selectOne("marketing_consent", { customer_id: customerId, channel: channel });
}

/* ── orders ──────────────────────────────────────────────────────────────── */

function generateOrderId() {
  // NF-<8 time digits>-<3 random> — 40-char-safe for Razorpay's receipt field.
  const rand = String(require("crypto").randomInt(100, 1000));
  return "NF-" + Date.now().toString().slice(-8) + "-" + rand;
}

/* ownerAtCreation(customer, shipping, sessionCustomerId)
   Who may see a brand-new order from their account, decided when it is
   written:
     - a signed-in checkout belongs to the session's customer;
     - a guest checkout belongs to a customer only if that customer has ALREADY
       verified the exact email or phone typed on the order;
     - otherwise nobody yet — it becomes claimable by whoever later proves
       control of the order's email or phone. */
function ownerAtCreation(customer, shipping, sessionCustomerId) {
  if (sessionCustomerId) return sessionCustomerId;
  if (!customer) return null;
  if (customer.email_verified_at && shipping.emailNormalized &&
      customer.email_normalized === shipping.emailNormalized) return customer.id;
  if (customer.phone_verified_at && shipping.phoneNormalized &&
      customer.phone_normalized === shipping.phoneNormalized) return customer.id;
  return null;
}

/* createPendingOrder({ orderId, customer, shipping, lines, totals, ... })
   Writes the order in `pending` state BEFORE the customer is sent to Razorpay,
   so a payment that succeeds while the browser dies is still reconcilable from
   the Razorpay dashboard by receipt/notes. */
async function createPendingOrder(input) {
  const now = db.nowISO();
  const s   = input.shipping;
  const t   = input.totals;

  const row = {
    id:                      db.newId(),
    order_id:                input.orderId,
    customer_id:             input.customerId || null,
    placed_by_customer_id:   input.placedByCustomerId || null,
    verified_owner_customer_id: input.verifiedOwnerCustomerId || null,

    razorpay_order_id:       input.razorpayOrderId || null,
    razorpay_payment_id:     null,
    razorpay_signature:      null,
    pending_payment_id:      null,
    payment_captured_amount: null,
    payment_currency:        null,
    payment_confirmed_via:   null,
    payment_checked_at:      null,
    payment_note:            null,

    currency:                "INR",
    amount_subtotal:         t.subtotal,
    amount_bundle_discount:  t.bundleDiscount,
    amount_prepaid_discount: t.prepaidDiscount,
    amount_gift_addon:       t.giftingAddOn,
    amount_shipping:         t.shipping,
    discount_code:           t.promoCode || null,
    amount_discount:         t.promoDiscount || 0,
    amount_total:            t.total,

    payment_status:          "pending",
    order_status:            "created",
    fulfillment_status:      "unfulfilled",
    payment_method:          "razorpay",
    checkout_type:           "razorpay",

    ship_name:               s.name,
    ship_phone:              s.phone,
    ship_email:              s.email,
    ship_email_normalized:   s.emailNormalized || validate.normalizeEmail(s.email) || null,
    ship_line1:              s.line1,
    ship_line2:              s.line2 || null,
    ship_city:               s.city,
    ship_state:              s.state,
    ship_pincode:            s.pincode,
    ship_country:            s.country || "India",

    whatsapp_opt_in:         input.whatsappOptIn === true,
    ga_client_id:            input.gaClientId || null,
    ga_sent_at:              null,
    notes:                   input.notes || null,
    offers:                  input.offers || [],

    shipped_at:              null,
    delivered_at:            null,
    courier_name:            null,
    awb:                     null,

    review_request_status:   "not_due",
    review_requested_at:     null,
    review_id:               null,

    paid_at:                 null,
    created_at:              now,
    updated_at:              now
  };

  const inserted = await db.insert("orders", row);
  const order    = (inserted && inserted[0]) || row;

  const items = input.lines.map(function (l) {
    return {
      id:           db.newId(),
      order_uuid:   order.id,
      order_id:     order.order_id,
      product_id:   l.productId,
      product_name: l.productName,
      unit_price:   l.unitPrice,
      quantity:     l.quantity,
      line_total:   l.lineTotal,
      created_at:   now
    };
  });
  if (items.length) await db.insert("order_items", items);

  return order;
}

async function getOrderByOrderId(orderId) {
  if (!orderId) return null;
  return db.selectOne("orders", { order_id: String(orderId) });
}
async function getOrderByRazorpayOrderId(rzpOrderId) {
  if (!rzpOrderId) return null;
  return db.selectOne("orders", { razorpay_order_id: String(rzpOrderId) });
}
async function getOrderByPaymentId(paymentId) {
  if (!paymentId) return null;
  return db.selectOne("orders", { razorpay_payment_id: String(paymentId) });
}

async function getOrderItems(orderUuid) {
  return db.select("order_items", { where: { order_uuid: orderUuid }, order: { column: "created_at", ascending: true } });
}

const OPEN_PAYMENT_STATES = ["pending", "awaiting_verification"];

/* markOrderPaid(order, payment) -> { order, alreadyPaid }
   The ONLY function that moves an online order to paid. Callers must already
   have confirmed with Razorpay that `payment` is CAPTURED, belongs to this
   order, and matches its amount and currency (see _lib/payments.js).

   IDEMPOTENT AT THE DATABASE LEVEL. The update is a single conditional
   statement — WHERE payment_status IN ('pending','awaiting_verification') — so
   concurrent callers (browser callback, webhook, reconciliation, status
   refresh) cannot both win: exactly one updates the row, the rest update zero
   rows and re-read it. razorpay_payment_id is UNIQUE as a second line of
   defence. A paid order is never moved back by this path. */
async function markOrderPaid(order, payment) {
  if (order.payment_status === "paid") {
    return { order: order, alreadyPaid: true };
  }

  const now = db.nowISO();
  let updated;
  try {
    updated = await db.update("orders", {
      where: { id: order.id, payment_status: ["in", OPEN_PAYMENT_STATES] },
      set: {
        payment_status:          "paid",
        // A cancelled order that is paid anyway stays cancelled — staff decide
        // whether to refund or reinstate it. It is still recorded as paid,
        // because the money is real.
        order_status:            order.order_status === "cancelled" ? "cancelled" : "confirmed",
        razorpay_payment_id:     payment.paymentId,
        razorpay_order_id:       payment.razorpayOrderId || order.razorpay_order_id,
        razorpay_signature:      payment.signature || null,
        pending_payment_id:      null,
        payment_captured_amount: payment.amount != null ? Number(payment.amount) : null,
        payment_currency:        payment.currency || null,
        payment_confirmed_via:   payment.via || null,
        payment_checked_at:      now,
        payment_note:            null,
        paid_at:                 now,
        updated_at:              now
      }
    });
  } catch (err) {
    // The payment id is already attached to a (different or same) order row.
    if (err instanceof db.UniqueViolationError) {
      const fresh = await db.selectOne("orders", { id: order.id });
      return { order: fresh || order, alreadyPaid: !!(fresh && fresh.payment_status === "paid") };
    }
    throw err;
  }

  if (updated && updated.length) {
    // Commit any promo redemption on this order now that the money is real.
    // Required here (not at the call sites) so every confirmation path commits
    // it, and only the single winner does.
    try {
      await require("./discounts").markRedeemed(updated[0].order_id);
    } catch (e) {
      console.error("[repo.markOrderPaid] discount commit failed:", e && e.message);
    }
    // Only the single winner tells the Desk dashboard (best effort, never throws).
    await require("./desk").queueOrder(updated[0].order_id);
    return { order: updated[0], alreadyPaid: false };
  }

  // Zero rows changed => somebody else already promoted it. Re-read the truth.
  const fresh = await db.selectOne("orders", { id: order.id });
  return { order: fresh || order, alreadyPaid: true };
}

/* markAwaitingVerification(order, info) -> order
   The customer reported a payment (valid checkout signature) that we could not
   yet confirm as captured — the lookup failed, timed out, or Razorpay still
   says `authorized`. Conditional on the order still being open, so this can
   never move a paid order backwards. */
async function markAwaitingVerification(order, info) {
  info = info || {};
  const now = db.nowISO();
  const rows = await db.update("orders", {
    where: { id: order.id, payment_status: ["in", OPEN_PAYMENT_STATES] },
    set: {
      payment_status:     "awaiting_verification",
      pending_payment_id: info.paymentId || order.pending_payment_id || null,
      payment_checked_at: now,
      payment_note:       info.note ? String(info.note).slice(0, 200) : null,
      updated_at:         now
    }
  });
  if (rows && rows.length) return rows[0];
  return (await db.selectOne("orders", { id: order.id })) || order;
}

/* noteFailedPayment(order, note) — an attempt Razorpay reports as failed.
   Only an order that was waiting on confirmation moves to `failed`; a plain
   pending order (customer may simply retry) is left alone. */
async function noteFailedPayment(order, note) {
  const now = db.nowISO();
  const rows = await db.update("orders", {
    where: { id: order.id, payment_status: "awaiting_verification" },
    set: { payment_status: "failed", payment_checked_at: now,
           payment_note: note ? String(note).slice(0, 200) : null, updated_at: now }
  });
  return rows && rows.length ? rows[0] : order;
}

/* ── order ownership ─────────────────────────────────────────────────────── */

function customerOwnsOrder(customer, order) {
  return !!(customer && order && order.verified_owner_customer_id &&
            order.verified_owner_customer_id === customer.id);
}

/* getOwnedOrders(customerId) — the order history a signed-in customer sees. */
async function getOwnedOrders(customerId, limit) {
  if (!customerId) return [];
  return db.select("orders", {
    where: { verified_owner_customer_id: customerId },
    order: { column: "created_at", ascending: false },
    limit: limit || 50
  });
}

/* Kept for internal/admin use. NOT an access check. */
async function getOrdersForCustomer(customerId, limit) {
  if (!customerId) return [];
  return db.select("orders", {
    where: { customer_id: customerId },
    order: { column: "created_at", ascending: false },
    limit: limit || 50
  });
}

/* linkOwnedOrders(customer) -> number linked
   Gives a customer the orders placed with an email or phone they have PROVEN
   they control. Orders that already have a verified owner are never moved:
   whoever verified first keeps them. Called after every successful
   verification, and on sign-in to pick up guest orders placed since. */
async function linkOwnedOrders(customer) {
  if (!customer) return 0;
  let linked = 0;
  const now = db.nowISO();

  if (customer.email_verified_at && customer.email_normalized) {
    const rows = await db.update("orders", {
      where: { ship_email_normalized: customer.email_normalized, verified_owner_customer_id: ["is", null] },
      set:   { verified_owner_customer_id: customer.id, customer_id: customer.id, updated_at: now }
    });
    linked += (rows || []).length;
  }
  if (customer.phone_verified_at && customer.phone_normalized) {
    const rows = await db.update("orders", {
      where: { ship_phone: customer.phone_normalized, verified_owner_customer_id: ["is", null] },
      set:   { verified_owner_customer_id: customer.id, customer_id: customer.id, updated_at: now }
    });
    linked += (rows || []).length;
  }
  return linked;
}

/* reseedProfileFromOwnedOrders(customer) -> customer
   When a guest record is claimed, its saved name/address may have come from
   checkouts that were matched by an identifier the claimant has NOT proven.
   Replace them with the newest order the claimant actually owns (or clear the
   address when there is none). */
async function reseedProfileFromOwnedOrders(customer, preferredName) {
  const owned = await getOwnedOrders(customer.id, 1);
  const latest = owned[0] || null;
  const patch = {
    name:          preferredName || (latest && latest.ship_name) || customer.name || null,
    address_line1: latest ? latest.ship_line1 : null,
    address_line2: latest ? (latest.ship_line2 || null) : null,
    city:          latest ? latest.ship_city : null,
    state:         latest ? latest.ship_state : null,
    pincode:       latest ? latest.ship_pincode : null
  };
  return (await updateCustomer(customer.id, patch)) || Object.assign({}, customer, patch);
}

/* ── safe projections ────────────────────────────────────────────────────────
   Everything the browser is allowed to see about an order. Deliberately omits
   internal ids, signatures and any other customer's data.                    */
function publicOrder(order, items) {
  if (!order) return null;
  return {
    orderId:        order.order_id,
    createdAt:      order.created_at,
    paidAt:         order.paid_at,
    currency:       order.currency,
    paymentStatus:  order.payment_status,
    awaitingPaymentConfirmation: order.payment_status === "awaiting_verification",
    orderStatus:    order.order_status,
    fulfillmentStatus: order.fulfillment_status,
    paymentMethod:  order.payment_method,
    razorpayPaymentId: order.razorpay_payment_id || null,
    totals: {
      subtotal:        order.amount_subtotal,
      bundleDiscount:  order.amount_bundle_discount,
      prepaidDiscount: order.amount_prepaid_discount,
      promoCode:       order.discount_code || null,
      promoDiscount:   order.amount_discount || 0,
      giftingAddOn:    order.amount_gift_addon,
      shipping:        order.amount_shipping,
      total:           order.amount_total
    },
    shipping: {
      name:    order.ship_name,
      phone:   order.ship_phone,
      email:   order.ship_email,
      line1:   order.ship_line1,
      line2:   order.ship_line2,
      city:    order.ship_city,
      state:   order.ship_state,
      pincode: order.ship_pincode,
      country: order.ship_country
    },
    whatsappOptIn: !!order.whatsapp_opt_in,
    items: (items || []).map(function (i) {
      return {
        productId: i.product_id, name: i.product_name,
        unitPrice: i.unit_price, quantity: i.quantity, lineTotal: i.line_total
      };
    }),
    delivery: {
      shippedAt:   order.shipped_at,
      deliveredAt: order.delivered_at,
      courierName: order.courier_name,
      awb:         order.awb
    },
    review: {
      requestStatus: order.review_request_status,
      requestedAt:   order.review_requested_at,
      submitted:     !!order.review_id
    }
  };
}

module.exports = {
  isClaimed, findCustomer, getCustomerById, hasCredentials,
  findOrCreateCustomer, updateCustomer,
  setMarketingConsent, getConsent,
  generateOrderId, ownerAtCreation, createPendingOrder,
  getOrderByOrderId, getOrderByRazorpayOrderId, getOrderByPaymentId, getOrderItems,
  OPEN_PAYMENT_STATES, markOrderPaid, markAwaitingVerification, noteFailedPayment,
  customerOwnsOrder, getOwnedOrders, getOrdersForCustomer, linkOwnedOrders,
  reseedProfileFromOwnedOrders,
  publicOrder
};
