/*
 * api/_lib/verification.js  —  proof that someone controls an email or phone
 * ============================================================================
 * Every flow that grants access to existing customer data — creating an
 * account over a guest record, signing in by phone, linking earlier purchases —
 * goes through a challenge here first.
 *
 * A challenge is:
 *   BOUND        to one purpose (account_register | phone_login |
 *                link_identifier), one channel and one normalized identifier.
 *                Verifying an email never verifies a phone, and a code issued
 *                for one operation cannot complete another.
 *   EXPIRING     email codes live VERIFICATION_CODE_TTL_SECONDS (default 600);
 *                phone codes follow OTP_EXPIRY_SECONDS (default 300).
 *   SINGLE-USE   consumption is a conditional UPDATE on consumed_at IS NULL, so
 *                a replay — or two simultaneous correct submissions — succeeds
 *                at most once.
 *   ATTEMPT-LIMITED  OTP_MAX_VERIFY_ATTEMPTS (default 5) wrong codes and the
 *                challenge is dead; counting is a compare-and-set on `attempts`.
 *   THROTTLED    OTP_RESEND_COOLDOWN_SECONDS between sends, OTP_MAX_SEND_ATTEMPTS
 *                sends per challenge, and a durable per-identifier ceiling
 *                across challenges so starting over does not reset the budget.
 *   STORED SAFELY  email codes are kept only as HMAC-SHA256(secret, id:code);
 *                the outbound email body is redacted in outbound_messages.
 *                Phone codes never touch our database — MSG91 holds them.
 *
 * Nothing here writes an HTTP response; callers translate results.
 */
"use strict";

const crypto    = require("crypto");
const db        = require("./db");
const http      = require("./http");
const messaging = require("./messaging");
const msg91     = require("./msg91");

const PURPOSES = {
  account_register: "finish creating your NAFUME account",
  phone_login:      "sign in to NAFUME",
  link_identifier:  "confirm this address for your NAFUME account"
};

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function emailTtlSeconds()  { return intEnv("VERIFICATION_CODE_TTL_SECONDS", 600); }
function cooldownSeconds()  { return intEnv("OTP_RESEND_COOLDOWN_SECONDS", 30); }
function maxSends()         { return intEnv("OTP_MAX_SEND_ATTEMPTS", 3); }
function maxAttempts()      { return intEnv("OTP_MAX_VERIFY_ATTEMPTS", 5); }

/* Per-identifier ceiling across all challenges (30-minute window). */
const IDENTIFIER_SEND_LIMIT  = 6;
const IDENTIFIER_WINDOW_MS   = 30 * 60 * 1000;

/* The HMAC key for stored email codes. VERIFICATION_SECRET when set; otherwise
   a key derived (inside db.js) from the server-only database secret, so a
   database dump alone does not let live codes be brute-forced offline. */
function codeKey() {
  const label = "nafume-verification-code|v1";
  if (process.env.VERIFICATION_SECRET) {
    return crypto.createHash("sha256").update(label + "|" + process.env.VERIFICATION_SECRET).digest();
  }
  return db.deriveServerKey(label) ||
         crypto.createHash("sha256").update(label + "|local-development-only").digest();
}
function hashCode(challengeId, code) {
  return crypto.createHmac("sha256", codeKey()).update(challengeId + ":" + code).digest("hex");
}
function codesMatch(challengeId, code, storedHash) {
  if (!storedHash || !/^\d{6}$/.test(String(code || ""))) return false;
  const a = Buffer.from(hashCode(challengeId, code), "hex");
  const b = Buffer.from(String(storedHash), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, "0"); }

function liveKey(purpose, channel, identifier) { return purpose + "|" + channel + "|" + identifier; }

function mask(channel, identifier) {
  const s = String(identifier || "");
  if (channel === "phone") return "+91 ••••••" + s.slice(-4);
  const at = s.indexOf("@");
  if (at < 1) return "your email";
  const local = s.slice(0, at);
  return local.slice(0, Math.min(2, local.length)) + "•••" + s.slice(at);
}

