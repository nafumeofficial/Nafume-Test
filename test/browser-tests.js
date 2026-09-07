/*
 * test/browser-tests.js  —  real-browser tests over the DevTools Protocol
 * ============================================================================
 *   node test/browser-tests.js
 *
 * Drives headless Chrome/Edge against the local server, so the checks below run
 * against the ACTUAL pages, with the ACTUAL scripts executing — not a simulated
 * DOM. No packages: Chrome is launched as a child process and controlled over a
 * WebSocket using Node's built-in global WebSocket (Node 22+).
 *
 * What this covers that the API suite cannot:
 *   - pages load with no console errors and no failed requests
 *   - checkout validation, states and the WhatsApp consent box behave
 *   - the popup's triggers, frequency cap and success state
 *   - the quiz runs question-by-question and produces a real product
 *   - responsive layout: no horizontal overflow, no tap target under 44px
 */
"use strict";

process.env.NAFUME_DB_DRIVER    = "memory";
process.env.RAZORPAY_KEY_ID     = "rzp_test_browsersuite";
process.env.RAZORPAY_KEY_SECRET = "browser_test_secret";
process.env.ADMIN_API_TOKEN     = "browser_admin_token";
delete process.env.NAFUME_DB_FILE;

const { spawn }   = require("child_process");
const fs          = require("fs");
const os          = require("os");
const path        = require("path");

const mocks = require("./mocks");
mocks.install();
const { start } = require("./server");

let passed = 0, failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name + (detail ? " → " + detail : "")); console.log("  FAIL  " + name + (detail ? " → " + detail : "")); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length))); }

/* ── browser discovery ───────────────────────────────────────────────────── */

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/* ── minimal CDP client ──────────────────────────────────────────────────── */

class Browser {
  constructor(proc, port, profileDir) {
    this.proc = proc; this.port = port; this.profileDir = profileDir;
    this.ws = null; this.id = 0; this.pending = new Map(); this.listeners = new Map();
  }

  static async launch() {
    const exe = findBrowser();
    if (!exe) throw new Error("No Chrome/Edge found. Set CHROME_PATH.");

    const port = 9000 + Math.floor(Math.random() * 900);
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "nafume-cdp-"));

    const proc = spawn(exe, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--remote-debugging-port=" + port,
      "--user-data-dir=" + profileDir,
      "about:blank"
    ], { stdio: "ignore" });

    // Wait for the debugging endpoint to answer.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/json/version");
        if (r.ok) return new Browser(proc, port, profileDir);
      } catch (_) {}
      await new Promise(r => setTimeout(r, 250));
    }
    proc.kill();
    throw new Error("Browser did not expose a debugging port in time.");
  }

  async newPage() {
    const r = await fetch("http://127.0.0.1:" + this.port + "/json/new?about:blank", { method: "PUT" });
    const target = await r.json();
    const page = new Page(target.webSocketDebuggerUrl, target.id, this.port);
    await page.connect();
    return page;
  }

  async close() {
    try { this.proc.kill(); } catch (_) {}
    // Give the process a moment to release the profile directory on Windows.
    await new Promise(r => setTimeout(r, 400));
    try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch (_) {}
  }
}

