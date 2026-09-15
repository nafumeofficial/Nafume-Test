# NAFUME Artisan Luxe — E-Commerce Website

Premium artisan perfume brand website. Static HTML/CSS/JS with **no build step and
no npm dependencies**, plus Vercel serverless functions in `api/` and a Postgres
database for customers and orders.

---

## Before it can take orders

> **Current launch status and the exact remaining steps are in
> [`NAFUME-READINESS-REPORT.md`](NAFUME-READINESS-REPORT.md).**

| Variable | Why | Where to get it |
|---|---|---|
| `SUPABASE_URL` | orders, customers, consent persist | supabase.com → Settings → API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side DB access — **never in frontend code** | same page (secret key) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | online payment | dashboard.razorpay.com → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | confirms captured payments when the browser never returns | Razorpay → Webhooks |
| `RESEND_API_KEY` + `CUSTOMER_EMAIL_FROM` | account verification codes, confirmations, review links | resend.com (verified domain) |
| `ADMIN_API_TOKEN` / `CRON_SECRET` / `SITE_URL` | delivery recording, scheduled jobs, email links | generate / your domain |

1. **New database:** run all of `db/schema.sql`. **Existing database:** back it
   up, then apply only the unapplied files in `db/migrations/` — never re-run
   the whole schema blindly.
2. Add the variables in Vercel → Settings → Environment Variables. Use a
   separate Supabase project and Razorpay **test** keys for Preview.
3. Redeploy, then run `node test/check-live-services.js --site https://<deployment>`.

See **`.env.example`** for every variable.

**Without the database configured, checkout returns a clear 503 rather than
silently losing orders — and the in-memory driver is refused on Vercel.**

---

## Order flow

```
product page → add to cart → /pages/order/shipping (checkout)
   │
   ├── Pay Online → /api/razorpay/create-order → Razorpay Checkout
   │                → /api/razorpay/verify-payment
   │                   signature ✓ + Razorpay says CAPTURED, same order/amount/currency
   │                     → paid (one conditional update, shared by every path)
   │                   authorized / lookup failed → awaiting_verification
   │                     ("We're confirming your payment. Please don't pay again…")
   │                → settled later by /api/razorpay/webhook (raw-body signature),
   │                  the confirmation page's status refresh, or reconciliation
   │
   └── Cash on Delivery → /api/orders/create-cod
   │
   ▼
/pages/order/confirmation → "Create your account to track this order"
   → /api/account/register (sends a code) → /api/account/verify (proves the email,
     then links only the orders placed with it)
```

Reviews open once a delivery is recorded, for the order's verified owner or
via the link in the review-request email (sent `REVIEW_REQUEST_DELAY_DAYS`
after delivery). `NAFUMEREVIEW` is redeemable only by the signed-in owner.

WhatsApp remains available for support and courtesy confirmation. It is no
longer where an order is created.

---

## Tests

Node 18+ (Node 22+ and Chrome/Edge for the browser suite). No install step.

```bash
node test/lint.js           # syntax, dead refs, secret scan
node test/run-tests.js      # 769 API checks, routed through api/index.js with
                            # Vercel's Node helpers emulated
NAFUME_TEST_ROUTER=direct node test/run-tests.js   # same suite, handlers directly
node test/browser-tests.js  # 165 checks in headless Chrome/Edge
NAFUME_DB_DRIVER=memory node test/server.js   # run the whole site locally
```

Those run against the memory driver with the external HTTP boundary
(Razorpay, Resend, MSG91) mocked — they prove the code's decisions, not the
live providers. Once you have real credentials, verify the live services with:

```bash
node test/check-live-services.js                        # Supabase (+ migration) + Razorpay
node test/check-live-services.js --email you@domain.com # one real email + its delivery event
node test/check-live-services.js --write-persistence-probe   # then redeploy and…
node test/check-live-services.js --verify-persistence <marker>
node test/check-live-services.js --site https://<deployment>  # read-only deployment checks
```

It creates only clearly-marked test data, never moves money, and never prints
a secret.

