/*
 * POST /api/otp/verify  —  finish phone sign-in (MSG91 VerifyOTP)
 * ============================================================================
 * Body: { challengeId, phone, otp }
 *
 * The code is checked against the phone_login challenge it was issued for
 * (expiring, single-use, attempt limited — _lib/verification.js), and only a
 * consumed challenge leads to a session:
 *   - a number already verified on a record signs in to that record;
 *   - a number on a plain guest record claims it (orders placed with that
 *     number are linked, nothing else);
 *   - a number listed, unverified, on someone's ACCOUNT is a conflict: no
 *     session, and the customer is told how to resolve it;
 *   - an unknown number gets a new, verified profile.
 * Proving a phone never verifies an email.
 */
"use strict";

const http         = require("../_lib/http");
const auth         = require("../_lib/auth");
const validate     = require("../_lib/validate");
const verification = require("../_lib/verification");
const accounts     = require("../_lib/accounts");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "otp-verify", limit: 40, windowMs: 15 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const digits = validate.normalizePhone(body.phone);
  const otp    = String(body.otp || "").replace(/\D/g, "");
  if (!digits) return http.fail(res, 400, "invalid_phone", "Invalid phone number.");
  if (otp.length !== 6) return http.fail(res, 400, "invalid_otp_format", "Please enter the 6-digit OTP.");
  if (!body.challengeId) {
    return http.fail(res, 400, "challenge_required", "Please request a new code and try again.");
  }

  if (!await http.durableLimit(req, res, {
    key: "otp-verify-number", scope: digits, limit: 8, windowMs: 15 * 60 * 1000
  })) return;
  if (!await http.durableLimit(req, res, { key: "otp-verify-ip", limit: 40, windowMs: 15 * 60 * 1000 })) return;

  try {
    const checked = await verification.verify({ challengeId: body.challengeId, code: otp, purpose: "phone_login" });
    if (!checked.ok) {
      const code = checked.code === "invalid_code" ? "invalid_otp"
                 : checked.code === "challenge_expired" ? "otp_expired" : checked.code;
      return http.fail(res, checked.status, code, checked.message,
        checked.attemptsRemaining !== undefined ? { attemptsRemaining: checked.attemptsRemaining } : undefined);
    }
    if (checked.challenge.identifier !== digits) {
      // The challenge was for a different number than the one submitted.
      return http.fail(res, 410, "otp_expired", "This code has expired or is no longer valid. Please request a new one.");
    }

    const signedIn = await accounts.signInWithVerifiedPhone(digits);
    if (!signedIn.ok) return http.fail(res, signedIn.status, signedIn.code, signedIn.message);

    const session = await auth.createSession(signedIn.customer.id, "otp");
    auth.setSessionCookie(req, res, session.token);

    return http.ok(res, {
      session:  true,
      customer: auth.publicCustomer(signedIn.customer),
      ordersLinked: signedIn.linked || 0
    });
  } catch (err) {
    return http.handleError(res, err, "otp/verify");
  }
};
