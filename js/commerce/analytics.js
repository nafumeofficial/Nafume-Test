/*
 * js/commerce/analytics.js  —  Google Analytics 4, with consent
 * ============================================================================
 * Nothing is sent to Google, and Google's script is not even downloaded, until the
 * visitor presses "Accept" on the cookie banner. "Decline" loads nothing. The choice
 * is remembered, and can be changed from "Cookie settings" in the footer.
 *
 * WHAT IS SENT: page views and the shopping funnel (see the table below), with
 * product ids, names, prices and order totals. NEVER names, emails, phone numbers,
 * addresses, or what someone typed into a field.
 *
 * It listens to the site's existing OperationsService.recordAnalyticsEvent(), so
 * the events the site already records are forwarded with no changes to the pages:
 *
 *   product page opened          -> view_item
 *   added to cart                -> add_to_cart
 *   checkout page opened         -> begin_checkout
 *   order placed (online / COD)  -> purchase   (once per order, with payment_type)
 *   order placed on WhatsApp     -> whatsapp_order_placed
 *   cart opened / item removed   -> view_cart, remove_from_cart
 *   checkout details / payment   -> add_shipping_info, add_payment_info
 *   WhatsApp button clicked      -> whatsapp_click
 *   lead popup / quiz / account  -> generate_lead, quiz_completed, sign_up, login
 *
 * Only runs on the real site (see CONFIG.analytics.hosts), so testing and preview
 * addresses never pollute the numbers. For local testing add ?nf_ga_test=1 once.
 */
