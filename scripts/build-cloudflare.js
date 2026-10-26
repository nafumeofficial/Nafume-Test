/*
 * scripts/build-cloudflare.js  —  assemble the public site into ./dist
 * ============================================================================
 *   node scripts/build-cloudflare.js
 *
 * Workers Static Assets serves everything in ./dist as a public file, so this
 * copies ONLY what a browser should be able to download. Server code, the
 * database files, tests and every .md/.sql file are left out — they are never
 * uploaded. (The Vercel build did the same job with .vercelignore.)
 *
 * It also writes dist/_headers from the security headers in vercel.json so both
 * hosts send the same ones.
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const EXCLUDE_DIRS  = new Set([".git", ".claude", ".wrangler", "node_modules", "dist", "server", "db", "test",
                               "api", "worker", "scripts", "docs", "ref", "_archive"]);
const EXCLUDE_FILES = /(^\.env)|(\.md$)|(\.sql$)|(^vercel\.json$)|(^wrangler\.jsonc?$)|(^\.vercelignore$)|(^\.claudeignore$)|(^\.gitignore$)|(^package(-lock)?\.json$)/i;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (entry) {
    if (entry.isDirectory()) {
      if (src === ROOT && EXCLUDE_DIRS.has(entry.name)) return;
      if (entry.name.startsWith("_backup")) return;
      copyDir(path.join(src, entry.name), path.join(dest, entry.name));
    } else if (!EXCLUDE_FILES.test(entry.name)) {
      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    }
  });
}

fs.rmSync(DIST, { recursive: true, force: true });
copyDir(ROOT, DIST);

// _headers: the catch-all header block from vercel.json.
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const block  = (config.headers || []).find(function (h) { return h.source === "/(.*)"; });
if (block) {
  const lines = ["/*"];
  block.headers.forEach(function (h) { lines.push("  " + h.key + ": " + h.value); });
  fs.writeFileSync(path.join(DIST, "_headers"), lines.join("\n") + "\n");
}

let files = 0;
(function count(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
  e.isDirectory() ? count(path.join(d, e.name)) : files++; }); })(DIST);
console.log("dist/ ready: " + files + " files");
