/*
 * api/_lib/db.js  —  NAFUME data layer
 * ============================================================================
 * A tiny, dependency-free storage abstraction with two interchangeable drivers.
 * The repo has no package.json and no build step, so this deliberately uses
 * nothing but Node built-ins + global fetch.
 *
 *   driver "supabase"  (production)
 *     Talks to Supabase's PostgREST endpoint over plain HTTPS. Real Postgres:
 *     real UNIQUE constraints, real indexes, real foreign keys. The schema
 *     lives in db/schema.sql — run it once in the Supabase SQL editor.
 *     Requires:  SUPABASE_URL  +  SUPABASE_SERVICE_ROLE_KEY
 *     The service-role key bypasses RLS, so it MUST stay server-side only.
 *     It is never sent to the browser by any endpoint in this repo.
 *
 *   driver "d1"  (Cloudflare Workers)
 *     Talks to a Cloudflare D1 (SQLite) database through the Worker's `DB`
 *     binding — no network credentials, no public endpoint. The Worker entry
 *     (worker/index.js) hands the binding over with setD1Binding(env.DB).
 *     The schema lives in db/d1/schema.sql. See server/_lib/db-d1.js.
 *
 *   driver "memory"  (local development + automated tests ONLY)
 *     In-process objects, optionally mirrored to a JSON file (NAFUME_DB_FILE).
 *     Enforces the same UNIQUE constraints as schema.sql so idempotency logic
 *     can be tested truthfully. NEVER usable in production: isConfigured()
 *     reports false unless NAFUME_DB_DRIVER=memory is set explicitly, and
 *     endpoints refuse to pretend they persisted anything when it isn't set.
 *
 * Driver selection:
 *   NAFUME_DB_DRIVER = "d1" | "supabase" | "memory"   (optional explicit override)
 *   otherwise: "d1" when a D1 binding has been supplied (Cloudflare Workers),
 *              "supabase" when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY exist,
 *              otherwise unconfigured (every call throws DbNotConfiguredError).
 *
 * Query shape (identical across drivers so tests mean something):
 *   select(table, { where, order, limit, columns })
 *   insert(table, row|rows, { onConflict, ignoreDuplicates, mergeDuplicates })
 *   update(table, { where, set })
 *   count (table, { where })
 *
 * `where` values:
 *   plain value          -> equality
 *   [op, value]          -> operator; op in eq|neq|gt|gte|lt|lte|is|in|like|ilike
 *   e.g. { delivered_at: ["lte", iso], review_requested_at: ["is", null] }
 */
"use strict";

const crypto = require("crypto");
const fs     = require("fs");
const { createD1Driver } = require("./db-d1");

/* ── Errors ──────────────────────────────────────────────────────────────── */

class DbNotConfiguredError extends Error {
  constructor(msg) {
    super(msg || "Database is not configured.");
    this.name = "DbNotConfiguredError";
    this.code = "db_not_configured";
  }
}
class DbError extends Error {
  constructor(msg, status, detail) {
    super(msg || "Database request failed.");
    this.name   = "DbError";
    this.code   = "db_error";
    this.status = status || 0;
    this.detail = detail || null;
  }
}
/* Raised when a UNIQUE constraint rejects a write and the caller did not ask
   for conflicts to be ignored/merged. Callers use this for idempotency. */
class UniqueViolationError extends Error {
  constructor(table, constraint) {
    super("Unique constraint violated on " + table);
    this.name       = "UniqueViolationError";
    this.code       = "unique_violation";
    this.table      = table;
    this.constraint = constraint || null;
  }
}

/* ── Schema knowledge shared by both drivers ─────────────────────────────────
   Mirrors the UNIQUE constraints declared in db/schema.sql. The supabase driver
   gets these enforced by Postgres itself; the memory driver enforces them here
   so local tests exercise the same failure modes. Keep the two in sync.      */
const UNIQUE_KEYS = {
  customers:            [["email_normalized"], ["phone_normalized"]],
  customer_auth:        [["customer_id"]],
  sessions:             [["token_hash"]],
  orders:               [["order_id"], ["razorpay_payment_id"], ["razorpay_order_id"]],
  order_items:          [],
  leads:                [["email_normalized", "source"]],
  quiz_responses:       [],
  reviews:              [["order_id", "product_id"]],
  marketing_consent:    [["customer_id", "channel"]],
  review_requests:      [["order_id"], ["access_token_hash"]],
  outbound_messages:    [],
  // slot_key is non-null only while a redemption holds an allowance slot, so
  // UNIQUE(slot_key) stops two parallel checkouts spending the same reward.
  discount_redemptions: [["code", "order_id"], ["slot_key"]],
  rate_limits:          [["bucket", "window_start"]],
  // live_key is non-null only while a challenge can still be used, so there is
  // at most one live challenge per (purpose, channel, identifier).
  verification_challenges: [["live_key"]],
  // One row per provider event id: a redelivered webhook is recognised.
  payment_events:       [["event_key"]]
};

