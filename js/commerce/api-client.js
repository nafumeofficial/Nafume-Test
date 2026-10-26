/* ============================================================================
   NAFUME — API Client
   ----------------------------------------------------------------------------
   One place for every call to /api, so error handling, timeouts and the
   "backend is unavailable" state are consistent across the site instead of
   being reinvented on each page.

   Design notes
     * Every call resolves — never rejects. Callers get a uniform result object
       and can render a real state instead of catching exceptions everywhere:
         { ok, status, data, error, message, offline }
       `offline: true` means the request never reached the server (no network,
       DNS failure, timeout) as opposed to the server answering with an error.
     * The server is the source of truth for orders and customers. localStorage
       keeps working as a fast local cache for pages that already read it, but
       nothing important depends on it any more.
     * No secrets live here. The only credential the browser ever sees is the
       Razorpay publishable key_id, handed back by /api/razorpay/create-order at
       checkout time.

   Public API (window.NafumeAPI)
     request(path, options)
     get(path) / post(path, body)
     lookupOrder(orderId, contact, { refreshPayment })
     me() / login() / register() / verifyAccount() / resendCode() / logout() / updateAccount()
     startIdentifierVerification() / confirmIdentifierVerification()
     subscribeLead(email, meta)
     quizQuestions() / quizRecommend(answers) / quizSubmit(email, answers)
     reviewEligibility(orderId, contact) / submitReview(payload)
     productReviews(productId)
     rememberCheckoutContact(orderId, contact) / recallCheckoutContact(orderId)
     toLocalOrder(serverOrder)
   ========================================================================== */
