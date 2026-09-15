/*
 * POST /api/account/register  —  step 1 of creating a NAFUME account
 * ============================================================================
 * This is the endpoint behind "Create your account to track this order".
 *
 * It does NOT create credentials, does NOT touch any existing customer record
 * and does NOT start a session. Anyone can type someone else's email or phone,
 * so registration first proves control of one identifier:
 *
 *   1. POST /api/account/register  { name, email, phone, password, verifyVia? }
 *        validates, refuses an existing account, hashes the password into a
 *        short-lived verification challenge, and sends a 6-digit code to the
 *        EMAIL (default) or, with verifyVia:"phone", by SMS.
 *        → { verificationRequired: true, challengeId, channel, destination }
 *   2. POST /api/account/verify  { challengeId, code }
 *        consumes the challenge, then creates the account on the proven
 *        identifier, links only the orders placed with that identifier, and
 *        signs the customer in. See _lib/accounts.js.
 *
 * Passwords are hashed with scrypt (api/_lib/auth.js) before they are stored
 * anywhere, including the challenge, and are never returned or logged.
 */
"use strict";

const http         = require("../_lib/http");
const validate     = require("../_lib/validate");
const auth         = require("../_lib/auth");
const repo         = require("../_lib/repo");
const verification = require("../_lib/verification");

const ACCOUNT_EXISTS = "An account already exists with these details. Please log in instead.";

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  if (!http.rateLimit(req, res, { key: "register", limit: 20, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;
  if (!await http.durableLimit(req, res, { key: "register-ip", limit: 15, windowMs: 30 * 60 * 1000 })) return;

  const body = await http.body(req, res);
  if (!body) return;

  /* ── validation ───────────────────────────────────────────────────────── */
  const e = validate.collector();

  const name      = validate.normalizeName(body.name);
  const email     = validate.normalizeEmail(body.email);
  const emailDisp = validate.displayEmail(body.email);
  const phone     = validate.normalizePhone(body.phone);
  const pw        = validate.checkPassword(body.password);
  const channel   = body.verifyVia === "phone" ? "phone" : "email";

  if (!name)  e.add("name",  "Please enter your full name.");
  if (!email) e.add("email", "Please enter a valid email address.");
  if (!phone) e.add("phone", "Please enter a valid 10-digit Indian mobile number.");
  if (!pw.ok) e.add("password", pw.message);

  if (e.has()) {
    return http.fail(res, 400, "invalid_input", e.first(), { fields: e.errors });
  }

  try {
    /* ── an account already on the identifier being proven? ─────────────── */
    const proven = channel === "email" ? email : phone;
    const holder = channel === "email"
      ? await repo.findCustomer(proven, null)
      : await repo.findCustomer(null, proven);
    if (holder && await repo.hasCredentials(holder.id)) {
      return http.fail(res, 409, "account_exists", ACCOUNT_EXISTS, { canLogin: true });
    }

    const passwordHash = await auth.hashPassword(body.password);

    const started = await verification.start({
      purpose:    "account_register",
      channel:    channel,
      identifier: proven,
      payload:    { name: name, email: email, emailDisplay: emailDisp, phone: phone, passwordHash: passwordHash }
    });

    if (!started.ok) {
      return http.fail(res, started.status, started.code, started.message,
        started.retryAfterSeconds ? { retryAfterSeconds: started.retryAfterSeconds } : undefined);
    }

    return http.ok(res, Object.assign({
      verificationRequired: true,
      message: channel === "email"
        ? "We've emailed a 6-digit code to " + started.challenge.destination + ". Enter it to finish creating your account."
        : "We've texted a 6-digit code to " + started.challenge.destination + ". Enter it to finish creating your account."
    }, started.challenge));

  } catch (err) {
    return http.handleError(res, err, "account/register");
  }
};