function fail(status, code, message, extra) {
  return Object.assign({ ok: false, status: status, code: code, message: message }, extra || {});
}

const GONE = "This code has expired or is no longer valid. Please request a new one.";

function providerAvailable(channel) {
  return channel === "phone" ? msg91.configured() : messaging.emailConfigured();
}

async function deliver(challenge, code) {
  if (challenge.channel === "phone") {
    const r = await msg91.sendOtp(challenge.identifier);
    // "already have a valid OTP" means a code MSG91 issued moments ago is still
    // good; the customer can use that one.
    return r.ok || r.reason === "already_sent" ? { ok: true } : { ok: false, reason: r.reason };
  }
  const to = (challenge.payload && challenge.payload.emailDisplay) || challenge.identifier;
  const minutes = Math.round(emailTtlSeconds() / 60);
  const r = await messaging.send({
    channel: "email", to: to,
    subject: "Your NAFUME verification code",
    body: messaging.verificationCodeEmail(code, PURPOSES[challenge.purpose] || "continue", minutes),
    relatedType: "verification", relatedId: challenge.id,
    sensitive: true
  });
  return r.sent ? { ok: true } : { ok: false, reason: r.reason || "send_failed" };
}

function publicChallenge(row) {
  return {
    challengeId:        row.id,
    channel:            row.channel,
    destination:        mask(row.channel, row.identifier),
    expiresAt:          row.expires_at,
    resendAfterSeconds: cooldownSeconds()
  };
}

/* start({ purpose, channel, identifier, customerId, payload })
   -> { ok:true, challenge } | { ok:false, status, code, message } */
async function start(opts) {
  const purpose    = opts.purpose;
  const channel    = opts.channel === "phone" ? "phone" : "email";
  const identifier = String(opts.identifier || "");
  if (!PURPOSES[purpose] || !identifier) return fail(400, "invalid_request", "That request could not be completed.");

  if (!providerAvailable(channel)) {
    return fail(503, "verification_unavailable", channel === "phone"
      ? "Text-message codes are not available right now. Please use email verification or try again later."
      : "We can't send verification emails right now. Please try again later.");
  }

  const budget = await http.consume("verify-send|" + channel + "|" + identifier,
    IDENTIFIER_SEND_LIMIT, IDENTIFIER_WINDOW_MS);
  if (!budget.allowed) {
    return fail(429, "rate_limited", "Too many codes requested. Please wait a while and try again.",
      { retryAfterSeconds: budget.retryAfterSeconds });
  }

  const key = liveKey(purpose, channel, identifier);
  const now = Date.now();

  const existing = await db.selectOne("verification_challenges", { live_key: key });
  if (existing) {
    const sinceSend = (now - new Date(existing.last_sent_at).getTime()) / 1000;
    const stillValid = new Date(existing.expires_at).getTime() > now;
    if (stillValid && sinceSend < cooldownSeconds()) {
      return fail(429, "resend_too_soon", "A code was sent a moment ago. Please wait before requesting another.",
        { retryAfterSeconds: Math.max(1, Math.ceil(cooldownSeconds() - sinceSend)) });
    }
    // Starting over retires the old challenge: its code stops working, and
    // whatever it held for the operation is dropped.
    await db.update("verification_challenges", {
      where: { id: existing.id, live_key: key },
      set:   { live_key: null, invalidated_at: db.nowISO(), payload: {}, code_hash: null, updated_at: db.nowISO() }
    });
  }

  const id   = db.newId();
  const code = channel === "email" ? newCode() : null;
  const ttl  = channel === "phone" ? msg91.expirySeconds() : emailTtlSeconds();
  const row  = {
    id:             id,
    purpose:        purpose,
    channel:        channel,
    identifier:     identifier,
    customer_id:    opts.customerId || null,
    payload:        opts.payload || {},
    code_hash:      code ? hashCode(id, code) : null,
    provider:       channel === "phone" ? "msg91" : "resend",
    attempts:       0,
    max_attempts:   maxAttempts(),
    send_count:     1,
    last_sent_at:   new Date(now).toISOString(),
    expires_at:     new Date(now + ttl * 1000).toISOString(),
    consumed_at:    null,
    invalidated_at: null,
    live_key:       key,
    created_at:     new Date(now).toISOString(),
    updated_at:     new Date(now).toISOString()
  };

  try {
    await db.insert("verification_challenges", row);
  } catch (err) {
    if (err instanceof db.UniqueViolationError) {
      return fail(429, "resend_too_soon", "A code was sent a moment ago. Please wait before requesting another.",
        { retryAfterSeconds: cooldownSeconds() });
    }
    throw err;
  }

  const sent = await deliver(row, code);
  if (!sent.ok) {
    await db.update("verification_challenges", {
      where: { id: id }, set: { live_key: null, invalidated_at: db.nowISO(), payload: {}, updated_at: db.nowISO() }
    });
    return fail(502, "verification_send_failed",
      "We couldn't send your code just now. Please try again in a moment.");
  }

  return { ok: true, challenge: publicChallenge(row) };
}

