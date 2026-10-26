/*
 * GET|POST /api/jobs/maintenance  —  run every scheduled job in one call
 * ============================================================================
 * WHY THIS EXISTS
 *   Vercel's Hobby plan allows only TWO cron jobs, each once per day. This
 *   project has three things that need to run on a schedule:
 *     - review-requests     queue post-delivery review requests
 *     - reconcile-payments  find payments neither the browser nor the webhook reported
 *     - drain-outbox        deliver messages that were queued while a provider was down
 *   Rather than making the owner choose, vercel.json points ONE daily cron at
 *   this endpoint and it runs all three in sequence. Each remains individually
 *   callable, so a Pro plan can schedule them separately for a faster cadence
 *   (see docs/deployment-checklist.md).
 *
 * AUTH  Bearer CRON_SECRET or ADMIN_API_TOKEN — the same rule the individual
 *       jobs enforce. The request is passed through to each job unchanged, so
 *       there is exactly one authorisation model, not two.
 *
 * ONE JOB FAILING MUST NOT STOP THE OTHERS: each is wrapped, and its outcome is
 * reported separately. A Razorpay outage must not also stop review requests.
 *
 * Every job it calls is idempotent, so a retried or duplicated cron delivery is
 * safe.
 */
"use strict";

const http = require("../_lib/http");
const auth = require("../_lib/auth");

const JOB_TOKENS = ["CRON_SECRET", "ADMIN_API_TOKEN"];

/* Static require() strings, not a computed path: a bundler (Cloudflare Workers)
   can only include modules it can see. Still loaded lazily, per job. */
const JOBS = [
  { name: "review-requests",    load: function () { return require("./review-requests"); } },
  { name: "reconcile-payments", load: function () { return require("./reconcile-payments"); } },
  { name: "drain-outbox",       load: function () { return require("./drain-outbox"); } },
  { name: "drain-desk",         load: function () { return require("./drain-desk"); } }
];

/* Read per request; compared in constant time (see _lib/auth.js). */
function authorised(req) { return auth.bearerMatches(req, JOB_TOKENS); }

/* Captures a job's response instead of sending it, so several handlers can run
   inside one request. Mirrors just enough of the response contract for the
   helpers in api/_lib/http.js. */
function captureResponse() {
  const captured = { status: 200, body: null, headers: {} };
  return {
    res: {
      statusCode: 200,
      setHeader: function (k, v) { captured.headers[k] = v; },
      getHeader: function (k) { return captured.headers[k]; },
      status: function (code) { captured.status = code; this.statusCode = code; return this; },
      json: function (payload) { captured.body = payload; return this; },
      send: function (payload) { captured.body = payload; return this; },
      end: function () { return this; },
      get headersSent() { return captured.body !== null; }
    },
    captured: captured
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }

  if (!auth.anyConfigured(JOB_TOKENS)) {
    console.error("[jobs/maintenance] refusing — set CRON_SECRET or ADMIN_API_TOKEN");
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!authorised(req)) return http.fail(res, 401, "unauthorised", "Not authorised.");

  const results = {};
  let anyFailed = false;

  for (let i = 0; i < JOBS.length; i++) {
    const job = JOBS[i];
    const { res: fakeRes, captured } = captureResponse();

    try {
      const run = job.load();
      // Each job reads req.query itself; give it a clean one it can rely on.
      const jobReq = Object.create(req);
      jobReq.query = req.query || {};
      await run(jobReq, fakeRes);

      results[job.name] = {
        status:  captured.status,
        ok:      captured.status >= 200 && captured.status < 300,
        summary: captured.body && captured.body.summary ? captured.body.summary : null,
        note:    captured.body && captured.body.note ? captured.body.note : undefined,
        needsAttention: (captured.body && captured.body.needsAttention &&
                         captured.body.needsAttention.length) ? captured.body.needsAttention : undefined
      };
      if (!results[job.name].ok) anyFailed = true;

    } catch (err) {
      // One job blowing up must never stop the rest.
      console.error("[jobs/maintenance] " + job.name + " threw:", err && err.message);
      results[job.name] = { status: 500, ok: false, error: "job_threw" };
      anyFailed = true;
    }
  }

  // Housekeeping: expired verification challenges drop any payload they held
  // (a pending registration's password hash) and any code hash.
  try {
    const purged = await require("../_lib/verification").purgeExpired();
    results["purge-verification-challenges"] = { status: 200, ok: true, summary: { purged: purged } };
  } catch (err) {
    console.error("[jobs/maintenance] purge-verification-challenges failed:", err && err.message);
    results["purge-verification-challenges"] = { status: 500, ok: false, error: "purge_failed" };
    anyFailed = true;
  }

  return http.ok(res, {
    ranAt: new Date().toISOString(),
    allOk: !anyFailed,
    jobs:  results
  });
};