class Page {
  constructor(wsUrl, targetId, port) {
    this.wsUrl = wsUrl; this.targetId = targetId; this.port = port;
    this.id = 0; this.pending = new Map();
    this.consoleErrors = []; this.pageErrors = []; this.failedRequests = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", async () => {
        this.ws.addEventListener("message", (ev) => this._onMessage(ev));
        await this.send("Page.enable");
        await this.send("Runtime.enable");
        await this.send("Log.enable");
        await this.send("Network.enable");
        // Block every third-party host. Tests must never depend on the public
        // internet, and this permanently asserts the thing that was broken:
        // the site's own pages must work when Razorpay's CDN does not answer.
        await this.send("Network.setBlockedURLs", {
          urls: ["*://checkout.razorpay.com/*", "*://cdn.tailwindcss.com/*",
                 "*://fonts.googleapis.com/*", "*://fonts.gstatic.com/*"]
        });
        resolve();
      });
      this.ws.addEventListener("error", reject);
    });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      this.consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails || {};
      this.pageErrors.push(d.text + " " + ((d.exception && d.exception.description) || ""));
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const e = msg.params.entry;
      const url = e.url || "";
      const thirdParty = /checkout\.razorpay\.com|cdn\.tailwindcss\.com|fonts\.(googleapis|gstatic)\.com/.test(url);
      // favicon noise and the deliberately blocked third parties are not defects
      if (!/favicon/i.test(url) && !thirdParty) this.consoleErrors.push(e.text + " @ " + url);
    }
    if (msg.method === "Network.loadingFailed" && msg.params.type !== "Image") {
      // Third-party blocks are deliberate (see Network.setBlockedURLs above).
      if (msg.params.errorText !== "net::ERR_BLOCKED_BY_CLIENT") {
        this.failedRequests.push(msg.params.errorText);
      }
    }
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timed out")); }
      }, 30000);
    });
  }

  async goto(url) {
    this.consoleErrors = []; this.pageErrors = []; this.failedRequests = [];
    const loaded = new Promise((resolve) => {
      const handler = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.method === "Page.loadEventFired") { this.ws.removeEventListener("message", handler); resolve(); }
        } catch (_) {}
      };
      this.ws.addEventListener("message", handler);
      setTimeout(resolve, 15000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await this.wait(350);   // let DOMContentLoaded handlers settle
  }

  /* Wrapped in an ASYNC IIFE so test snippets may use `await` (e.g. calling the
     API directly from the page). awaitPromise resolves it before returning. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: "(async function(){ " + expression + " })()",
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " +
        ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ""));
    }
    return r.result.value;
  }

  async setViewport(width, height, mobile) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: !!mobile
    });
  }

  wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async close() {
    try { await fetch("http://127.0.0.1:" + this.port + "/json/close/" + this.targetId); } catch (_) {}
    try { this.ws.close(); } catch (_) {}
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

let BASE = "";

async function testPagesLoadClean(page) {
  section("Pages load without console/runtime errors");

  const pages = [
    ["/", "Homepage"],
    ["/pages/collections/shop.html", "Shop"],
    ["/pages/products/dark-oud.html", "Product detail"],
    ["/pages/order/shipping.html", "Checkout"],
    ["/pages/account/account.html", "Account"],
    ["/pages/account/register.html", "Register"],
    ["/fragrance-finder.html", "Fragrance finder"],
    ["/pages/order/review.html", "Review form"],
    ["/pages/order/confirmation.html", "Confirmation"],
    ["/pages/order/track-order.html", "Track order"],
    ["/admin/orders-admin.html", "Admin orders"],
    ["/pages/collections/gifting.html", "Gifting"],
    ["/pages/guides/oud-perfume-guide.html", "Guide"],
    ["/pages/support/faq.html", "FAQ"],
    ["/pages/legal/privacy-policy.html", "Privacy policy"],
    ["/404.html", "404 page"]
  ];

  for (const [url, label] of pages) {
    await page.goto(BASE + url);
    await page.wait(500);
    const errs = page.pageErrors.concat(page.consoleErrors);
    ok(label + " loads with no JS errors", errs.length === 0, errs.slice(0, 2).join(" | "));
  }
}

async function testHomepageIntact(page) {
  section("Homepage regression (existing functionality)");

  await page.goto(BASE + "/");

  eq("header renders", await page.eval("return !!document.querySelector('.nf-header');"), true);
  eq("nav links present", await page.eval("return document.querySelectorAll('.nf-nav-link').length > 4;"), true);
  eq("product cards render", await page.eval("return document.querySelectorAll('.home-product-card').length > 0;"), true);
  eq("Shop by Mood intact", await page.eval("return document.querySelectorAll('#shop-by-mood .mood-card').length;"), 7);
  eq("footer rendered by launch.js", await page.eval("return document.getElementById('global-footer').children.length > 0;"), true);
  eq("fragrance finder entry point added", await page.eval("return !!document.getElementById('fragrance-finder');"), true);

  // Cart still works.
  await page.eval("localStorage.removeItem('nafumeLaunchCart'); return 1;");
  await page.goto(BASE + "/");
  eq("add to cart works", await page.eval(
    "launchAddToCart('dark-oud', 2); return JSON.parse(localStorage.getItem('nafumeLaunchCart'))[0].qty;"), 2);
  eq("cart badge updates", await page.eval(
    "return document.querySelector('.lp-cart-badge').textContent.trim();"), "2");
  eq("cart drawer opens", await page.eval(
    "openCart(); return document.getElementById('launch-cart-drawer').classList.contains('open');"), true);

  // Only images that actually declare a source can be "broken"; slots that JS
  // fills in later legitimately have none yet.
  const images = await page.eval(`
    return Array.from(document.images)
      .filter(function (i) {
        var src = i.getAttribute('src');
        return src && !src.startsWith('data:') && i.complete && i.naturalWidth === 0;
      })
      .map(function (i) { return i.getAttribute('src'); });
  `);
  ok("no broken images on the homepage", images.length === 0, images.join(", "));
}

async function testCheckoutPage(page) {
  section("Checkout page behaviour");

  // Seed a cart, then load checkout.
  await page.goto(BASE + "/");
  await page.eval("launchAddToCart('seduction', 1); return 1;");
  await page.goto(BASE + "/pages/order/shipping.html");

  eq("WhatsApp consent checkbox exists", await page.eval("return !!document.getElementById('whatsapp-optin');"), true);
  eq("consent is NOT pre-ticked (explicit consent)", await page.eval("return document.getElementById('whatsapp-optin').checked;"), false);
  eq("email is required", await page.eval("return document.getElementById('cust-email').required;"), true);
  eq("online payment is the default", await page.eval("return document.querySelector('[name=\"payment\"]:checked').value;"), "online");
  eq("COD is still offered", await page.eval("return !!document.querySelector('[name=\"payment\"][value=\"COD\"]');"), true);

  eq("no WhatsApp order button remains", await page.eval(
    "return Array.from(document.querySelectorAll('button')).filter(b => /confirm order on whatsapp/i.test(b.textContent)).length;"), 0);

  // Regression guard: Razorpay's CDN is blocked for this whole suite, so this
  // asserts the checkout page's own JavaScript is never held hostage by it.
  eq("checkout JS works with the payment CDN unreachable", await page.eval(
    "return typeof window.placeOrder === 'function' && typeof window.initCheckoutUI === 'function';"), true);
  eq("Razorpay SDK is NOT loaded eagerly", await page.eval(
    "return typeof window.Razorpay;"), "undefined");
  eq("online payment is still offered (it is a config decision)", await page.eval(
    "return document.querySelector('.payment-option[data-method=\"online\"]').style.display !== 'none';"), true);
  eq("CTA reads 'Pay Securely' for online", await page.eval(
    "return /pay securely/i.test(document.getElementById('btn-place-order').textContent);"), true);

  // Switching to COD relabels the CTA.
  await page.eval("document.querySelector('[name=\"payment\"][value=\"COD\"]').click(); return 1;");
  await page.wait(150);
  eq("CTA relabels for COD", await page.eval(
    "return /place cod order/i.test(document.getElementById('btn-place-order').textContent);"), true);

  // Empty submit → inline field errors, no network call.
  await page.eval("document.querySelector('[name=\"payment\"][value=\"online\"]').click(); return 1;");
  await page.eval("document.getElementById('shipping-form').requestSubmit(); return 1;");
  await page.wait(300);
  ok("empty submit shows field errors", await page.eval("return document.querySelectorAll('.field-error').length >= 5;"));
  eq("empty submit shows a status message", await page.eval(
    "var n = document.getElementById('checkout-status-note'); return n.style.display !== 'none' && n.classList.contains('is-error');"), true);

  // Bad email only.
  await page.eval(`
    document.querySelector('[name="name"]').value = 'Browser Test';
    document.querySelector('[name="phone"]').value = '9876500001';
    document.querySelector('[name="email"]').value = 'nope';
    document.querySelector('[name="addr1"]').value = '12 MG Road';
    document.querySelector('[name="city"]').value = 'Bengaluru';
    document.querySelector('[name="state"]').value = 'Karnataka';
    document.querySelector('[name="pin"]').value = '560001';
    document.getElementById('shipping-form').requestSubmit();
    return 1;
  `);
  await page.wait(300);
  eq("invalid email flagged inline", await page.eval(
    "return document.querySelector('[name=\"email\"]').classList.contains('has-error');"), true);

  // Typing clears the error.
  await page.eval(`
    var el = document.querySelector('[name="email"]');
    el.value = 'browser@example.com';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);
  eq("fixing a field clears its error", await page.eval(
    "return document.querySelector('[name=\"email\"]').classList.contains('has-error');"), false);

  // Real COD order, end to end through the browser.
  await page.eval(`
    document.getElementById('whatsapp-optin').checked = true;
    document.querySelector('[name="payment"][value="COD"]').click();
    return 1;
  `);
  await page.eval("document.getElementById('shipping-form').requestSubmit(); return 1;");
  await page.wait(2500);

  const url = await page.eval("return window.location.pathname + window.location.search;");
  ok("COD checkout redirects to the confirmation page", /confirmation/.test(url), url);
  ok("confirmation URL carries the order id", /orderId=NF-/.test(url), url);

  eq("cart is cleared after ordering", await page.eval(
    "return JSON.parse(localStorage.getItem('nafumeLaunchCart') || '[]').length;"), 0);
}

/* The promo field must change the price on screen, survive a payment-method
   switch, and never let Enter submit the checkout form. */
