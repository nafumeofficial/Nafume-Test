/*
 * test/lint.js  —  static checks for a build-free codebase
 * ============================================================================
 *   node test/lint.js
 *
 * There is no bundler or type checker in this project, so a typo in a script
 * tag or an unbalanced brace would only show up as a blank page in a browser.
 * This does the checking a build step would normally do:
 *
 *   1. every .js file parses
 *   2. every inline <script> in every .html file parses
 *   3. every local <script src>/<link href> actually exists on disk
 *   4. no secret-looking literal is committed in frontend code
 *   5. no leftover placeholder markers in the files this project owns
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["_archive", "ref", ".git", "node_modules", "assets"]);

let errors = 0, warnings = 0, checked = 0;

function fail(file, message) { errors++; console.log("  FAIL  " + file + "\n        " + message); }
function warn(file, message) { warnings++; console.log("  WARN  " + file + "\n        " + message); }

function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith("_backup")) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const rel = f => f.replace(ROOT + path.sep, "").replace(/\\/g, "/");

/* ── 1 + 2. syntax ───────────────────────────────────────────────────────── */

console.log("\n── JavaScript syntax ───────────────────────────────────────────");

function parse(source, label) {
  try {
    // Module-scope wrapper so top-level `return`/`require` in CommonJS parses.
    new vm.Script("(function(exports,require,module,__filename,__dirname){" + source + "\n})", { filename: label });
    return null;
  } catch (err) {
    return err.message;
  }
}

for (const file of files.filter(f => f.endsWith(".js"))) {
  checked++;
  const err = parse(fs.readFileSync(file, "utf8"), rel(file));
  if (err) fail(rel(file), err);
}

console.log("\n── Inline <script> syntax ──────────────────────────────────────");

const INLINE_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

for (const file of files.filter(f => f.endsWith(".html"))) {
  // Strip HTML comments first: a <script> mentioned inside a comment is prose,
  // not code, and the browser never parses it. Replaced with blank lines so
  // reported line numbers still line up with the file.
  const html = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, c =>
    c.replace(/[^\n]/g, " "));
  let m, n = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(html)) !== null) {
    const attrs = m[1] || "";
    const body  = m[2] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;                 // external
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue;  // ld+json etc.
    if (!body.trim()) continue;
    n++; checked++;
    const err = parse(body, rel(file) + " inline#" + n);
    if (err) fail(rel(file) + " (inline script #" + n + ")", err);
  }
}

/* ── 3. local asset references resolve ───────────────────────────────────── */

console.log("\n── Local script/style references ───────────────────────────────");

const REF_RE = /<(?:script[^>]*\bsrc|link[^>]*\bhref)\s*=\s*["']([^"']+)["']/gi;

for (const file of files.filter(f => f.endsWith(".html"))) {
  const html = fs.readFileSync(file, "utf8");
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(html)) !== null) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue;
    if (!/\.(js|css)$/i.test(ref)) continue;

    const target = ref.startsWith("/")
      ? path.join(ROOT, ref.slice(1))
      : path.resolve(path.dirname(file), ref);

    checked++;
    if (!fs.existsSync(target)) fail(rel(file), "missing local reference: " + ref);
  }
}

/* ── 4. no secrets in frontend code ──────────────────────────────────────── */

console.log("\n── Secret scan (frontend) ──────────────────────────────────────");

const SECRET_PATTERNS = [
  [/rzp_live_[A-Za-z0-9]{8,}/,      "live Razorpay key id"],
  [/rzp_test_[A-Za-z0-9]{14,}/,     "real Razorpay test key id"],
  [/\bsk_live_[A-Za-z0-9]{8,}/,     "live secret key"],
  [/RAZORPAY_KEY_SECRET\s*[:=]\s*["'][^"']+["']/, "hardcoded Razorpay secret"],
  [/RAZORPAY_WEBHOOK_SECRET\s*[:=]\s*["'][^"']+["']/, "hardcoded Razorpay webhook secret"],
  [/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+["']/, "hardcoded Supabase service key"],
  [/ADMIN_API_TOKEN\s*[:=]\s*["'][^"']+["']/, "hardcoded admin token"],
  [/CRON_SECRET\s*[:=]\s*["'][^"']+["']/, "hardcoded cron secret"],
  [/MSG91_AUTH_KEY\s*[:=]\s*["'][^"']+["']/, "hardcoded MSG91 key"],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "JWT-looking literal (Supabase keys are JWTs)"],
  [/\bre_[A-Za-z0-9]{16,}/,         "Resend API key"],
  [/https:\/\/[a-z0-9]{20}\.supabase\.co/, "hardcoded Supabase project URL"],
  [/\bxoxb-[A-Za-z0-9-]{10,}/,      "Slack bot token"],
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, "private key"]
];

