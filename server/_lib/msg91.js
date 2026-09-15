/*
 * api/_lib/msg91.js  —  MSG91 SendOTP / VerifyOTP (phone verification)
 * ============================================================================
 * The existing phone-code integration, extracted from the old /api/otp handlers
 * so phone sign-in and phone verification for account linking share one
 * implementation. MSG91 generates, delivers and checks the code; NAFUME's own
 * verification_challenges row binds the code to one number and one operation,
 * counts attempts and makes a successful check single-use.
 *
 * Env: MSG91_AUTH_KEY, MSG91_TEMPLATE_ID (DLT-approved, contains ##OTP##),
 *      MSG91_SENDER_ID, OTP_EXPIRY_SECONDS.
 *
 * The HTTP contract below is unchanged from the previous handlers and has NOT
 * been verified against a live MSG91 account from this repository.
 */
"use strict";

const TIMEOUT_MS = 8000;

function authKey()    { return process.env.MSG91_AUTH_KEY; }
function templateId() { return process.env.MSG91_TEMPLATE_ID; }
function senderId()   { return process.env.MSG91_SENDER_ID || "NAFUME"; }
function expirySeconds() { return parseInt(process.env.OTP_EXPIRY_SECONDS || "300", 10) || 300; }

function configured() { return !!(authKey() && templateId()); }

async function call(url, init) {
  const ctrl  = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const resp = await fetch(url, Object.assign({ signal: ctrl.signal }, init));
    clearTimeout(timer);
    const data = await resp.json().catch(function () { return {}; });
    return { ok: true, data: data || {} };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: err && err.name === "AbortError" ? "timeout" : "network_error" };
  }
}

/* sendOtp("9876543210") -> { ok } | { ok:false, reason } */
async function sendOtp(digits) {
  if (!configured()) return { ok: false, reason: "unavailable" };
  const r = await call("https://control.msg91.com/api/v5/otp", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "authkey": authKey() },
    body: JSON.stringify({
      template_id: templateId(),
      sender:      senderId(),
      mobile:      "91" + digits,
      otp_length:  6,
      otp_expiry:  Math.ceil(expirySeconds() / 60)
    })
  });
  if (!r.ok) return { ok: false, reason: "unavailable" };
  if (r.data.type === "success") return { ok: true };
  const msg = String(r.data.message || "").toLowerCase();
  if (msg.indexOf("already have a valid otp") !== -1) return { ok: false, reason: "already_sent" };
  return { ok: false, reason: "send_failed" };
}

/* verifyOtp("9876543210", "123456") -> { ok } | { ok:false, reason } */
async function verifyOtp(digits, otp) {
  if (!authKey()) return { ok: false, reason: "unavailable" };
  const url = "https://control.msg91.com/api/v5/otp/verify" +
              "?mobile=" + encodeURIComponent("91" + digits) +
              "&otp="    + encodeURIComponent(otp);
  const r = await call(url, { method: "GET", headers: { "authkey": authKey() } });
  if (!r.ok) return { ok: false, reason: "unavailable" };
  if (r.data.type === "success") return { ok: true };
  const msg = String(r.data.message || "").toLowerCase();
  if (msg.indexOf("not matched") !== -1 || msg.indexOf("wrong otp") !== -1 || msg.indexOf("invalid otp") !== -1) {
    return { ok: false, reason: "invalid" };
  }
  if (msg.indexOf("expired") !== -1 || msg.indexOf("otp not found") !== -1 || msg.indexOf("request not found") !== -1) {
    return { ok: false, reason: "expired" };
  }
  // Includes "already verified": a replayed code is never a success.
  return { ok: false, reason: "failed" };
}

module.exports = { configured, sendOtp, verifyOtp, expirySeconds };