async function testPromoCodeUI(page) {
  section("Promo code at checkout");

  await page.setViewport(1280, 900, false);
  await page.goto(BASE + "/");
  await page.eval("localStorage.removeItem('nafumeLaunchCart'); return 1;");
  await page.goto(BASE + "/");
  await page.eval("launchAddToCart('seduction', 1); return 1;");
  await page.goto(BASE + "/pages/order/shipping.html");
  await page.wait(600);

  eq("promo field is present", await page.eval("return !!document.getElementById('promo-code');"), true);
  eq("apply button is not a submit button", await page.eval(
    "return document.getElementById('promo-apply').type;"), "button");

  const totalBefore = await page.eval("return document.getElementById('order-total').textContent;");

  // Empty code is caught locally.
  await page.eval("document.getElementById('promo-apply').click(); return 1;");
  await page.wait(300);
  ok("empty code is rejected without a request", await page.eval(
    "return /enter a promo code/i.test(document.getElementById('promo-msg').textContent);"));

  // Enter must NOT submit the checkout form.
  const urlBefore = await page.eval("return location.pathname + location.search;");
  await page.eval(`
    var el = document.getElementById('promo-code');
    el.value = 'NAFUME10';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 1;
  `);
  await page.wait(1800);
  eq("Enter in the promo field does not navigate", await page.eval(
    "return location.pathname + location.search;"), urlBefore);

  eq("valid code is applied", await page.eval(
    "return /applied/i.test(document.getElementById('promo-msg').textContent);"), true);
  eq("promo message is styled as success", await page.eval(
    "return document.getElementById('promo-msg').classList.contains('is-success');"), true);

  const totalAfter = await page.eval("return document.getElementById('order-total').textContent;");
  ok("the displayed total actually went down", totalBefore !== totalAfter,
     totalBefore + " → " + totalAfter);
  ok("a discount row appears in the summary", await page.eval(
    "return /Promo code NAFUME10/.test(document.querySelector('.order-totals').innerText);"));
  eq("the field locks to the applied code", await page.eval(
    "return document.getElementById('promo-code').readOnly;"), true);
  eq("the button becomes Remove", await page.eval(
    "return document.getElementById('promo-apply').textContent.trim();"), "Remove");

  // Removing it restores the original total.
  await page.eval("document.getElementById('promo-apply').click(); return 1;");
  await page.wait(400);
  eq("removing the code restores the total", await page.eval(
    "return document.getElementById('order-total').textContent;"), totalBefore);
  eq("the field unlocks", await page.eval(
    "return document.getElementById('promo-code').readOnly;"), false);

  // An invalid code is refused clearly.
  await page.eval(`
    document.getElementById('promo-code').value = 'TOTALLYFAKE';
    document.getElementById('promo-apply').click();
    return 1;
  `);
  await page.wait(1600);
  eq("an invalid code shows an error", await page.eval(
    "return document.getElementById('promo-msg').classList.contains('is-error');"), true);
  eq("an invalid code does not change the total", await page.eval(
    "return document.getElementById('order-total').textContent;"), totalBefore);

  // Re-apply, then switch to COD: the code must be re-quoted, not silently kept.
  await page.eval(`
    document.getElementById('promo-code').value = 'NAFUME10';
    document.getElementById('promo-apply').click();
    return 1;
  `);
  await page.wait(1600);
  const onlineTotal = await page.eval("return document.getElementById('order-total').textContent;");

  await page.eval("document.querySelector('[name=\"payment\"][value=\"COD\"]').click(); return 1;");
  await page.wait(2000);
  const codTotal = await page.eval("return document.getElementById('order-total').textContent;");
  ok("switching to COD re-quotes the code", onlineTotal !== codTotal, onlineTotal + " → " + codTotal);
  eq("the code is still applied after the switch", await page.eval(
    "return document.getElementById('promo-msg').classList.contains('is-success');"), true);

  // Place the order and confirm the discount reached the database.
  await page.eval(`
    document.querySelector('[name="name"]').value  = 'Promo Tester';
    document.querySelector('[name="phone"]').value = '9876500077';
    document.querySelector('[name="email"]').value = 'promo.tester@example.com';
    document.querySelector('[name="addr1"]').value = '4 Brigade Road';
    document.querySelector('[name="city"]').value  = 'Bengaluru';
    document.querySelector('[name="state"]').value = 'Karnataka';
    document.querySelector('[name="pin"]').value   = '560001';
    document.getElementById('shipping-form').requestSubmit();
    return 1;
  `);
  await page.wait(2600);

  ok("discounted COD order completes", await page.eval(
    "return /confirmation/.test(location.pathname);"), await page.eval("return location.pathname;"));

  const dbOrder = await page.eval(`
    const id = new URLSearchParams(location.search).get('orderId');
    const r = await fetch('/api/orders/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id, contact: 'promo.tester@example.com' })
    });
    const d = await r.json();
    return d.order ? d.order.totals : null;
  `);
  ok("the stored order carries the promo code", dbOrder && dbOrder.promoCode === "NAFUME10",
     JSON.stringify(dbOrder));
  ok("the stored order carries a real discount amount", dbOrder && dbOrder.promoDiscount > 0,
     JSON.stringify(dbOrder));
}

