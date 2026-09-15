/*
 * POST /api/account/update  —  edit profile, address and marketing consent
 * ============================================================================
 * Requires a session. Only ever writes to the session's OWN customer row — the
 * customer id comes from the session cookie, never from the request body, so
 * one customer cannot edit another.
 *
 * Body (all optional): { name, address:{line1,line2,city,state,pincode},
 *                        whatsappOptIn }
 * Email and phone are NOT editable here. Putting an address you have not proven
 * on your account would let guest orders placed with it be matched to you, and
 * would block its real owner — so a changed email/phone is refused with
 * `verification_required` and goes through /api/account/identifiers instead.
 * Sending the current, unchanged values is accepted (the edit form does).
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

    /* ── email / phone: changes need verification ─────────────────────── */
    const wantsEmail = body.email !== undefined && validate.clean(body.email, 254) !== "" &&
      validate.normalizeEmail(body.email) !== (me.email_normalized || null);
    const wantsPhone = body.phone !== undefined && validate.clean(body.phone, 20) !== "" &&
      validate.normalizePhone(body.phone) !== (me.phone_normalized || null);
    if (wantsEmail || wantsPhone) {
      const fields = {};
      if (wantsEmail) fields.email = "Verify a new email with a code before it's saved.";
      if (wantsPhone) fields.phone = "Verify a new mobile number with a code before it's saved.";
      return http.fail(res, 400, "verification_required",
        "To change your " + (wantsEmail && wantsPhone ? "email and mobile number" : wantsEmail ? "email" : "mobile number") +
        ", verify the new one with a code first.", { fields: fields });
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
