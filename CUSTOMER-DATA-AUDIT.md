# NAFUME customer data collection audit

> **Superseded (15 September 2026).** The three issues below have been fixed in
> code and covered by regression tests on branch
> `fix/launch-readiness-ownership-payments-reviews`. Current status, live
> verification evidence and remaining actions are in
> [NAFUME-READINESS-REPORT.md](NAFUME-READINESS-REPORT.md). This file is kept as
> the historical record.

Reviewed: 7 September 2026.

Compared the two-page `ref/NAFUME_Customer_Data_Collection_Plan (2).pdf` against the current working files, including uncommitted changes. The PDF was treated as the requested comparison baseline, not as permission to change the website or deploy it.

**All six features have substantial implementation in this repository. They are not all ready to call complete.** There are two confirmed functional/security gaps, a payment verification concern, two differences from the PDF, and production setup that could not be verified from local files.

“Built” below means code exists and was inspected. It does not mean the same code is deployed or that real services are configured. No production database, hosting dashboard, payment account, email delivery, or live cron execution was verified. No website implementation was changed during this audit.

## Comparison with the PDF

| PDF requirement | Current implementation | Status and remaining work |
|---|---|---|
| **1. In-site Razorpay checkout and database save** | Checkout collects name, phone, email and address. The backend computes prices, saves a customer and pending order, then marks the order paid through payment verification. Supabase schema, webhook recovery and payment reconciliation exist. WhatsApp is no longer required to create the order. COD is an additional feature. | **Built, with a payment verification concern.** Live persistence and payments remain unverified. The browser verification endpoint accepts `authorized` payments and can mark paid when its payment lookup fails. Address this before launch. |
| **2. Account creation after checkout** | Confirmation page offers “Create your account to track this order.” Registration pre-fills checkout details, links customer records and orders, creates a session, and supports order history and saved checkout details. | **Built, but ownership verification needs fixing.** A guest record can be claimed by supplying its email or phone without proving control of that identifier. Confirmed locally. |
| **3. Email capture popup** | Homepage popup supports exit intent and 50% scroll, after a 15-second dwell. Saves email separately in `leads` with `source = popup_lead`. Displays `NAFUME10`; server-side discount validation and redemption are implemented. Optional code email uses Resend. | **Built, with a frequency difference.** The PDF says once per visitor. Current suppression is 30 days after dismissal and 365 days after subscription, using localStorage plus a cookie. Email delivery and live lead persistence remain unverified. |
| **4. WhatsApp opt-in at checkout** | Checkbox is near the phone field; the order and consent records store the selection. The `whatsapp_broadcast_audience` database view selects opted-in, non-revoked numbers. Account controls support changing consent. | **Built, with a default-state difference.** The PDF asks for checked by default; the current new-customer checkbox is unchecked. A returning signed-in customer's saved choice can be restored. Automatic WhatsApp sending is not implemented; the PDF describes broadcasts as a later step. |
| **5. Fragrance finder** | Homepage teaser follows the mood shopping area and links to the quiz. Five questions cover mood, occasion, intensity, fragrance family and intended recipient. No login is required. Recommendations appear before email capture; email is required to save/email the result. Answers, product and preference tags are stored with the lead/customer link. | **Built.** Requires the database for saving and Resend for actual email. Preference data exists, but automated targeted marketing campaigns are not built by this feature. |
| **6. Post-delivery review request** | Orders have `delivered_at`. Admin can record delivery. A scheduled job queues email requests after a configurable delay, default five days. Review form supports rating, text and optional photo. Submission returns `NAFUMEREVIEW`; redemption and moderation are implemented. | **Built, with a delivery eligibility gap.** Requests wait for delivery, but review submission only requires a paid order and permits a reward before delivery. Delivery recording is manual through admin in this flow. Cron, email and production delivery handling remain unverified. WhatsApp is not required because the PDF permits email. |

## Issues to resolve before calling this ready

### 1. Verify ownership before claiming guest customer records — highest priority

