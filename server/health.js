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

const http        = require("./_lib/http");
const db          = require("./_lib/db");
const configCheck = require("./_lib/config-check");
const auth        = require("./_lib/auth");

/* Read per request; compared in constant time (see _lib/auth.js). */
function tokenMatches(req) { return auth.bearerMatches(req, ["ADMIN_API_TOKEN"]); }

/* Tables and columns added by db/migrations/20260915_launch_readiness.sql.
   Their absence means the migration has not been applied to this database. */
const MIGRATION_PROBES = [
  { table: "verification_challenges", columns: "id,live_key" },
  { table: "payment_events",          columns: "id,event_key" },
  { table: "orders",                  columns: "id,verified_owner_customer_id,ship_email_normalized,pending_payment_id" },
  { table: "customers",               columns: "id,email_verified_at,phone_verified_at" },
  { table: "review_requests",         columns: "id,access_token_hash" },
  { table: "discount_redemptions",    columns: "id,slot_key" }
];

/* A real read against real tables. Reports reachability and whether the schema
   AND the latest migration have actually been applied — a missing table or
   column is the single most common "why is nothing saving?" cause. */
async function probeDatabase() {
  if (!db.isConfigured()) {
    return { reachable: false, schemaApplied: false, error: "not_configured" };
  }
  const started = Date.now();
  try {
    await db.select("orders", { limit: 1 });
    const missing = [];
    for (let i = 0; i < MIGRATION_PROBES.length; i++) {
      const p = MIGRATION_PROBES[i];
      try { await db.select(p.table, { columns: p.columns, limit: 1 }); }
      catch (_) { missing.push(p.table); }
    }
    return {
      reachable: true, schemaApplied: true,
      migrationApplied: missing.length === 0,
      missingMigrationObjects: missing.length ? missing : undefined,
      latencyMs: Date.now() - started
    };
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
        ? (db.driverName() === "d1" ? "Run db/d1/schema.sql: npx wrangler d1 execute nafume --remote --file db/d1/schema.sql" : "Run db/schema.sql in the Supabase SQL editor.")
        : (db.driverName() === "d1" ? "Check the D1 binding (DB) in wrangler.jsonc." : "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and that the project is not paused.")
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

  const ok = report.ok && database.reachable && database.schemaApplied && database.migrationApplied === true;

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
  if (database.schemaApplied && database.migrationApplied === false) {
    steps.push("Apply db/migrations/20260915_launch_readiness.sql — missing: " +
      (database.missingMigrationObjects || []).join(", ") + ".");
  }
  if (report.storage.memoryRefused) {
    steps.push("NAFUME_DB_DRIVER=memory is set on a hosted deployment and was refused. Remove it and configure Supabase.");
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
    steps.push("Set RESEND_API_KEY — account creation needs emailed verification codes, and queued messages in outbound_messages are waiting for it.");
  }
  if (!report.capabilities.adminApi) {
    steps.push("Set ADMIN_API_TOKEN to record delivery dates — review requests cannot become due without it.");
  }
  if (!report.capabilities.scheduledJobs) {
    steps.push("Set CRON_SECRET so the scheduled jobs in vercel.json can run.");
  }
  return steps;
}