/* resend({ challengeId, purpose }) -> same shape as start() */
async function resend(opts) {
  const row = opts.challengeId ? await db.selectOne("verification_challenges", { id: String(opts.challengeId) }) : null;
  if (!row || row.purpose !== opts.purpose || !row.live_key || row.consumed_at) {
    return fail(410, "challenge_expired", GONE);
  }
  if (opts.customerId !== undefined && row.customer_id !== (opts.customerId || null)) {
    return fail(410, "challenge_expired", GONE);
  }
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) return fail(410, "challenge_expired", GONE);

  const sinceSend = (now - new Date(row.last_sent_at).getTime()) / 1000;
  if (sinceSend < cooldownSeconds()) {
    return fail(429, "resend_too_soon", "Please wait a moment before requesting another code.",
      { retryAfterSeconds: Math.max(1, Math.ceil(cooldownSeconds() - sinceSend)) });
  }
  if ((row.send_count || 1) >= maxSends()) {
    return fail(429, "too_many_sends", "That's the most codes we can send for now. Please start again later.");
  }
  if (!providerAvailable(row.channel)) {
    return fail(503, "verification_unavailable", "We can't send codes right now. Please try again later.");
  }
  const budget = await http.consume("verify-send|" + row.channel + "|" + row.identifier,
    IDENTIFIER_SEND_LIMIT, IDENTIFIER_WINDOW_MS);
  if (!budget.allowed) {
    return fail(429, "rate_limited", "Too many codes requested. Please wait a while and try again.",
      { retryAfterSeconds: budget.retryAfterSeconds });
  }

  const code = row.channel === "email" ? newCode() : null;
  const ttl  = row.channel === "phone" ? msg91.expirySeconds() : emailTtlSeconds();
  const set  = {
    send_count:   (row.send_count || 1) + 1,
    last_sent_at: new Date(now).toISOString(),
    expires_at:   new Date(now + ttl * 1000).toISOString(),
    updated_at:   new Date(now).toISOString()
  };
  // The previous code stops working the moment a new one is issued.
  if (code) set.code_hash = hashCode(row.id, code);

  const claimed = await db.update("verification_challenges", {
    where: { id: row.id, send_count: row.send_count || 1, consumed_at: ["is", null] },
    set:   set
  });
  if (!claimed || !claimed.length) {
    return fail(429, "resend_too_soon", "Please wait a moment before requesting another code.",
      { retryAfterSeconds: cooldownSeconds() });
  }

  const sent = await deliver(Object.assign({}, row, set), code);
  if (!sent.ok) return fail(502, "verification_send_failed", "We couldn't send your code just now. Please try again.");
  return { ok: true, challenge: publicChallenge(Object.assign({}, row, set)) };
}

/* verify({ challengeId, code, purpose, customerId? })
   -> { ok:true, challenge } | { ok:false, status, code, message }
   On success the challenge is consumed; the caller performs the operation and
   then calls clearPayload(). */