(function (global) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 20000;
  var CONTACT_KEY = "nafume_order_contacts";      // { orderId: contact } — lets the
                                                  // confirmation page authenticate a
                                                  // guest lookup without re-asking
  var PREFILL_KEY = "nafume_account_prefill";     // post-checkout account prefill

  /* ── storage helpers (never throw: private mode, quota, disabled) ──────── */
  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  /* ── core request ─────────────────────────────────────────────────────── */

  /* request(path, options) -> Promise<result>
     options: { method, body, timeoutMs }
     Always resolves. Network/timeout failures come back as offline:true so the
     UI can say "check your connection" rather than "something went wrong". */
  function request(path, options) {
    options = options || {};
    var method    = options.method || (options.body !== undefined ? "POST" : "GET");
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;

    var init = {
      method: method,
      headers: {},
      credentials: "same-origin"          // session cookie travels with the request
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (controller) init.signal = controller.signal;

    return global.fetch(path, init)
      .then(function (response) {
        if (timer) clearTimeout(timer);
        return response.json()
          .catch(function () { return {}; })
          .then(function (data) {
            return {
              ok:      response.ok && data.success !== false,
              status:  response.status,
              data:    data || {},
              error:   data && data.error ? data.error : (response.ok ? null : "http_" + response.status),
              message: (data && data.message) || (response.ok ? null : defaultMessage(response.status)),
              fields:  (data && data.fields) || null,
              offline: false
            };
          });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        var timedOut = err && err.name === "AbortError";
        return {
          ok: false, status: 0, data: {},
          error: timedOut ? "timeout" : "network_error",
          message: timedOut
            ? "That took too long. Please check your connection and try again."
            : "We couldn't reach NAFUME. Please check your internet connection and try again.",
          fields: null,
          offline: true
        };
      });
  }

  function defaultMessage(status) {
    if (status === 404) return "We couldn't find what you were looking for.";
    if (status === 429) return "Too many attempts. Please wait a moment and try again.";
    if (status === 503) return "Our system is temporarily unavailable. Please try again in a minute.";
    if (status >= 500)  return "Something went wrong on our side. Please try again.";
    return "That request could not be completed.";
  }

  function get(path)        { return request(path, { method: "GET" }); }
  function post(path, body) { return request(path, { method: "POST", body: body || {} }); }

  /* ── checkout contact memory ────────────────────────────────────────────
     A guest has no session, so the confirmation page proves ownership of the
     order with the contact detail used at checkout. Stored per order id and
     pruned so this never grows unbounded.                                   */

  function rememberCheckoutContact(orderId, contact) {
    if (!orderId || !contact) return;
    var map = readJSON(CONTACT_KEY, {}) || {};
    map[orderId] = String(contact);
    var keys = Object.keys(map);
    if (keys.length > 20) {
      keys.slice(0, keys.length - 20).forEach(function (k) { delete map[k]; });
    }
    writeJSON(CONTACT_KEY, map);
  }
  function recallCheckoutContact(orderId) {
    var map = readJSON(CONTACT_KEY, {}) || {};
    return map[orderId] || null;
  }

  function rememberAccountPrefill(prefill) {
    if (!prefill) return;
    writeJSON(PREFILL_KEY, {
      name:    prefill.name || "",
      email:   prefill.email || "",
      phone:   prefill.phone || "",
      orderId: prefill.orderId || "",
      at:      new Date().toISOString()
    });
  }
  function recallAccountPrefill() {
    var p = readJSON(PREFILL_KEY, null);
    if (!p || !p.at) return null;
    // Only meaningful straight after a purchase; expire after 24 hours.
    if (Date.now() - new Date(p.at).getTime() > 24 * 60 * 60 * 1000) return null;
    return p;
  }
  function clearAccountPrefill() {
    try { global.localStorage.removeItem(PREFILL_KEY); } catch (e) {}
  }

  /* ── orders ───────────────────────────────────────────────────────────── */

  /* lookupOrder(orderId, contact, { refreshPayment })
     refreshPayment asks the server to re-check an online payment that is still
     being confirmed (used by the confirmation page while it waits). */
  function lookupOrder(orderId, contact, opts) {
    return post("/api/orders/lookup", {
      orderId: orderId,
      contact: contact || recallCheckoutContact(orderId) || "",
      refreshPayment: !!(opts && opts.refreshPayment)
    });
  }

  /* toLocalOrder(serverOrder)
     Maps the server's order projection into the shape the existing pages
     (confirmation.html, track-order.html, account.html) already render, so the
     switch to server-backed data needed no rewrite of that rendering code. */
  function toLocalOrder(o) {
    if (!o) return null;
    var s = o.shipping || {};
    var d = o.delivery || {};
    return {
      orderId:           o.orderId,
      createdAt:         o.createdAt,
      status:            o.orderStatus,
      paymentStatus:     o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      paymentMethod:     o.paymentMethod,
      checkoutType:      o.paymentMethod === "cod" ? "cod" : (o.paymentMethod === "whatsapp" ? "whatsapp" : "razorpay"),
      source:            "server",
      customer: {
        name:    s.name    || "",
        phone:   s.phone   || "",
        email:   s.email   || "",
        address: [s.line1, s.line2].filter(Boolean).join(", "),
        city:    s.city    || "",
        state:   s.state   || "",
        pincode: s.pincode || ""
      },
      items: (o.items || []).map(function (i) {
        return {
          productId: i.productId, name: i.name, price: i.unitPrice,
          quantity: i.quantity, qty: i.quantity, size: "50ml"
        };
      }),
      totals: {
        subtotal:        (o.totals && o.totals.subtotal) || 0,
        shipping:        (o.totals && o.totals.shipping) || 0,
        bundleDiscount:  (o.totals && o.totals.bundleDiscount) || 0,
        prepaidDiscount: (o.totals && o.totals.prepaidDiscount) || 0,
        giftingAddOn:    (o.totals && o.totals.giftingAddOn) || 0,
        total:           (o.totals && o.totals.total) || 0
      },
      razorpay: o.razorpayPaymentId ? { paymentId: o.razorpayPaymentId } : null,
      whatsappOptIn: !!o.whatsappOptIn,
      tracking: {
        awb:           d.awb || null,
        courierName:   d.courierName || null,
        shippedAt:     d.shippedAt || null,
        deliveredAt:   d.deliveredAt || null,
        currentStatus: d.deliveredAt ? "delivered" : (d.shippedAt ? "shipped" : "order_placed"),
        events: []
      },
      review: o.review || null
    };
  }

  /* ── account ──────────────────────────────────────────────────────────── */

  function me()                        { return get("/api/account/me"); }
  function login(identifier, password) { return post("/api/account/login", { identifier: identifier, password: password }); }
  /* register() only sends a code; verifyAccount() finishes the account. */
  function register(payload)           { return post("/api/account/register", payload); }
  function verifyAccount(challengeId, code) {
    return post("/api/account/verify", { challengeId: challengeId, code: code });
  }
  function resendCode(challengeId, purpose) {
    return post("/api/account/resend-code", { challengeId: challengeId, purpose: purpose || "account_register" });
  }
  function startIdentifierVerification(channel, value) {
    return post("/api/account/identifiers", { action: "start", channel: channel, value: value });
  }
  function confirmIdentifierVerification(challengeId, code) {
    return post("/api/account/identifiers", { action: "confirm", challengeId: challengeId, code: code });
  }
  function logout()                    { return post("/api/account/logout", {}); }
  function updateAccount(payload)      { return post("/api/account/update", payload); }

  /* ── leads / quiz / reviews ───────────────────────────────────────────── */

  function subscribeLead(email, meta) {
    return post("/api/leads/subscribe", { email: email, source: "popup_lead", meta: meta || {} });
  }
  function quizQuestions()          { return get("/api/quiz/questions"); }
  function quizRecommend(answers)   { return post("/api/quiz/recommend", { answers: answers }); }
  function quizSubmit(email, answers, optIn) {
    return post("/api/quiz/submit", { email: email, answers: answers, marketingOptIn: optIn === true });
  }
  /* token = the review link token from the review-request email. A signed-in
     owner needs none (the session cookie travels with the request). */
  function reviewEligibility(orderId, token) {
    return post("/api/reviews/eligibility", { orderId: orderId, token: token || "" });
  }
  function submitReview(payload)    { return post("/api/reviews/submit", payload); }
  function productReviews(productId) {
    return get("/api/reviews/list?productId=" + encodeURIComponent(productId));
  }

  global.NafumeAPI = {
    request: request, get: get, post: post,
    lookupOrder: lookupOrder, toLocalOrder: toLocalOrder,
    me: me, login: login, register: register, logout: logout, updateAccount: updateAccount,
    verifyAccount: verifyAccount, resendCode: resendCode,
    startIdentifierVerification: startIdentifierVerification,
    confirmIdentifierVerification: confirmIdentifierVerification,
    subscribeLead: subscribeLead,
    quizQuestions: quizQuestions, quizRecommend: quizRecommend, quizSubmit: quizSubmit,
    reviewEligibility: reviewEligibility, submitReview: submitReview, productReviews: productReviews,
    rememberCheckoutContact: rememberCheckoutContact,
    recallCheckoutContact: recallCheckoutContact,
    rememberAccountPrefill: rememberAccountPrefill,
    recallAccountPrefill: recallAccountPrefill,
    clearAccountPrefill: clearAccountPrefill
  };
})(window);
