/*
 * api/_lib/auth.js  —  password hashing, sessions, cookies
 * ============================================================================
 * Zero dependencies: everything here is built on node:crypto.
 *
 * PASSWORDS
 *   Hashed with scrypt (RFC 7914) — memory-hard, in Node's standard library,
 *   and a legitimate choice alongside bcrypt/argon2. Parameters N=16384, r=8,
 *   p=1, 64-byte output, 16-byte random salt per password.
 *   Stored as:  scrypt$N$r$p$<salt-base64>$<hash-base64>
 *   The parameters travel with the hash, so raising the cost later does not
 *   invalidate existing passwords. Comparison is timing-safe.
 *   Plaintext passwords are never stored, never logged, never returned.
 *
 * SESSIONS
 *   A 32-byte random token is given to the browser in an HttpOnly cookie. Only
 *   its SHA-256 hash is written to the database, so a database leak yields no
 *   usable sessions. Sessions are rows, so logout genuinely revokes them.
 *
 * CSRF
 *   The session cookie is SameSite=Lax, and every state-changing endpoint is a
 *   POST that requires Content-Type: application/json — a combination a
 *   cross-site form cannot produce without a CORS preflight. Authenticated
 *   endpoints additionally call assertSameOrigin().
 */
"use strict";

const crypto = require("crypto");
const db     = require("./db");

/* ── password hashing ────────────────────────────────────────────────────── */

const SCRYPT_N       = 16384;
const SCRYPT_R       = 8;
const SCRYPT_P       = 1;
const SCRYPT_KEYLEN  = 64;
const SCRYPT_SALT    = 16;
// 128 * N * r bytes are needed; give scrypt explicit headroom over the default.
const SCRYPT_MAXMEM  = 64 * 1024 * 1024;

function scryptAsync(password, salt, keylen, params) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, keylen, params, function (err, derived) {
      if (err) reject(err); else resolve(derived);
    });
  });
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(SCRYPT_SALT);
  const key  = await scryptAsync(String(plain), salt, SCRYPT_KEYLEN,
    { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P,
          salt.toString("base64"), key.toString("base64")].join("$");
}

/* verifyPassword(plain, stored) -> boolean. Never throws — a malformed stored
   hash is treated as "does not match" rather than crashing the login route. */
async function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    if (!N || !r || !p || N > 1048576) return false;

    const salt     = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!salt.length || !expected.length) return false;

    const actual = await scryptAsync(String(plain), salt, expected.length,
      { N: N, r: r, p: p, maxmem: SCRYPT_MAXMEM });

    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

/* ── session tokens ──────────────────────────────────────────────────────── */

const SESSION_COOKIE   = "nf_session";
const SESSION_DAYS     = 30;
const SESSION_MAX_AGE  = SESSION_DAYS * 24 * 60 * 60;   // seconds

function newToken()      { return crypto.randomBytes(32).toString("base64url"); }
function hashToken(tok)  { return crypto.createHash("sha256").update(String(tok)).digest("hex"); }

/* createSession(customerId, method) -> { token, expiresAt } */
async function createSession(customerId, method) {
  const token     = newToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

  await db.insert("sessions", {
    id:          db.newId(),
    customer_id: customerId,
    token_hash:  hashToken(token),
    method:      ["otp", "email_code", "phone_code"].indexOf(method) !== -1 ? method : "password",
    created_at:  db.nowISO(),
    expires_at:  expiresAt,
    revoked_at:  null
  });

  return { token: token, expiresAt: expiresAt };
}

async function revokeSession(token) {
  if (!token) return;
  await db.update("sessions", {
    where: { token_hash: hashToken(token) },
    set:   { revoked_at: db.nowISO() }
  });
}

async function revokeAllSessions(customerId) {
  await db.update("sessions", {
    where: { customer_id: customerId, revoked_at: ["is", null] },
    set:   { revoked_at: db.nowISO() }
  });
}

/* ── cookies ─────────────────────────────────────────────────────────────── */

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  String(header).split(";").forEach(function (pair) {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; } }
  });
  return out;
}

/* Secure flag is dropped only for plain-HTTP localhost, so the cookie still
   works during local development but is always Secure in any deployment. */
function isSecureRequest(req) {
  const proto = String((req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim();
  if (proto) return proto === "https";
  const host = String((req.headers && req.headers.host) || "");
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

function appendCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", value);
  else res.setHeader("Set-Cookie", (Array.isArray(existing) ? existing : [existing]).concat(value));
}

function setSessionCookie(req, res, token) {
  const parts = [
    SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + SESSION_MAX_AGE
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

function clearSessionCookie(req, res) {
  const parts = [
    SESSION_COOKIE + "=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

function readSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

/* ── current customer ────────────────────────────────────────────────────── */

/* getSession(req) -> { session, customer } | null
   Expired and revoked sessions resolve to null. */
async function getSession(req) {
  const token = readSessionToken(req);
  if (!token) return null;

  const session = await db.selectOne("sessions", { token_hash: hashToken(token) });
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const customer = await db.selectOne("customers", { id: session.customer_id });
  if (!customer) return null;

  return { session: session, customer: customer, token: token };
}

/* ── origin check ────────────────────────────────────────────────────────────
   Defence in depth on top of SameSite=Lax. Requests with no Origin header
   (same-origin navigations, curl, server-to-server) are allowed; a request
   that declares a DIFFERENT origin than the host is rejected.                */
function isSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = String((req.headers && req.headers.host) || "");
  try {
    return new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

/* ── bearer tokens for staff + scheduled jobs ────────────────────────────────
   bearerMatches(req, ["ADMIN_API_TOKEN", "CRON_SECRET"]) -> true when the
   Authorization header is "Bearer <value>" for one of the named variables.
   Constant-time per candidate; unset variables never match.                */
function bearerMatches(req, envNames) {
  const header = String((req.headers && req.headers.authorization) || "");
  const given  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  let matched = false;
  (envNames || []).forEach(function (name) {
    const expected = String(process.env[name] || "").trim();
    if (!expected) return;
    const b = crypto.createHash("sha256").update(expected).digest();
    if (crypto.timingSafeEqual(a, b)) matched = true;
  });
  return matched;
}
function anyConfigured(envNames) {
  return (envNames || []).some(function (n) { return String(process.env[n] || "").trim().length > 0; });
}

/* ── safe customer projection ────────────────────────────────────────────────
   The ONLY shape a customer record may take on its way to the browser. Password
   hashes, internal flags and other people's data can never leak through it.   */
function publicCustomer(c) {
  if (!c) return null;
  return {
    customerId: c.id,
    name:       c.name || "",
    email:      c.email || "",
    phone:      c.phone || "",
    emailVerified: !!c.email_verified_at,
    phoneVerified: !!c.phone_verified_at,
    hasAccount: !!c.has_account,
    address: {
      line1:   c.address_line1 || "",
      line2:   c.address_line2 || "",
      city:    c.city || "",
      state:   c.state || "",
      pincode: c.pincode || "",
      country: c.country || "India"
    },
    createdAt: c.created_at || null
  };
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, revokeSession, revokeAllSessions,
  setSessionCookie, clearSessionCookie, readSessionToken, parseCookies,
  getSession, isSameOrigin, publicCustomer, bearerMatches, anyConfigured,
  hashToken, newToken,
  SESSION_COOKIE, SESSION_MAX_AGE
};