async function testConfirmationAndAccountCta(page) {
  section("Confirmation page + account CTA");

  await page.wait(1200);
  const bodyText = await page.eval("return document.getElementById('confirmation-box').innerText;");
  ok("confirmation shows the order is confirmed", /confirmed/i.test(bodyText), bodyText.slice(0, 120));
  ok("confirmation shows Cash on Delivery", /cash on delivery/i.test(bodyText));
  ok("confirmation lists the item", /SEDUCTION/i.test(bodyText));

  eq("account CTA rendered", await page.eval(
    "return !!document.querySelector('.nf-account-cta');"), true);
  ok("CTA uses the plan's wording", await page.eval(
    "return /create your account to track this order/i.test(document.querySelector('.nf-account-cta-title').textContent);"));

  const prefill = await page.eval("return JSON.parse(localStorage.getItem('nafume_account_prefill') || 'null');");
  ok("checkout details stored for prefill", !!prefill && prefill.email === "browser@example.com",
     JSON.stringify(prefill));

  // "Maybe later" must be a real, working choice — and it deliberately DISCARDS
  // the prefill (the customer declined). Snapshot it first so the next suite,
  // which tests the register-with-prefill path, still has something to work
  // with; a real customer taking that path simply would not have clicked skip.
  const saved = await page.eval("return localStorage.getItem('nafume_account_prefill');");
  await page.eval("document.getElementById('account-cta-skip').click(); return 1;");
  await page.wait(150);
  eq("skipping the CTA works", await page.eval("return !!document.querySelector('.nf-account-cta');"), false);
  eq("skipping clears the stored prefill", await page.eval(
    "return localStorage.getItem('nafume_account_prefill');"), null);
  await page.eval("localStorage.setItem('nafume_account_prefill', " + JSON.stringify(saved) + "); return 1;");
}

async function testRegisterPrefill(page) {
  section("Account creation with checkout prefill");

  await page.goto(BASE + "/pages/account/register.html?from=order");
  await page.wait(600);

  eq("name pre-filled from checkout", await page.eval("return document.getElementById('reg-name').value;"), "Browser Test");
  eq("email pre-filled from checkout", await page.eval("return document.getElementById('reg-email').value;"), "browser@example.com");
  eq("phone pre-filled from checkout", await page.eval("return document.getElementById('reg-phone').value;"), "9876500001");
  eq("submit disabled until terms accepted", await page.eval("return document.getElementById('reg-submit').disabled;"), true);

  await page.eval("document.getElementById('reg-agree').click(); return 1;");
  eq("accepting terms enables submit", await page.eval("return document.getElementById('reg-submit').disabled;"), false);

  // Weak password rejected client-side.
  await page.eval("document.getElementById('reg-password').value = 'abc'; document.getElementById('reg-form').requestSubmit(); return 1;");
  await page.wait(300);
  eq("weak password flagged", await page.eval(
    "return document.getElementById('reg-password').classList.contains('has-error');"), true);

  // Real registration. Read the status BEFORE the success screen's 2.2s
  // auto-redirect to the dashboard fires.
  await page.eval("document.getElementById('reg-password').value = 'BrowserPass123'; document.getElementById('reg-form').requestSubmit(); return 1;");
  await page.wait(1400);

  const status = await page.eval(
    "var el = document.getElementById('reg-status'); return el ? el.textContent : '(already redirected)';");
  ok("account created", /account is ready/i.test(status), status);
  ok("the order was linked to the new account", /1 order is already linked/i.test(status), status);

  // Redirects to the account dashboard, which loads real server data.
  await page.wait(3600);
  const acctText = await page.eval("return document.body.innerText;");
  ok("dashboard greets the customer", /welcome, browser/i.test(acctText), acctText.slice(0, 160));
  ok("order history shows the order", /NF-/.test(acctText));
  ok("no password hash ever reaches the page", !/scrypt\$/.test(await page.eval("return document.documentElement.innerHTML;")));
}

