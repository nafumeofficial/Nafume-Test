/*
 * POST /api/account/logout  —  revoke the current session
 * ============================================================================
 * Revokes the session row (so the token is dead server-side even if the cookie
 * survives somewhere) and clears the cookie. Always returns success: logging
 * out of an already-expired session is not an error the customer should see.
 */
"use strict";

const http = require("../_lib/http");
const auth = require("../_lib/auth");

module.exports = async function handler(req, res) {
  if (!http.guard(req, res, "POST")) return;

  const token = auth.readSessionToken(req);
  auth.clearSessionCookie(req, res);

  if (token) {
    try {
      await auth.revokeSession(token);
    } catch (err) {
      // Cookie is already cleared, so the customer is logged out either way.
      console.error("[account/logout] revoke failed:", err && err.message);
    }
  }
  return http.ok(res, { message: "You have been logged out." });
};
