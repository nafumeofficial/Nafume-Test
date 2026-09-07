/*
 * api/_lib/http.js  —  shared request/response plumbing for the /api functions
 * ============================================================================
 * Keeps every endpoint consistent about: method guards, JSON body parsing,
 * status codes, safe error messages, and best-effort rate limiting.
 *
 * Rule enforced here: raw database/provider errors NEVER reach the customer.
 * `fail()` sends a short, human-readable message; the real cause is logged
 * server-side only.
 */
"use strict";

const db = require("./db");

/* ── responses ───────────────────────────────────────────────────────────── */

function json(res, status, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // These endpoints return per-customer data — never let a proxy or CDN cache it.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  return res.status(status).json(payload);
}

function ok(res, payload) { return json(res, 200, Object.assign({ success: true }, payload || {})); }

function fail(res, status, code, message, extra) {
  return json(res, status, Object.assign({ success: false, error: code, message: message }, extra || {}));
}

const MESSAGES = {
  method_not_allowed:   "That request method is not supported here.",
  invalid_json:         "We could not read that request. Please try again.",
  payload_too_large:    "That request was too large.",
  rate_limited:         "Too many attempts. Please wait a moment and try again.",
  storage_unavailable:  "Our system is temporarily unavailable. Please try again in a minute.",
  server_error:         "Something went wrong on our side. Please try again."
};

/* ── method guard ────────────────────────────────────────────────────────── */

/* guard(req, res, "POST") -> true when the handler should continue.
   Handles the CORS preflight verb so browsers never see a 405 for OPTIONS. */
function guard(req, res, method) {
  if (req.method === "OPTIONS") { res.status(204).end(); return false; }
  if (req.method !== method) {
    res.setHeader("Allow", method + ", OPTIONS");
    fail(res, 405, "method_not_allowed", MESSAGES.method_not_allowed);
    return false;
  }
  return true;
}

/* ── body parsing ────────────────────────────────────────────────────────── */

const MAX_BODY_BYTES = 512 * 1024;   // generous for a review photo, small enough to be safe

/* readJsonBody(req)
   Vercel normally pre-parses JSON into req.body. When it doesn't (or when the
   function runs behind the plain Node server used by the local test harness),
   fall back to reading the stream ourselves with a hard size cap. */
function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    if (req.body !== undefined && req.body !== null && typeof req.body !== "string") {
      return resolve(req.body);
    }
    if (typeof req.body === "string") {
      if (req.body.length === 0) return resolve({});
      try { return resolve(JSON.parse(req.body)); }
      catch (_) { return reject(new SyntaxError("invalid_json")); }
    }

    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks = [];

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      fn(value);
    }

    req.on("data", function (c) {
      if (tooLarge) return;               // already over the cap; just drain
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // DRAIN, don't destroy. Destroying the request socket also tears down
        // the response, so the client would see a network error instead of the
        // 413 we are about to send. Stop buffering, let the rest arrive and be
        // discarded, and answer properly.
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        const err = new Error("payload_too_large");
        err.code = "payload_too_large";
        return finish(reject, err);
      }
      chunks.push(c);
    });

    req.on("end", function () {
      if (tooLarge) return;
      if (!chunks.length) return finish(resolve, {});
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish(resolve, {});
      try { finish(resolve, JSON.parse(text)); }
      catch (_) { finish(reject, new SyntaxError("invalid_json")); }
    });

    req.on("error", function (err) { finish(reject, err); });
    req.on("aborted", function () { finish(reject, new Error("client_aborted")); });
  });
}

/* body(req, res) -> parsed object, or null when a response has already been
   sent because the body was unreadable. */