Check a running deployment at any time:

```bash
curl -s https://YOUR-DOMAIN/api/health -H "Authorization: Bearer $ADMIN_API_TOKEN" | jq
```

---

## Project Structure

```
/
├── index.html                  ← Home page (entry point)
├── 404.html                    ← Custom 404 page
├── robots.txt
├── sitemap.xml
├── .gitignore
├── .claudeignore
├── README.md
│
├── css/
│   └── launch.css              ← Primary stylesheet (System B)
│   └── style.css               ← Legacy stylesheet (System A — confirmation page)
│
├── js/
│   ├── launch.js               ← Core logic: cart, footer, products, checkout
│   ├── app.js                  ← Legacy JS (System A)
│   └── commerce/
│       ├── config.js           ← Product catalogue & LAUNCH_CONFIG
│       ├── api-client.js       ← Every /api call + uniform error/offline states
│       ├── lead-popup.js       ← Exit-intent / 50%-scroll email capture
│       ├── fragrance-quiz.js   ← Fragrance finder widget
│       ├── collection-service.js
│       ├── seo-service.js
│       ├── offer-service.js
│       ├── commerce-service.js ← Local order cache (server is the source of truth)
│       ├── customer-service.js
│       ├── review-service.js
│       ├── tracking-service.js
│       └── operations-service.js
│
├── api/
│   └── index.js                ← One Vercel Function; routes every /api/* URL
│
├── server/                     ← Server-only handlers and shared code
│   ├── health.js               ← Liveness + config report (token for detail)
│   ├── _lib/                   ← Shared: db, http, validate, auth, catalog,
│   │                             discounts, repo, messaging, review-access,
│   │                             config-check
│   ├── razorpay/               ← create-order, verify-payment, webhook
│   ├── orders/                 ← create-cod, lookup
│   ├── discounts/              ← validate (server-authoritative promo quotes)
│   ├── account/                ← register, login, logout, me, update
│   ├── otp/                    ← send, verify (MSG91 — also issues a session)
│   ├── leads/                  ← subscribe
│   ├── quiz/                   ← questions, recommend, submit
│   ├── reviews/                ← eligibility, submit, list
│   ├── jobs/                   ← maintenance (cron) → review-requests,
│   │                             reconcile-payments, drain-outbox
│   ├── admin/                  ← orders (delivery dates), reviews (moderation)
│   └── instagram/              ← feed
│
├── db/
│   └── schema.sql              ← Postgres schema, indexes, constraints, RLS
│
├── test/                       ← No-dependency test tooling (see README §Tests)
│   ├── server.js               ← Runs the static site + /api locally
│   ├── run-tests.js            ← API suite
│   ├── browser-tests.js        ← Headless-Chrome suite
│   ├── check-live-services.js  ← Verifies REAL Supabase/Razorpay/Resend
│   ├── mocks.js                ← Razorpay + Resend HTTP boundary only
│   └── lint.js                 ← Syntax / references / secret scan
│
├── assets/
│   ├── images/products/        ← Product images (one folder per product)
│   ├── images/                 ← Brand & UI images
│   └── fonts/                  ← Self-hosted fonts (Acumin Pro Wide, Stevie Sans)
│
├── pages/
│   ├── products/               ← 5 product detail pages
│   │   ├── seduction.html
│   │   ├── dark-oud.html
│   │   ├── red-spirit.html
│   │   ├── aqua-manthan.html
│   │   └── all-day-misfit.html
│   │
│   ├── collections/            ← Shop & collection pages
│   │   ├── collection.html     ← Single collection (uses ?collection=slug)
│   │   ├── collections.html    ← Browse all collections
│   │   ├── shop.html           ← All products / new launches
│   │   ├── gifting.html        ← Gifting page
│   │   └── build-your-own-box.html
│   │
│   ├── order/                  ← Order flow
│   │   ├── shipping.html       ← LIVE checkout (Razorpay + COD, on-site)
│   │   ├── confirmation.html   ← Order confirmation + account CTA
│   │   ├── review.html         ← Post-delivery review form
│   │   └── track-order.html    ← Order tracking
│   │
│   ├── account/
│   │   ├── account.html
│   │   └── register.html       ← Register / create account page
│   │
│   ├── support/
│   │   ├── contact.html
│   │   ├── faq.html
│   │   └── grievance-officer.html
│   │
│   ├── legal/
│   │   ├── privacy-policy.html
│   │   ├── shipping-policy.html
│   │   ├── return-refund-policy.html
│   │   └── terms-conditions.html
│   │
│   └── brand/
│       ├── about.html
│       └── consultation.html
│
├── admin/                      ← Internal admin tools (not indexed)
│   ├── operations-admin.html
│   ├── orders-admin.html
│   └── reviews-admin.html
│
├── _archive/
│   └── deprecated-pages/       ← Old pages (launch, product, wishlist, etc.)
│
└── _backup_before_structure_cleanup/  ← Pre-reorganisation backup
```