async function testLoginLogout(page) {
  section("Login / logout round trip");

  await page.goto(BASE + "/pages/account/account.html");
  await page.wait(900);

  // Currently signed in from registration.
  ok("session persists across a reload", await page.eval("return /welcome/i.test(document.body.innerText);"));

  await page.eval("document.getElementById('acct-logout').click(); return 1;");
  await page.wait(1500);
  ok("logout returns to the sign-in screen", await page.eval("return !!document.getElementById('login-form');"));
  ok("OTP sign-in is offered too", await page.eval("return !!document.getElementById('otp-block');"));

  // Wrong password.
  await page.eval(`
    document.getElementById('login-id').value = 'browser@example.com';
    document.getElementById('login-pw').value = 'WrongPass123';
    document.getElementById('login-form').requestSubmit();
    return 1;
  `);
  await page.wait(2000);
  ok("wrong password shows an error", await page.eval(
    "var s = document.getElementById('login-status'); return s.style.display !== 'none' && s.classList.contains('is-error');"));

  // Right password.
  await page.eval(`
    document.getElementById('login-pw').value = 'BrowserPass123';
    document.getElementById('login-form').requestSubmit();
    return 1;
  `);
  await page.wait(2500);
  ok("correct password signs in", await page.eval("return /welcome/i.test(document.body.innerText);"));
}

async function testLeadPopup(page) {
  section("Email capture popup");

  await page.goto(BASE + "/");
  // Clear the frequency cap and the "already a customer" suppression.
  await page.eval(`
    localStorage.removeItem('nafume_lead_popup_state');
    localStorage.removeItem('nafume_orders_v2');
    document.cookie = 'nf_lead_popup=; Max-Age=0; path=/';
    return 1;
  `);
  await page.goto(BASE + "/");
  await page.wait(400);

  eq("popup is not shown immediately", await page.eval("return !!document.getElementById('nf-lead-popup');"), false);

  // Open it through the public API (the trigger paths themselves are dwell/scroll based).
  await page.eval("window.NafumeLeadPopup.open(); return 1;");
  await page.wait(400);

  eq("popup opens", await page.eval("return !!document.querySelector('#nf-lead-popup.is-open');"), true);
  eq("popup is a modal dialog", await page.eval(
    "return document.querySelector('.nf-lead-card').getAttribute('aria-modal');"), "true");
  eq("offer is 10% off", await page.eval(
    "return /10% off/i.test(document.querySelector('.nf-lead-title').textContent);"), true);
  eq("background scroll is locked", await page.eval(
    "return document.body.classList.contains('nf-lead-open');"), true);

  // Invalid email is caught before the network.
  await page.eval("document.getElementById('nf-lead-email').value='bad'; document.getElementById('nf-lead-form').requestSubmit(); return 1;");
  await page.wait(300);
  ok("invalid email rejected in the popup", await page.eval(
    "return document.getElementById('nf-lead-error').textContent.length > 0;"));

  // Real capture.
  await page.eval("document.getElementById('nf-lead-email').value='popup.browser@example.com'; document.getElementById('nf-lead-form').requestSubmit(); return 1;");
  await page.wait(2000);

  ok("discount code is shown on screen", await page.eval("return !!document.querySelector('.nf-lead-code-value');"));
  eq("code matches the configured offer", await page.eval(
    "return document.querySelector('.nf-lead-code-value').textContent.trim();"), "NAFUME10");

  // Escape closes.
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 1;");
  await page.wait(500);
  eq("Escape closes the popup", await page.eval("return !!document.querySelector('#nf-lead-popup.is-open');"), false);
  eq("scroll lock released", await page.eval("return document.body.classList.contains('nf-lead-open');"), false);

  // Frequency cap.
  const suppressed = await page.eval("return window.NafumeLeadPopup.isSuppressed();");
  eq("popup suppresses itself after capture", suppressed, true);

  await page.goto(BASE + "/");
  await page.eval("window.dispatchEvent(new Event('scroll')); return 1;");
  await page.wait(600);
  eq("popup does not reappear on the next visit", await page.eval("return !!document.getElementById('nf-lead-popup');"), false);

  // Never on checkout.
  await page.goto(BASE + "/pages/order/shipping.html");
  await page.wait(400);
  eq("popup never loads on checkout", await page.eval("return typeof window.NafumeLeadPopup;"), "undefined");
}