const frontend = files.filter(f => {
  const r = rel(f);
  return (r.startsWith("js/") || r.startsWith("css/") || r.endsWith(".html")) && !r.startsWith("test/");
});

for (const file of frontend) {
  const src = fs.readFileSync(file, "utf8");
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(src)) fail(rel(file), "possible " + label + " committed in frontend code");
  }
  checked++;
}

// The service-role key must never be READ outside server/_lib/db.js. Naming it in
// a comment (setup docs) is fine; only process.env access is a problem.
for (const file of files.filter(f => f.endsWith(".js"))) {
  const r = rel(file);
  if (r === "server/_lib/db.js" || r === "server/_lib/config-check.js" || r.startsWith("test/")) continue;
  if (/process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(fs.readFileSync(file, "utf8"))) {
    fail(r, "reads process.env.SUPABASE_SERVICE_ROLE_KEY — it must only be read in server/_lib/db.js");
  }
}

// No server-side secret may be referenced by ANY browser-delivered file.
// process.env does not exist in a browser, so a reference is either dead code
// or a bundling mistake — both worth failing on.
const SERVER_ONLY_ENV = [
  "SUPABASE_SERVICE_ROLE_KEY", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "RESEND_API_KEY", "ADMIN_API_TOKEN", "CRON_SECRET", "MSG91_AUTH_KEY"
];
for (const file of files.filter(f => rel(f).startsWith("js/") || (f.endsWith(".html") && !rel(f).startsWith("test/")))) {
  const src = fs.readFileSync(file, "utf8");
  SERVER_ONLY_ENV.forEach(name => {
    if (new RegExp("process\\.env\\." + name).test(src)) {
      fail(rel(file), "browser-delivered file references process.env." + name);
    }
  });
  checked++;
}

// .env must never be committed.
if (fs.existsSync(path.join(ROOT, ".env"))) {
  const ignore = fs.existsSync(path.join(ROOT, ".gitignore"))
    ? fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8") : "";
  if (!/^\s*\.env\s*$/m.test(ignore)) {
    fail(".env", "a .env file exists and .gitignore does not ignore it");
  } else {
    console.log("  note: a local .env exists and is correctly gitignored");
  }
}

// .env.example must contain NAMES ONLY — never a value.
const examplePath = path.join(ROOT, ".env.example");
if (fs.existsSync(examplePath)) {
  checked++;
  const offenders = fs.readFileSync(examplePath, "utf8").split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .filter(l => {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
      if (!m) return false;
      const value = m[2].trim();
      if (!value) return false;                    // name only — correct
      if (/^\d+$/.test(value)) return false;       // a documented numeric default
      return true;                                  // anything else looks like a real value
    });
  if (offenders.length) {
    fail(".env.example", "contains what look like real values: " +
      offenders.map(o => o.split("=")[0]).join(", "));
  }
}

/* ── 5. placeholders in owned files ──────────────────────────────────────── */

console.log("\n── Placeholder scan ───────────────────────────────────────────");

const OWNED = files.filter(f => {
  const r = rel(f);
  if (r === "test/lint.js") return false;          // this file defines the markers
  return r.startsWith("api/") || r.startsWith("test/") || r.startsWith("db/") ||
         r === "js/commerce/api-client.js" || r === "js/commerce/lead-popup.js" ||
         r === "js/commerce/fragrance-quiz.js" || r === "pages/order/review.html";
});

for (const file of OWNED) {
  // `placeholder="…"` is a real HTML attribute, not a leftover marker — strip
  // those (and the CSS ::placeholder selector) before scanning.
  const src = fs.readFileSync(file, "utf8")
    .replace(/placeholder\s*=\s*(["'][^"']*["']|\\?["'][^"']*\\?["'])/gi, "")
    .replace(/::?placeholder/gi, "");

  const hits = src.match(/\b(TODO|FIXME|XXX|HACK|PLACEHOLDER|coming soon|not implemented)\b/gi);
  if (hits) fail(rel(file), "placeholder marker(s): " + [...new Set(hits)].join(", "));
  checked++;
}

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log("\n" + "═".repeat(70));
console.log("  checked " + checked + " items — " + errors + " error(s), " + warnings + " warning(s)");
console.log("═".repeat(70));
process.exitCode = errors ? 1 : 0;
