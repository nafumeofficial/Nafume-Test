/*
 * POST /api/account/update  —  edit profile, address and marketing consent
 * ============================================================================
 * Requires a session. Only ever writes to the session's OWN customer row — the
 * customer id comes from the session cookie, never from the request body, so
 * one customer cannot edit another.
 *
 * Body (all optional): { name, email, phone, address:{line1,line2,city,state,pincode},
 *                        whatsappOptIn }
 * Changing email/phone to a value another customer already owns is rejected
 * rather than allowed to collide with the unique index.
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
  if (!http.rateLimit(req, res, { key: "account-update", limit: 20, windowMs: 10 * 60 * 1000 })) return;
  if (!http.requireStorage(res)) return;

  const body = await http.body(req, res);
  if (!body) return;

  try {
    const session = await auth.getSession(req);
    if (!session) {
      return http.fail(res, 401, "not_authenticated", "Please log in to update your details.");
    }
    const me = session.customer;
    const e  = validate.collector();
    const patch = {};

    /* ── name ───────────────────────────────────────────────────────────── */
    if (body.name !== undefined) {
      const name = validate.normalizeName(body.name);
      if (!name) e.add("name", "Please enter your full name.");
      else patch.name = name;
    }

    /* ── email ──────────────────────────────────────────────────────────── */
    if (body.email !== undefined && validate.clean(body.email, 254) !== (me.email || "")) {
      const email = validate.normalizeEmail(body.email);
      if (!email) {
        e.add("email", "Please enter a valid email address.");
      } else if (email !== me.email_normalized) {
        const clash = await db.selectOne("customers", { email_normalized: email });
        if (clash && clash.id !== me.id) {
          e.add("email", "That email is already used by another NAFUME account.");
        } else {
          patch.email = validate.displayEmail(body.email);
          patch.email_normalized = email;
        }
      }
    }

    /* ── phone ──────────────────────────────────────────────────────────── */
    if (body.phone !== undefined && validate.clean(body.phone, 20) !== (me.phone || "")) {
      const phone = validate.normalizePhone(body.phone);
      if (!phone) {
        e.add("phone", "Please enter a valid 10-digit Indian mobile number.");
      } else if (phone !== me.phone_normalized) {
        const clash = await db.selectOne("customers", { phone_normalized: phone });
        if (clash && clash.id !== me.id) {
          e.add("phone", "That mobile number is already used by another NAFUME account.");
        } else {
          patch.phone = phone;
          patch.phone_normalized = phone;
        }
      }
    }

    /* ── address ────────────────────────────────────────────────────────── */
    if (body.address && typeof body.address === "object") {
      const a = body.address;
      if (a.line1 !== undefined) patch.address_line1 = validate.clean(a.line1, 200);
      if (a.line2 !== undefined) patch.address_line2 = validate.clean(a.line2, 200);
      if (a.city  !== undefined) patch.city  = validate.clean(a.city, 80);
      if (a.state !== undefined) patch.state = validate.clean(a.state, 80);
      if (a.pincode !== undefined) {
        const pin = validate.normalizePincode(a.pincode);
        if (a.pincode && !pin) e.add("pincode", "Please enter a valid 6-digit PIN code.");
        else patch.pincode = pin || null;
      }
    }

    if (e.has()) {
      return http.fail(res, 400, "invalid_input", e.first(), { fields: e.errors });
    }

    const updated = Object.keys(patch).length ? await repo.updateCustomer(me.id, patch) : me;

    /* ── consent ────────────────────────────────────────────────────────── */
    let whatsappConsent = null;
    if (body.whatsappOptIn !== undefined) {
      whatsappConsent = await repo.setMarketingConsent(me.id, "whatsapp", body.whatsappOptIn === true, "account");
    } else {
      whatsappConsent = await repo.getConsent(me.id, "whatsapp");
    }

    return http.ok(res, {
      customer: auth.publicCustomer(updated || me),
      consent:  { whatsapp: !!(whatsappConsent && whatsappConsent.opted_in && !whatsappConsent.revoked_at) },
      message:  "Your details have been saved."
    });

  } catch (err) {
    return http.handleError(res, err, "account/update");
  }
};
