/*
 * api/_lib/accounts.js  —  what a PROVEN identifier lets someone do
 * ============================================================================
 * Everything here runs only after _lib/verification.js has consumed a
 * challenge, i.e. the caller has just proven control of one email or one
 * phone number. The rules:
 *
 *   1. A proof covers exactly the identifier it was for. Proving an email says
 *      nothing about the phone number typed next to it.
 *   2. Records come in three kinds:
 *        guest     no credentials, nothing verified   → claimable by proof of
 *                                                        an identifier on it
 *        profile   no credentials, something verified → belongs to whoever
 *                  (e.g. created by phone sign-in)       verified it
 *        account   has credentials                    → belongs to its holder
 *   3. A verified identifier beats an unverified copy of the same identifier on
 *      another record: the unverified copy is detached. A verified identifier
 *      already verified on another record is a CONFLICT — nothing is merged
 *      silently; the customer is told and support can resolve it.
 *   4. Orders become visible only through repo.linkOwnedOrders(), which uses
 *      verified identifiers only.
 */
"use strict";

const db       = require("./db");
const repo     = require("./repo");

const COLUMNS = {
  email: { value: "email_normalized", display: "email", verified: "email_verified_at" },
  phone: { value: "phone_normalized", display: "phone", verified: "phone_verified_at" }
};

function otherChannel(channel) { return channel === "email" ? "phone" : "email"; }

function conflictError(message) {
  return { ok: false, status: 409, code: "identifier_conflict", message: message };
}

/* attachIdentifier(customer, channel, value, display, verified)
   -> { ok, customer, conflict? }
   Sets email/phone on `customer`. With verified=true, an unverified copy on
   another record is detached first; a verified copy elsewhere is a conflict.
   With verified=false the identifier is attached only if nobody else has it. */
async function attachIdentifier(customer, channel, value, display, verified) {
  const col = COLUMNS[channel];
  const now = db.nowISO();

  const holder = await db.selectOne("customers", { [col.value]: value });
  if (holder && holder.id !== customer.id) {
    if (!verified) return { ok: true, customer: customer, conflict: true };
    if (holder[col.verified]) return { ok: false, customer: customer, conflict: true, verifiedElsewhere: true };
    // Detach the unverified copy — the person who proved control wins it.
    const detach = { updated_at: now };
    detach[col.value] = null;
    detach[col.display] = null;
    await db.update("customers", { where: { id: holder.id, [col.value]: value }, set: detach });
  }

  const patch = { updated_at: now };
  patch[col.value] = value;
  patch[col.display] = display || value;
  if (verified) patch[col.verified] = now;
  else if (customer[col.value] !== value) patch[col.verified] = null;

  try {
    const rows = await db.update("customers", { where: { id: customer.id }, set: patch });
    return { ok: true, customer: (rows && rows[0]) || Object.assign({}, customer, patch), conflict: false };
  } catch (err) {
    if (err instanceof db.UniqueViolationError) return { ok: true, customer: customer, conflict: true };
    throw err;
  }
}

/* completeRegistration(challenge) — the account_register challenge was just
   consumed. payload: { name, email, emailDisplay, phone, passwordHash }. */
async function completeRegistration(challenge) {
  const p        = challenge.payload || {};
  const channel  = challenge.channel;
  const proven   = challenge.identifier;
  const secondCh = otherChannel(channel);
  const secondVal = secondCh === "email" ? p.email : p.phone;
  const secondDisplay = secondCh === "email" ? p.emailDisplay : p.phone;
  const provenDisplay = channel === "email" ? (p.emailDisplay || proven) : proven;
  const col = COLUMNS[channel];

  if (!p.passwordHash) return { ok: false, status: 410, code: "challenge_expired",
    message: "This sign-up has expired. Please start again." };

  let target = await db.selectOne("customers", { [col.value]: proven });
  let claimedGuest = false;

  if (target) {
    if (await repo.hasCredentials(target.id)) {
      return { ok: false, status: 409, code: "account_exists",
        message: "An account already exists with these details. Please log in instead.", canLogin: true };
    }
    const secondCol = COLUMNS[secondCh];
    if (target[secondCol.verified]) {
      // Someone verified the OTHER identifier on this record (e.g. phone
      // sign-in). Proving this one does not give access to what they proved.
      // The proven identifier is detached from that record and gets its own.
      const attached = await createCustomer({ name: p.name, source: "account_registration" });
      const moved = await attachIdentifier(attached, channel, proven, provenDisplay, true);
      if (!moved.ok) return conflictError("This " + channel + " is already verified on another account.");
      target = moved.customer;
    } else {
      claimedGuest = true;
      const rows = await db.update("customers", {
        where: { id: target.id },
        set:   { [col.verified]: db.nowISO(), has_account: true, name: p.name || target.name,
                 updated_at: db.nowISO() }
      });
      target = (rows && rows[0]) || target;
    }
  } else {
    const fresh = await createCustomer({ name: p.name, source: "account_registration" });
    const attached = await attachIdentifier(fresh, channel, proven, provenDisplay, true);
    if (!attached.ok) return conflictError("This " + channel + " is already verified on another account.");
    target = attached.customer;
  }

  // Credentials. UNIQUE(customer_id) settles two registrations racing.
  const now = db.nowISO();
  try {
    await db.insert("customer_auth", {
      id: db.newId(), customer_id: target.id, password_hash: p.passwordHash,
      failed_attempts: 0, locked_until: null, created_at: now, updated_at: now
    });
  } catch (err) {
    if (err instanceof db.UniqueViolationError) {
      return { ok: false, status: 409, code: "account_exists",
        message: "An account already exists with these details. Please log in instead.", canLogin: true };
    }
    throw err;
  }
  target = (await repo.updateCustomer(target.id, { has_account: true })) || target;

  // The other identifier is recorded as typed but UNVERIFIED — it grants no
  // access until proven, and it never displaces anyone else's copy.
  const conflicts = {};
  if (secondVal && target[COLUMNS[secondCh].value] !== secondVal) {
    const second = await attachIdentifier(target, secondCh, secondVal, secondDisplay, false);
    target = second.customer;
    if (second.conflict) conflicts[secondCh] = "in_use";
  }

  const linked = await repo.linkOwnedOrders(target);
  if (claimedGuest) target = await repo.reseedProfileFromOwnedOrders(target, p.name);

  return { ok: true, customer: target, linked: linked, conflicts: conflicts };
}

