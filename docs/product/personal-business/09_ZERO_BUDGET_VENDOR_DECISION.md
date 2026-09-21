# Zero-budget vendor decision

PB-2026-09-17.1 | Independently reviewed B00 contract boundary for the unified execution program. Nothing here creates an account, a credential or spend.

## The rail

The selected development tiers require USD 0 of new fixed monthly spend. Actual account plans are unverified. Unapproved variable spend is USD 0. Automatic top-ups are off; no annual commitments are taken.

| role | vendor | tier | fixed/mo | what it supplies |
|---|---|---|---|---|
| marketing hosting | Cloudflare Workers static assets | existing source configuration | $0 new | site hosting, TLS, CDN; D1/email retain their own quotas |
| control-plane runtime | Cloudflare Workers | Workers Free | $0 | Web Fetch-compatible control-plane worker |
| identity | WorkOS AuthKit | AuthKit Free | $0 | hosted OIDC issuer/subject for `verifySubject` |
| database | Neon | Neon Free | $0 | serverless Postgres for hosted control-plane state |
| payments | Stripe | test mode first | $0 fixed | checkout/invoicing; future live charges require approval and incur variable fees |
| app hosting | Vercel | not selected | — | recorded as an optional future adapter, not this rail |

The data form lives in `services/control-plane/contract/vendors.ts` (`VENDOR_ALLOWLIST`, `SPEND_POLICY`) so the matrix is enforced by test, not only written here.

## Fees, limits and evidence per vendor

Variable fees are distinct from fixed spend. Free tiers must remain inside their quotas, and Stripe's live fees require separate approval. No account was provisioned or inspected: every selected vendor's `accountState` remains `unverified`. The website source configures Workers with static assets, D1 and email (`diomedes-site/wrangler.toml`); this decision does not migrate it to Pages. Primary pricing was rechecked on 2026-09-17.

| vendor | free-tier limits | variable fees | sources |
|---|---|---|---|
| Cloudflare Workers static assets | static requests free; dynamic requests share the Workers quota | D1/email and actual account plan unverified | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare Workers | 100,000 requests/day; 10 ms CPU per invocation | none on the free plan | [Limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| WorkOS AuthKit | free for the first one million MAU | none at this scale | [Pricing](https://workos.com/pricing), [AuthKit](https://workos.com/docs/authkit) |
| Neon | 100 projects; 10 branches/project; 100 CU-hours/project/month; 0.5 GB/project; 5 GB transfer/project/month | none within Free quotas | [Vendor quota source](https://github.com/neondatabase/website/blob/main/content/faqs/free-plan-limits-and-quotas.md) |
| Stripe | test mode only; no stored spend authority | US domestic cards 2.9% + $0.30 per successful transaction; Billing adds 0.7% of Billing volume; disputes/international/FX and optional products can add fees | [Payments](https://stripe.com/us/pricing), [Billing](https://stripe.com/billing/pricing) |
| Vercel | not selected | not selected | [Pricing](https://vercel.com/pricing) |

## Rejected paid add-ons, by name

- WorkOS: custom domain, SSO/SAML, SCIM directory sync, audit-log retention product, paid organization features.
- Cloudflare: Workers Paid plan, Queues/Streams paid usage, per-request paid addons.
- Neon: Launch and Scale paid tiers, paid read replicas.
- Stripe: unapproved live charges, Stripe Tax, Billing annual commitments and optional paid extras, automatic top-ups. Pay-as-you-go Billing remains the approved future integration candidate; it is not enabled by this contract.
- Vercel: Pro, Connect, per-seat billing.

## Boundaries this rail keeps

- No Next.js migration; the commercial app surface is not on this rail.
- No cloud scheduler: managed dispatch is request-driven.
- Missing credentials block only live-provider evidence; offline implementation and fixtures proceed.
- The website's contact database is not an entitlement backend; no document price is a subscription.
- A questionnaire answer, a model's output and a settings record are not spend decisions (`applySpendOverride` refuses all of them).

## What this decision does not do

It does not provision infrastructure, create accounts, select a production checkout flow or sell anything. B01–B04 carry those work orders; this record is the boundary they may not exceed without a new decision.
