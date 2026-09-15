/*
 * POST /api/account/identifiers  —  verify an email or phone for my account
 * ============================================================================
 * Requires a session. Two actions:
 *
 *   { action: "start",   channel: "email"|"phone", value }
 *       sends a code to that address (link_identifier challenge bound to THIS
 *       customer, THIS channel and THIS value)
 *   { action: "confirm", challengeId, code }
 *       on success: the identifier is saved as VERIFIED on this account, any
 *       unverified copy on another record is detached, and orders placed with
 *       it are linked. If another account has already VERIFIED it, nothing is
 *       merged — the customer is told to contact support.
 *
 * This is how a customer changes their email/phone, verifies the unverified
 * one from registration, and brings in purchases made with a different email
 * or number.
 */
"use strict";

const http         = require("../_lib/http");
const validate     = require("../_lib/validate");
const auth         = require("../_lib/auth");
const repo         = require("../_lib/repo");
const verification = require("../_lib/verification");
const accounts     = require("../_lib/accounts");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "identifiers", limit: 30, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  try {
    const session = await auth.getSession(req);
    if (!session) return http.fail(res, 401, "not_authenticated", "Please sign in to verify your details.");
    const me = session.customer;

    if (body.action === "start") {
      const channel = body.channel === "phone" ? "phone" : body.channel === "email" ? "email" : null;
      if (!channel) return http.fail(res, 400, "invalid_channel", "Choose email or mobile number.");

      const value = channel === "email" ? validate.normalizeEmail(body.value) : validate.normalizePhone(body.value);
      if (!value) {
        return http.fail(res, 400, "invalid_input", channel === "email"
          ? "Please enter a valid email address." : "Please enter a valid 10-digit Indian mobile number.");
      }
      const verifiedCol = channel === "email" ? "email_verified_at" : "phone_verified_at";
      const valueCol    = channel === "email" ? "email_normalized" : "phone_normalized";
      if (me[valueCol] === value && me[verifiedCol]) {
        return http.ok(res, { alreadyVerified: true, message: "That's already verified on your account." });
      }

      const started = await verification.start({
        purpose: "link_identifier", channel: channel, identifier: value, customerId: me.id,
        payload: { display: channel === "email" ? validate.displayEmail(body.value) : value,
                   emailDisplay: channel === "email" ? validate.displayEmail(body.value) : undefined }
      });
      if (!started.ok) {
        return http.fail(res, started.status, started.code, started.message,
          started.retryAfterSeconds ? { retryAfterSeconds: started.retryAfterSeconds } : undefined);
      }
      return http.ok(res, Object.assign({ verificationRequired: true,
        message: "Enter the 6-digit code we sent to " + started.challenge.destination + "." }, started.challenge));
    }

    if (body.action === "confirm") {
      const checked = await verification.verify({
        challengeId: body.challengeId, code: body.code, purpose: "link_identifier", customerId: me.id
      });
      if (!checked.ok) {
        return http.fail(res, checked.status, checked.code, checked.message,
          checked.attemptsRemaining !== undefined ? { attemptsRemaining: checked.attemptsRemaining } : undefined);
      }
      const ch = checked.challenge;
      const done = await accounts.verifyIdentifierForCustomer(me, ch.channel, ch.identifier,
        (ch.payload && ch.payload.display) || ch.identifier);
      await verification.clearPayload(ch.id);
      if (!done.ok) return http.fail(res, done.status, done.code, done.message);

      const orders = await repo.getOwnedOrders(done.customer.id, 50);
      return http.ok(res, {
        customer:     auth.publicCustomer(done.customer),
        ordersLinked: done.linked,
        orderCount:   orders.length,
        message:      done.linked
          ? "Verified — " + done.linked + " earlier order" + (done.linked === 1 ? " was" : "s were") + " added to your account."
          : "Verified."
      });
    }

    return http.fail(res, 400, "invalid_action", "action must be start or confirm.");

  } catch (err) {
    return http.handleError(res, err, "account/identifiers");
  }
};