(function (global) {
  "use strict";

  var cfg = (global.COMMERCE_CONFIG && global.COMMERCE_CONFIG.analytics) || {};
  var MEASUREMENT_ID = String(cfg.measurementId || "");
  var CONSENT_KEY = "nafume_consent_v1";
  var SENT_PREFIX = "nafume_ga_sent_";
  var CART_KEY = "nafumeLaunchCart";

  /* The stub launch.js leaves behind collects events fired before this file loaded. */
  var early = (global.NafumeAnalytics && global.NafumeAnalytics.q) || [];

  var loaded = false;           // Google's script is on the page
  var pending = [];             // events seen before the visitor chose
  var MAX_PENDING = 50;

  /* ── small helpers ──────────────────────────────────────────────────────── */

  function store(key, value) {
    try {
      if (value === undefined) return global.localStorage.getItem(key);
      global.localStorage.setItem(key, value);
    } catch (e) { return null; }
    return null;
  }
  function allowedHere() {
    try {
      if (global.sessionStorage.getItem("nf_ga_test") === "1") return true;
      if (/[?&]nf_ga_test=1/.test(global.location.search)) { global.sessionStorage.setItem("nf_ga_test", "1"); return true; }
    } catch (e) {}
    var hosts = cfg.hosts || [];
    var h = String((global.location && global.location.hostname) || "").toLowerCase();
    return hosts.indexOf(h) !== -1;
  }
  function consent() { return store(CONSENT_KEY); }       // "granted" | "denied" | null

  /* ── products and cart ──────────────────────────────────────────────────── */

  function priceOf() {
    return (typeof LAUNCH_CONFIG !== "undefined" && LAUNCH_CONFIG.sellingPrice) ||
           (global.COMMERCE_CONFIG && global.COMMERCE_CONFIG.sellingPrice) || 799;
  }
  function itemFor(productId, qty) {
    var name = productId;
    try {
      if (typeof LAUNCH_PRODUCTS !== "undefined") {
        var p = LAUNCH_PRODUCTS.find(function (x) { return x.id === productId; });
        if (p) name = p.displayName || p.name || productId;
      }
    } catch (e) {}
    return { item_id: String(productId), item_name: String(name), item_brand: "NAFUME",
             item_category: "Perfume", price: priceOf(), quantity: Math.max(1, parseInt(qty, 10) || 1) };
  }
  function cartItems() {
    try {
      return (JSON.parse(store(CART_KEY) || "[]") || []).map(function (i) {
        return { item_id: String(i.id), item_name: String(i.name || i.id), item_brand: "NAFUME",
                 item_category: "Perfume", price: Number(i.price) || priceOf(), quantity: Math.max(1, parseInt(i.qty, 10) || 1) };
      });
    } catch (e) { return []; }
  }
  function valueOf(items) {
    return items.reduce(function (sum, i) { return sum + i.price * i.quantity; }, 0);
  }

  /* ── sending ────────────────────────────────────────────────────────────── */

  function gtagReady() { return loaded && typeof global.gtag === "function"; }

  function send(name, params) {
    var c = consent();
    if (c === "granted" && gtagReady()) { global.gtag("event", name, params || {}); return; }
    if (c === null && pending.length < MAX_PENDING) pending.push([name, params || {}]);   // decide later
    // "denied": drop it
  }

  function loadGoogle() {
    if (loaded || !MEASUREMENT_ID) return;
    loaded = true;
    global.dataLayer = global.dataLayer || [];
    global.gtag = function () { global.dataLayer.push(arguments); };
    global.gtag("consent", "default", {
      analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied"
    });
    global.gtag("js", new Date());
    global.gtag("config", MEASUREMENT_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
    var s = global.document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(MEASUREMENT_ID);
    global.document.head.appendChild(s);
  }

  function grant() {
    store(CONSENT_KEY, "granted");
    hideBanner();
    loadGoogle();
    var q = pending; pending = [];
    q.forEach(function (e) { send(e[0], e[1]); });
  }
  function deny() {
    store(CONSENT_KEY, "denied");
    pending = [];
    hideBanner();
    // If Google was already loaded this visit, stop its storage immediately.
    if (typeof global.gtag === "function") {
      global.gtag("consent", "update", { analytics_storage: "denied" });
      global.gtag("config", MEASUREMENT_ID, { send_page_view: false });
    }
  }

  /* ── the cookie banner ──────────────────────────────────────────────────── */

  var bannerEl = null;
  function hideBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }
  function el(tag, props, styles) {
    var n = global.document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { n[k] = props[k]; });
    Object.keys(styles || {}).forEach(function (k) { n.style[k] = styles[k]; });
    return n;
  }
  function showBanner() {
    if (bannerEl || !global.document || !global.document.body) return;
    var box = el("div", { id: "nf-consent" }, {
      position: "fixed", left: "12px", right: "12px", bottom: "12px", maxWidth: "460px", margin: "0 auto",
      background: "#111", color: "#fff", padding: "16px 18px", zIndex: "2147483000",
      fontFamily: "Arial, Helvetica, sans-serif", fontSize: "13px", lineHeight: "1.5",
      boxShadow: "0 6px 30px rgba(0,0,0,.35)", paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))"
    });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Cookie preferences");
    var text = el("p", {}, { margin: "0 0 12px" });
    text.appendChild(global.document.createTextNode(
      "We use cookies to understand how people use our site, so we can improve it. No ads and we never sell your data. "));
    var link = el("a", { href: "/pages/legal/privacy-policy.html", textContent: "Privacy Policy" }, { color: "#fff", textDecoration: "underline" });
    text.appendChild(link);
    var row = el("div", {}, { display: "flex", gap: "10px", justifyContent: "flex-end" });
    var no  = el("button", { type: "button", textContent: "Decline", id: "nf-consent-decline" },
      { background: "transparent", color: "#fff", border: "1px solid #666", padding: "9px 18px", fontSize: "12px", letterSpacing: ".08em", cursor: "pointer" });
    var yes = el("button", { type: "button", textContent: "Accept", id: "nf-consent-accept" },
      { background: "#fff", color: "#111", border: "1px solid #fff", padding: "9px 18px", fontSize: "12px", letterSpacing: ".08em", fontWeight: "bold", cursor: "pointer" });
    no.addEventListener("click", deny);
    yes.addEventListener("click", grant);
    row.appendChild(no); row.appendChild(yes);
    box.appendChild(text); box.appendChild(row);
    global.document.body.appendChild(box);
    bannerEl = box;
  }

  /* ── turning the site's events into GA4 events ──────────────────────────── */

  function once(key) {
    if (store(SENT_PREFIX + key)) return false;
    store(SENT_PREFIX + key, "1");
    return true;
  }

  function purchaseFrom(payload) {
    var items = cartItems();
    var base = { transaction_id: String(payload.orderId), value: Number(payload.total) || valueOf(items),
                 currency: "INR", items: items };
    if (!once("order_" + payload.orderId)) return;
    if (payload.checkoutType === "whatsapp") { send("whatsapp_order_placed", base); return; }
    base.payment_type = payload.checkoutType === "cod" ? "cod" : "online";
    send("purchase", base);
  }

  var BRIDGE = {
    add_to_cart: function (p) {
      var item = itemFor(p.productId, p.qty);
      send("add_to_cart", { currency: "INR", value: item.price * item.quantity, items: [item] });
    },
    order_created:    purchaseFrom,
    lead_captured:    function () { send("generate_lead", { lead_source: "popup" }); },
    quiz_completed:   function () { send("quiz_completed", {}); },
    account_created:  function () { send("sign_up", { method: "email" }); },
    account_login:    function () { send("login", { method: "account" }); },
    review_submitted: function (p) { send("review_submitted", { rating: p && p.rating }); },
    bundle_started:   function () { send("bundle_started", {}); },
    bundle_completed: function (p) { send("bundle_completed", { source: p && p.source, count: p && p.count }); },
    upsell_added:     function (p) { send("upsell_added", { item_id: p && p.productId }); },
    track_order_search: function () { send("track_order_search", {}); }
    // product_view and begin_checkout are sent directly below, so they are not doubled here
  };

  function forward(name, payload) {
    var fn = BRIDGE[name];
    if (fn) { try { fn(payload || {}); } catch (e) {} }
  }

  /* Wrap OperationsService.recordAnalyticsEvent once it exists. */
  function bridge() {
    var ops = global.OperationsService;
    if (!ops || ops.__nfGa) return !!(ops && ops.__nfGa);
    var original = ops.recordAnalyticsEvent;
    if (typeof original !== "function") return false;
    ops.recordAnalyticsEvent = function (name, payload) {
      try { forward(name, payload); } catch (e) {}
      return original.apply(this, arguments);
    };
    ops.__nfGa = true;
    return true;
  }

  /* ── page-level events ──────────────────────────────────────────────────── */

  function pageEvents() {
    if (global.PRODUCT_PAGE_ID) {
      var item = itemFor(global.PRODUCT_PAGE_ID, 1);
      send("view_item", { currency: "INR", value: item.price, items: [item] });
    }
    var path = String((global.location && global.location.pathname) || "");
    if (/\/pages\/order\/shipping/.test(path)) {
      var items = cartItems();
      if (items.length) send("begin_checkout", { currency: "INR", value: valueOf(items), items: items });
    }
  }

  /* ── cart and checkout steps ────────────────────────────────────────────── */

  function wrapGlobal(name, before) {
    var fn = global[name];
    if (typeof fn !== "function" || fn.__nfGa) return;
    var wrapped = function () {
      try { before.apply(null, arguments); } catch (e) {}
      return fn.apply(this, arguments);
    };
    wrapped.__nfGa = true;
    global[name] = wrapped;
  }
  var shippingSent = false;
  function paymentType() {
    var r = global.document.querySelector('input[name="payment"]:checked');
    var v = r ? String(r.value).toLowerCase() : "";
    return v === "cod" ? "cod" : v === "whatsapp" ? "whatsapp" : "online";
  }
  function checkoutSteps() {
    wrapGlobal("launchRemove", function (productId) {
      var i = cartItems().filter(function (x) { return x.item_id === String(productId); })[0];
      if (i) send("remove_from_cart", { currency: "INR", value: i.price * i.quantity, items: [i] });
    });
    wrapGlobal("openCart", function () {
      var items = cartItems();
      if (items.length) send("view_cart", { currency: "INR", value: valueOf(items), items: items });
    });
    wrapGlobal("placeOrder", function () {
      var items = cartItems(), t = paymentType();
      if (!items.length || shippingSent) return;
      shippingSent = true;
      var p = { currency: "INR", value: valueOf(items), items: items };
      send("add_shipping_info", p);
      p.payment_type = t; send("add_payment_info", p);
    });
    global.document.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.name === "payment") {
        var items = cartItems();
        send("add_payment_info", { currency: "INR", value: valueOf(items), items: items, payment_type: paymentType() });
      }
    });
    global.document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href*="wa.me"], #wa-send-btn') : null;
      if (a) send("whatsapp_click", { link_location: String(global.location.pathname) });
    });
  }

  /* ── start ──────────────────────────────────────────────────────────────── */

  function start() {
    if (!MEASUREMENT_ID || !allowedHere()) return;
    var c = consent();
    if (c === "granted") loadGoogle();
    else if (c === null) {
      if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", showBanner);
      else showBanner();
    }

    // Replace the stub launch.js left behind, then replay what it collected.
    global.NafumeAnalytics = {
      q: [], track: send, consent: consent, accept: grant, decline: deny,
      openConsent: function () { hideBanner(); showBanner(); },
      _forward: forward
    };
    early.forEach(function (e) { forward(e[0], e[1]); });

    pageEvents();
    checkoutSteps();

    var tries = 0, timer = global.setInterval(function () {
      if (bridge() || ++tries > 60) global.clearInterval(timer);
    }, 100);
  }

  start();
})(window);
