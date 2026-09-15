/*
 * POST /api/account/resend-code  —  send a fresh code for a live challenge
 * ============================================================================
 * Body: { challengeId, purpose? }   purpose defaults to account_register
 *
 * Cooldown (OTP_RESEND_COOLDOWN_SECONDS), a per-challenge send cap
 * (OTP_MAX_SEND_ATTEMPTS) and a durable per-identifier ceiling apply. A new
 * code replaces the old one; the attempt count is NOT reset, so resending is
 * not a way to get more guesses.
 *
 * link_identifier challenges belong to a signed-in customer and may only be
 * resent from that customer's session.
 */
"use strict";

const http         = require("../_lib/http");
const auth         = require("../_lib/auth");
const verification = require("../_lib/verification");

const ALLOWED = ["account_register", "phone_login", "link_identifier"];

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "resend-code", limit: 20, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const purpose = ALLOWED.indexOf(String(body.purpose || "")) !== -1 ? String(body.purpose) : "account_register";

  try {
    const opts = { challengeId: body.challengeId, purpose: purpose };
    if (purpose === "link_identifier") {
      const session = await auth.getSession(req);
      if (!session) return http.fail(res, 401, "not_authenticated", "Please sign in again.");
      opts.customerId = session.customer.id;
    }
    const r = await verification.resend(opts);
    if (!r.ok) {
      return http.fail(res, r.status, r.code, r.message,
        r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : undefined);
    }
    return http.ok(res, Object.assign({ message: "A new code is on its way to " + r.challenge.destination + "." }, r.challenge));
  } catch (err) {
    return http.handleError(res, err, "account/resend-code");
  }
};
