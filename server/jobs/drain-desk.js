/*
 * GET|POST /api/jobs/drain-desk  —  retry orders that did not reach the Desk
 * ============================================================================
 * Orders are queued in `desk_events` before the dashboard is contacted (see
 * _lib/desk.js). This job retries the ones still waiting (idempotent: the Desk
 * never creates the same order twice), then asks the Desk for shipping and status
 * changes made by the team and applies them, so the customer's Track Order page
 * stays current.
 *
 * AUTH  Bearer CRON_SECRET or ADMIN_API_TOKEN (same rule as the other jobs).
 */
"use strict";

const http = require("../_lib/http");
const auth = require("../_lib/auth");
const desk = require("../_lib/desk");

const JOB_TOKENS = ["CRON_SECRET", "ADMIN_API_TOKEN"];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }
  if (!auth.anyConfigured(JOB_TOKENS)) {
    return http.fail(res, 503, "job_not_configured",
      "This job is not configured. Set CRON_SECRET (or ADMIN_API_TOKEN) to enable it.");
  }
  if (!auth.bearerMatches(req, JOB_TOKENS)) return http.fail(res, 401, "unauthorised", "Not authorised.");
  if (!http.requireStorage(res)) return;

  try {
    const summary = await desk.drain(40);
    const updates = await desk.pullUpdates();          // shipping + status changes made in the Desk
    return http.ok(res, { ranAt: new Date().toISOString(), summary: summary, updates: updates, backlog: await desk.backlog() });
  } catch (err) {
    return http.handleError(res, err, "jobs/drain-desk");
  }
};
