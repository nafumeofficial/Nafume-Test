/*
 * POST /api/account/register  —  create a NAFUME customer account
 * ============================================================================
 * This is the endpoint behind "Create your account to track this order".
 *
 * The post-checkout case is the important one: the customer already exists as a
 * row (guest checkout created it), so registering ATTACHES credentials to that
 * existing customer instead of creating a second record. Their order history is
 * therefore correct from the very first login, with nothing to re-enter.
 *
 * Body: { name, email, phone, password }
 * Sets an HttpOnly session cookie on success — the customer is logged straight
 * in rather than being asked to sign in again.
 *
 * Passwords are hashed with scrypt (api/_lib/auth.js) and never stored,
 * returned, or logged in plaintext.
 */
"use strict";

const http     = require("../_lib/http");
const validate = require("../_lib/validate");
const auth     = require("../_lib/auth");
const repo     = require("../_lib/repo");
const db       = require("../_lib/db");

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

  if (!name)  e.add("name",  "Please enter your full name.");
  if (!email) e.add("email", "Please enter a valid email address.");
  if (!phone) e.add("phone", "Please enter a valid 10-digit Indian mobile number.");
  if (!pw.ok) e.add("password", pw.message);

  if (e.has()) {
    return http.fail(res, 400, "invalid_input", e.first(), { fields: e.errors });
  }

  try {
    /* ── existing account? ──────────────────────────────────────────────── */
    const existing = await repo.findCustomer(email, phone);

    if (existing) {
      const credentials = await db.selectOne("customer_auth", { customer_id: existing.id });
      if (credentials) {
        return http.fail(res, 409, "account_exists",
          "An account already exists with these details. Please log in instead.",
          { canLogin: true });
      }
    }

    /* ── customer row (reuse the guest-checkout record when there is one) ── */
    const found = existing
      ? { customer: existing }
      : await repo.findOrCreateCustomer({
          name: name, email: emailDisp, emailNormalized: email,
          phone: phone, phoneNormalized: phone,
          source: "account_registration", hasAccount: true
        });

    const customer = found.customer;

    // Fill in anything the account form supplies that the guest record lacked.
    const patch = { has_account: true };
    if (name && name !== customer.name) patch.name = name;
    if (email && !customer.email_normalized) { patch.email = emailDisp; patch.email_normalized = email; }
    if (phone && !customer.phone_normalized) { patch.phone = phone;     patch.phone_normalized = phone; }
    const updatedCustomer = (await repo.updateCustomer(customer.id, patch)) || customer;

    /* ── credentials ────────────────────────────────────────────────────── */
    const passwordHash = await auth.hashPassword(body.password);
    const now = db.nowISO();
    try {
      await db.insert("customer_auth", {
        id:              db.newId(),
        customer_id:     customer.id,
        password_hash:   passwordHash,
        failed_attempts: 0,
        locked_until:    null,
        created_at:      now,
        updated_at:      now
      });
    } catch (err) {
      if (err instanceof db.UniqueViolationError) {
        // Two registrations raced; the other one won.
        return http.fail(res, 409, "account_exists",
          "An account already exists with these details. Please log in instead.", { canLogin: true });
      }
      throw err;
    }

    /* ── link any orders that were not already attached ─────────────────── */
    const linked = await repo.attachOrphanOrders(updatedCustomer);

    /* ── log them in ────────────────────────────────────────────────────── */
    const session = await auth.createSession(customer.id, "password");
    auth.setSessionCookie(req, res, session.token);

    const orders = await repo.getOrdersForCustomer(customer.id, 20);

    return http.ok(res, {
      customer:    auth.publicCustomer(updatedCustomer),
      orderCount:  orders.length,
      ordersLinked: linked,
      message:     "Your NAFUME account is ready."
    });

  } catch (err) {
    return http.handleError(res, err, "account/register");
  }
};
