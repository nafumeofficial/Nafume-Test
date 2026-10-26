/*
 * POST /api/account/reset  —  step 2 of "Forgot password?"
 * ============================================================================
 * Body: { challengeId, code, newPassword }
 *
 * Consumes the password_reset challenge (expiring, single-use, attempt-limited)
 * and only then sets the new password. The new password is checked FIRST, so a
 * weak one costs the customer neither their code nor an attempt.
 *
 * On success: the password changes, any lockout is cleared, EVERY existing
 * session is signed out (so someone who had the old password is locked out),
 * and the customer is emailed a security notice. They are NOT signed in
 * automatically: they sign in with the new password.
 */
"use strict";

const http         = require("../_lib/http");
const validate     = require("../_lib/validate");
const auth         = require("../_lib/auth");
const db           = require("../_lib/db");
const repo         = require("../_lib/repo");
const messaging    = require("../_lib/messaging");
const verification = require("../_lib/verification");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "reset", limit: 30, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "reset-ip", limit: 30, windowMs: 15 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  const pw = validate.checkPassword(body.newPassword);
  if (!pw.ok) return http.fail(res, 400, "invalid_input", pw.message, { fields: { newPassword: pw.message } });

  try {
    const checked = await verification.verify({
      challengeId: body.challengeId, code: body.code, purpose: "password_reset"
    });
    if (!checked.ok) {
      return http.fail(res, checked.status, checked.code, checked.message,
        checked.attemptsRemaining !== undefined ? { attemptsRemaining: checked.attemptsRemaining } : undefined);
    }

    const customerId = checked.challenge.customer_id;
    const creds = customerId ? await db.selectOne("customer_auth", { customer_id: customerId }) : null;
    await verification.clearPayload(checked.challenge.id);
    if (!creds) {
      return http.fail(res, 410, "challenge_expired", "This code has expired or is no longer valid. Please request a new one.");
    }

    const hash = await auth.hashPassword(body.newPassword);
    await db.update("customer_auth", {
      where: { id: creds.id },
      set:   { password_hash: hash, failed_attempts: 0, locked_until: null, updated_at: db.nowISO() }
    });
    await auth.revokeAllSessions(customerId);

    // Security notice (best effort; never blocks the reset).
    try {
      const customer = await db.selectOne("customers", { id: customerId });
      if (customer && customer.email) {
        await messaging.send({
          channel: "email", to: customer.email,
          subject: "Your NAFUME password was changed",
          body: messaging.passwordChangedEmail(),
          relatedType: "password_reset", relatedId: checked.challenge.id
        });
      }
    } catch (e) { console.error("[account/reset] notice failed:", e && e.message); }

    return http.ok(res, { message: "Your password has been updated. Please sign in with your new password." });

  } catch (err) {
    return http.handleError(res, err, "account/reset");
  }
};