async function verify(opts) {
  const id   = String(opts.challengeId || "");
  const code = String(opts.code || "").replace(/\D/g, "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(410, "challenge_expired", GONE);
  if (code.length !== 6) return fail(400, "invalid_code_format", "Please enter the 6-digit code.");

  const row = await db.selectOne("verification_challenges", { id: id });
  if (!row || row.purpose !== opts.purpose) return fail(410, "challenge_expired", GONE);
  if (opts.customerId !== undefined && row.customer_id !== (opts.customerId || null)) {
    return fail(410, "challenge_expired", GONE);
  }
  if (row.consumed_at) return fail(410, "challenge_used", "This code has already been used. Please request a new one.");
  if (row.invalidated_at || !row.live_key) return fail(410, "challenge_expired", GONE);

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.update("verification_challenges", {
      where: { id: row.id, live_key: row.live_key },
      set:   { live_key: null, invalidated_at: db.nowISO(), payload: {}, code_hash: null, updated_at: db.nowISO() }
    });
    return fail(410, "challenge_expired", "This code has expired. Please request a new one.");
  }

  const used = row.attempts || 0;
  const max  = row.max_attempts || maxAttempts();
  if (used >= max) {
    return fail(429, "too_many_attempts", "Too many incorrect attempts. Please request a new code.");
  }

  // Claim one attempt atomically BEFORE checking the code.
  const counted = await db.update("verification_challenges", {
    where: { id: row.id, attempts: used, consumed_at: ["is", null] },
    set:   { attempts: used + 1, updated_at: db.nowISO() }
  });
  if (!counted || !counted.length) {
    return fail(409, "verification_busy", "Please try that code again.");
  }

  let correct = false;
  if (row.channel === "phone") {
    const checked = await msg91.verifyOtp(row.identifier, code);
    if (!checked.ok && checked.reason === "unavailable") {
      return fail(503, "verification_unavailable", "We couldn't check your code right now. Please try again.");
    }
    correct = checked.ok;
  } else {
    correct = codesMatch(row.id, code, row.code_hash);
  }

  if (!correct) {
    const remaining = Math.max(0, max - (used + 1));
    if (remaining === 0) {
      await db.update("verification_challenges", {
        where: { id: row.id, live_key: row.live_key },
        set:   { live_key: null, invalidated_at: db.nowISO(), payload: {}, updated_at: db.nowISO() }
      });
      return fail(429, "too_many_attempts", "Too many incorrect attempts. Please request a new code.");
    }
    return fail(422, "invalid_code", "That code isn't right. Please check it and try again.",
      { attemptsRemaining: remaining });
  }

  // Single use: only one caller can move consumed_at from NULL.
  const consumed = await db.update("verification_challenges", {
    where: { id: row.id, consumed_at: ["is", null], live_key: row.live_key },
    set:   { consumed_at: db.nowISO(), live_key: null, code_hash: null, updated_at: db.nowISO() }
  });
  if (!consumed || !consumed.length) {
    return fail(410, "challenge_used", "This code has already been used. Please request a new one.");
  }

  return { ok: true, challenge: consumed[0] };
}

/* Drop anything sensitive held for the operation (e.g. a password hash). */
async function clearPayload(challengeId) {
  try {
    await db.update("verification_challenges", {
      where: { id: challengeId }, set: { payload: {}, updated_at: db.nowISO() }
    });
  } catch (err) {
    console.error("[verification] payload clear failed:", err && err.message);
  }
}

/* purgeExpired() — housekeeping for the daily maintenance job. Challenges that
   expired over an hour ago lose their payload (e.g. a pending registration's
   password hash) and any leftover code hash. Rows are kept for audit. */
async function purgeExpired() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = await db.update("verification_challenges", {
    where: { expires_at: ["lt", cutoff], consumed_at: ["is", null], invalidated_at: ["is", null] },
    set:   { payload: {}, code_hash: null, live_key: null, invalidated_at: db.nowISO(), updated_at: db.nowISO() }
  });
  return (rows || []).length;
}

module.exports = {
  PURPOSES, start, resend, verify, clearPayload, mask, purgeExpired,
  _hashCode: hashCode
};