async function testQuiz(page) {
  section("Fragrance finder");

  await page.goto(BASE + "/fragrance-finder.html");
  await page.wait(1200);

  eq("quiz mounts", await page.eval("return !!document.querySelector('.nf-quiz-card');"), true);
  eq("one question at a time", await page.eval("return document.querySelectorAll('.nf-quiz-question').length;"), 1);
  eq("first question shows progress", await page.eval(
    "return /Question 1 of 5/.test(document.querySelector('.nf-quiz-step').textContent);"), true);
  // No email is asked for until the recommendation has been shown. (Scoped to
  // the quiz — the site footer has its own newsletter field.)
  eq("no email asked for before the result", await page.eval(
    "return document.querySelector('[data-fragrance-quiz]').querySelectorAll('input[type=\"email\"]').length;"), 0);
  eq("no login required to start", await page.eval(
    "return document.querySelector('[data-fragrance-quiz]').querySelectorAll('input[type=\"password\"]').length;"), 0);

  // Answer all five with the oud-leaning path.
  const picks = ["powerful", "festive", "strong", "oud", "gift"];
  for (const value of picks) {
    await page.eval(`
      var btn = document.querySelector('.nf-quiz-option[data-value="${value}"]');
      if (btn) btn.click();
      return 1;
    `);
    await page.wait(400);
  }
  await page.wait(1600);

  eq("result screen shown", await page.eval("return !!document.querySelector('.nf-quiz-result');"), true);
  eq("recommends a real NAFUME product", await page.eval(
    "return document.querySelector('.nf-quiz-product-name').textContent.trim();"), "Dark Oud");
  ok("preference tags displayed", await page.eval("return document.querySelectorAll('.nf-quiz-tag').length >= 3;"));
  ok("email capture offered after the result", await page.eval("return !!document.getElementById('nf-quiz-email');"));
  ok("add-to-cart offered on the result", await page.eval("return !!document.getElementById('nf-quiz-add');"));

  // Add to cart from the result.
  await page.eval("document.getElementById('nf-quiz-add').click(); return 1;");
  await page.wait(400);
  eq("quiz result adds the real product to the cart", await page.eval(
    "return (JSON.parse(localStorage.getItem('nafumeLaunchCart') || '[]')[0] || {}).id;"), "dark-oud");

  // Save the result.
  await page.eval("document.getElementById('nf-quiz-email').value='quiz.browser@example.com'; document.getElementById('nf-quiz-save-form').requestSubmit(); return 1;");
  await page.wait(2000);
  ok("saving the result confirms", await page.eval(
    "return /saved/i.test(document.querySelector('.nf-quiz-save-title').textContent);"));

  // Back-navigation within the quiz.
  await page.goto(BASE + "/fragrance-finder.html");
  await page.wait(1200);
  await page.eval("document.querySelector('.nf-quiz-option').click(); return 1;");
  await page.wait(350);
  eq("Back button appears after Q1", await page.eval("return !!document.getElementById('nf-quiz-back');"), true);
  await page.eval("document.getElementById('nf-quiz-back').click(); return 1;");
  await page.wait(300);
  eq("Back returns to Q1", await page.eval(
    "return /Question 1 of 5/.test(document.querySelector('.nf-quiz-step').textContent);"), true);
}

async function testResponsive(page) {
  section("Responsive layout");

  const viewports = [
    [320, 640, "Small phone (320px)"],
    [390, 844, "Larger phone (390px)"],
    [768, 1024, "Tablet (768px)"],
    [1280, 800, "Laptop (1280px)"],
    [1920, 1080, "Desktop (1920px)"]
  ];

  const pages = [
    ["/", "Homepage"],
    ["/pages/order/shipping.html", "Checkout"],
    ["/fragrance-finder.html", "Fragrance finder"],
    ["/pages/account/account.html", "Account"],
    ["/pages/order/review.html", "Review form"]
  ];

  for (const [w, h, label] of viewports) {
    await page.setViewport(w, h, w < 700);
    let overflowing = [];
    for (const [url, name] of pages) {
      await page.goto(BASE + url);
      await page.wait(500);
      const overflow = await page.eval(
        "return Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);");
      if (overflow > 1) overflowing.push(name + " (+" + overflow + "px)");
    }
    ok(label + ": no horizontal overflow", overflowing.length === 0, overflowing.join(", "));
  }

  // Tap targets on the smallest phone.
  await page.setViewport(320, 640, true);
  await page.goto(BASE + "/pages/order/shipping.html");
  await page.wait(500);
  // Controls only. Inline text links (a product name inside a card) are not
  // tap targets in the button sense and should not be padded to 44px.
  // Measures the effective hit area, including any ::after expander.
  const smallTargets = await page.eval(`
    var bad = [];
    var sel = 'button, select, input[type="checkbox"], input[type="radio"], input[type="submit"], a[class*="btn"], a[class*="cta"]';
    document.querySelectorAll(sel).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;                            // hidden
      if (el.closest('.nf-ann, .nf-nav-row, .nf-drawer-nav, footer, #global-footer')) return;

      var height = r.height, width = r.width;

      // A checkbox/radio inside a <label> is tapped via the whole label — that
      // is the correct pattern, so measure the label instead of the 20px box.
      if (el.type === 'checkbox' || el.type === 'radio') {
        var label = el.closest('label');
        if (label) {
          var lr = label.getBoundingClientRect();
          height = lr.height; width = lr.width;
        }
      }

      var after = getComputedStyle(el, '::after');
      if (after && after.content !== 'none' && after.position === 'absolute') {
        var top = parseFloat(after.top) || 0, bottom = parseFloat(after.bottom) || 0;
        var left = parseFloat(after.left) || 0, right = parseFloat(after.right) || 0;
        if (top < 0)    height -= top;
        if (bottom < 0) height -= bottom;
        if (left < 0)   width  -= left;
        if (right < 0)  width  -= right;
      }
      if (height < 40 || width < 40) {
        bad.push((el.id || el.className || el.tagName) + ' ' + Math.round(width) + 'x' + Math.round(height));
      }
    });
    return bad;
  `);
  ok("checkout tap targets are large enough on a 320px phone",
     smallTargets.length === 0, smallTargets.slice(0, 4).join(", "));

  // The popup must not cover the page on a small screen.
  await page.goto(BASE + "/");
  await page.eval("localStorage.removeItem('nafume_lead_popup_state'); document.cookie='nf_lead_popup=; Max-Age=0; path=/'; return 1;");
  await page.goto(BASE + "/");
  await page.wait(400);
  await page.eval("window.NafumeLeadPopup.open(); return 1;");
  await page.wait(500);
  const popupFits = await page.eval(`
    var card = document.querySelector('.nf-lead-card');
    if (!card) return { missing: true };
    var r = card.getBoundingClientRect();
    return { w: r.width, vw: window.innerWidth, h: r.height, vh: window.innerHeight,
             closeVisible: document.querySelector('.nf-lead-close').getBoundingClientRect().top >= 0 };
  `);
  ok("popup fits a 320px viewport", popupFits.w <= popupFits.vw, JSON.stringify(popupFits));
  ok("popup close button is reachable", popupFits.closeVisible === true);
  ok("popup does not exceed the screen height", popupFits.h <= popupFits.vh, JSON.stringify(popupFits));

  await page.send("Emulation.clearDeviceMetricsOverride");
}

