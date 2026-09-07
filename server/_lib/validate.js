/*
 * api/_lib/validate.js  —  input normalization + validation
 * ============================================================================
 * One place for "what does a clean NAFUME record look like", so every endpoint
 * stores data the same shape and matching a repeat customer actually works.
 *
 * Normalization rules:
 *   name    trimmed, internal whitespace collapsed, length-capped
 *   email   trimmed + lowercased for the *_normalized matching column; the
 *           original casing is kept in the display column
 *   phone   digits only, last 10 kept (India). "+91 98765 43210", "098765 43210"
 *           and "9876543210" all normalize to "9876543210" so they match.
 *   pincode 6 digits, first digit 1-9
 */
"use strict";

/* ── primitives ──────────────────────────────────────────────────────────── */

function str(v) { return typeof v === "string" ? v : (v == null ? "" : String(v)); }

/* clean(value, maxLen) — trims, collapses runs of whitespace, caps length.
   Whitespace-only input becomes "" so it can be rejected as missing. */
function clean(v, maxLen) {
  const s = str(v).replace(/\s+/g, " ").trim();
  return maxLen ? s.slice(0, maxLen) : s;
}

/* cleanMultiline — like clean() but preserves newlines (review bodies, notes). */
function cleanMultiline(v, maxLen) {
  const s = str(v)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return maxLen ? s.slice(0, maxLen) : s;
}

function digitsOnly(v) { return str(v).replace(/\D/g, ""); }

/* ── email ───────────────────────────────────────────────────────────────── */

// Deliberately permissive-but-sane: one @, no spaces, a dot in the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

function isEmail(v) {
  const s = clean(v, 254);
  return s.length >= 6 && s.length <= 254 && EMAIL_RE.test(s);
}
function normalizeEmail(v) {
  const s = clean(v, 254).toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}
function displayEmail(v) { return clean(v, 254); }

/* ── phone (India) ───────────────────────────────────────────────────────── */

/* normalizePhone — returns the 10-digit subscriber number, or null.
   Accepts 10 digits, 91 + 10, 0 + 10, and +91 forms. */
function normalizePhone(v) {
  let d = digitsOnly(v);
  if (d.length > 10) {
    if (d.startsWith("91") && d.length === 12) d = d.slice(2);
    else if (d.startsWith("0") && d.length === 11) d = d.slice(1);
    else d = d.slice(-10);
  }
  if (d.length !== 10) return null;
  if (!/^[6-9]/.test(d)) return null;      // Indian mobile numbers start 6-9
  return d;
}
function isPhone(v) { return normalizePhone(v) !== null; }

/* ── address ─────────────────────────────────────────────────────────────── */

function normalizePincode(v) {
  const d = digitsOnly(v);
  return /^[1-9][0-9]{5}$/.test(d) ? d : null;
}

/* ── name ────────────────────────────────────────────────────────────────── */

function normalizeName(v) {
  const s = clean(v, 120);
  // Must contain at least one letter — rejects "123", "---", "   ".
  return /[A-Za-zÀ-ɏऀ-ॿ]/.test(s) ? s : null;
}

/* ── password ────────────────────────────────────────────────────────────── */

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

/* checkPassword — returns { ok } or { ok:false, message }.
   Length-first policy (long > complex) with a small floor on variety, and an
   upper bound so a huge string can't be used to burn scrypt CPU. */
function checkPassword(v) {
  const s = str(v);
  if (s.length < PASSWORD_MIN) {
    return { ok: false, message: "Password must be at least " + PASSWORD_MIN + " characters." };
  }
  if (s.length > PASSWORD_MAX) {
    return { ok: false, message: "Password is too long." };
  }
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) {
    return { ok: false, message: "Password must include at least one letter and one number." };
  }
  return { ok: true };
}

/* ── collector ───────────────────────────────────────────────────────────────
   Accumulates field errors so a form can highlight everything at once instead
   of making the customer fix one field per round-trip.                       */

function collector() {
  const errors = {};
  return {
    add: function (field, message) { if (!errors[field]) errors[field] = message; return this; },
    has: function () { return Object.keys(errors).length > 0; },
    errors: errors,
    /* first() — the message shown as the summary line in the UI. */
    first: function () {
      const k = Object.keys(errors)[0];
      return k ? errors[k] : null;
    }
  };
}

