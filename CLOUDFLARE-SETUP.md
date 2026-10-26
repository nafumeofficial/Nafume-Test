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