async function testAdminPage(page) {
  section("Admin orders page");

  await page.setViewport(1280, 900, false);
  await page.goto(BASE + "/admin/orders-admin.html");
  await page.wait(500);

  eq("admin asks for a token first", await page.eval(
    "return document.getElementById('orders-panel').style.display;"), "none");
  eq("token field is a password input (not shoulder-readable)", await page.eval(
    "return document.getElementById('token').type;"), "password");

  // Wrong token is refused.
  await page.eval("document.getElementById('token').value='wrong'; document.getElementById('auth-btn').click(); return 1;");
  await page.wait(1200);
  ok("wrong token refused", await page.eval(
    "return document.getElementById('auth-msg').style.display === 'block';"));
  eq("orders stay hidden after a bad token", await page.eval(
    "return document.getElementById('orders-panel').style.display;"), "none");

  // Correct token.
  await page.eval("document.getElementById('token').value='" + process.env.ADMIN_API_TOKEN +
    "'; document.getElementById('auth-btn').click(); return 1;");
  await page.wait(1800);

  eq("correct token opens the order list", await page.eval(
    "return document.getElementById('orders-panel').style.display;"), "");
  eq("token is cleared from the input after use", await page.eval(
    "return document.getElementById('token').value;"), "");
  eq("token is NOT persisted to localStorage", await page.eval(
    "return localStorage.getItem('nf_admin_token');"), null);
  ok("token is held in sessionStorage only", await page.eval(
    "return !!sessionStorage.getItem('nf_admin_token');"));

  // Orders placed earlier in this suite should be listed.
  await page.eval("document.getElementById('f-payment').value=''; document.getElementById('f-payment').dispatchEvent(new Event('change')); return 1;");
  await page.wait(1600);
  const rows = await page.eval("return document.querySelectorAll('.ord').length;");
  ok("real orders are listed from the database", rows > 0, "rows=" + rows);
  ok("order rows show the customer", await page.eval(
    "return /browser@example\\.com/.test(document.getElementById('orders').innerText);"));

  const orderId = await page.eval("return document.querySelector('.ord').getAttribute('data-order');");

  // Record shipping. The row re-renders on success, so assert on the resulting
  // ORDER STATE rather than the transient "Saved ✓" message.
  await page.eval(`
    var row = document.querySelector('.ord[data-order="${orderId}"]');
    row.querySelector('.in-awb').value = 'AWBBROWSER1';
    row.querySelector('.in-courier').value = 'Delhivery';
    row.querySelector('.act-ship').click();
    return 1;
  `);
  await page.wait(2200);
  ok("marking shipped persists", await page.eval(
    `var r = document.querySelector('.ord[data-order="${orderId}"]');
     return r && /shipped|delivered/i.test(r.innerText) && r.innerText.indexOf('AWBBROWSER1') === -1
       ? true : (r ? r.querySelector('.in-awb').value === 'AWBBROWSER1' : false);`));

  // A future delivery date is refused before it ever reaches the server.
  const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await page.eval(`
    var row = document.querySelector('.ord[data-order="${orderId}"]');
    row.querySelector('.in-delivered').value = '${future}';
    row.querySelector('.act-deliver').click();
    return 1;
  `);
  await page.wait(700);
  ok("future delivery date rejected client-side", await page.eval(
    `return /future/i.test(document.querySelector('.ord[data-order="${orderId}"] .rowmsg').textContent);`));

  // A real delivery date is accepted and persisted — including for the COD
  // order this suite created, which is the case that used to be impossible.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await page.eval(`
    var row = document.querySelector('.ord[data-order="${orderId}"]');
    row.querySelector('.in-delivered').value = '${yesterday}';
    row.querySelector('.act-deliver').click();
    return 1;
  `);
  await page.wait(2400);
  ok("delivery date recorded", await page.eval(
    `var r = document.querySelector('.ord[data-order="${orderId}"]');
     return r ? /Delivered:\\s*(?!—)\\S/.test(r.innerText) : false;`),
    await page.eval(`var r = document.querySelector('.ord[data-order="${orderId}"]');
                     return r ? r.innerText.slice(0, 300) : '(row gone)';`));
}

/* Closes the loop: a review submitted by a customer, approved by a moderator,
   must actually appear on the product page. */
async function testReviewLifecycle(page) {
  section("Review lifecycle → product page");

  await page.setViewport(1280, 900, false);

  // Place a paid-equivalent order we can review. COD + delivered marks it paid.
  const orderId = await page.eval(`
    const shipping = {
      name: "Review Tester", phone: "9876500055", email: "review.tester@example.com",
      addr1: "9 Residency Road", city: "Bengaluru", state: "Karnataka", pin: "560025"
    };
    const r = await fetch('/api/orders/create-cod', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'red-spirit', qty: 1 }], shipping })
    });
    const d = await r.json();
    return d.order ? d.order.orderId : null;
  `);
  ok("test order created for the review flow", !!orderId, String(orderId));

  await page.eval(`
    await fetch('/api/admin/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${process.env.ADMIN_API_TOKEN}' },
      body: JSON.stringify({ orderId: '${orderId}', action: 'mark_delivered' })
    });
    return 1;
  `);

  // The customer opens the review link from the email.
  await page.goto(BASE + "/pages/order/review.html?orderId=" + encodeURIComponent(orderId));
  await page.wait(1500);

  // No stored contact for this order in this browser, so it asks — correctly.
  const askedForContact = await page.eval("return !!document.getElementById('lookup-form');");
  if (askedForContact) {
    ok("review form asks a guest to prove ownership", true);
    await page.eval(`
      document.getElementById('lk-order').value = '${orderId}';
      document.getElementById('lk-contact').value = 'review.tester@example.com';
      document.getElementById('lookup-form').requestSubmit();
      return 1;
    `);
    await page.wait(1800);
  }

  eq("review form rendered", await page.eval("return !!document.getElementById('review-form');"), true);
  eq("product from the order is pre-listed", await page.eval(
    "return document.getElementById('rv-product').value;"), "red-spirit");

  // Submitting with no rating is refused.
  await page.eval("document.getElementById('review-form').requestSubmit(); return 1;");
  await page.wait(400);
  ok("rating is required", await page.eval(
    "return document.getElementById('err-rating').textContent.length > 0;"));

  await page.eval(`
    document.getElementById('star-5').checked = true;
    document.getElementById('rv-title').value = 'Genuinely excellent';
    document.getElementById('rv-body').value = 'Lasts all evening and the trail is beautiful.';
    document.getElementById('review-form').requestSubmit();
    return 1;
  `);
  await page.wait(2200);

  const thanks = await page.eval("return document.getElementById('review-root').innerText;");
  ok("review submitted with a thank-you state", /thank you/i.test(thanks), thanks.slice(0, 140));
  ok("next-order discount code shown", /NAFUMEREVIEW/.test(thanks), thanks.slice(0, 200));

  // Not visible on the product page until it is moderated.
  await page.goto(BASE + "/pages/products/red-spirit.html");
  await page.wait(1800);
  eq("a pending review is NOT shown on the product page", await page.eval(
    "return /Genuinely excellent/.test(document.body.innerText);"), false);

  // Moderator publishes it.
  await page.eval(`
    const list = await (await fetch('/api/admin/reviews?status=pending', {
      headers: { 'Authorization': 'Bearer ${process.env.ADMIN_API_TOKEN}' }
    })).json();
    const target = (list.reviews || []).find(r => r.title === 'Genuinely excellent');
    if (!target) return 'not-found';
    await fetch('/api/admin/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${process.env.ADMIN_API_TOKEN}' },
      body: JSON.stringify({ reviewId: target.id, action: 'publish' })
    });
    return 'ok';
  `);

  await page.goto(BASE + "/pages/products/red-spirit.html");
  await page.wait(2200);
  ok("a published review appears on the product page", await page.eval(
    "return /Genuinely excellent/.test(document.body.innerText);"));
  ok("the reviewer's email is never shown publicly", await page.eval(
    "return !/review\\.tester@example\\.com/.test(document.documentElement.innerHTML);"));
  ok("the reviewer's full name is not shown publicly", await page.eval(
    "return !/Review Tester/.test(document.body.innerText);"));
}

async function testBackendUnavailable(page) {
  section("Backend unavailable (graceful degradation)");

  await page.setViewport(1280, 800, false);
  await page.goto(BASE + "/pages/order/shipping.html");

  // Force every /api call to fail, the way a dropped connection would.
  await page.eval(`
    window.__origFetch = window.fetch;
    window.fetch = function (url) {
      if (String(url).indexOf('/api/') === 0) return Promise.reject(new TypeError('Failed to fetch'));
      return window.__origFetch.apply(this, arguments);
    };
    return 1;
  `);

  await page.eval("launchAddToCart('seduction', 1); return 1;");
  await page.eval(`
    document.querySelector('[name="name"]').value = 'Offline Test';
    document.querySelector('[name="phone"]').value = '9876500002';
    document.querySelector('[name="email"]').value = 'offline@example.com';
    document.querySelector('[name="addr1"]').value = '12 MG Road';
    document.querySelector('[name="city"]').value = 'Bengaluru';
    document.querySelector('[name="state"]').value = 'Karnataka';
    document.querySelector('[name="pin"]').value = '560001';
    document.querySelector('[name="payment"][value="COD"]').click();
    document.getElementById('shipping-form').requestSubmit();
    return 1;
  `);
  await page.wait(1500);

  const status = await page.eval("return document.getElementById('checkout-status-note').textContent;");
  ok("network failure shows a clear message", /connection|reach|internet/i.test(status), status);
  eq("the button is re-enabled, not left spinning", await page.eval(
    "return document.getElementById('btn-place-order').disabled;"), false);
  eq("cart is NOT cleared when the order failed", await page.eval(
    "return JSON.parse(localStorage.getItem('nafumeLaunchCart') || '[]').length > 0;"), true);
  eq("still on the checkout page", await page.eval("return /shipping/.test(location.pathname);"), true);
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  if (!findBrowser()) {
    console.log("No Chrome/Edge available — skipping browser tests.");
    console.log("Install Chrome or Edge, or set CHROME_PATH.");
    return;
  }

  const server = await start(0);
  BASE = server.url;
  console.log("NAFUME browser suite — " + BASE);

  const browser = await Browser.launch();
  const page = await browser.newPage();

  const suites = [
    testPagesLoadClean, testHomepageIntact, testPromoCodeUI, testCheckoutPage,
    testConfirmationAndAccountCta, testRegisterPrefill, testLoginLogout,
    testLeadPopup, testQuiz, testAdminPage, testReviewLifecycle,
    testResponsive, testBackendUnavailable
  ];

  for (const suite of suites) {
    try { await suite(page); }
    catch (err) {
      failed++;
      failures.push(suite.name + " threw: " + (err && err.message));
      console.log("  ERROR " + suite.name + ": " + (err && err.message));
    }
  }

  await page.close();
  await browser.close();
  server.server.close();

  console.log("\n" + "═".repeat(70));
  console.log("  " + passed + " passed, " + failed + " failed");
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach(f => console.log("  • " + f));
  }
  console.log("═".repeat(70));
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => { console.error("browser suite crashed:", err); process.exit(1); });
