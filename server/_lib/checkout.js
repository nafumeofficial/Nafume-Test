/*
 * api/_lib/checkout.js  —  who is this order for?
 * ============================================================================
 * Shared by /api/razorpay/create-order and /api/orders/create-cod.
 */
"use strict";

const repo = require("./repo");

/* checkoutCustomer(session, shipping, source)
   -> { customer, sessionCustomerId, recordConsent }

   Signed in: the order belongs to the session's customer, and their saved
   name/address are refreshed from what they just typed (they are
   authenticated, so this is address reuse working as intended).

   Guest: the customer record is matched or created from the typed details, but
   a CLAIMED record (an account, or anything verified) is never modified by the
   typed details, and its WhatsApp consent only changes when the number typed is
   the number on that record — typing someone's email must not be able to
   rewrite their profile or their marketing consent. */
async function checkoutCustomer(session, s, source) {
  if (session) {
    const me = session.customer;
    const updated = await repo.updateCustomer(me.id, {
      name: s.name || me.name, address_line1: s.line1, address_line2: s.line2 || null,
      city: s.city, state: s.state, pincode: s.pincode
    });
    return { customer: updated || me, sessionCustomerId: me.id, recordConsent: true };
  }
  const found = await repo.findOrCreateCustomer({
    name: s.name, email: s.email, emailNormalized: s.emailNormalized,
    phone: s.phone, phoneNormalized: s.phoneNormalized,
    line1: s.line1, line2: s.line2, city: s.city, state: s.state, pincode: s.pincode,
    source: source
  });
  const c = found.customer;
  const recordConsent = !repo.isClaimed(c) || (!!c.phone_normalized && c.phone_normalized === s.phoneNormalized);
  return { customer: c, sessionCustomerId: null, recordConsent: recordConsent };
}

module.exports = { checkoutCustomer };