async function createCustomer(fields) {
  const now = db.nowISO();
  const row = {
    id: db.newId(), name: fields.name || null,
    email: null, email_normalized: null, email_verified_at: null,
    phone: null, phone_normalized: null, phone_verified_at: null,
    address_line1: null, address_line2: null, city: null, state: null, pincode: null,
    country: "India", has_account: false, source: fields.source || "account_registration",
    created_at: now, updated_at: now
  };
  const inserted = await db.insert("customers", row);
  return (inserted && inserted[0]) || row;
}

/* signInWithVerifiedPhone(digits) — a phone_login challenge was just consumed.
   -> { ok:true, customer, created } | { ok:false, status, code, message } */
async function signInWithVerifiedPhone(digits) {
  let row = await db.selectOne("customers", { phone_normalized: digits });

  if (!row) {
    try {
      const fresh = await createCustomer({ source: "otp_login" });
      const attached = await attachIdentifier(fresh, "phone", digits, digits, true);
      row = attached.customer;
      const linked = await repo.linkOwnedOrders(row);
      if (linked) row = await repo.reseedProfileFromOwnedOrders(row, null);
      return { ok: true, customer: row, created: true, linked: linked };
    } catch (err) {
      if (!(err instanceof db.UniqueViolationError)) throw err;
      row = await db.selectOne("customers", { phone_normalized: digits });
      if (!row) throw err;
    }
  }

  if (row.phone_verified_at) {
    const linked = await repo.linkOwnedOrders(row);
    return { ok: true, customer: row, created: false, linked: linked };
  }

  if (row.has_account || row.email_verified_at || await repo.hasCredentials(row.id)) {
    // An account lists this number but never proved it. The code proves this
    // caller holds the number, not that they are that account's holder.
    return conflictError(
      "This mobile number is saved on an account that hasn't verified it yet. " +
      "Sign in with your email and password to verify it, or contact NAFUME support.");
  }

  // A plain guest record: the proven number claims it.
  const rows = await db.update("customers", {
    where: { id: row.id, phone_normalized: digits },
    set:   { phone_verified_at: db.nowISO(), updated_at: db.nowISO() }
  });
  row = (rows && rows[0]) || row;
  const linked = await repo.linkOwnedOrders(row);
  row = await repo.reseedProfileFromOwnedOrders(row, null);
  return { ok: true, customer: row, created: false, linked: linked };
}

/* verifyIdentifierForCustomer(customer, channel, value, display)
   A signed-in customer proved an email/phone (link_identifier challenge). */
async function verifyIdentifierForCustomer(customer, channel, value, display) {
  const fresh = (await repo.getCustomerById(customer.id)) || customer;
  const attached = await attachIdentifier(fresh, channel, value, display, true);
  if (!attached.ok) {
    return conflictError(channel === "phone"
      ? "This mobile number is already verified on another NAFUME account. Contact support to combine accounts."
      : "This email is already verified on another NAFUME account. Contact support to combine accounts.");
  }
  const linked = await repo.linkOwnedOrders(attached.customer);
  return { ok: true, customer: attached.customer, linked: linked };
}

module.exports = {
  completeRegistration, signInWithVerifiedPhone, verifyIdentifierForCustomer,
  attachIdentifier
};