---

## Root Pages

| File | Purpose |
|------|---------|
| `checkout.html` | Redirect stub → `/pages/order/shipping.html` |
| `fragrance-finder.html` | The fragrance-finder quiz page |

Cart state: `nafumeLaunchCart` in localStorage. Orders, customers, leads,
consent, quiz responses and reviews live in Postgres — localStorage keeps only
a read cache for offline viewing.

---

## Deployment

Deployed on **Vercel** (the `api/` folder needs a serverless host; a purely
static host will not work).

**Upload these folders/files:**

```
index.html
404.html
checkout.html
fragrance-finder.html
robots.txt
sitemap.xml
vercel.json
api/
server/
pages/
admin/
assets/
css/
js/
```

**Never served:** `.vercelignore` keeps `test/`, `db/`, `docs/`, `ref/`,
archives and `*.md` out of the deployment, and `vercel.json` redirects public
requests for `/server/*` (bundled into the function, not a website asset).
Before this, the test deployment served the backend source, schema and audit
notes as public files.

**Update before launch:**
- Set the four required environment variables (see the top of this README) and
  run `db/schema.sql` in Supabase.
- Replace `nafume.com` in `sitemap.xml`, `robots.txt`, `SITE_URL` and SEO meta
  tags with the final live domain.
- Set `ADMIN_API_TOKEN` and `CRON_SECRET` so delivery tracking and the review
  system work.
- Switch `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` from test to live keys **in
  the Vercel dashboard only** — no code change is needed.

---

## Key Technical Notes

- All navigation links use **root-relative paths** (`/pages/products/seduction.html`) — requires a web server (Netlify, Vercel, GitHub Pages). Local `file://` browsing will not resolve root-relative links correctly.
- CSS/JS paths inside `pages/**/*.html` use `../../` relative prefix.
- CSS/JS paths inside `admin/*.html` use `../` relative prefix.
- WhatsApp number: `918595862227` — do not change.
- Pricing: ₹799 sell / ₹1299 MRP — locked in `LAUNCH_CONFIG`.
- Fonts: Acumin Pro Wide Medium & Stevie Sans — self-hosted in `assets/fonts/`.

### Pricing is defined in two places on purpose

`js/commerce/config.js` drives what the browser *displays*.
`server/_lib/catalog.js` decides what the customer is actually *charged*.

The server recomputes every total from its own catalogue and rejects any order
whose client-side total disagrees — so a tampered frontend can never produce a
cheaper Razorpay order. **If you change prices or offers, change both files.**
Drift fails safe (the payment is blocked with `amount_mismatch`) rather than
silently charging the wrong amount.

### Third-party scripts must never block checkout

Razorpay's `checkout.js` is loaded **on demand** by `ensureRazorpaySdk()` in
`js/launch.js`, not with a `<script>` tag. A blocking tag holds up every script
after it, which previously left the checkout page with no validation and no
submit handler whenever Razorpay's CDN was slow. `test/browser-tests.js` blocks
all third-party hosts and asserts checkout still works.
