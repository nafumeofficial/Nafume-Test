# NAFUME on Cloudflare (Workers + D1)

One Worker serves the pages (Static Assets), the `/api/*` routes and the daily
maintenance cron. The database is Cloudflare D1 (SQLite); there is no database
URL or key — the Worker reaches it through the `DB` binding.

## One-time setup (Nafume Cloudflare account)

```bash
npx wrangler login                      # sign in as the Nafume account
npx wrangler d1 create nafume           # copy the printed database_id into wrangler.jsonc
npx wrangler d1 execute nafume --remote --file db/d1/schema.sql

# secrets (each prompts for the value; never put these in wrangler.jsonc)
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put CRON_SECRET
npx wrangler secret put NAFUME_SERVER_SECRET   # any long random string

npx wrangler deploy
```

Then add `www.nafume.com` as a custom domain on the Worker and point the Razorpay
webhook at `https://www.nafume.com/api/razorpay/webhook`.

## Local development and tests

```bash
node test/run-tests.js                    # memory driver
NAFUME_TEST_DB=d1 node test/run-tests.js  # same suite on the D1 driver + db/d1/schema.sql
npx wrangler d1 execute nafume --local --file db/d1/schema.sql
npx wrangler dev --local                  # reads secrets from .dev.vars (git-ignored)
```

## Status (26 Oct 2026)

Done: D1 database `nafume` created and loaded with `db/d1/schema.sql`; Worker `nafume`
deployed at `https://nafume.nafume-official.workers.dev`; `nafume.com` added to the
Nafume Cloudflare account with GoDaddy nameservers switched to Cloudflare; secrets
`CRON_SECRET`, `NAFUME_SERVER_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_API_TOKEN` set.

Still to do before `www.nafume.com` moves to the new site:
1. Generate the Razorpay live key (needs the account owner's OTP) and set
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`; optionally `RESEND_API_KEY`.
2. Create the Razorpay webhook: `https://www.nafume.com/api/razorpay/webhook`, events
   payment.captured, order.paid, payment.authorized, payment.failed, same secret as
   `RAZORPAY_WEBHOOK_SECRET`.
3. Go live: delete the old `www` CNAME (`cname.vercel-dns-0.com`) in Cloudflare DNS,
   uncomment `routes` in `wrangler.jsonc`, run `npx wrangler deploy`.
   Rollback: recreate that CNAME and remove the custom domain from the Worker.
4. `node test/check-live-services.js --site https://www.nafume.com`, then one small
   real payment.
