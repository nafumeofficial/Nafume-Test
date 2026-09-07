/* ============================================================================
   NAFUME — Email Capture Popup
   ----------------------------------------------------------------------------
   Offers 10% off a first order in exchange for an email, then stores the
   visitor as a LEAD (never as a customer or an order) via /api/leads/subscribe.

   TRIGGERS  (whichever happens first)
     desktop  exit intent — the pointer leaves through the top of the viewport
     any device  scrolling past 50% of the page
     A short dwell time must also have passed, so the popup never ambushes
     someone in the first seconds of their visit.

   FREQUENCY
     Shown at most once per visitor per SUPPRESS_DAYS, tracked in localStorage
     with a cookie fallback for browsers where storage is unavailable. Dismissing
     it, subscribing, or already being a customer all suppress it.

   NEVER SHOWN
     on checkout, account, confirmation or review pages (interrupting someone
     mid-purchase to sell them a discount is a good way to lose the purchase),
     or to a visitor who already has an order/session.

   ACCESSIBILITY
     role="dialog" + aria-modal, focus moved into the dialog and restored on
     close, Escape closes, focus is trapped while open, and the whole thing is
     keyboard operable.
   ========================================================================== */
(function (global) {
  "use strict";

  var STORAGE_KEY   = "nafume_lead_popup_state";
  var COOKIE_NAME   = "nf_lead_popup";
  var SUPPRESS_DAYS = 30;          // after dismissing
  var SUBSCRIBED_DAYS = 365;       // after subscribing
  var MIN_DWELL_MS  = 15000;       // don't interrupt the first 15 seconds
  var SCROLL_TRIGGER = 0.5;        // 50% of the page

  // Paths where a popup would be an interruption rather than an offer.
  var BLOCKED = ["/pages/order/", "/pages/account/", "/checkout", "/admin/"];

  var state = { shown: false, dialog: null, lastFocus: null, armed: false };

  /* ── persistence (never throws) ───────────────────────────────────────── */

  function readState() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    // Cookie fallback for private mode / storage disabled.
    var m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]*)"));
    if (m) { try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) {} }
    return null;
  }

  function writeState(value, days) {
    var payload = JSON.stringify(value);
    try { global.localStorage.setItem(STORAGE_KEY, payload); } catch (e) {}
    try {
      var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
      document.cookie = COOKIE_NAME + "=" + encodeURIComponent(payload) +
        "; expires=" + expires + "; path=/; SameSite=Lax";
    } catch (e) {}
  }

  function suppressedUntil() {
    var s = readState();
    if (!s || !s.until) return 0;
    return new Date(s.until).getTime() || 0;
  }

  function suppress(reason, days) {
    writeState({
      reason: reason,
      until:  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    }, days);
  }

  /* ── eligibility ──────────────────────────────────────────────────────── */

  function pathBlocked() {
    var path = (global.location.pathname || "").toLowerCase();
    return BLOCKED.some(function (p) { return path.indexOf(p) !== -1; });
  }

  function hasExistingRelationship() {
    // Someone who has already ordered doesn't need a first-order discount.
    try {
      var orders = JSON.parse(global.localStorage.getItem("nafume_orders_v2") || "[]");
      if (Array.isArray(orders) && orders.length) return true;
    } catch (e) {}
    return false;
  }

  function shouldConsider() {
    if (state.shown) return false;
    if (pathBlocked()) return false;
    if (Date.now() < suppressedUntil()) return false;
    if (hasExistingRelationship()) return false;
    if (!global.NafumeAPI) return false;
    return true;
  }

  /* ── markup ───────────────────────────────────────────────────────────── */

  function buildDialog() {
    var wrap = document.createElement("div");
    wrap.className = "nf-lead-popup";
    wrap.id = "nf-lead-popup";
    wrap.innerHTML =
      '<div class="nf-lead-overlay" data-close="1"></div>' +
      '<div class="nf-lead-card" role="dialog" aria-modal="true" aria-labelledby="nf-lead-title" tabindex="-1">' +
        '<button type="button" class="nf-lead-close" data-close="1" aria-label="Close">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="nf-lead-body" id="nf-lead-body">' +
          '<p class="nf-lead-eyebrow">NAFUME</p>' +
          '<h2 class="nf-lead-title" id="nf-lead-title">Take 10% off your first order</h2>' +
          '<p class="nf-lead-sub">Join the list for early access to new launches and a code for 10% off your first NAFUME fragrance.</p>' +
          '<form class="nf-lead-form" id="nf-lead-form" novalidate>' +
            '<label class="nf-lead-label" for="nf-lead-email">Email address</label>' +
            '<input class="nf-lead-input" id="nf-lead-email" name="email" type="email" ' +
              'inputmode="email" autocomplete="email" placeholder="your@email.com" required/>' +
            '<p class="nf-lead-error" id="nf-lead-error" role="alert"></p>' +
            '<button class="nf-lead-submit" id="nf-lead-submit" type="submit">Get my code</button>' +
          '</form>' +
          '<button type="button" class="nf-lead-decline" data-close="1">No thanks, I\'ll pay full price</button>' +
          '<p class="nf-lead-fineprint">One email, no spam. Unsubscribe any time.</p>' +
        '</div>' +
      '</div>';
    return wrap;
  }

  function successMarkup(discount, emailed) {
    return '<p class="nf-lead-eyebrow">Welcome to NAFUME</p>' +
      '<h2 class="nf-lead-title" id="nf-lead-title">Here\'s your code</h2>' +
      '<p class="nf-lead-sub">Use it at checkout on your first order.</p>' +
      '<div class="nf-lead-code" id="nf-lead-code">' +
        '<span class="nf-lead-code-value">' + escapeHtml(discount.code) + '</span>' +
        '<button type="button" class="nf-lead-copy" id="nf-lead-copy">Copy</button>' +
      '</div>' +
      '<p class="nf-lead-terms">' + escapeHtml(discount.terms || "") + '</p>' +
      (emailed
        ? '<p class="nf-lead-fineprint">We\'ve emailed it to you as well.</p>'
        : '<p class="nf-lead-fineprint">Save this code now — it\'s shown here only.</p>') +
      '<a class="nf-lead-shop" href="/pages/collections/shop.html">Shop new launches</a>';
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  /* ── focus management ─────────────────────────────────────────────────── */

  function focusables(root) {
    return Array.prototype.slice.call(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null; });
  }

  function trapFocus(e) {
    if (e.key !== "Tab" || !state.dialog) return;
    var card = state.dialog.querySelector(".nf-lead-card");
    var list = focusables(card);
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function onKeydown(e) {
    if (e.key === "Escape") { close("dismissed"); return; }
    trapFocus(e);
  }

  /* ── open / close ─────────────────────────────────────────────────────── */

  function open(trigger) {
    if (!shouldConsider()) return;
    state.shown = true;
    state.lastFocus = document.activeElement;

    state.dialog = buildDialog();
    state.dialog.dataset.trigger = trigger;
    document.body.appendChild(state.dialog);
    // Next frame so the CSS transition actually runs.
    requestAnimationFrame(function () { state.dialog.classList.add("is-open"); });
    document.body.classList.add("nf-lead-open");

    state.dialog.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) close("dismissed");
    });
    document.addEventListener("keydown", onKeydown);

    var form = state.dialog.querySelector("#nf-lead-form");
    if (form) form.addEventListener("submit", submit);

    var card = state.dialog.querySelector(".nf-lead-card");
    if (card) card.focus();

    try {
      if (global.OperationsService) {
        global.OperationsService.recordAnalyticsEvent("lead_popup_shown", { trigger: trigger });
      }
    } catch (e) {}
  }

  function close(reason) {
    if (!state.dialog) return;
    if (reason === "dismissed") suppress("dismissed", SUPPRESS_DAYS);

    document.removeEventListener("keydown", onKeydown);
    document.body.classList.remove("nf-lead-open");
    state.dialog.classList.remove("is-open");

    var node = state.dialog;
    state.dialog = null;
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 250);

    if (state.lastFocus && state.lastFocus.focus) {
      try { state.lastFocus.focus(); } catch (e) {}
    }
  }

  /* ── submit ───────────────────────────────────────────────────────────── */

  function submit(e) {
    e.preventDefault();
    var input  = document.getElementById("nf-lead-email");
    var button = document.getElementById("nf-lead-submit");
    var error  = document.getElementById("nf-lead-error");
    if (!input || !button) return;

    var email = (input.value || "").trim();
    error.textContent = "";
    input.classList.remove("has-error");

    if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) {
      input.classList.add("has-error");
      error.textContent = "Please enter a valid email address.";
      input.focus();
      return;
    }

    button.disabled = true;
    button.textContent = "Getting your code…";

    global.NafumeAPI.subscribeLead(email, {
      trigger: state.dialog ? state.dialog.dataset.trigger : "unknown",
      page: (global.location.pathname || "").slice(0, 120)
    }).then(function (res) {
      button.disabled = false;
      button.textContent = "Get my code";

      if (!res.ok) {
        input.classList.add("has-error");
        error.textContent = res.message || "We couldn't save that right now. Please try again.";
        return;
      }

      // Subscribed (or already subscribed) — either way, don't ask again.
      suppress("subscribed", SUBSCRIBED_DAYS);

      var body = document.getElementById("nf-lead-body");
      if (body) {
        body.innerHTML = successMarkup(res.data.discount, res.data.emailed);
        var copyBtn = document.getElementById("nf-lead-copy");
        if (copyBtn) {
          copyBtn.addEventListener("click", function () {
            var code = res.data.discount.code;
            var done = function () {
              copyBtn.textContent = "Copied";
              setTimeout(function () { copyBtn.textContent = "Copy"; }, 2000);
            };
            if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
              global.navigator.clipboard.writeText(code).then(done, done);
            } else {
              // Older mobile browsers: select the text so it can be copied by hand.
              var range = document.createRange();
              range.selectNodeContents(document.querySelector(".nf-lead-code-value"));
              var sel = global.getSelection();
              sel.removeAllRanges(); sel.addRange(range);
              done();
            }
          });
        }
        var card = state.dialog && state.dialog.querySelector(".nf-lead-card");
        if (card) card.focus();
      }

      try {
        if (global.OperationsService) {
          global.OperationsService.recordAnalyticsEvent("lead_captured",
            { alreadySubscribed: res.data.alreadySubscribed === true });
        }
      } catch (e2) {}
    });
  }

  /* ── triggers ─────────────────────────────────────────────────────────── */

  function armTriggers() {
    if (state.armed || !shouldConsider()) return;
    state.armed = true;

    var dwellPassed = false;
    setTimeout(function () { dwellPassed = true; }, MIN_DWELL_MS);

    // Exit intent — pointer devices only. `relatedTarget` null + leaving through
    // the top edge is the signal that they're heading for the tab bar.
    function onMouseOut(e) {
      if (!dwellPassed) return;
      if (e.relatedTarget || e.toElement) return;
      if (e.clientY > 8) return;
      cleanup();
      open("exit_intent");
    }

    // Scroll depth — works everywhere, and is the only trigger on touch devices.
    var scrollTicking = false;
    function onScroll() {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(function () {
        scrollTicking = false;
        if (!dwellPassed) return;
        var doc = document.documentElement;
        var scrollable = doc.scrollHeight - global.innerHeight;
        if (scrollable <= 0) return;
        if ((global.scrollY || doc.scrollTop) / scrollable >= SCROLL_TRIGGER) {
          cleanup();
          open("scroll");
        }
      });
    }

    function cleanup() {
      document.removeEventListener("mouseout", onMouseOut);
      global.removeEventListener("scroll", onScroll);
    }

    var finePointer = global.matchMedia && global.matchMedia("(pointer: fine)").matches;
    if (finePointer) document.addEventListener("mouseout", onMouseOut);
    global.addEventListener("scroll", onScroll, { passive: true });
  }

  /* Manual trigger for a footer/nav "get 10% off" link. */
  function openManually() {
    // An explicit request overrides the frequency cap — they asked for it.
    state.shown = false;
    if (pathBlocked()) return;
    var saved = readState();
    try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    open("manual");
    if (saved && saved.reason === "subscribed") writeState(saved, SUBSCRIBED_DAYS);
  }

  global.NafumeLeadPopup = { open: openManually, close: close, isSuppressed: function () {
    return Date.now() < suppressedUntil();
  } };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", armTriggers);
  } else {
    armTriggers();
  }
})(window);
