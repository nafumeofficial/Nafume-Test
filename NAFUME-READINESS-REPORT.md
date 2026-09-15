# NAFUME launch readiness report

Updated: 15 September 2026 · Branch: `fix/launch-readiness-ownership-payments-reviews` (local, not pushed)

## Verdict

**Do not enable real orders yet.**

The three audit gaps are fixed in code and covered by regression tests: guest account takeover, payments marked paid without capture, and reviews/rewards before delivery. None of it has been verified against live Supabase, Razorpay, Resend, MSG91 or a deployment with this code. No credentials or Vercel team access were available to this session.

Ownership, payment capture, persistence and delivery-gated reviews each stay **blocked** until the live checks in [§8](#8-remaining-actions-for-you) pass.

| Area | Implemented | Locally tested | Integration verified |
|---|---|---|---|
| Account ownership (verification before linking) | ✅ | ✅ | ⛔ blocked: needs Resend (+ MSG91 for SMS) |
| Payment capture + recovery | ✅ | ✅ | ⛔ blocked: needs Razorpay test keys, webhook, deployment |
| Persistent storage | ✅ | ✅ PGlite (real Postgres engine) | ⛔ blocked: needs a Supabase test project |
| Delivery-gated reviews + rewards | ✅ | ✅ | ⛔ blocked: needs storage + email + deployment |
| Email delivery | ✅ | ✅ mocked | ⛔ blocked: needs Resend key + verified domain |
| Scheduled jobs on Vercel | ✅ | ✅ | ⛔ blocked: needs access to the `nafume` Vercel team |
| Source files not publicly served | ✅ | ✅ route patterns compiled | ⛔ blocked: needs a deployment of this branch |
| WhatsApp automation | prepared, **disabled** | ✅ gate tested | not started (needs provider, templates, approval) |

---

## 1. Current state

### Repository and deployments

| Fact | Evidence |
|---|---|
| Local `main` is 2 commits ahead of `origin/main` (`nafumeofficial/Nafume`) | `git status`: `main...origin/main [ahead 2]` |
| Those 2 commits (`f3d740c`, `2e133bb`) are on `nafumeofficial/Nafume-Test` | `git log nafume-test/main` = `2e133bb` |
| Vercel project **`nafume/nafume-test`** deploys `Nafume-Test@main` to Production | GitHub deployment status for `2e133bb` → `vercel.com/nafume/nafume-test/…` |
| Vercel project **`nafume/nafume`** deploys `Nafume@main`; last production deploy is `79604f0` (15 July) | GitHub deployments on `nafumeofficial/Nafume` |
| `www.nafume.com/api/health` → **404**: the live site runs the pre-API version | `GET` on 15 Sep |
| `nafume-test.vercel.app/api/health` → `{"storage": false}`: current code, **no database configured** | `GET` on 15 Sep |
| On `nafume-test`: webhook, cron and admin endpoints → **503** (secrets not set) | `node test/check-live-services.js --site https://nafume-test.vercel.app` |
| On `nafume-test`: `/server/_lib/db.js`, `/db/schema.sql`, `/test/run-tests.js` and `/CUSTOMER-DATA-AUDIT.md` are **publicly downloadable** (HTTP 200) | same run |
| Both GitHub repos are **public** | `gh repo view` |
| Vercel CLI is signed in as `himanshunarwaria`, who is **not a member of the `nafume` team** | `vercel teams ls` |
| No `.env`, no Supabase CLI or token, no Razorpay, Resend or MSG91 credentials on this machine | presence check only; no values read |

**Pushing a branch.** Vercel's Git integration creates a **Preview** deployment for non-production branches. Production deploys have only ever come from `main`. Pushing this branch should not change live traffic, but I could not read the project settings to confirm the production branch. The Preview would also use whatever **Preview** environment variables the `nafume` team set, which may include live keys. I have not pushed. See [§8](#8-remaining-actions-for-you).

### Environment variables (presence only)

Nothing is set locally. On the deployments, `nafume-test` reports no storage and no webhook/job/admin secrets. Anything beyond that needs the admin token or dashboard access.

---

## 2. Audit findings vs current code

| Audit finding (7 Sep) | Still present before this work? | Now |
|---|---|---|
| Guest record claimed by typing its email/phone; session exposes old orders | **Yes** (reproduced by the existing suite: `/api/account/register` issued a session immediately) | Fixed: code verification before credentials, session or linking |
| `verify-payment` accepts `authorized`, and marks paid if the lookup fails | **Yes**, and the suite asserted it (`genuine payment honoured when the confirmation fetch fails`) | Fixed: capture only; everything else waits in `awaiting_verification` |
| Review + `NAFUMEREVIEW` possible before delivery | **Yes** | Fixed: delivery recorded is required, enforced server-side |
| Git push / Vercel function limit | Resolved (single router in `api/index.js`; deploys succeed on `nafume-test`) | — |
| Browser suite could not start | **No longer true:** 151/151 baseline on this machine | 165/165 |

### Additional issues found and fixed during this work

| # | Issue | Severity | Fix |
|---|---|---|---|
| A | **Webhook signature never verified on Vercel.** The handler read `req.body` first; Vercel's helper parses it, so the code took its "raw body unavailable → skip signature" path. Confirmed from `@vercel/node` source. | High | Reads raw bytes from the stream (Vercel replays them), verifies over those bytes, and **fails closed** if they are unavailable |
| B | **Backend source, schema, test suite and audit publicly served** on the deployment | High | `.vercelignore` + `vercel.json` redirects for `/server/*` |
| C | Guest checkout **filled a typed email/phone into another customer's record** and overwrote their saved address. Enabled cross-identifier account takeover via phone sign-in. | High | Checkout never modifies a claimed record; identifiers are never filled in; visibility needs a verified owner |
| D | Order history based on `customer_id`, which comes from typed checkout details | High | New `orders.verified_owner_customer_id` is the only access key |
| E | `/api/account/update` let a customer set any unclaimed email or phone. That blocked the real owner and attracted their future guest orders. | High | Email/phone changes require a verification code |
| F | `NAFUMEREVIEW` is a public code redeemable by anyone typing a reviewer's email | Medium | Requires the signed-in owner; allowance counts reviews on orders they own |
| G | Review access by order id + typed contact (order ids are short and time-based) | Medium | Session owner, or hashed single-order token from the review email |
| H | Parallel checkouts could spend one reward twice | Medium | DB-unique allowance slots (`slot_key`) |
| I | COD double-submit guard could return **another person's order and address** for a matching email + cart | Medium | Duplicate only when every typed detail matches |
| J | Supabase `sb_secret_…` keys were also sent as `Authorization: Bearer`, which fails JWT verification | Medium (would break new projects) | Secret keys go only in `apikey`; legacy JWT keys keep both headers |
| K | `NAFUME_DB_DRIVER=memory` could run on a deployment | Medium | Refused on Vercel / `NODE_ENV=production`; health reports it |
| L | Confirmation page inserted order fields into HTML unescaped | Medium (once orders link to accounts) | Escaped |
| M | Quiz submission changed **email marketing consent** on any record matching a typed email | Low | Only with a session; guests' choice is stored on their lead |
| N | Job and admin tokens compared non-constant-time and read once at cold start | Low | Constant-time, read per request |
| O | OTP sign-in: an unverified phone on a record + any valid SMS = session to that record | High (part of C) | Challenge-bound OTP; unverified phone on an account → conflict, no session |

---

## 3. What changed

### Account ownership
- **Registration is two steps.** `POST /api/account/register` validates, refuses existing accounts, stores a scrypt hash in a challenge, and emails a 6-digit code. It can text the code via MSG91 instead (`verifyVia: "phone"`). It creates nothing and starts no session. `POST /api/account/verify` consumes the code, then creates the account on the **proven** identifier, links only orders placed with it, and starts the session.
- **Challenges** (`server/_lib/verification.js`, table `verification_challenges`) are:
  - bound to purpose, channel and identifier;
  - expiring (email 10 min; SMS `OTP_EXPIRY_SECONDS`);
  - single-use (conditional consume) and limited to 5 wrong attempts (compare-and-set counter);
  - throttled: 30 s cooldown, 3 sends per challenge, 6 sends per identifier per 30 min, durable.

  Email codes are stored only as HMAC. The outbox copy of the email is redacted. Expired payloads are purged daily.
- **Proof covers one identifier.** An email code never verifies the phone, and vice versa. The other identifier is saved unverified and grants nothing.
- **Conflicts are refused, not merged** (`server/_lib/accounts.js`):
  - A verified identifier beats an unverified copy elsewhere (the copy is detached).
  - An identifier already verified on another account → `409 identifier_conflict`.
  - A phone listed unverified on someone's account → SMS sign-in refused with instructions.
- **Linking earlier purchases:** `POST /api/account/identifiers` (start/confirm) lets a signed-in customer verify another email or mobile. Unowned orders placed with it are linked. Orders already owned by someone else never move.
- Ownership is enforced server-side in `me`, `orders/lookup`, `reviews/*` and discounts.

### Payments
- `server/_lib/payments.js` is the single rulebook. **Paid** requires Razorpay's API to report `captured`, on this Razorpay order, for exactly `amount_total × 100` paise, in the order's currency.
  - A valid signature alone, `authorized`, lookup failure or timeout → **`awaiting_verification`**, with the message: *"We're confirming your payment. Please don't pay again. Your order status will update once confirmation arrives."*
  - Mismatched order, amount or currency → refused, team alerted, not paid.
  - Failed or refunded → 402.
- **One paid transition for all paths:** `UPDATE … WHERE payment_status IN ('pending','awaiting_verification')`. Confirmation emails and discount commits run only for the single winner. A paid order is never moved back.
- **Recovery** runs through four paths:
  - the webhook: raw-body signature, event-id dedupe in `payment_events`, re-checks Razorpay;
  - a confirmation-page status refresh (`refreshPayment`, at most one Razorpay call per order per 10 s; the page polls);
  - the reconciliation job (awaiting first, then pending; flags long-uncaptured authorizations; closes all-failed attempts);
  - a late browser callback.
- Payment status stays separate from order and fulfilment status. COD is unchanged: paid when delivery is recorded with cash collected.

### Reviews and rewards
- Eligibility and submission share `server/_lib/review-access.js`. Required: paid, not cancelled, **delivery recorded** (`delivered_at` + fulfilment `delivered`), product in the order, one review per (order, product).
- Access is the owner's session **or** the review-link token from the email. Only the token's SHA-256 is stored; it is bound to the order and expires after 60 days. Guessed ids, other customers' tokens and other sessions all get the same 404.
- **Eligibility starts at delivery; the email is a separate reminder** sent `REVIEW_REQUEST_DELAY_DAYS` (confirmed default **5**) after delivery. The job claims each order with a conditional update before sending, so repeated or concurrent runs send once.
- `NAFUMEREVIEW` terms unchanged: one reward per review, hidden reviews still count. It is now redeemable only by the signed-in owner, with DB-unique allowance slots.
- Approved reviews show only on their own product page (`/api/reviews/list?productId=…`, published only); covered by the browser suite.

### Storage and deployment
- Migration `db/migrations/20260915_launch_readiness.sql` (additive, idempotent) with rollback. `db/schema.sql` now includes it for fresh databases.
- Memory driver refused on hosted runtimes. Supabase key header fix.
- `/api/health` (with admin token) checks that the migration's tables and columns exist.
- `.vercelignore` + redirects stop source, schema, tests and docs being served.
- `test/check-live-services.js` gained:
  - migration and constraint checks against live Supabase;
  - a persistence probe (write → redeploy → verify);
  - Resend delivery-event read-back;
  - read-only deployment checks (`--site`).

### Frontend (design, pricing, copy and checkout options unchanged apart from the flows above)
- `register.html`: code step with resend, "text me instead", and back.
- `account.html`: OTP uses the challenge; "Verify & link orders" panel; verified badges; email/phone read-only in the edit form; `?next=` return (same-site only).
- `review.html`: link-token or session; clear "not delivered yet" state; explains how to redeem; strips the token from the address bar.
- `launch.js` + `confirmation.html`: awaiting state clears the cart, shows the exact message and polls until paid or failed; order fields escaped.
- `orders-admin.html`: "Confirming payment" filter.

### Changed files
- **New:**
  - `.vercelignore`
  - `db/migrations/20260915_launch_readiness.sql` and `….rollback.sql`
  - `server/_lib/{accounts,checkout,msg91,payments,verification}.js`
  - `server/account/{verify,resend-code,identifiers}.js`
- **Modified:**
  - `.env.example`, `README.md`, `CUSTOMER-DATA-AUDIT.md` (superseded note), `vercel.json`, `api/index.js`, `db/schema.sql`
  - `server/_lib/{auth,config-check,db,discounts,messaging,repo,review-access}.js`
  - `server/account/{login,me,register,update}.js`, `server/admin/{orders,reviews}.js`, `server/health.js`
  - `server/jobs/{drain-outbox,maintenance,reconcile-payments,review-requests}.js`
  - `server/orders/{create-cod,lookup}.js`, `server/otp/{send,verify}.js`, `server/quiz/submit.js`
  - `server/razorpay/{create-order,verify-payment,webhook}.js`, `server/reviews/{eligibility,submit}.js`
  - `admin/orders-admin.html`, `js/commerce/api-client.js`, `js/launch.js`
  - `pages/account/{account,register}.html`, `pages/order/{confirmation,review}.html`
  - `test/{browser-tests,check-live-services,mocks,run-tests,server}.js`

---

## 4. Migrations

**Prepared, not applied to any real database.**

| File | Purpose |
|---|---|
| `db/migrations/20260915_launch_readiness.sql` | Adds `customers.email_verified_at/phone_verified_at`; orders' verified owner, normalized email and payment-confirmation columns, plus a `payment_status` CHECK (incl. `awaiting_verification`); `verification_challenges`, `payment_events`, `schema_migrations`; review-link token hash; redemption slots with partial UNIQUE indexes; RLS on new tables. Backfills normalized emails and slots. **Existing orders get no verified owner**: customers re-verify to see them. |
| `db/migrations/20260915_launch_readiness.rollback.sql` | Destructive reversal (resets awaiting orders to pending first). Prefer an application rollback. |

**Validated on a real Postgres engine (PGlite 0.3.7, scratchpad, not Supabase): 29/29.**
- Applies over the committed schema with existing rows, and re-runs cleanly.
- Backfills are correct.
- CHECK, live-challenge, event-id, slot and payment-id constraints reject what they should.
- The paid transition happens once and can't be reverted by the awaiting update.
- Rollback removes the objects and keeps orders; re-apply works.
- The fresh `schema.sql` creates 16 tables, all with RLS and 0 policies.

PGlite does not exercise PostgREST, Supabase roles or network behaviour. That is what `check-live-services.js` is for.

---

## 5. Tests

| Command | Result | Notes |
|---|---|---|
| `node test/run-tests.js` (baseline, before changes) | 501 passed, 0 failed | Included tests asserting the audited bugs |
| `node test/run-tests.js` | **769 passed, 0 failed** | Through `api/index.js` with Vercel helpers emulated (eager body read + raw replay + lazy `req.body`) |
| `NAFUME_TEST_ROUTER=direct node test/run-tests.js` | **769 passed, 0 failed** | Handlers without the router |
| `node test/browser-tests.js` (baseline) | 151 passed, 0 failed | |
| `node test/browser-tests.js` | **165 passed, 0 failed** | Headless Chrome, incl. a 390 px mobile run of the confirming-payment state |
| `node test/lint.js` | 624 checks, 0 errors, 0 warnings | Includes the "service key only read in db.js" rule (it caught one violation, since fixed) |
| PGlite migration check (scratchpad) | 29 passed, 0 failed | See §4 |
| `vercel.json` sources compiled with `path-to-regexp@6.3.0` | 15/15 valid; 9 sensitive paths blocked, 10 site paths allowed | Scratchpad |
| `check-live-services.js --site https://nafume-test.vercel.app` | 4 passed, 13 failed, 4 skipped | Real evidence of the **current** (old-code) test deployment; failures listed in §1 |

**Regression coverage added**, all through `api/index.js`:
- **Account ownership:** unverified guest claims (email and cross-identifier variants); attempt exhaustion.
- **Verification rules:** expiry, replay, concurrent correct codes, resend cooldown and cap, superseded codes, purpose binding, provider unavailable or failing, conflicting records, payload purge.
- **Phone flows:** SMS sign-in, SMS registration, identifier linking, cross-account conflict.
- **Payment capture:** authorized-but-uncaptured, lookup failure/timeout, delayed capture by webhook, mismatched order/amount/currency, refunded.
- **Races and replays:** a simultaneous burst of 3 callbacks, 2 duplicate webhooks, `order.paid` and a status refresh (one paid row, one confirmation, one team alert); stale events.
- **Webhook hardening:** re-serialised body rejected, exact raw bytes accepted, retry after a Razorpay outage, parsed-body-only runtime refused.
- **Browser-close recovery:** status refresh and reconciliation (incl. dry run).
- **Reviews:** before delivery, guessed ids, another customer's link or session, expired link, cancelled order; delay fixtures (4 vs 6 days) with concurrent and repeated scheduler runs.
- **Rewards:** guest vs signed-in, parallel redemptions, DB slot race.
- **Auth and hosting:** admin/job auth through the router and direct handler calls; router traversal; memory driver refused on Vercel; Supabase header logic.

**Updated tests that endorsed incorrect behaviour:** fetch-failure→paid; instant registration session; contact-based reviews; pre-delivery review acceptance; guest `NAFUMEREVIEW`; queueing WhatsApp with no provider.

**Mocks are not live proof.** Razorpay, Resend and MSG91 are replaced at the HTTP boundary (`test/mocks.js`). The MSG91 request/response contract is carried over unchanged from the existing integration and has never been checked against a live account.

---

## 6. Services

| Service | Code expects | Verified live? | What's needed |
|---|---|---|---|
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secret or legacy key) | No | Test project, migration, keys in Vercel **Preview** |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | No | Test keys + test-mode webhook with the 4 events |
| Resend | `RESEND_API_KEY`, `CUSTOMER_EMAIL_FROM`, `ORDER_NOTIFY_EMAIL_FROM`, `ORDER_NOTIFY_EMAIL_TO` | No | Key + verified domain (SPF/DKIM records come from Resend's dashboard) |
| MSG91 | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `MSG91_SENDER_ID` | No | Only if SMS codes are wanted at launch; DLT-approved template with `##OTP##` |
| Vercel | `SITE_URL`, `ADMIN_API_TOKEN`, `CRON_SECRET`; cron `0 4 * * *` → `/api/jobs/maintenance` | No (not a team member) | Access to team `nafume`, or you set these |

**Scheduler:**
- Hobby crons run once a day at some point in the scheduled hour: 04:00–04:59 UTC (09:30–10:29 IST).
- Delivery is best effort and can be missed or duplicated. Every job is idempotent.
- The webhook and the confirmation-page refresh are the fast paths; reconciliation is the daily safety net.
- Cron runs only on Production deployments. On Preview, trigger it by hand with the bearer token.

---

## 7. Decisions to confirm

| Topic | Current behaviour | Recommendation |
|---|---|---|
| WhatsApp opt-in at checkout | **Unchecked** by default; backend stores exactly the choice (`true` only for a real tick) | Keep (DPDP clear affirmative action) |
| Popup frequency | Needs 15 s on the page, then exit-intent (desktop) or 50 % scroll. Suppressed 30 days after dismissal, 365 after subscribing (localStorage + cookie). | Keep; no defect found |
| `NAFUMEREVIEW` | Now requires signing in to the account that owns the reviewed order | Keep (the code is public) |
| Existing accounts / orders before the migration | No verified owner; customers verify their email to see orders | Acceptable: no production database exists yet |
| Quiz email opt-in | The form says "keep you posted" and always sends `marketingOptIn: true` | Consider an explicit checkbox before email campaigns |
| Review-link lifetime | 60 days (`REVIEW_LINK_TTL_DAYS`) | Confirm |
| Operations owner | Not assigned | Please nominate who records deliveries and moderates reviews |

---

## 8. Remaining actions for you

Minimum set, in order. **Never paste secrets into chat**; enter them in the dashboards.

1. **Access.** Add me (Vercel user `himanshunarwaria`) to team **`nafume`**, or do steps 3–5 yourself. Confirm the Production Branch of both projects is `main` (Project → Settings → Git).
2. **Push approval.** Reply with which repo may receive branch `fix/launch-readiness-ownership-payments-reviews`. `nafumeofficial/Nafume-Test` is recommended: it makes a Preview on `nafume-test`, with no production deploy expected. Both repos are public.
3. **Supabase test project.** Create a separate project (Mumbai). Open SQL Editor, paste `db/schema.sql`, Run. Copy the Project URL and a **secret** key into Vercel `nafume-test` → Environment Variables → **Preview** (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
4. **Razorpay test mode.**
   - Generate test keys → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (Preview).
   - Add a **Test-mode webhook** with URL `https://<preview-url>/api/razorpay/webhook`, a new secret (→ `RAZORPAY_WEBHOOK_SECRET`), and events `payment.captured`, `order.paid`, `payment.authorized`, `payment.failed`.
   - If the Preview has Vercel Deployment Protection on, add a bypass for the webhook or use an unprotected test deployment, or Razorpay's calls will be blocked.
5. **Resend.** API key → `RESEND_API_KEY`. Add your domain under Domains and create the DNS records exactly as Resend shows them, until **Verified**. Set `CUSTOMER_EMAIL_FROM` and `ORDER_NOTIFY_EMAIL_FROM` to addresses on that domain, and `ORDER_NOTIFY_EMAIL_TO`.
6. **Other Preview variables.** Generate each of the following with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` and store it in your password manager: `ADMIN_API_TOKEN`, `CRON_SECRET`, `VERIFICATION_SECRET`. Set `SITE_URL` to the Preview URL. Redeploy.
7. **Run the checks** locally, loading the same test values from a local `.env` (git-ignored):
   - `node test/check-live-services.js --email <your inbox>`
   - `node test/check-live-services.js --write-persistence-probe`, redeploy, then `--verify-persistence <marker>`
   - `node test/check-live-services.js --site https://<preview-url>`
8. **Staging acceptance** ([§9](#9-staging-acceptance-checklist)) on desktop and a phone, with Razorpay test cards/UPI.
9. **Nominate** the person who records deliveries and moderates reviews.
10. Optional: MSG91 DLT template + keys if SMS codes should be offered at launch.

---

## 9. Staging acceptance checklist

Record evidence (screenshot, SQL row or Razorpay/Resend event) for each.

- [ ] Guest checkout (test card) → confirmation shows **Payment Successful**; `orders.payment_status='paid'`, `payment_confirmed_via='checkout_callback'`, `payment_captured_amount` = total × 100; one customer confirmation email **received** (Resend `last_event=delivered`)
- [ ] Browser closed right after paying → order becomes paid via **webhook** (`payment_confirmed_via='webhook'`); Razorpay dashboard shows the delivery 200; exactly one confirmation email
- [ ] Resend the same webhook from the Razorpay dashboard → 200 `duplicate`; no second email
- [ ] Payment left authorized (if your test account allows manual capture) → confirmation shows the "don't pay again" message; after capture the page updates by itself
- [ ] Create account from the confirmation page → code email **received** → account created → order visible; wrong code refused; old code refused after resend
- [ ] In another browser, try registering with that email → no access without the code
- [ ] Log out / log in → history and saved address reused at checkout; a signed-in checkout appears in history
- [ ] WhatsApp box unticked → `marketing_consent.opted_in=false`; ticked → `true`; account page toggle updates it; `whatsapp_broadcast_audience` reflects it
- [ ] Popup: appears after 15 s + exit/scroll; `leads` row; code email **received**; `NAFUME10` applies once; not shown again after dismiss
- [ ] Quiz: 5 answers → recommendation; `quiz_responses` row with tags; email **received**
- [ ] Admin (`/admin/orders-admin`): mark shipped → mark delivered (date) → `delivered_at` set
- [ ] Signed-in owner can review immediately after delivery; a guest cannot without the link
- [ ] Set a test order's delivery ≥ 6 days back, run `POST /api/jobs/maintenance` twice with `CRON_SECRET` → exactly **one** review email **received**; its link opens the form
- [ ] Submit review with photo → `pending`; publish in `/admin/reviews-admin` → visible on **that** product page only
- [ ] Signed in, `NAFUMEREVIEW` applies once; second use refused; guest typing the same email refused
- [ ] Before delivery, review attempt shows "once it has been delivered"
- [ ] `/api/health` with admin token: `ok: true`, `migrationApplied: true`, empty `nextSteps`
- [ ] `check-live-services.js --site`: all read-only checks pass, incl. source files **not** served
- [ ] Vercel → Cron Jobs → `/api/jobs/maintenance` shows a successful run (Production only)

---

## 10. Production launch and rollback

### Prepared changes (need your explicit approval)
1. Merge the branch into `main` of the repo that serves `www.nafume.com` (`nafumeofficial/Nafume` → project `nafume`). This **deploys to live traffic**.
2. Production Supabase project: new → run `db/schema.sql`. If one already exists with data → back up, check `schema_migrations`, apply `db/migrations/20260915_launch_readiness.sql`.
3. Production variables in project `nafume` → **Production** scope:
   - **Razorpay:** LIVE keys and a separate **Live-mode** webhook with the same events.
   - **Email:** the Resend key and verified senders.
   - **Secrets and URL:** new `ADMIN_API_TOKEN`, `CRON_SECRET`, `VERIFICATION_SECRET`; `SITE_URL=https://www.nafume.com`.
   - **Do not set** `NAFUME_DB_DRIVER`.
4. Update `SITE_URL`, sitemap and canonical domains if they differ.

### Backup (before any production migration)
- Supabase → Database → Backups: confirm a recent backup exists, or take a logical dump from your machine: `pg_dump "<connection string>" --format=custom --file nafume-pre-20260915.dump` (connection string from Project Settings → Database; enter it in your terminal, not chat).
- Record `SELECT count(*) FROM orders;` and `SELECT max(created_at) FROM orders;` for comparison.

### Controlled live-order verification (after approval + deploy)
1. `node test/check-live-services.js --site https://www.nafume.com` → all pass.
2. You place **one real low-value order** with your own card/UPI. I will not initiate charges.
3. Verify: order `paid` via callback **and** a webhook delivery 200 in Razorpay Live; `payment_captured_amount` correct; confirmation email received; customer/order/items rows present.
4. Refund it from the Razorpay dashboard if you don't want to keep it. Order status is not changed automatically by refunds; mark it cancelled in admin.
5. Create your account from the confirmation page and confirm the order links.

### Rollback
- **Application:** Vercel → project `nafume` → Deployments → previous Production deployment → **Instant Rollback**. Cron schedules do not follow instant rollbacks; disable crons if needed.
- **Before rolling back code:** resolve any orders in `awaiting_verification` (run reconciliation, or set them to `pending`), because older code does not understand that state.
- **Schema:** leave the additive migration in place (older code ignores it). Only if it must go: restore the backup, or run `db/migrations/20260915_launch_readiness.rollback.sql`. This deletes verification state, webhook history, review-link tokens and ownership links.
- **Webhooks:** disable the Live webhook in Razorpay if the endpoint is rolled back to code without it.

---

## 11. Delivery and review operating instructions

**Who:** nominate one owner plus one backup (see §8.9).

**Daily (after dispatch):**
1. Open `https://<site>/admin/orders-admin`, paste `ADMIN_API_TOKEN` (kept for the browser tab only).
2. Filter **Paid**. For each dispatched order enter AWB + courier → **Mark shipped**.
3. When the courier confirms delivery, set the delivery date → **Mark delivered**. For COD, this also records the cash as collected; if the customer refused, don't mark it delivered (the API supports `codCollected:false` for a refused delivery).
4. Check the **Confirming payment** filter. Anything older than an hour: look the payment up in the Razorpay dashboard. The daily job flags these too.

**Reviews (at least twice a week):**
1. Open `https://<site>/admin/reviews-admin`, token, filter **Pending**.
2. **Publish** genuine reviews (they appear on that product's page); **Hide** abusive or irrelevant ones. The customer keeps their reward either way (existing policy).

**What happens automatically:**
- A customer who owns the order (signed in) can review as soon as delivery is recorded.
- **5 days after delivery**, the daily job emails a review link (one per order, valid 60 days).
- After submitting, the customer sees `NAFUMEREVIEW`; it works once per review while signed in.

**Weekly checks:**
- `POST /api/jobs/reconcile-payments?dryRun=1` with the token, and read `needsAttention`.
- `SELECT channel, status, count(*) FROM outbound_messages GROUP BY 1,2;` (stuck or failed messages).
- `SELECT order_id FROM orders WHERE review_request_status='queued' AND order_id NOT IN (SELECT order_id FROM review_requests);` should be empty.

---

## 12. WhatsApp automation readiness

- **State:** consent capture, storage and revocation work; `whatsapp_broadcast_audience` lists only opted-in, un-revoked numbers; marketing sends check live consent. No provider adapter exists.
- **Change made:** a launch gate in `server/_lib/messaging.js`. Sending needs all four of:
  - an implemented adapter (a code change);
  - provider credentials (`WHATSAPP_PROVIDER`, `WHATSAPP_API_KEY`, `WHATSAPP_SENDER_NUMBER`);
  - approved template names (`WHATSAPP_TEMPLATE_ORDER_CONFIRMED`, `…_SHIPPED`, `…_DELIVERED`);
  - `WHATSAPP_SENDING_ENABLED=true`.

  While disabled, **nothing is sent or queued**, so enabling later cannot release a stale backlog. `/api/health` reports each item.
- **Existing provider:** MSG91 (already used for SMS) offers WhatsApp Business messaging, which would avoid a second vendor. Its API contract was not verifiable from here; implementing the adapter is a follow-up once the account, number and templates exist.
- **Before any campaign:** Meta-approved templates; opt-out handling (reply STOP → revoke consent); export only from the view; your written launch authorization. **No WhatsApp messages were sent during this work.**

---

## 13. Known limitations and residual risks

- **Nothing live verified.** Webhook raw-body handling on Vercel is implemented from `@vercel/node`'s source and emulated in tests. The first real webhook delivery is the proof, and `--site` checks it.
- **Deployment-level checks pending.** `.vercelignore` and redirect precedence over static files match Vercel's docs, but haven't been confirmed on a deployment.
- **Guest order lookup** (order id + email/phone) still exists for the confirmation and tracking pages, as is common. Failed guesses are throttled per order id.
- **Review-link tokens** are hashed in `review_requests`, but the email body in `outbound_messages` contains the link, so the drain job can retry it.
- **MSG91 codes are held per phone number by MSG91.** NAFUME's challenge binds purpose and single use, but a code texted for one purpose proves the same number for another live challenge on that number.
- **Registration still reveals whether an account exists** for an email (409), as before.
- **COD rapid double-submits** rely on the existing time-window guard, not a DB constraint.
