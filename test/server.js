/*
 * test/server.js  —  local runner for the /api serverless functions
 * ============================================================================
 * Vercel sends every /api route through api/index.js, which dispatches to
 * handlers in /server. This script recreates the function contract locally
 * with plain Node — no packages and no Vercel CLI.
 *
 *   node test/server.js            → http://localhost:3100
 *   node test/run-tests.js         → starts this in-process and runs the suite
 *
 * ROUTER MODES  (NAFUME_TEST_ROUTER)
 *   "vercel"  (default) — production-shaped. The vercel.json rewrite
 *             /api/:path* → /api?path=:path* is applied and the request goes
 *             through api/index.js. Vercel's Node helpers are emulated the way
 *             @vercel/node implements them: the body is read eagerly, replayed
 *             to later 'data'/'end' listeners, and exposed as a lazy
 *             `req.body` getter that parses by Content-Type (and throws on
 *             malformed JSON). This is what makes raw-body webhook signature
 *             handling testable locally.
 *   "direct"  — each /api path is resolved straight to its /server handler
 *             file, bypassing the router and the helpers.
 *
 * It also serves the static site from the repo root, so the whole flow can be
 * clicked through in a browser (root-relative /css, /js, /pages links work).
 *
 * NOT for production. Vercel serves /api and the static files itself.
 */
"use strict";

const nodeHttp = require("http");
const fs       = require("fs");
const path     = require("path");
const { PassThrough } = require("stream");

const ROOT     = path.resolve(__dirname, "..");
const API_ROOT = path.join(ROOT, "server");

function routerMode() {
  return String(process.env.NAFUME_TEST_ROUTER || "vercel").toLowerCase() === "direct" ? "direct" : "vercel";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4":  "video/mp4",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8"
};

/* ── Vercel-compatible response shim ─────────────────────────────────────── */

function decorate(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (payload) {
    const text = JSON.stringify(payload);
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(text);
    return res;
  };
  res.send = function (payload) {
    if (typeof payload === "object" && payload !== null) return res.json(payload);
    res.end(String(payload == null ? "" : payload));
    return res;
  };
  return res;
}

/* ── Vercel Node helper emulation ────────────────────────────────────────────
   Mirrors @vercel/node's addHelpers(): read the whole body first, re-expose
   the same bytes to 'data'/'end' listeners through a PassThrough, and define
   req.body as a lazy getter.                                                 */

function readWholeBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function addVercelHelpers(req) {
  const contentType = req.headers["content-type"];
  const body = contentType === undefined ? Buffer.from("") : await readWholeBody(req);

  if (contentType !== undefined) {
    const replica = new PassThrough();
    const on = replica.on.bind(replica);
    const originalOn = req.on.bind(req);
    req.read = replica.read.bind(replica);
    req.on = req.addListener = function (name, cb) {
      return name === "data" || name === "end" ? on(name, cb) : originalOn(name, cb);
    };
    replica.write(body);
    replica.end();
  }

  let parsed;
  let computed = false;
  Object.defineProperty(req, "body", {
    configurable: true,
    enumerable: true,
    get: function () {
      if (computed) return parsed;
      computed = true;
      const type = String(contentType || "").split(";")[0].trim().toLowerCase();
      if (contentType === undefined) { parsed = undefined; return parsed; }
      if (type === "application/json") {
        const text = body.toString("utf8");
        if (!text) { parsed = {}; return parsed; }
        try { parsed = JSON.parse(text); }
        catch (e) { computed = false; const err = new Error("Invalid JSON"); err.statusCode = 400; throw err; }
        return parsed;
      }
      if (type === "text/plain") { parsed = body.toString("utf8"); return parsed; }
      if (type === "application/octet-stream") { parsed = body; return parsed; }
      parsed = body.toString("utf8");
      return parsed;
    },
    set: function (v) { parsed = v; computed = true; }
  });
}

/* ── API routing ─────────────────────────────────────────────────────────── */

/* Maps /api/razorpay/create-order → server/razorpay/create-order.js
   Files starting with "_" are libraries, never routes. */
function resolveApiFile(pathname) {
  const rel = pathname.replace(/^\/api\/?/, "").replace(/\.js$/, "");
  if (!rel) return null;
  if (!/^[a-zA-Z0-9/_-]+$/.test(rel)) return null;
  if (rel.split("/").some(function (seg) { return seg === ".." || seg.startsWith("_"); })) return null;

  const candidates = [
    path.join(API_ROOT, rel + ".js"),
    path.join(API_ROOT, rel, "index.js")
  ];
  for (let i = 0; i < candidates.length; i++) {
    const f = path.resolve(candidates[i]);
    if (f.startsWith(API_ROOT) && fs.existsSync(f)) return f;
  }
  return null;
}

/* ── static files ────────────────────────────────────────────────────────── */

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel === "/index.html" || rel === "/") rel = "/index.html";

  let file = path.resolve(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end("Forbidden"); }

  // vercel.json cleanUrls: /pages/order/shipping → shipping.html
  if (!fs.existsSync(file) && !path.extname(file)) {
    if (fs.existsSync(file + ".html")) file = file + ".html";
    else if (fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const custom = path.join(ROOT, "404.html");
    return res.end(fs.existsSync(custom) ? fs.readFileSync(custom) : "Not found");
  }

  res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
}

/* ── server ──────────────────────────────────────────────────────────────── */

function createServer() {
  return nodeHttp.createServer(function (req, res) {
    decorate(res);
    const parsed = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    req.query = Object.fromEntries(parsed.searchParams.entries());

    if (!parsed.pathname.startsWith("/api/")) return serveStatic(parsed.pathname, res);

    if (routerMode() === "vercel") {
      // vercel.json: { "source": "/api/:path*", "destination": "/api?path=:path*" }
      const rest = parsed.pathname.replace(/^\/api\/?/, "");
      req.query = Object.assign({}, req.query, { path: rest });
      const router = require(path.join(ROOT, "api", "index.js"));
      return Promise.resolve()
        .then(function () { return addVercelHelpers(req); })
        .then(function () { return router(req, res); })
        .catch(function (err) {
          console.error("[test/server] router threw:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: false, error: "unhandled", message: String(err && err.message) }));
          }
        });
    }

    const file = resolveApiFile(parsed.pathname);
    if (!file) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "not_found", message: "No such endpoint." }));
    }

    let handler;
    try {
      delete require.cache[require.resolve(file)];   // pick up edits without a restart
      handler = require(file);
    } catch (err) {
      console.error("[test/server] failed to load", file, err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "handler_load_failed", message: String(err.message) }));
    }

    Promise.resolve()
      .then(function () { return handler(req, res); })
      .catch(function (err) {
        console.error("[test/server] handler threw:", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ success: false, error: "unhandled", message: String(err && err.message) }));
        }
      });
  });
}

function start(port) {
  return new Promise(function (resolve) {
    const server = createServer();
    server.listen(port || 3100, function () {
      const addr = server.address();
      resolve({ server: server, port: addr.port, url: "http://127.0.0.1:" + addr.port });
    });
  });
}

module.exports = { createServer, start };

if (require.main === module) {
  const port = parseInt(process.env.PORT || "3100", 10);
  start(port).then(function (s) {
    console.log("NAFUME local server → " + s.url);
    console.log("  DB driver: " + require("../server/_lib/db").driverName());
  });
}
