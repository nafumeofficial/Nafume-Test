/*
 * api/_lib/config-check.js  —  is this deployment actually configured?
 * ============================================================================
 * Reports PRESENCE ONLY. No secret value is ever returned, logged, echoed,
 * hashed into something reversible, or partially revealed. The answer to every
 * question here is a boolean.
 *
 * Two tiers:
 *   required   the site cannot take an order without these
 *   optional   each unlocks one capability; absence degrades cleanly and the
 *              code already says so at the point of use
 *
 * Used by /api/health (token-protected) and by test/check-live-services.js.
 */
"use strict";

const db = require("./db");

/* present(name) — true when the variable is set to something non-blank.
   Whitespace-only counts as missing: a variable set to " " in a dashboard is a
   configuration mistake, not a value. */
function present(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

const REQUIRED = [
  { name: "SUPABASE_URL",              why: "Postgres endpoint. Without it nothing persists." },
  { name: "SUPABASE_SERVICE_ROLE_KEY", why: "Server-side database access. Never exposed to the browser." },
  { name: "RAZORPAY_KEY_ID",           why: "Publishable key used to open Razorpay Checkout." },
  { name: "RAZORPAY_KEY_SECRET",       why: "Signs and verifies payments. Server-side only." }
];

const OPTIONAL = [
  { name: "RAZORPAY_WEBHOOK_SECRET", unlocks: "Payment recovery when the customer's browser never returns.",
    withoutIt: "Orders paid but abandoned mid-redirect stay pending until the reconciliation job runs." },
  { name: "RESEND_API_KEY",          unlocks: "Order confirmations, discount codes, quiz results, review requests.",
    withoutIt: "Messages are queued in outbound_messages and reported as not sent. Nothing is faked." },
  { name: "CUSTOMER_EMAIL_FROM",     unlocks: "A branded sender on a verified domain for customer email.",
    withoutIt: "Falls back to the internal sender, which on Resend's sandbox only reaches your own account." },
  { name: "ADMIN_API_TOKEN",         unlocks: "Admin order + review pages, and recording delivery dates.",
    withoutIt: "Every /api/admin/* route refuses all requests. Review requests can never become due." },
  { name: "CRON_SECRET",             unlocks: "Scheduled review requests and payment reconciliation.",
    withoutIt: "Both jobs refuse to run rather than exposing an open endpoint." },
  { name: "SITE_URL",                unlocks: "Absolute links inside emails.",
    withoutIt: "Review-request links in emails will not be clickable." },
  { name: "MSG91_AUTH_KEY",          unlocks: "One-time-code sign-in by phone.",
    withoutIt: "Password sign-in still works; the OTP option reports it is unavailable." },
  { name: "INSTAGRAM_ACCESS_TOKEN",  unlocks: "Live Instagram feed on the homepage.",
    withoutIt: "The feed falls back to bundled product images." }
];

/* inspect() -> a full, secret-free configuration report. */
function inspect() {
  const required = REQUIRED.map(function (item) {
    return { name: item.name, present: present(item.name), why: item.why };
  });
  const optional = OPTIONAL.map(function (item) {
    return {
      name: item.name, present: present(item.name),
      unlocks: item.unlocks, withoutIt: item.withoutIt
    };
  });

  const missingRequired = required.filter(function (r) { return !r.present; }).map(function (r) { return r.name; });
  const missingOptional = optional.filter(function (o) { return !o.present; }).map(function (o) { return o.name; });

  // A memory driver in production means data is not really being stored.
  const driver = db.driverName();
  const driverIsProductionSafe = driver === "supabase";

  return {
    ok: missingRequired.length === 0 && driverIsProductionSafe,
    storage: {
      driver: driver,
      configured: db.isConfigured(),
      productionSafe: driverIsProductionSafe,
      warning: driver === "memory"
        ? "NAFUME_DB_DRIVER=memory is set. Data is per-instance and is LOST on redeploy. Never use this in production."
        : (driver === "none" ? "No storage driver is configured. Checkout will refuse orders." : null)
    },
    required: required,
    optional: optional,
    missingRequired: missingRequired,
    missingOptional: missingOptional,
    capabilities: {
      takesOrders:        missingRequired.length === 0 && driverIsProductionSafe,
      onlinePayment:      present("RAZORPAY_KEY_ID") && present("RAZORPAY_KEY_SECRET"),
      cashOnDelivery:     db.isConfigured(),
      paymentRecovery:    present("RAZORPAY_WEBHOOK_SECRET"),
      sendsEmail:         present("RESEND_API_KEY"),
      sendsWhatsApp:      false,     // no provider is integrated — see api/_lib/messaging.js
      otpLogin:           present("MSG91_AUTH_KEY"),
      adminApi:           present("ADMIN_API_TOKEN"),
      scheduledJobs:      present("CRON_SECRET") || present("ADMIN_API_TOKEN")
    }
  };
}

/* assertReadyToTakeOrders() -> null when healthy, or a short reason string.
   Called by the order endpoints so a mis-configured deployment fails loudly at
   the first checkout rather than quietly losing orders. */
function assertReadyToTakeOrders() {
  const report = inspect();
  if (report.storage.driver === "memory" && process.env.NODE_ENV === "production") {
    return "memory_driver_in_production";
  }
  if (!report.storage.configured) return "storage_not_configured";
  return null;
}

module.exports = { inspect, assertReadyToTakeOrders, present, REQUIRED, OPTIONAL };
