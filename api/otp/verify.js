/*
 * POST /api/otp/verify  —  MSG91 VerifyOTP proxy  (Vercel Serverless Function)
 * --------------------------------------------------------------------------
 * This runs server-side only. MSG91_AUTH_KEY is NEVER exposed to the browser.
 * Raw MSG91 error messages are never forwarded to the client.
 *
 * On a successful OTP check this ALSO issues a real server session:
 *   - the phone number is matched to (or creates) a `customers` row, so OTP
 *     login and password login resolve to the SAME customer record rather than
 *     two competing identity systems;
 *   - an HttpOnly session cookie is set, identical to the one password login
 *     issues, so /api/account/me works either way.
 * If the database is not configured the OTP result is still returned truthfully
 * ({ success: true }) — just without a session. That keeps the endpoint
 * backwards-compatible with the older localStorage-only account flow.
 *
 * Env vars required (Vercel Dashboard — NOT in any frontend file):
 *   MSG91_AUTH_KEY           — authkey from msg91.com
 *   OTP_MAX_VERIFY_ATTEMPTS  — max wrong-OTP attempts per session (default 5;
 *                              enforced on the client via sessionStorage — a
 *                              proper server-side counter needs Vercel KV)
 */
"use strict";

const AUTH_KEY = process.env.MSG91_AUTH_KEY;

const db   = require("../_lib/db");
const auth = require("../_lib/auth");
const repo = require("../_lib/repo");
const http = require("../_lib/http");

/* startSessionForPhone — best effort. A storage problem must never turn a
   genuinely correct OTP into a login failure, so every path here is caught. */
async function startSessionForPhone(req, res, digits) {
  if (!db.isConfigured()) return { session: false, customer: null };
  try {
    const found = await repo.findOrCreateCustomer({
      phone: digits, phoneNormalized: digits, source: "otp_login"
    });
    await repo.attachOrphanOrders(found.customer);
    const session = await auth.createSession(found.customer.id, "otp");
    auth.setSessionCookie(req, res, session.token);
    return { session: true, customer: auth.publicCustomer(found.customer) };
  } catch (err) {
    console.error("[otp/verify] session creation failed:", err && err.message);
    return { session: false, customer: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!AUTH_KEY) {
    return res.status(500).json({
      error: "server_misconfigured",
      message: "OTP service is not configured. Please contact support."
    });
  }

  const body   = (typeof req.body === "string") ? JSON.parse(req.body) : (req.body || {});
  const digits = String(body.phone || "").replace(/\D/g, "");
  const otp    = String(body.otp   || "").replace(/\D/g, "");

  if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
    return res.status(400).json({ error: "invalid_phone", message: "Invalid phone number." });
  }
  if (otp.length !== 6) {
    return res.status(400).json({
      error: "invalid_otp_format",
      message: "Please enter the 6-digit OTP."
    });
  }

  /* Durable per-number cap on VERIFY attempts. A 6-digit code has a million
     combinations; without a server-side ceiling, an attacker could simply try
     them. The old client-side sessionStorage counter was trivially bypassed by
     clearing storage, so the real limit lives in the database. */
  if (!await http.durableLimit(req, res, {
    key: "otp-verify-number", scope: digits, limit: 8, windowMs: 15 * 60 * 1000
  })) return;
  if (!await http.durableLimit(req, res, {
    key: "otp-verify-ip", limit: 40, windowMs: 15 * 60 * 1000
  })) return;

  const mobile    = "91" + digits;
  const verifyUrl = "https://control.msg91.com/api/v5/otp/verify" +
                    "?mobile=" + encodeURIComponent(mobile) +
                    "&otp="    + encodeURIComponent(otp);

  let result;
  try {
    const resp = await fetch(verifyUrl, {
      method:  "GET",
      headers: { "authkey": AUTH_KEY }
    });
    result = await resp.json();
  } catch (_) {
    return res.status(500).json({
      error: "server_error",
      message: "Service temporarily unavailable. Please try again."
    });
  }

  if (result.type === "success") {
    const started = await startSessionForPhone(req, res, digits);
    return res.status(200).json({
      success:  true,
      session:  started.session,
      customer: started.customer
    });
  }

  const msg = String(result.message || "").toLowerCase();

  if (msg.includes("not matched") || msg.includes("wrong otp") || msg.includes("invalid otp")) {
    return res.status(422).json({
      error: "invalid_otp",
      message: "Incorrect OTP. Please check and try again."
    });
  }
  if (msg.includes("expired") || msg.includes("otp not found") || msg.includes("request not found")) {
    return res.status(422).json({
      error: "otp_expired",
      message: "OTP has expired. Please request a new one."
    });
  }

  return res.status(422).json({
    error: "verify_failed",
    message: "OTP verification failed. Please try again."
  });
};
