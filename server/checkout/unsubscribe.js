/*
 * GET /api/checkout/unsubscribe?e=<email>&t=<token>  —  stop cart reminders
 * ============================================================================
 * One click, no sign-in. The token is an HMAC of the address (see _lib/abandoned),
 * so the link only works for the person it was emailed to. Always lands on the
 * same confirmation page, valid link or not, so it cannot be used to test which
 * addresses exist.
 */
"use strict";

const http      = require("../_lib/http");
const validate  = require("../_lib/validate");
const abandoned = require("../_lib/abandoned");
const db        = require("../_lib/db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return http.fail(res, 405, "method_not_allowed", http.MESSAGES.method_not_allowed);
  }
  if (!http.requireStorage(res)) return;

  const q = req.query || {};
  const emailNorm = validate.normalizeEmail(q.e);
  try {
    if (emailNorm && abandoned.tokenValid(emailNorm, q.t)) {
      const row = await db.selectOne("leads", { email_normalized: emailNorm, source: abandoned.SOURCE });
      if (row) {
        const meta = Object.assign({}, row.metadata || {}, { unsubscribed: true });
        await db.update("leads", { where: { id: row.id }, set: { metadata: meta, updated_at: db.nowISO() } });
      }
    }
  } catch (err) {
    return http.handleError(res, err, "checkout/unsubscribe");
  }
  res.writeHead(302, { Location: "/pages/support/unsubscribed.html" });
  res.end();
};