const TABLES = Object.keys(UNIQUE_KEYS);

/* ── where-clause helpers ────────────────────────────────────────────────── */

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "like", "ilike"];

function normalizeCondition(raw) {
  if (Array.isArray(raw) && raw.length === 2 && OPS.indexOf(raw[0]) !== -1) {
    return { op: raw[0], value: raw[1] };
  }
  if (raw === null) return { op: "is", value: null };
  return { op: "eq", value: raw };
}

/* ── memory driver ───────────────────────────────────────────────────────── */

function createMemoryDriver(filePath) {
  const store = {};
  TABLES.forEach(function (t) { store[t] = []; });

  function load() {
    if (!filePath) return;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      TABLES.forEach(function (t) {
        if (Array.isArray(parsed[t])) store[t] = parsed[t];
      });
    } catch (_) { /* first run / unreadable — start empty */ }
  }
  function flush() {
    if (!filePath) return;
    try { fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8"); }
    catch (_) { /* non-fatal for a dev driver */ }
  }
  load();

  function tableOf(name) {
    if (!store[name]) throw new DbError("Unknown table: " + name);
    return store[name];
  }

  function matches(row, where) {
    if (!where) return true;
    return Object.keys(where).every(function (col) {
      const c = normalizeCondition(where[col]);
      const v = row[col];
      switch (c.op) {
        case "eq":   return v === c.value;
        case "neq":  return v !== c.value;
        case "gt":   return v != null && v >  c.value;
        case "gte":  return v != null && v >= c.value;
        case "lt":   return v != null && v <  c.value;
        case "lte":  return v != null && v <= c.value;
        case "is":   return c.value === null ? (v === null || v === undefined) : v === c.value;
        case "in":   return Array.isArray(c.value) && c.value.indexOf(v) !== -1;
        case "like": return typeof v === "string" &&
                       new RegExp("^" + String(c.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$").test(v);
        case "ilike":return typeof v === "string" &&
                       new RegExp("^" + String(c.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i").test(v);
        default:     return false;
      }
    });
  }

  /* Returns the conflicting row for the first violated unique key, or null.
     NULLs never conflict — same as Postgres UNIQUE semantics. */
  function findConflict(name, row) {
    const keys = UNIQUE_KEYS[name] || [];
    const rows = tableOf(name);
    for (let k = 0; k < keys.length; k++) {
      const cols = keys[k];
      if (cols.some(function (c) { return row[c] === null || row[c] === undefined; })) continue;
      const hit = rows.find(function (r) {
        return cols.every(function (c) { return r[c] === row[c]; });
      });
      if (hit) return { row: hit, constraint: name + "_" + cols.join("_") + "_key" };
    }
    return null;
  }

  return {
    name: "memory",
    isConfigured: function () { return true; },

    select: async function (name, opts) {
      opts = opts || {};
      let rows = tableOf(name).filter(function (r) { return matches(r, opts.where); });
      if (opts.order) {
        const col  = opts.order.column;
        const desc = opts.order.ascending === false;
        rows = rows.slice().sort(function (a, b) {
          const av = a[col], bv = b[col];
          if (av === bv) return 0;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return (av < bv ? -1 : 1) * (desc ? -1 : 1);
        });
      }
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return rows.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    },

    insert: async function (name, rowOrRows, opts) {
      opts = opts || {};
      const rows  = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      const table = tableOf(name);
      const out   = [];

      for (let i = 0; i < rows.length; i++) {
        const row      = JSON.parse(JSON.stringify(rows[i]));
        const conflict = findConflict(name, row);
        if (conflict) {
          if (opts.ignoreDuplicates) continue;                 // PostgREST returns nothing
          if (opts.mergeDuplicates) {
            Object.assign(conflict.row, row);
            out.push(JSON.parse(JSON.stringify(conflict.row)));
            continue;
          }
          throw new UniqueViolationError(name, conflict.constraint);
        }
        table.push(row);
        out.push(JSON.parse(JSON.stringify(row)));
      }
      flush();
      return out;
    },

    update: async function (name, opts) {
      opts = opts || {};
      const table = tableOf(name);
      const hits  = table.filter(function (r) { return matches(r, opts.where); });
      hits.forEach(function (r) { Object.assign(r, opts.set); });
      flush();
      return hits.map(function (r) { return JSON.parse(JSON.stringify(r)); });
    },

    count: async function (name, opts) {
      opts = opts || {};
      return tableOf(name).filter(function (r) { return matches(r, opts.where); }).length;
    },

    /* test-only helpers — not part of the driver contract used by endpoints */
    _reset: function () {
      TABLES.forEach(function (t) { store[t] = []; });
      flush();
    },
    _dump: function () { return JSON.parse(JSON.stringify(store)); }
  };
}

/* ── supabase (PostgREST) driver ─────────────────────────────────────────── */

function encodeCondition(c) {
  if (c.op === "in") {
    const list = (Array.isArray(c.value) ? c.value : [c.value]).map(function (v) {
      return '"' + String(v).replace(/"/g, '\\"') + '"';
    }).join(",");
    return "in.(" + list + ")";
  }
  if (c.op === "is") return "is." + (c.value === null ? "null" : String(c.value));
  return c.op + "." + String(c.value);
}

function buildQuery(opts) {
  const params = [];
  if (opts.columns) params.push("select=" + encodeURIComponent(opts.columns));
  if (opts.where) {
    Object.keys(opts.where).forEach(function (col) {
      params.push(encodeURIComponent(col) + "=" + encodeURIComponent(encodeCondition(normalizeCondition(opts.where[col]))));
    });
  }
  if (opts.order) {
    params.push("order=" + encodeURIComponent(
      opts.order.column + "." + (opts.order.ascending === false ? "desc" : "asc") + ".nullslast"));
  }
  if (opts.limit) params.push("limit=" + parseInt(opts.limit, 10));
  return params.length ? "?" + params.join("&") : "";
}

/* supabaseAuthHeaders(key)
   Supabase's current secret keys (sb_secret_…) are not JWTs and belong on the
   `apikey` header only — sending one as `Authorization: Bearer` fails JWT
   verification. The legacy service_role key IS a JWT and keeps the historic
   pair of headers. https://supabase.com/docs/guides/api/api-keys             */
function supabaseAuthHeaders(key) {
  const k = String(key || "");
  const isJwt = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k);
  return isJwt ? { "apikey": k, "Authorization": "Bearer " + k } : { "apikey": k };
}

function createSupabaseDriver(baseUrl, serviceKey, timeoutMs) {
  const root = String(baseUrl).replace(/\/+$/, "") + "/rest/v1/";
  const TIMEOUT = timeoutMs || 10000;

  const headersBase = supabaseAuthHeaders(serviceKey);

  async function request(method, path, body, extraPrefer) {
    const ctrl  = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    const prefer = ["return=representation"].concat(extraPrefer || []).join(",");

    let resp;
    try {
      resp = await fetch(root + path, {
        method:  method,
        headers: Object.assign({
          "Content-Type":  "application/json",
          "Prefer":        prefer,
          "Accept":        "application/json"
        }, headersBase),
        body:   body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      throw new DbError(
        err.name === "AbortError" ? "Database request timed out." : "Database is unreachable.",
        0, err.name);
    }
    clearTimeout(timer);

    const text = await resp.text().catch(function () { return ""; });

    if (!resp.ok) {
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (_) {}
      // 23505 = unique_violation, 23503 = foreign_key_violation
      if (payload && payload.code === "23505") {
        throw new UniqueViolationError(path.split("?")[0], payload.constraint || null);
      }
      // The message is logged server-side only; callers translate to safe text.
      throw new DbError("Database request failed.", resp.status,
        payload ? (payload.code || payload.message) : text.slice(0, 200));
    }

    if (!text) return [];
    try { return JSON.parse(text); } catch (_) { return []; }
  }

  return {
    name: "supabase",
    isConfigured: function () { return true; },

    select: function (name, opts) {
      opts = opts || {};
      return request("GET", encodeURIComponent(name) + buildQuery(
        { columns: opts.columns || "*", where: opts.where, order: opts.order, limit: opts.limit }));
    },

    insert: function (name, rowOrRows, opts) {
      opts = opts || {};
      let path = encodeURIComponent(name);
      const prefer = [];
      if (opts.onConflict) {
        path += "?on_conflict=" + encodeURIComponent(opts.onConflict);
        prefer.push(opts.mergeDuplicates ? "resolution=merge-duplicates" : "resolution=ignore-duplicates");
      }
      return request("POST", path, rowOrRows, prefer);
    },

    update: function (name, opts) {
      opts = opts || {};
      return request("PATCH", encodeURIComponent(name) + buildQuery({ where: opts.where }), opts.set);
    },

    count: async function (name, opts) {
      const rows = await request("GET",
        encodeURIComponent(name) + buildQuery({ columns: "id", where: (opts || {}).where }));
      return rows.length;
    }
  };
}

/* ── driver resolution (memoized per cold start) ─────────────────────────── */

let _driver;
let _resolved = false;
let _d1Binding = null;

/* Called by the Worker for every request (cheap: compares identity). */
function setD1Binding(binding) {
  if (binding === _d1Binding) return;
  _d1Binding = binding || null;
  _driver = undefined; _resolved = false;
}

function resolveDriver() {
  if (_resolved) return _driver;
  _resolved = true;

  const wantD1 = String(process.env.NAFUME_DB_DRIVER || "").trim().toLowerCase() === "d1" ||
                 (!String(process.env.NAFUME_DB_DRIVER || "").trim() && !!globalThis.__NAFUME_CLOUDFLARE);
  if (wantD1) {
    if (!_d1Binding) { _driver = null; return _driver; }
    _driver = createD1Driver(_d1Binding, {
      DbError: DbError, UniqueViolationError: UniqueViolationError,
      normalizeCondition: normalizeCondition, TABLES: TABLES
    });
    return _driver;
  }

  const explicit = String(process.env.NAFUME_DB_DRIVER || "").trim().toLowerCase();
  const url      = String(process.env.SUPABASE_URL || "").trim();
  const key      = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (explicit === "memory") {
    // The memory driver is per-process and vanishes on every cold start. A
    // hosted deployment must never run on it, whatever the variable says:
    // refusing storage makes checkout answer 503 instead of "saving" orders
    // that disappear minutes later.
    if (isHostedRuntime()) {
      console.error("[db] NAFUME_DB_DRIVER=memory refused on a hosted deployment — configure Supabase.");
      _driver = null;
      return _driver;
    }
    _driver = createMemoryDriver(process.env.NAFUME_DB_FILE || null);
    return _driver;
  }
  if (explicit === "supabase" || (url && key)) {
    if (!url || !key) { _driver = null; return _driver; }
    _driver = createSupabaseDriver(url, key, parseInt(process.env.NAFUME_DB_TIMEOUT_MS || "10000", 10));
    return _driver;
  }
  _driver = null;
  return _driver;
}

/* Test/dev hook: lets the local harness swap drivers between cases. */
function _resetDriverCache() { _driver = undefined; _resolved = false; }

/* True on Vercel or Cloudflare Workers (any environment) or when NODE_ENV=production. */
function isHostedRuntime() {
  return !!String(process.env.VERCEL || "").trim() ||
         !!globalThis.__NAFUME_CLOUDFLARE ||
         String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function isConfigured() { return !!resolveDriver(); }
function driverName()   { const d = resolveDriver(); return d ? d.name : "none"; }
/* deriveServerKey(label) -> Buffer | null
   A key derived from the service-role secret for server-side HMACs (e.g.
   stored verification codes). The secret itself never leaves this module;
   callers get HMAC_SHA256(secret, label), distinct per label. */
function deriveServerKey(label) {
  const k = String(process.env.NAFUME_SERVER_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!k) return null;
  return crypto.createHmac("sha256", k).update("nafume-derived|" + String(label)).digest();
}

/* Explains a null driver, for the health report. */
function memoryDriverRefused() {
  return String(process.env.NAFUME_DB_DRIVER || "").trim().toLowerCase() === "memory" && isHostedRuntime();
}

function requireDriver() {
  const d = resolveDriver();
  if (!d) {
    throw new DbNotConfiguredError(
      "Database is not configured. Bind a D1 database (DB) or set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return d;
}

/* ── public API ──────────────────────────────────────────────────────────── */

async function select(table, opts) { return requireDriver().select(table, opts); }
async function insert(table, row, opts) { return requireDriver().insert(table, row, opts); }
async function update(table, opts) { return requireDriver().update(table, opts); }
async function count(table, opts) { return requireDriver().count(table, opts); }

/* selectOne — convenience for the very common "fetch by unique key" case. */
async function selectOne(table, where, opts) {
  const rows = await select(table, Object.assign({ where: where, limit: 1 }, opts || {}));
  return rows && rows.length ? rows[0] : null;
}

/* newId — application-generated primary keys keep both drivers identical and
   make an id available before the row is written (needed for FK linking). */
function newId() { return crypto.randomUUID(); }

function nowISO() { return new Date().toISOString(); }

module.exports = {
  select, selectOne, insert, update, count,
  newId, nowISO,
  isConfigured, driverName, memoryDriverRefused, isHostedRuntime, setD1Binding,
  DbNotConfiguredError, DbError, UniqueViolationError,
  UNIQUE_KEYS, TABLES,
  supabaseAuthHeaders, deriveServerKey,
  _resetDriverCache
};
