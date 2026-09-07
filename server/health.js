/*
 * GET /api/health  —  deployment health and configuration report
 * ============================================================================
 * TWO MODES, deliberately:
 *
 *   PUBLIC (no token)
 *     A liveness probe. Returns only { ok, service, storage: true|false }.
 *     Enough for an uptime monitor; useless to an attacker. It never reveals
 *     WHICH integrations are configured, because "this site has no webhook
 *     secret set" is exactly the reconnaissance an attacker wants.
 *
 *   DETAILED (Authorization: Bearer <ADMIN_API_TOKEN>)
 *     The full configuration report from api/_lib/config-check.js: which
 *     variables are present, which capabilities are live, and a real database
 *     round-trip. Presence booleans only — no secret value is ever returned.
 *
 * The database check is a genuine SELECT, so a wrong URL, a revoked key, or a
 * schema that was never applied shows up here rather than at a customer's
 * checkout.
 */
"use strict";

const crypto      = require("crypto");
const http        = require("./_lib/http");
const db          = require("./_lib/db");
const configCheck = require("./_lib/config-check");

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;

function tokenMatches(req) {
  if (!ADMIN_API_TOKEN) return false;
  const header = String((req.headers && req.headers.authorization) || "");
  const given  = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* A real read against a real table. Reports reachability and whether the schema
   has actually been applied — a missing table is the single most common
   "why is nothing saving?" cause. */
async function probeDatabase() {
  if (!db.isConfigured()) {
    return { reachable: false, schemaApplied: false, error: "not_configured" };
  }
  const started = Date.now();
  try {
    await db.select("orders", { limit: 1 });
    return { reachable: true, schemaApplied: true, latencyMs: Date.now() - started };
  } catch (err) {
    const detail = (err && err.detail) ? String(err.detail) : "";
    // PostgREST answers PGRST205 / 42P01 when the table does not exist.
    const missingTable = /PGRST205|42P01|does not exist|Unknown table/i.test(detail + " " + (err.message || ""));
    return {
      reachable: !missingTable ? false : true,
      schemaApplied: !missingTable,
      latencyMs: Date.now() - started,
      error: missingTable ? "schema_not_applied" : "unreachable",
      hint: missingTable
        ? "Run db/schema.sql in the Supabase SQL editor."
        : "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and that the project is not paused."
    };
  }
}

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "GET")) return;

  const detailed = tokenMatches(req);

  if (!detailed) {
    // Deliberately minimal. 200 while the process is alive; the storage boolean
    // is the only detail, because an uptime check needs to distinguish "up" from
    // "up but cannot take orders".
    return http.ok(res, {
      service: "nafume",
      storage: db.isConfigured(),
      detail:  "Provide Authorization: Bearer <ADMIN_API_TOKEN> for the full configuration report."
    });
  }

  const report   = configCheck.inspect();
  const database = await probeDatabase();

  const ok = report.ok && database.reachable && database.schemaApplied;

  return http.json(res, ok ? 200 : 503, {
    success: true,
    ok: ok,
    service: "nafume",
    checkedAt: new Date().toISOString(),
    storage: Object.assign({}, report.storage, { probe: database }),
    required: report.required,
    optional: report.optional,
    missingRequired: report.missingRequired,
    missingOptional: report.missingOptional,
    capabilities: report.capabilities,
    nextSteps: buildNextSteps(report, database)
  });
};

/* Turns the report into an ordered to-do list. */
function buildNextSteps(report, database) {
  const steps = [];

  if (!database.schemaApplied) {
    steps.push("Run db/schema.sql in the Supabase SQL editor — the expected tables are missing.");
  }
  if (!database.reachable && database.error === "unreachable") {
    steps.push("Database unreachable. Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and that the project is not paused.");
  }
  report.missingRequired.forEach(function (name) {
    steps.push("Set " + name + " — the site cannot take orders without it.");
  });
  if (report.storage.driver === "memory") {
    steps.push("Unset NAFUME_DB_DRIVER — the memory driver loses all data on redeploy.");
  }
  if (!report.capabilities.paymentRecovery) {
    steps.push("Set RAZORPAY_WEBHOOK_SECRET and add the webhook in Razorpay so payments survive a closed browser.");
  }
  if (!report.capabilities.sendsEmail) {
    steps.push("Set RESEND_API_KEY to deliver the messages currently queued in outbound_messages.");
  }
  if (!report.capabilities.adminApi) {
    steps.push("Set ADMIN_API_TOKEN to record delivery dates — review requests cannot become due without it.");
  }
  if (!report.capabilities.scheduledJobs) {
    steps.push("Set CRON_SECRET so the scheduled jobs in vercel.json can run.");
  }
  return steps;
}
