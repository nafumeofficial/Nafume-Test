/*
 * POST /api/account/verify  —  step 2 of registration: prove the code
 * ============================================================================
 * Body: { challengeId, code }
 *
 * Consumes the account_register challenge (expiring, single-use, attempt
 * limited — see _lib/verification.js) and only then:
 *   - creates the account on the identifier that was proven,
 *   - records the other identifier as unverified (no access from it),
 *   - links the orders placed with the proven identifier,
 *   - starts a session.
 * A wrong, expired, replayed or superseded code changes nothing and never
 * returns customer data.
 */
"use strict";

const http         = require("../_lib/http");
const auth         = require("../_lib/auth");
const repo         = require("../_lib/repo");
const verification = require("../_lib/verification");
const accounts     = require("../_lib/accounts");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "account-verify", limit: 40, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "account-verify-ip", limit: 40, windowMs: 15 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  try {
    const checked = await verification.verify({
      challengeId: body.challengeId, code: body.code, purpose: "account_register"
    });
    if (!checked.ok) {
      return http.fail(res, checked.status, checked.code, checked.message,
        checked.attemptsRemaining !== undefined ? { attemptsRemaining: checked.attemptsRemaining } : undefined);
    }

    const done = await accounts.completeRegistration(checked.challenge);
    await verification.clearPayload(checked.challenge.id);

    if (!done.ok) {
      return http.fail(res, done.status, done.code, done.message, done.canLogin ? { canLogin: true } : undefined);
    }

    const session = await auth.createSession(done.customer.id, checked.challenge.channel === "phone" ? "phone_code" : "email_code");
    auth.setSessionCookie(req, res, session.token);

    const orders = await repo.getOwnedOrders(done.customer.id, 50);

    const notes = [];
    if (done.conflicts.phone) notes.push("That mobile number is linked to another NAFUME record, so it wasn't added. You can verify it from your account.");
    if (done.conflicts.email) notes.push("That email is linked to another NAFUME record, so it wasn't added. You can verify it from your account.");

    return http.ok(res, {
      customer:     auth.publicCustomer(done.customer),
      orderCount:   orders.length,
      ordersLinked: done.linked,
      conflicts:    done.conflicts,
      notes:        notes,
      message:      "Your NAFUME account is ready."
    });

  } catch (err) {
    return http.handleError(res, err, "account/verify");
  }
};
