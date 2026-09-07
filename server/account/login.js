/*
 * POST /api/account/login  —  email/phone + password sign-in
 * ============================================================================
 * Body: { identifier, password }   identifier = email OR 10-digit mobile
 *
 * Anti-enumeration: a wrong password, a customer with no account, and a
 * completely unknown identifier all return the SAME 401 with the same message,
 * and the unknown-identifier path still runs a scrypt verification against a
 * dummy hash so the response time does not reveal which case it was.
 *
 * Lockout: after LOCK_THRESHOLD consecutive failures the account is locked for
 * LOCK_MINUTES. Counters reset on a successful login.
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const auth     = require("../_lib/auth");
const repo     = require("../_lib/repo");
const db       = require("../_lib/db");

const LOCK_THRESHOLD = 8;
const LOCK_MINUTES   = 15;

const GENERIC = "Those details don't match an account. Please check and try again.";

/* A real scrypt hash of a value nobody can supply, used to burn the same CPU on
   the "no such account" path so timing cannot be used to enumerate customers. */
const DUMMY_HASH = "scrypt$16384$8$1$" +
  "AAAAAAAAAAAAAAAAAAAAAA==$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;
  if (!auth.isSameOrigin(req)) return http.fail(res, 403, "forbidden", "Request rejected.");
  // Generous per-IP: carrier NAT shares one IP across many real customers. The
  // meaningful brute-force defence is the per-account lockout further down.
  if (!http.rateLimit(req, res, { key: "login", limit: 40, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  const rawIdentifier = validate.clean(body.identifier, 254);
  const password      = typeof body.password === "string" ? body.password : "";

  if (!rawIdentifier || !password) {
    return http.fail(res, 400, "missing_credentials", "Please enter your email or mobile number and your password.");
  }
  if (password.length > validate.PASSWORD_MAX) {
    return http.fail(res, 401, "invalid_credentials", GENERIC);
  }

  const email = validate.normalizeEmail(rawIdentifier);
  const phone = validate.normalizePhone(rawIdentifier);
  if (!email && !phone) {
    return http.fail(res, 400, "invalid_identifier",
      "Please enter a valid email address or 10-digit mobile number.");
  }

  /* Durable, cross-instance limits. Two of them, because they stop different
     attacks:
       per IDENTITY — someone hammering one account from many IPs
       per IP       — someone spraying one password across many accounts
     Serverless spreads requests across instances, so the in-memory limiter
     above only ever sees a fraction of either. */
  if (!await http.durableLimit(req, res, {
    key: "login-identity", scope: email || phone, limit: 12, windowMs: 15 * 60 * 1000
  })) return;
  if (!await http.durableLimit(req, res, {
    key: "login-ip", limit: 50, windowMs: 15 * 60 * 1000
  })) return;

  try {
    const customer = await repo.findCustomer(email, phone);
    const credentials = customer
      ? await db.selectOne("customer_auth", { customer_id: customer.id })
      : null;

    if (!credentials) {
      await auth.verifyPassword(password, DUMMY_HASH);   // equalise timing
      return http.fail(res, 401, "invalid_credentials", GENERIC);
    }

    if (credentials.locked_until && new Date(credentials.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(credentials.locked_until).getTime() - Date.now()) / 60000);
      return http.fail(res, 423, "account_locked",
        "Too many failed attempts. Please try again in " + mins + " minute" + (mins === 1 ? "" : "s") + ".");
    }

    const matched = await auth.verifyPassword(password, credentials.password_hash);

    if (!matched) {
      const attempts = (credentials.failed_attempts || 0) + 1;
      const patch = { failed_attempts: attempts, updated_at: db.nowISO() };
      if (attempts >= LOCK_THRESHOLD) {
        patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        patch.failed_attempts = 0;
      }
      await db.update("customer_auth", { where: { id: credentials.id }, set: patch });
      return http.fail(res, 401, "invalid_credentials", GENERIC);
    }

    if (credentials.failed_attempts || credentials.locked_until) {
      await db.update("customer_auth", {
        where: { id: credentials.id },
        set:   { failed_attempts: 0, locked_until: null, updated_at: db.nowISO() }
      });
    }

    // Late-linking: catches orders placed as a guest since the last login.
    await repo.attachOrphanOrders(customer);

    const session = await auth.createSession(customer.id, "password");
    auth.setSessionCookie(req, res, session.token);

    return http.ok(res, { customer: auth.publicCustomer(customer) });

  } catch (err) {
    return http.handleError(res, err, "account/login");
  }
};