/* ── shipping address validation ─────────────────────────────────────────────
   Shared by checkout. Returns { valid, errors, value }.                      */

function validateShipping(input) {
  input = input || {};
  const e = collector();

  const name    = normalizeName(input.name);
  const phone   = normalizePhone(input.phone);
  const email   = normalizeEmail(input.email);
  const line1   = clean(input.addr1 !== undefined ? input.addr1 : input.line1, 200);
  const line2   = clean(input.addr2 !== undefined ? input.addr2 : input.line2, 200);
  const city    = clean(input.city, 80);
  const state   = clean(input.state, 80);
  const pincode = normalizePincode(input.pin !== undefined ? input.pin : input.pincode);

  if (!name)    e.add("name",    "Please enter your full name.");
  if (!phone)   e.add("phone",   "Please enter a valid 10-digit Indian mobile number.");
  if (!email)   e.add("email",   "Please enter a valid email address.");
  if (line1.length < 5) e.add("addr1", "Please enter your full street address.");
  if (city.length < 2)  e.add("city",  "Please enter your city.");
  if (state.length < 2) e.add("state", "Please select your state.");
  if (!pincode) e.add("pin",     "Please enter a valid 6-digit PIN code.");

  return {
    valid:  !e.has(),
    errors: e.errors,
    message: e.first(),
    value: {
      name:            name || "",
      phone:           phone || "",
      phoneNormalized: phone,
      email:           displayEmail(input.email),
      emailNormalized: email,
      line1:           line1,
      line2:           line2,
      city:            city,
      state:           state,
      pincode:         pincode || "",
      country:         "India"
    }
  };
}

/* ── inline image validation (review photos) ─────────────────────────────────
   Only JPEG/PNG/WebP data URLs are accepted, the base64 payload must decode,
   the decoded bytes must carry the matching magic number, and the size is
   capped. This stops a "photo" field being used to smuggle SVG/HTML (stored
   XSS) or an oversized blob.                                                 */

const IMAGE_MAX_BYTES = 350 * 1024;
const IMAGE_TYPES = {
  "image/jpeg": [[0xFF, 0xD8, 0xFF]],
  "image/png":  [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]]        // "RIFF" + "WEBP" checked below
};

function validateImageDataUrl(value) {
  const s = str(value).trim();
  if (!s) return { valid: true, value: null };        // optional field

  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) {
    return { valid: false, message: "Please upload a JPG, PNG or WebP image." };
  }
  const mime    = m[1];
  const payload = m[2];

  // 4 base64 chars -> 3 bytes; check before allocating the buffer.
  const approxBytes = Math.floor(payload.length * 3 / 4);
  if (approxBytes > IMAGE_MAX_BYTES) {
    return { valid: false, message: "Image is too large. Please use one under 350 KB." };
  }

  let buf;
  try { buf = Buffer.from(payload, "base64"); }
  catch (_) { return { valid: false, message: "That image could not be read." }; }

  if (!buf.length || buf.length > IMAGE_MAX_BYTES) {
    return { valid: false, message: "Image is too large. Please use one under 350 KB." };
  }

  // Magic-number check — the declared MIME type must match the actual bytes.
  const signatures = IMAGE_TYPES[mime] || [];
  const matches = signatures.some(function (sig) {
    return sig.every(function (byte, i) { return buf[i] === byte; });
  });
  if (!matches) return { valid: false, message: "That file is not a valid image." };
  if (mime === "image/webp" && buf.slice(8, 12).toString("ascii") !== "WEBP") {
    return { valid: false, message: "That file is not a valid image." };
  }

  return { valid: true, value: "data:" + mime + ";base64," + buf.toString("base64"), bytes: buf.length };
}

module.exports = {
  clean, cleanMultiline, digitsOnly,
  isEmail, normalizeEmail, displayEmail,
  isPhone, normalizePhone,
  normalizePincode, normalizeName,
  checkPassword, PASSWORD_MIN, PASSWORD_MAX,
  collector, validateShipping,
  validateImageDataUrl, IMAGE_MAX_BYTES
};
