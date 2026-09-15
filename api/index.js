/*
 * Single Vercel Function router
 * ============================================================================
 * Vercel's Hobby runtime permits 12 functions per deployment. NAFUME exposes
 * more API routes than that, so vercel.json rewrites every public /api/* URL
 * to this one function while the route handlers live in /server.
 *
 * Keep this map explicit. Static require() calls let Vercel include every
 * handler and its dependencies in the function bundle, and prevent a request
 * path from ever becoming a filesystem path.
 */
"use strict";

const ROUTES = Object.freeze({
  "/account/identifiers":        require("../server/account/identifiers"),
  "/account/login":              require("../server/account/login"),
  "/account/logout":             require("../server/account/logout"),
  "/account/me":                 require("../server/account/me"),
  "/account/register":           require("../server/account/register"),
  "/account/resend-code":        require("../server/account/resend-code"),
  "/account/update":             require("../server/account/update"),
  "/account/verify":             require("../server/account/verify"),
  "/admin/orders":               require("../server/admin/orders"),
  "/admin/reviews":              require("../server/admin/reviews"),
  "/discounts/validate":         require("../server/discounts/validate"),
  "/health":                     require("../server/health"),
  "/instagram/feed":             require("../server/instagram/feed"),
  "/jobs/drain-outbox":          require("../server/jobs/drain-outbox"),
  "/jobs/maintenance":           require("../server/jobs/maintenance"),
  "/jobs/reconcile-payments":    require("../server/jobs/reconcile-payments"),
  "/jobs/review-requests":       require("../server/jobs/review-requests"),
  "/leads/subscribe":            require("../server/leads/subscribe"),
  "/orders/create-cod":          require("../server/orders/create-cod"),
  "/orders/lookup":              require("../server/orders/lookup"),
  "/otp/send":                   require("../server/otp/send"),
  "/otp/verify":                 require("../server/otp/verify"),
  "/quiz/questions":             require("../server/quiz/questions"),
  "/quiz/recommend":             require("../server/quiz/recommend"),
  "/quiz/submit":                require("../server/quiz/submit"),
  "/razorpay/create-order":      require("../server/razorpay/create-order"),
  "/razorpay/verify-payment":    require("../server/razorpay/verify-payment"),
  "/razorpay/webhook":           require("../server/razorpay/webhook"),
  "/reviews/eligibility":        require("../server/reviews/eligibility"),
  "/reviews/list":               require("../server/reviews/list"),
  "/reviews/submit":             require("../server/reviews/submit")
});

module.exports = async function handler(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, "https://nafume.invalid").pathname;
  } catch (_) {
    pathname = "";
  }

  let rewrittenPath = req.query && req.query.path;
  if (Array.isArray(rewrittenPath)) rewrittenPath = rewrittenPath.join("/");

  const route = rewrittenPath
    ? "/" + String(rewrittenPath).replace(/^\/+|\/+$/g, "")
    : pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const routeHandler = ROUTES[route];

  if (!routeHandler) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({
      success: false,
      error: "not_found",
      message: "No such endpoint."
    });
  }

  return routeHandler(req, res);
};
