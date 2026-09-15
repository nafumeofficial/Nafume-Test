/*
 * POST /api/otp/send  —  start phone sign-in (MSG91 SendOTP)
 * ============================================================================
 * Body: { phone }  →  { success, challengeId, destination, cooldownSeconds }
 *
 * Creates a phone_login verification challenge (bound to this number and to
 * sign-in only) and asks MSG91 to text the code. /api/otp/verify requires the
 * challengeId, so a code can only complete the sign-in it was sent for, at most
 * once, within its attempt limit. MSG91_AUTH_KEY never reaches the browser.
 *
 * DLT / MSG91 setup (India): an OTP template containing ##OTP##, DLT-approved,
 * with its Template ID and Sender ID in MSG91_TEMPLATE_ID / MSG91_SENDER_ID.
 */
"use strict";

const http         = require("../_lib/http");
const validate     = require("../_lib/validate");
const verification = require("../_lib/verification");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!http.rateLimit(req, res, { key: "otp-send", limit: 20, windowMs: 15 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const digits = validate.normalizePhone(body.phone);
  if (!digits) {
    return http.fail(res, 400, "invalid_phone", "Please enter a valid 10-digit Indian mobile number.");
  }

  /* Durable per-NUMBER and per-IP throttles. Each SMS costs money and lands on
     a real person's phone, so rotating IPs must not pump codes at one number. */
  if (!await http.durableLimit(req, res, {
    key: "otp-send-number", scope: digits, limit: 5, windowMs: 15 * 60 * 1000
  })) return;
  if (!await http.durableLimit(req, res, { key: "otp-send-ip", limit: 20, windowMs: 15 * 60 * 1000 })) return;

  try {
    const started = await verification.start({ purpose: "phone_login", channel: "phone", identifier: digits });
    if (!started.ok) {
      return http.fail(res, started.status, started.code, started.message, {
        cooldownSeconds: started.retryAfterSeconds || undefined
      });
    }
    return http.ok(res, Object.assign({ cooldownSeconds: started.challenge.resendAfterSeconds }, started.challenge));
  } catch (err) {
    return http.handleError(res, err, "otp/send");
  }
};
