/*
 * api/_lib/repo.js  —  domain data access (customers, orders, consent, reviews)
 * ============================================================================
 * All multi-step database work lives here so endpoints stay thin and the same
 * rules (customer de-duplication, order idempotency, safe projections) apply
 * everywhere.
 */
"use strict";

const db = require("./db");

/* ── customers ───────────────────────────────────────────────────────────────
   Repeat-customer matching, in priority order:
     1. normalized email  (strongest signal — unique per person in practice)
     2. normalized phone
   Both columns are UNIQUE in the database, so two concurrent checkouts racing
   to create the same customer resolve to one row: the loser catches the unique
   violation and re-reads the winner's row.                                    */

/* mergeMissing(existing, incoming)
   Fills blanks on an existing customer without ever clobbering good data with
   empty data. Address and name ARE refreshed when the new order supplies them,
   because the newest checkout is the most current address the customer has. */
function mergeMissing(existing, incoming) {
  const patch = {};
  const refreshable = ["name", "address_line1", "address_line2", "city", "state", "pincode"];

  refreshable.forEach(function (col) {
    const v = incoming[col];
    if (v !== undefined && v !== null && String(v).trim() !== "" && v !== existing[col]) {
      patch[col] = v;
    }
  });

  // Identifiers are only ever FILLED IN, never overwritten — overwriting could
  // silently move a person's login identity or collide with another row.
  ["email", "email_normalized", "phone", "phone_normalized"].forEach(function (col) {
    const v = incoming[col];
    if (v && !existing[col]) patch[col] = v;
  });

  if (incoming.has_account === true && !existing.has_account) patch.has_account = true;

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

/* findOrCreateCustomer(input) -> { customer, created }
   `input` uses the normalized shape produced by validate.validateShipping(). */
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
    // Don't attach an identifier that already belongs to a DIFFERENT customer —
    // that write would violate the unique index and isn't ours to make.
    if (incoming.phone_normalized && !existing.phone_normalized) {
      const clash = await db.selectOne("customers", { phone_normalized: incoming.phone_normalized });
      if (clash && clash.id !== existing.id) {
        incoming.phone = null; incoming.phone_normalized = null;
      }
    }
    if (incoming.email_normalized && !existing.email_normalized) {
      const clash = await db.selectOne("customers", { email_normalized: incoming.email_normalized });
      if (clash && clash.id !== existing.id) {
        incoming.email = null; incoming.email_normalized = null;
      }
    }

    const patch = mergeMissing(existing, incoming);
    if (Object.keys(patch).length) {
      const updated = await db.update("customers", { where: { id: existing.id }, set: patch });
      return { customer: (updated && updated[0]) || Object.assign({}, existing, patch), created: false };
    }
    return { customer: existing, created: false };
  }

  const now = db.nowISO();
  const row = Object.assign({
    id:         db.newId(),
    country:    "India",
    source:     input.source || "checkout",
    created_at: now,
    updated_at: now
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
  const rand = String(Math.floor(100 + Math.random() * 900));
  return "NF-" + Date.now().toString().slice(-8) + "-" + rand;
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

    razorpay_order_id:       input.razorpayOrderId || null,
    razorpay_payment_id:     null,
    razorpay_signature:      null,

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
    ship_line1:              s.line1,
    ship_line2:              s.line2 || null,
    ship_city:               s.city,
    ship_state:              s.state,
    ship_pincode:            s.pincode,
    ship_country:            s.country || "India",

    whatsapp_opt_in:         input.whatsappOptIn === true,
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

/* markOrderPaid(order, payment) -> { order, alreadyPaid }
   IDEMPOTENT. The update is conditional on the row still being `pending`, so a
   duplicate verification callback updates zero rows and returns the existing
   paid order untouched. razorpay_payment_id is UNIQUE at the database level as
   the second line of defence. */
async function markOrderPaid(order, payment) {
  if (order.payment_status === "paid") {
    return { order: order, alreadyPaid: true };
  }

  const now = db.nowISO();
  const updated = await db.update("orders", {
    where: { id: order.id, payment_status: "pending" },
    set: {
      payment_status:      "paid",
      order_status:        "confirmed",
      razorpay_payment_id: payment.paymentId,
      razorpay_order_id:   payment.razorpayOrderId || order.razorpay_order_id,
      razorpay_signature:  payment.signature || null,
      paid_at:             now,
      updated_at:          now
    }
  });

  if (updated && updated.length) {
    // Commit any promo redemption on this order now that the money is real.
    // Required here (not at the call sites) so BOTH the browser callback and
    // the webhook commit it, and neither can forget.
    try {
      await require("./discounts").markRedeemed(updated[0].order_id);
    } catch (e) {
      console.error("[repo.markOrderPaid] discount commit failed:", e && e.message);
    }
    return { order: updated[0], alreadyPaid: false };
  }

  // Zero rows changed => somebody else already promoted it. Re-read the truth.
  const fresh = await db.selectOne("orders", { id: order.id });
  return { order: fresh || order, alreadyPaid: true };
}

async function getOrdersForCustomer(customerId, limit) {
  if (!customerId) return [];
  return db.select("orders", {
    where: { customer_id: customerId },
    order: { column: "created_at", ascending: false },
    limit: limit || 50
  });
}

/* attachOrphanOrders(customer)
   A guest checkout creates the customer row too, so orders are normally linked
   already. This catches the edge case where an order was written before the
   customer row existed (or the link was lost) and re-attaches by shipping
   email/phone at account-creation time. */
async function attachOrphanOrders(customer) {
  if (!customer) return 0;
  let linked = 0;
  const now = db.nowISO();

  if (customer.email_normalized) {
    const rows = await db.update("orders", {
      where: { ship_email: customer.email, customer_id: ["is", null] },
      set:   { customer_id: customer.id, updated_at: now }
    });
    linked += (rows || []).length;
  }
  if (customer.phone) {
    const rows = await db.update("orders", {
      where: { ship_phone: customer.phone, customer_id: ["is", null] },
      set:   { customer_id: customer.id, updated_at: now }
    });
    linked += (rows || []).length;
  }
  return linked;
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
  findCustomer, findOrCreateCustomer, updateCustomer,
  setMarketingConsent, getConsent,
  generateOrderId, createPendingOrder,
  getOrderByOrderId, getOrderByRazorpayOrderId, getOrderByPaymentId, getOrderItems,
  markOrderPaid, getOrdersForCustomer, attachOrphanOrders,
  publicOrder
};
