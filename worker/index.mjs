/*
 * worker/index.mjs  —  Cloudflare Worker entry for NAFUME
 * ============================================================================
 * Static pages are served by Workers Static Assets (see wrangler.jsonc); this
 * Worker only receives /api/* (run_worker_first) and the scheduled trigger.
 *
 * The route handlers in /server were written for Node-style (req, res) objects
 * (Vercel Functions). This file adapts a Fetch Request to that contract —
 * req.method / url / headers / query / body, a raw-body 'data'/'end' stream for
 * the Razorpay webhook signature — and turns the captured response back into
 * a Fetch Response. The handlers themselves are unchanged.
 *
 * Storage: env.DB (Cloudflare D1). Secrets and vars arrive through process.env
 * (nodejs_compat populates it from `wrangler secret` / [vars]).
 */
import router from "../api/index.js";
import db from "../server/_lib/db.js";

globalThis.__NAFUME_CLOUDFLARE = true;

const textEncoder = new TextEncoder();

function lowerHeaders(headers) {
  const out = {};
  headers.forEach(function (value, key) { out[key.toLowerCase()] = value; });
  return out;
}

/* Fetch Request -> Node-style req (the parts the handlers read). */
async function toNodeRequest(request, url, queryExtra) {
  const headers = lowerHeaders(request.headers);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const raw = hasBody ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);

  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: headers,
    query: Object.assign(Object.fromEntries(url.searchParams.entries()), queryExtra || {}),
    socket: { remoteAddress: headers["cf-connecting-ip"] || "unknown" },
    rawBody: raw
  };

  // Same contract as Vercel's helpers: a lazy, content-type-aware req.body that
  // throws on malformed JSON; the raw bytes stay available through 'data'/'end'.
  let parsed, computed = false;
  Object.defineProperty(req, "body", {
    configurable: true, enumerable: true,
    get: function () {
      if (computed) return parsed;
      const contentType = headers["content-type"];
      if (contentType === undefined) { computed = true; parsed = undefined; return parsed; }
      const type = String(contentType).split(";")[0].trim().toLowerCase();
      const text = raw.toString("utf8");
      if (type === "application/json") {
        if (!text) { computed = true; parsed = {}; return parsed; }
        try { parsed = JSON.parse(text); }
        catch (_) { const err = new Error("Invalid JSON"); err.statusCode = 400; throw err; }
        computed = true; return parsed;
      }
      computed = true; parsed = text; return parsed;
    },
    set: function (v) { parsed = v; computed = true; }
  });

  const listeners = {};
  req.on = req.addListener = function (name, cb) {
    (listeners[name] = listeners[name] || []).push(cb);
    if (name === "end") {
      // Deliver the buffered body once, asynchronously, like a real stream.
      queueMicrotask(function () {
        (listeners.data || []).forEach(function (fn) { fn(raw); });
        (listeners.end  || []).forEach(function (fn) { fn(); });
      });
    }
    return req;
  };
  req.resume = function () {};
  return req;
}

/* A Node-style res that records everything, resolved into a Fetch Response. */
function createResponse() {
  const headers = new Headers();
  let status = 200, body = null, done = false;
  let resolveDone;
  const finished = new Promise(function (r) { resolveDone = r; });

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: function (k, v) { headers.set(k, Array.isArray(v) ? v.join(", ") : String(v)); return res; },
    getHeader: function (k) { return headers.get(k) || undefined; },
    removeHeader: function (k) { headers.delete(k); },
    status: function (code) { status = code; res.statusCode = code; return res; },
    writeHead: function (code, h) { status = code; res.statusCode = code; if (h) Object.keys(h).forEach(function (k) { res.setHeader(k, h[k]); }); return res; },
    end: function (data) {
      if (done) return res;
      done = true; res.headersSent = true;
      body = data === undefined || data === null ? null : data;
      resolveDone();
      return res;
    },
    json: function (payload) {
      if (!headers.get("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(payload));
    },
    send: function (payload) {
      if (typeof payload === "object" && payload !== null && !(payload instanceof Uint8Array)) return res.json(payload);
      return res.end(payload == null ? "" : payload);
    },
    write: function (chunk) { body = (body || "") + String(chunk); return true; }
  };

  res.toResponse = async function () {
    await finished;
    const noBody = status === 204 || status === 304;
    return new Response(noBody ? null : body, { status: status, headers: headers });
  };
  return res;
}

function configureStorage(env) {
  if (env && env.DB) db.setD1Binding(env.DB);
}

/* process.env needs strings; copy any non-string bindings' values defensively. */
function exposeEnv(env) {
  if (!env || typeof process === "undefined" || !process.env) return;
  Object.keys(env).forEach(function (k) {
    if (typeof env[k] === "string" && process.env[k] === undefined) process.env[k] = env[k];
  });
}

export default {
  async fetch(request, env) {
    exposeEnv(env);
    configureStorage(env);

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
      // Static assets answer everything else before reaching this Worker; this
      // is only a safety net if run_worker_first is ever widened.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    const rest = url.pathname.replace(/^\/api\/?/, "");
    const req = await toNodeRequest(request, url, { path: rest });
    const res = createResponse();
    try {
      await router(req, res);
      if (!res.headersSent) res.end();
    } catch (err) {
      console.error("[worker] unhandled error", err && err.stack || err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "server_error", message: "Something went wrong on our side. Please try again." });
      }
    }
    return res.toResponse();
  },

  // Scheduled jobs (wrangler.jsonc triggers.crons), authenticated with CRON_SECRET.
  //   daily 04:00 UTC       maintenance: review requests, payment checks, outbox, Desk retry
  //   every 10 minutes      retry orders the Desk dashboard has not accepted yet
  async scheduled(event, env, ctx) {
    exposeEnv(env);
    configureStorage(env);
    const secret = env.CRON_SECRET || env.ADMIN_API_TOKEN;
    // Every 10 minutes: Desk sync, then any customer emails still waiting in the outbox.
    const jobs = event.cron === "*/10 * * * *" ? ["drain-desk", "drain-outbox"] : ["maintenance"];
    ctx.waitUntil((async function () {
      for (const job of jobs) {
        const pathname = "/api/jobs/" + job;
        const req = await toNodeRequest(
          new Request("https://internal.invalid" + pathname, {
            method: "POST", headers: { authorization: "Bearer " + (secret || "") }
          }),
          new URL("https://internal.invalid" + pathname), { path: "jobs/" + job });
        const res = createResponse();
        try { await router(req, res); if (!res.headersSent) res.end(); }
        catch (err) { console.error("[worker] scheduled " + job + " failed", err && err.stack || err); }
      }
    })());
  }
};