In [server/account/register.js](server/account/register.js), registration looks up an existing customer by email, then phone, through [server/_lib/repo.js](server/_lib/repo.js). If that customer has no password account, the endpoint installs the submitted password and issues a session without OTP, email verification or a verified order-claim credential.

**Local confirmation:** created a synthetic guest checkout, then registered with its email and a different phone number. Registration returned HTTP 200; the resulting session could see the guest's previous order through `/api/account/me`.

Required result: prove control of the relevant email/phone before attaching credentials or exposing prior orders. Review other customer-matching paths alongside this change. Merely making the frontend prefill read-only will not protect the endpoint.

### 2. Keep payment state accurate when capture is not confirmed

[server/razorpay/verify-payment.js](server/razorpay/verify-payment.js) accepts both `captured` and `authorized`, and continues to `markOrderPaid` if its independent payment fetch fails. Amount comparison also depends on that fetch succeeding. The existing API suite explicitly accepts the fetch-failure-to-paid behavior.

Required result: retain an awaiting-verification state when capture cannot be confirmed, and let the existing webhook/reconciliation paths resolve it. Preserve a clear customer message about checking payment so the customer is not encouraged to pay twice. Razorpay distinguishes authorization from capture and moves an order to paid after successful capture. See [Razorpay's Orders documentation](https://razorpay.com/docs/payments/orders/?preferred-country=US) and [Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/).

This is a code-path finding; no real payment was made during this audit.

### 3. Require delivery before accepting a post-delivery review/reward

[server/_lib/review-access.js](server/_lib/review-access.js) checks payment and previous reviews, but only returns delivery as information. [server/reviews/submit.js](server/reviews/submit.js) does not enforce delivery before insertion or reward issuance.

**Local confirmation:** a synthetic paid order with `delivered_at = null` successfully submitted a review and received `NAFUMEREVIEW`.

Required result: enforce delivered status consistently in eligibility and submission before issuing this reward. The request scheduler already waits for delivery; the form/API needs the same rule.

## Missing, different, and unverified are separate categories

- **Missing implementation:** WhatsApp provider integration and automatic WhatsApp messages; targeted marketing campaign automation. These are later extensions, not reasons to rebuild the existing collection features.
- **Different from the PDF:** unchecked WhatsApp checkbox; time-limited popup suppression; backend implemented as Vercel Node serverless handlers rather than the PDF's proposed existing Node/Express deployment. The backend architecture difference achieves the same functional objective and does not itself require a rewrite.
- **Needs correction:** guest account ownership, payment capture handling, and review eligibility before delivery.
- **Unverified production setup:** deployed code version, applied Supabase schema, service credentials, Razorpay webhooks, verified email sender, cron execution and delivery dates. Blank values in `.env.example` are placeholders, not evidence that production credentials are absent.

I would retain explicit, unchecked WhatsApp opt-in and document that change to the plan. Decide whether popup suppression should remain 30 days or match the PDF's once-per-browser-visitor intention. Cookies cannot guarantee identity across devices or after browser data is cleared.

## Next steps in sequence

| Order | Owner | Action | Evidence needed to finish |
|---|---|---|---|
| **1** | Developer | Fix guest account ownership, payment capture handling and delivery eligibility. Add focused regression checks for these gaps. | Unverified registration cannot access old orders; unconfirmed capture does not mark paid; undelivered orders cannot claim review rewards. |
| **2** | You + developer | Confirm the WhatsApp checkbox and popup frequency decisions. Review and include all required working files in the deployment source; many API files and the database schema are currently untracked in Git. | Agreed behavior and a complete, reviewable source revision. |
| **3** | You / whoever manages hosting | Prepare Supabase and apply the full [db/schema.sql](db/schema.sql). Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the intended deployment environment. | Tables, constraints and access controls exist; server can persist and read synthetic data. Do not use the memory driver for production. |
| **4** | You / hosting administrator | Configure Razorpay test credentials, `SITE_URL`, `ADMIN_API_TOKEN` and `CRON_SECRET`; deploy the complete site and API to Vercel. Use a separate test database for preview/testing where possible. | Deployed pages and APIs respond; authenticated `/api/health` reports configuration and a working database connection. |
| **5** | You / Razorpay administrator | Configure `RAZORPAY_WEBHOOK_SECRET` and the `/api/razorpay/webhook` endpoint for `payment.captured`. Verify the agreed capture behavior in test mode. | A test payment creates customer/order/items, becomes paid after capture, and the webhook succeeds even if the browser confirmation is interrupted. |
| **6** | You / email administrator | Configure Resend and a verified sending domain. Set `RESEND_API_KEY`, `CUSTOMER_EMAIL_FROM`, `ORDER_NOTIFY_EMAIL_FROM` and `ORDER_NOTIFY_EMAIL_TO`. | A test recipient receives order confirmation, popup code, quiz result and review request. A queued message is not evidence of delivery. |
| **7** | Developer + you | Run the complete staging acceptance flow listed below, and get the browser suite running. | All six PDF features work against the configured services and real persistent test storage. |
| **8** | You / operations team | Establish who marks orders shipped/delivered in `admin/orders-admin.html`, moderates reviews in `admin/reviews-admin.html`, and checks cron/payment/message failures. Verify `/api/jobs/maintenance` runs on schedule. | A delivered test order becomes due after the configured delay and receives exactly one request. Current schedule is daily at 04:00 UTC (09:30 IST). |
| **9** | You / payment and hosting administrators | After acceptance, configure live Razorpay keys and the live-mode webhook in the production environment, then redeploy and verify the production configuration. | Production uses the intended database and live payment account; the complete order-to-confirmation flow is verified. |
| **10** | Developer + marketing team | Add WhatsApp sending when needed, then build campaigns around saved preference tags and recorded consent. Wire message triggers as well as the provider adapter. | Messages are actually delivered to the intended opted-in audience; opt-outs stop future marketing messages. This can follow launch if email covers the review flow. |

The PDF's dependency order still applies: make checkout/database persistence dependable first, then accounts and checkout consent, then delivery/review automation. Popup and quiz already exist and can be validated alongside that work.

### Staging acceptance flow

1. Guest checkout, test payment, database order/customer/items, confirmation email.
2. Duplicate payment verification and interrupted browser confirmation: one paid order, no duplicate confirmation.
3. Post-checkout account prefill, verified ownership, logout/login, order history and address reuse.
4. Popup trigger, successful lead save, discount application, repeat-use rejection and suppression after dismissal/subscription.
5. WhatsApp consent checked and unchecked: corresponding database state; account opt-out removes broadcast eligibility.
6. Complete all five quiz questions, save with email, inspect persisted answers/tags, receive the recommendation email.
7. Mark delivery, run the request job when due, receive email, submit text/photo review, receive and redeem the reward, then publish through moderation.
8. Confirm undelivered orders cannot claim reviews/rewards and unverified account registration cannot expose guest history after the fixes.

## Verification performed during this audit

- Extracted and read both pages of the supplied PDF.
- Inspected active frontend, API handlers, schema and deployment configuration; backup/archive copies were not treated as the current site.
- `node test/run-tests.js`: **501 passed, 0 failed**. Uses memory storage and mocked external providers, so this is not live Supabase/Razorpay/Resend verification.
- `node test/lint.js`: **650 checks, 0 errors, 0 warnings**.
- `node test/browser-tests.js`: **could not start the browser session**; Chrome/Edge did not expose its debugging port within the test timeout. No browser pass count is claimed.
- Two additional isolated local probes confirmed the account-claim and pre-delivery-review gaps using synthetic data, memory storage and mocked providers. No real email was sent or payment taken.

The existing [deployment checklist](docs/deployment-checklist.md) and [.env.example](.env.example) explain the service wiring in more detail. Use the sequence above with the corrections identified here; passing the current test suite alone does not resolve those gaps.