async function body(req, res) {
  try {
    const parsed = await readJsonBody(req);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (err) {
    if (err && err.code === "payload_too_large") {
      fail(res, 413, "payload_too_large", MESSAGES.payload_too_large);
    } else {
      fail(res, 400, "invalid_json", MESSAGES.invalid_json);
    }
    return null;
  }
}

/* ── storage guard ───────────────────────────────────────────────────────── */

/* requireStorage(res) -> true when the database is usable.
   Endpoints call this FIRST so they never report success for data they cannot
   actually persist. */
function requireStorage(res) {
  if (db.isConfigured()) return true;
  console.error("[api] database not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  fail(res, 503, "storage_unavailable", MESSAGES.storage_unavailable);
  return false;
}

/* ── error translation ───────────────────────────────────────────────────── */

/* handleError(res, err, where)
   Single place that decides what a customer is allowed to see. Logs the real
   error with a tag; returns a generic message. */
function handleError(res, err, where) {
  const tag = "[" + (where || "api") + "]";
  if (err instanceof db.DbNotConfiguredError) {
    console.error(tag, "database not configured");
    return fail(res, 503, "storage_unavailable", MESSAGES.storage_unavailable);
  }
  if (err instanceof db.DbError) {
    console.error(tag, "database error", err.status, err.detail);
    return fail(res, 503, "storage_unavailable", MESSAGES.storage_unavailable);
  }
  console.error(tag, err && err.message ? err.message : err);
  return fail(res, 500, "server_error", MESSAGES.server_error);
}

/* ── best-effort rate limiting ───────────────────────────────────────────────
   Per-instance, in-memory. Serverless spreads traffic across instances, so this
   throttles casual abuse and accidental double-submits, not a distributed
   attack. Endpoints that need hard limits (OTP) also rely on the upstream
   provider's own limits. Documented rather than pretended to be more.

   LIMITS ARE DELIBERATELY GENEROUS. Most Indian mobile networks put large
   numbers of customers behind carrier-grade NAT, so many genuine shoppers share
   one source IP. A limit tight enough to stop a determined attacker would lock
   out real customers first. The real protections live elsewhere and do not
   depend on IP at all: per-account lockout on login (api/account/login.js),
   UNIQUE constraints for duplicate writes, and server-side price recomputation.
   This layer only blunts accidental floods and casual scripted abuse.         */

const buckets = new Map();
const BUCKET_SWEEP_EVERY = 500;
let sinceSweep = 0;

function clientKey(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip  = (Array.isArray(fwd) ? fwd[0] : String(fwd || "")).split(",")[0].trim() ||
              (req.socket && req.socket.remoteAddress) || "unknown";
  return ip;
}

/* rateLimit(req, res, { key, limit, windowMs })
   -> true when the request may proceed (a 429 has been sent otherwise). */
function rateLimit(req, res, opts) {
  opts = opts || {};
  const limit    = opts.limit    || 20;
  const windowMs = opts.windowMs || 60000;
  const id       = (opts.key || "default") + "|" + clientKey(req);
  const now      = Date.now();

  if (++sinceSweep >= BUCKET_SWEEP_EVERY) {
    sinceSweep = 0;
    buckets.forEach(function (v, k) { if (v.resetAt <= now) buckets.delete(k); });
  }

  let b = buckets.get(id);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(id, b);
  }
  b.count++;
  if (b.count > limit) {
    const retry = Math.ceil((b.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retry));
    fail(res, 429, "rate_limited", MESSAGES.rate_limited, { retryAfterSeconds: retry });
    return false;
  }
  return true;
}

/* ── durable rate limiting ───────────────────────────────────────────────────
   The in-memory limiter above only ever sees the traffic that happens to land
   on one serverless instance, so an attacker spreading requests across
   instances defeats it. This variant keeps its counter in the database, so
   every instance shares one view.

   Design notes:
     * Fixed windows, not a sliding log — one row per (bucket, window), one
       read + one write per request. A sliding window would need a row per
       request, which is far more write load than these endpoints justify.
     * The bucket string carries the scope, so the same helper limits by IP
       ("login|1.2.3.4") or by identity ("otp-send|9876543210"). Limiting OTP
       by PHONE is the one that actually matters — an attacker rotating IPs
       still cannot pump SMS at one number.
     * FAIL-OPEN on storage errors. A database blip must not lock every
       customer out of checkout; the in-memory limiter is still in front, and
       the endpoint's own validation still applies. This is a deliberate
       availability-over-strictness choice for a storefront.
     * Expired rows are swept opportunistically (roughly 1 request in 50) so no
       cron is needed to keep the table small.                               */

const SWEEP_PROBABILITY = 0.02;

async function sweepExpired() {
  try {
    const stale = await db.select("rate_limits", {
      where: { window_end: ["lt", new Date(Date.now() - 60 * 60 * 1000).toISOString()] },
      limit: 200
    });
    for (let i = 0; i < stale.length; i++) {
      await db.update("rate_limits", { where: { id: stale[i].id }, set: { hits: 0 } });
    }
  } catch (_) { /* housekeeping only */ }
}

/* consume(bucket, limit, windowMs) -> { allowed, remaining, retryAfterSeconds }
   Never throws. */
async function consume(bucket, limit, windowMs) {
  if (!db.isConfigured()) return { allowed: true, remaining: limit, retryAfterSeconds: 0 };

  const now         = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const windowEnd   = new Date(Math.floor(now / windowMs) * windowMs + windowMs).toISOString();

  try {
    const existing = await db.selectOne("rate_limits", { bucket: bucket, window_start: windowStart });

    if (!existing) {
      try {
        await db.insert("rate_limits", {
          id: db.newId(), bucket: bucket,
          window_start: windowStart, window_end: windowEnd,
          hits: 1, created_at: db.nowISO(), updated_at: db.nowISO()
        });
        if (Math.random() < SWEEP_PROBABILITY) await sweepExpired();
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      } catch (err) {
        // Lost the insert race with a parallel request — fall through and
        // increment the row the winner created.
        if (!(err instanceof db.UniqueViolationError)) throw err;
      }
    }

    const row = existing || await db.selectOne("rate_limits", { bucket: bucket, window_start: windowStart });
    const hits = (row ? row.hits : 0) + 1;

    if (hits > limit) {
      return {
        allowed: false, remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((new Date(windowEnd).getTime() - now) / 1000))
      };
    }

    await db.update("rate_limits", {
      where: { bucket: bucket, window_start: windowStart },
      set:   { hits: hits, updated_at: db.nowISO() }
    });
    return { allowed: true, remaining: limit - hits, retryAfterSeconds: 0 };

  } catch (err) {
    console.error("[rate-limit] storage error — failing open:", err && err.message);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/* durableLimit(req, res, { key, limit, windowMs, scope })
   -> true when the request may proceed (a 429 has been sent otherwise).

   `scope` overrides the default per-IP bucket — pass a phone number or email to
   limit per identity instead. Always ALSO apply the in-memory rateLimit() first:
   it is free and absorbs bursts before they reach the database. */
async function durableLimit(req, res, opts) {
  opts = opts || {};
  const limit    = opts.limit || 20;
  const windowMs = opts.windowMs || 60000;
  const scope    = opts.scope != null && opts.scope !== "" ? String(opts.scope) : clientKey(req);
  const bucket   = (opts.key || "default") + "|" + scope;

  const result = await consume(bucket, limit, windowMs);
  if (result.allowed) return true;

  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  fail(res, 429, "rate_limited", MESSAGES.rate_limited, {
    retryAfterSeconds: result.retryAfterSeconds
  });
  return false;
}

module.exports = {
  json, ok, fail, guard, body, requireStorage, handleError, rateLimit,
  durableLimit, consume,
  clientKey, MESSAGES, MAX_BODY_BYTES
};
