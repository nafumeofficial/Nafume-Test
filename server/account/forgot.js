/*
 * POST /api/account/forgot  —  step 1 of "Forgot password?"
 * ============================================================================
 * Body: { email }
 *
 * Sends a 6-digit code to the account's email, using the same expiring,
 * single-use, attempt-limited challenge as registration (_lib/verification.js).
 *
 * IT NEVER REVEALS WHETHER AN ACCOUNT EXISTS. Every valid-looking email gets the
 * same answer, the same shape, and (roughly) the same wait: a real challenge id
 * when a code was sent, a made-up one otherwise. A made-up id can never be
 * verified. Rate limits count per email address whether or not it has an
 * account, so the limit itself doesn't give anything away either.
 *
 * Only an account whose email has been VERIFIED can be reset by email. An email
 * that was merely typed on a guest order proves nothing about who owns the
 * account.
 */
"use strict";

const crypto       = require("crypto");
const http         = require("../_lib/http");
const validate     = require("../_lib/validate");
const auth         = require("../_lib/auth");
const repo         = require("../_lib/repo");
const verification = require("../_lib/verification");

const SAME_ANSWER = "If an account exists for that email, we've sent a 6-digit code to it. Enter it below to choose a new password.";

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "forgot", limit: 15, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const email = validate.normalizeEmail(body.email);
  if (!email) return http.fail(res, 400, "invalid_input", "Please enter a valid email address.", { fields: { email: "Please enter a valid email address." } });

  if (!await http.durableLimit(req, res, { key: "forgot-ip", limit: 15, windowMs: 30 * 60 * 1000 })) return;
  if (!await http.durableLimit(req, res, { key: "forgot-identity", scope: email, limit: 5, windowMs: 30 * 60 * 1000 })) return;

  try {
    const started = Date.now();
    const customer = await repo.findCustomer(email, null);
    const eligible = !!(customer && customer.email_verified_at && await repo.hasCredentials(customer.id));

    let challenge = null;
    if (eligible) {
      const r = await verification.start({
        purpose: "password_reset", channel: "email", identifier: email, customerId: customer.id,
        payload: { emailDisplay: validate.displayEmail(body.email) }
      });
      if (r.ok) challenge = r.challenge;
      // Pressed twice: hand back the code that was just sent (it still works).
      else if (r.code === "resend_too_soon") {
        challenge = await verification.currentChallenge({ purpose: "password_reset", channel: "email", identifier: email });
      }
    }

    // Take about the same time whether or not an email was sent.
    const spent = Date.now() - started;
    if (!challenge && spent < 900) await sleep(900 - spent + Math.floor(Math.random() * 200));

    return http.ok(res, {
      verificationRequired: true,
      challengeId:          challenge ? challenge.challengeId : crypto.randomUUID(),
      channel:              "email",
      destination:          challenge ? challenge.destination : "your email",
      resendAfterSeconds:   challenge ? challenge.resendAfterSeconds : 30,
      message:              SAME_ANSWER
    });
  } catch (err) {
    return http.handleError(res, err, "account/forgot");
  }
};
