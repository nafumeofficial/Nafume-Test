/*
 * server/_lib/abandoned.js  —  abandoned-checkout reminders
 * ============================================================================
 * Someone typed their email at checkout and did not finish. We keep ONE row per
 * email in `leads` (source "abandoned_checkout"), holding the cart as the server
 * priced it, and send ONE reminder email about an hour later — unless they
 * ordered in the meantime or unsubscribed. No new table: the lead row's metadata
 * carries the cart and the reminder state.
 *
 * The unsubscribe link carries an HMAC of the address, so nobody can unsubscribe
 * (or probe for) somebody else's email.
 */
"use strict";

const crypto = require("crypto");
const db     = require("./db");

const SOURCE            = "abandoned_checkout";
const REMIND_AFTER_MS   = 60 * 60 * 1000;          // 1 hour of silence
const GIVE_UP_AFTER_MS  = 48 * 60 * 60 * 1000;     // never remind about carts older than 2 days
const REREMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // at most one reminder a week per person

function key() {
  const label = "nafume-abandoned-unsubscribe|v1";
  if (process.env.VERIFICATION_SECRET) {
    return crypto.createHash("sha256").update(label + "|" + process.env.VERIFICATION_SECRET).digest();
  }
  return db.deriveServerKey(label) ||
         crypto.createHash("sha256").update(label + "|local-development-only").digest();
}
function tokenFor(emailNorm) {
  return crypto.createHmac("sha256", key()).update(String(emailNorm)).digest("hex").slice(0, 32);
}
function tokenValid(emailNorm, token) {
  const a = Buffer.from(tokenFor(emailNorm)), b = Buffer.from(String(token || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function unsubscribeUrl(siteUrl, emailNorm) {
  return siteUrl + "/api/checkout/unsubscribe?e=" + encodeURIComponent(emailNorm) + "&t=" + tokenFor(emailNorm);
}

module.exports = { SOURCE, REMIND_AFTER_MS, GIVE_UP_AFTER_MS, REREMIND_AFTER_MS, tokenFor, tokenValid, unsubscribeUrl };
