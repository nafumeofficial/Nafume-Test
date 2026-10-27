/* ============================================================================
   NAFUME — Commerce Configuration   (Upgrade 1: commerce foundation)
   ----------------------------------------------------------------------------
   Single source of truth for commerce settings.

   Current mode: "local"
     - Cart + orders are persisted in the browser (localStorage).
     - Checkout is completed over WhatsApp (existing flow, unchanged).

   The Shopify fields below are PLACEHOLDERS for a future upgrade and are NOT
   active. No real credentials live here.

   NOTE: pricing / shipping values mirror LAUNCH_CONFIG in js/launch.js (the
   live store). Keep the two in sync until launch.js is migrated onto this file.
   ========================================================================== */
(function (global) {
  "use strict";

  var COMMERCE_CONFIG = {
    // ── Mode ────────────────────────────────────────────────────────────────
    commerceMode: "local",            // "local" | "shopify" (future)

    // ── Brand ───────────────────────────────────────────────────────────────
    brandName:     "NAFUME",
    brandFullName: "NAFUME Artisan Luxe",
    currency:       "INR",
    currencySymbol: "₹",          // ₹

    // ── Order capture (current WhatsApp flow) ───────────────────────────────
    whatsappNumber: "918595862227",
    checkoutType:   "whatsapp",

    // ── Analytics (Google Analytics 4) — see js/commerce/analytics.js ───────
    // Loaded only after the visitor accepts the cookie banner, and only on these
    // hostnames, so testing and preview addresses never reach the real numbers.
    analytics: {
      measurementId: "G-XH88TWQ621",
      hosts: ["www.nafume.com", "nafume.com"]
    },

    // ── Pricing / shipping (mirrors js/launch.js LAUNCH_CONFIG) ─────────────
    sellingPrice:          799,
    mrp:                   1299,
    freeShippingThreshold: 999,
    shippingCost:          99,
    defaultSaleText: "Summer Sale — ₹799 each · Free shipping above ₹999",

    // ── localStorage keys ───────────────────────────────────────────────────
    storageKeys: {
      cart:            "nafumeLaunchCart",     // shared with js/launch.js — DO NOT rename
      orders:          "nafume_orders_v2",     // structured orders (Upgrade 1)
      // Customer accounts (Upgrade 3) — LOCAL DEMO ONLY, not secure auth.
      customers:       "nafume_customers",         // all local profiles
      currentCustomer: "nafume_current_customer",  // logged-in customerId
      customerSession: "nafume_customer_session",  // mock login/OTP session
      reviews:         "nafume_product_reviews",   // local product reviews (Upgrade 4)
      inventory:       "nafume_inventory_v1",      // local stock levels (Upgrade 10)
      analytics:       "nafume_analytics_events"   // local analytics events (Upgrade 10)
    },

    /* ── Shopify checkout (Upgrade 2) ───────────────────────────────────────
       NOT ACTIVE by default. To turn on the real Shopify hosted checkout, see
       docs/shopify-checkout-setup.md. Quick version:
         1. paste your store domain + Storefront token below
         2. paste each product's variant id into js/launch.js
         3. set  commerceMode: "shopify"  AND  checkout.enableShopifyCheckout: true

       ⚠️  SECURITY: only the **Storefront API** access token may live in this
       frontend file — it is designed to be public. NEVER paste a Shopify
       **Admin API** token here (or anywhere in client-side code); that token
       can read/modify your whole store and must stay on a server only.        */
    shopify: {
      enabled:               false,        // master switch for Shopify mode
      storeDomain:           "",           // e.g. "nafume.myshopify.com"  (no https://)
      storefrontAccessToken: "",           // PUBLIC Storefront API token — paste here
      apiVersion:            "2025-01",
      checkoutFallbackMode:  "whatsapp"    // what to use when Shopify can't start
    },

    // ── Checkout buttons / mode flags ───────────────────────────────────────
    checkout: {
      enableWhatsAppCheckout: true,                          // keep WhatsApp available
      enableShopifyCheckout:  false,                         // flip true once configured
      primaryCheckoutLabel:   "Proceed to Secure Checkout",  // shown in Shopify mode
      whatsappCheckoutLabel:  "Order on WhatsApp"            // assisted / fallback option
    },

    /* ── Razorpay online payment ─────────────────────────────────────────────
       Real payment gateway (Standard Checkout). Order creation + signature
       verification happen server-side in api/razorpay/create-order.js and
       api/razorpay/verify-payment.js — RAZORPAY_KEY_SECRET never appears here
       or anywhere else in frontend code. Only the publishable key_id (safe to
       expose) is returned by create-order.js at checkout time; nothing is
       hardcoded in this file.

       ┌─────────────────────────────────────────────────────────────────────┐
       │  🔒 SECURITY                                                          │
       │  • NEVER put RAZORPAY_KEY_SECRET or RAZORPAY_WEBHOOK_SECRET in any    │
       │    frontend file. They live only in Vercel → Environment Variables.  │
       │  • WhatsApp checkout stays available as a fallback — Razorpay never  │
       │    replaces it, only adds an additional "Pay Online" option.         │
       └─────────────────────────────────────────────────────────────────────┘ */
    razorpay: {
      enabled:                true,   // master switch — false hides "Pay Online", WhatsApp/COD only
      createOrderEndpoint:    "/api/razorpay/create-order",
      verifyPaymentEndpoint:  "/api/razorpay/verify-payment",
      buttonLabel:            "Pay Online (Razorpay)",
      themeColor:             "#C5A059"   // NAFUME gold — passed to Razorpay Checkout UI
    },

    /* ── Order tracking (Upgrade 7: Shiprocket-ready foundation) ────────────
       Controls how the Track Order page behaves. Default is fully LOCAL:
       it shows the order's local status timeline only. No live courier API is
       called from the browser.

       ┌─────────────────────────────────────────────────────────────────────┐
       │  🔒 SECURITY — READ BEFORE EDITING                                   │
       │  • NEVER put a Shiprocket API token, email, password, bearer token   │
       │    or refresh token in this file (or anywhere in client-side JS).    │
       │  • Shiprocket private credentials must live ONLY on a server.        │
       │  • For LIVE tracking, build a backend/serverless endpoint (e.g.      │
       │    /api/track-order) that holds the token in environment variables,  │
       │    calls Shiprocket privately, and returns a sanitized status.       │
       │  • The frontend may ONLY call `backendTrackingEndpoint` (your own    │
       │    server) — it must never call Shiprocket directly.                 │
       │  See docs/shiprocket-tracking-setup.md for the full guide.           │
       └─────────────────────────────────────────────────────────────────────┘

       shiprocketTrackingMode:
         "local"         — show local order status only (no external link)
         "external_link" — if an AWB / tracking URL exists, show a courier
                           tracking button (default)
         "backend_proxy" — FUTURE: frontend calls YOUR backend endpoint, which
                           privately calls Shiprocket. Requires backendTrackingEndpoint. */
    tracking: {
      provider:                "local",          // "local" | "shiprocket" (via backend only)
      enableShiprocket:        false,            // keep false until a backend exists
      shiprocketTrackingMode:  "external_link",  // "local" | "external_link" | "backend_proxy"
      backendTrackingEndpoint: "",               // e.g. "/api/track-order" — YOUR server, NOT Shiprocket
      allowManualAwbUpdate:    true,             // lets orders-admin.html add AWB/courier locally
      supportMessage:          "Live courier tracking will appear once your order is dispatched."
    },

    /* ── Upsells & offers (Upgrade 9) ───────────────────────────────────────
       Practical, local-first ecommerce offers. All values are easy to change.
       These drive js/commerce/offer-service.js. They are LOCAL/messaging only —
       no payment is taken in the browser.

       ⚠️  SHOPIFY: if you turn on live Shopify checkout, these local discounts do
       NOT automatically apply inside Shopify. You must recreate matching discount
       codes / automatic discounts / bundle & sample products in Shopify Admin.
       See docs/upsells-bundles-system.md.

       💡 PRICING NOTE: buyAny3.bundlePrice acts as a PRICE CAP — the customer is
       always charged the lower of (their 3 items) or bundlePrice, so they can
       never pay more than normal. At a deep sale price the cap may not bind. */
    offers: {
      prepaidDiscount: {
        enabled:   true,
        type:      "percentage",   // "percentage" | "flat"
        value:     5,              // 5% off
        label:     "Extra 5% off on prepaid orders",
        appliesTo: "prepaid"       // matched against the chosen payment method
      },
      freeShipping: {
        enabled:   true,
        threshold: 999,            // keep in sync with freeShippingThreshold above
        label:     "Free shipping above ₹999"
      },
      tryMeSample: {
        enabled:   true,
        threshold: 999,
        label:     "Free try-me sample on eligible orders",
        // TODO[sample]: connect a real sample product ID / Shopify variant ID later.
        productId: null
      },
      buyAny3: {
        enabled:          true,
        requiredQuantity: 3,
        bundlePrice:      2199,    // price cap for any 3 eligible 50ml perfumes
        label:            "Buy any 3 × 50ml at ₹2199"
      },
      giftingAddOn: {
        enabled: true,
        price:   99,
        label:   "Add premium gift packaging"
      }
    },

    /* ── Operations & scalability (Upgrade 10) ──────────────────────────────
       Drives the LOCAL operations dashboard (operations-admin.html) and the
       operations-service.js helpers: order management, inventory visibility,
       CSV export and lightweight local analytics events.

       ┌─────────────────────────────────────────────────────────────────────┐
       │  ⚠️  LOCAL DEMO ONLY — NOT PRODUCTION SECURE                         │
       │  • operations-admin.html has NO authentication. Anyone who opens it  │
       │    on this browser can read/edit local data. Never link it publicly. │
       │  • NEVER expose private API keys (Shopify Admin, Shiprocket, payment) │
       │    in this file or anywhere in client-side JS.                       │
       │  • Production order/inventory/customer admin MUST be handled by       │
       │    Shopify Admin, a protected backend dashboard, or a secure server. │
       │  See docs/operational-scalability-system.md.                         │
       └─────────────────────────────────────────────────────────────────────┘ */
    operations: {
      mode:                   "local",          // "local" | "backend" (future)
      enableLocalAdmin:       true,
      enableDataExport:       true,
      enableAnalyticsEvents:  true,
      enableInventoryWarnings: true,
      lowStockThreshold:      5,
      defaultStockQuantity:   50,               // seeded for products with no stored stock
      supportEmail:           "nafume.official@gmail.com",
      supportWhatsApp:        "",               // optional; falls back to whatsappNumber
      adminWarning:           "Local demo admin only. Connect a secure backend before production."
    },

    /* ── Legacy flat aliases (kept so Upgrade 1 code keeps working) ──────────
       Prefer the nested `shopify` block above. */
    shopifyStoreDomain:           "",
    shopifyStorefrontAccessToken: "",
    shopifyApiVersion:            "2025-01",
    enableShopifyCheckout:        false
  };

  global.COMMERCE_CONFIG = COMMERCE_CONFIG;
})(window);
