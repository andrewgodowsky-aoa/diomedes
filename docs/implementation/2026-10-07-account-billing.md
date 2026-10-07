# Account billing and customer developer keys

Work order: B04.BILLING, prompt `01a114a7-e090-7373-8c29-ae107a5b08fa`, owner Codex.
Branch `feature/stripe-plan-catalog`, worktree
`F:/Diomedes/diomedes-wt/stripe-plan-catalog`, base
`bae249b60ffafa3934d775c6d59fbac80990a83e`.
Companion site: `feature/stripe-account-billing` in
`F:/Diomedes/diomedes-site-wt/stripe-account-billing`.
Canonical repository documents reviewed at version 2026-10-06.1.
Andrew authorized isolated implementation, both paid app usage and the customer
developer API, browser setup, and committing the completed candidate.

## Behavior

The desktop and Account Center request subscription Checkout and customer portal
sessions using their existing authenticated account boundaries. Prices and the
Stripe customer are resolved by the server. Only Individual and Business have
fixed self-service terms. Individual requires the eligibility affirmation;
business entities and sole proprietorships do not qualify, freelancers do.

Verified invoice/subscription events enter the existing signed webhook router
and inbox. Reconciliation fetches current Stripe state under a customer lock,
validates the exact paid monthly invoice, and atomically writes plan grants,
access revisions and billing-system audit rows. Included credits continue through
the existing funding service; no second balance or permission model is created.
Duplicate and reordered events cannot revive revoked invoice grants. Refunds,
disputes and credit notes conservatively hold the customer's subscription access
for manual review, including a refund associated with a different purchase on
the same Stripe customer. Holds are durable and this slice provides no release
operation. Portal cancellation is at period end; automatic plan switches and
quantity changes are disabled in the prepared test portal.

Customer developer keys are hashed, scoped, expiring, revoke-once credentials.
They are accepted only by `/developer/v1/*`, with explicit metered-work usage,
and use the same admissions, routes, funding and provider gateway as the app.
See [the developer contract](../developer-api.md).

## Activation configuration

Apply migration `021_account_billing.sql` through the normal reviewed migration
runner, then the amended runtime permissions. No production database was changed
by implementation or validation. Keep the flags off until configuration and a
complete hosted test are accepted:

- `STRIPE_SUBSCRIPTIONS_ENABLED=1` enables Checkout and subscription handlers.
- `STRIPE_SUBSCRIPTION_CATALOG` is an exact JSON array of reviewed
  `{id,priceId,amountCents}` rows. It contains no secret. Preserve the existing
  Dashboard native IDs; never recreate a price to repair a missing mapping.
- `STRIPE_SECRET_KEY` is a server secret matching the selected environment.
  Restrict it to the used customer, Checkout, portal, price, subscription,
  invoice and charge operations. Never place it in a website or desktop bundle.
- `STRIPE_WEBHOOK_SECRET` is the signature secret for the deployed
  `/billing/stripe/webhook` endpoint. Keep `STRIPE_WEBHOOK_SECRET_PREVIOUS` only
  during a controlled rotation. API version is `2026-08-26.dahlia`.
- Subscribe to existing `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, plus `invoice.paid`,
  `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`,
  `customer.subscription.created/updated/deleted`, `charge.refunded`,
  `charge.dispute.created`, and `credit_note.created`.
- Preserve reviewed `CREDIT_RATE_PLAN` and `CREDIT_RATE_FREE` settings for top-ups.
- `DEVELOPER_API_ENABLED=1` exposes key issuance and the developer routes after
  migration, runtime permissions, routing, funding and identity are ready.
- Production subscription grants require `STRIPE_LIVE=1`. Test keys and test
  prices must stay on an isolated development database.

The customer portal must be configured in each Stripe mode. The test default
portal was saved with `https://nectovia.diomedes.net/account#plan` as its return
URL. Checkout uses fixed success/cancel variants of that same Account Center.
Customer webhooks, not the browser return, confirm payment.

## Verified external state and launch limits

On 2026-10-07 the Stripe plugin confirmed charges enabled, payouts enabled,
details submitted, and empty currently-due/pending-verification requirements.
The default USD bank was verified Mercury (Column NA), with daily scheduled
payouts and a two-day delay. This is configuration evidence, not a payout receipt.
Six test Products/Prices already exist; account-specific IDs and screenshots are
retained outside Git. No real charge, customer subscription or payout was made.

Still required for launch: live price mapping, restricted server credential,
live portal, endpoint/signing secret, tax treatment and applicable registrations,
production migration/deployment, and a hosted end-to-end payment-to-access test.
Starter needs a reviewed exactly-three-payment schedule and end behavior. Managed
agreements need their actual quoted amount and approved scope. Founding offers
and launch credit promotions are not automatically applied by this candidate.
Do not mark B04 DONE from a local commit or these prerequisite checks.

## Validation

An isolated Neon branch `stripe-billing-validation`, with schema only and no
copied customer records, contains a disposable `b01_validation_stripe_billing`
database. The branch expires 2026-10-08 at 06:00 UTC. All 21 migrations applied
and a second migration run was idempotent. Five PostgreSQL tests passed under the
actual `cp_runtime` login: serialized Checkout, Business and Individual grant
replay/revocation, foreign events/refund holds, and hashed key revocation and
privileges. An initial event shape failure exposed an extra personId passed to
the strict payment ledger; the handler now names only the verified ledger fields.
Final candidate checks:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| App broad unit suite | 10,314 | 2 | 5 |
| Isolated recheck: both failed files, account host and catalog | 107 | 0 | 0 |
| Control-plane unit suite | 1,273 | 0 | 87 |
| Final billing, developer-key and Worker checks after final route edits | 26 | 0 | 0 |
| Isolated PostgreSQL, final candidate | 5 | 0 | 0 |
| Required app browser suite | 36 | 0 | 0 |
| Website account/proxy unit checks | 36 | 0 | 0 |
| Website account, billing and pricing browser checks | 37 | 0 | 0 |

Root and control-plane TypeScript, Vite, control-plane Worker dry-run build,
website production build and copy check passed. The website build reports two
unused-variable hints and 101 advisory voice warnings, zero fail-level warnings.
Counts overlap across focused reruns; do not sum them into a unique-test total.
The 87 control-plane skips include the five PostgreSQL checks run separately.

The broad app failures were `automatic-work-host.test.ts` waiting for a writer
Need and `scoped-work.test.ts` exceeding 30 seconds in its twenty-edit test.
Both files passed in the isolated rerun, without changes to their implementation
or assertions. Their load-sensitive failure remains unresolved; the broad gate
is not reported green. This candidate is committed for review, not merged or
deployed. No installed-app, real-provider, real-payment or payout acceptance.

A read-only Cloudflare secret-name check confirmed the account Worker does not
yet have STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET. No secret values were read.
The Stripe plugin planner became available after reconnect and confirmed the
hosted Checkout, portal, fixed subscription and assisted quote/schedule approach.
Tax obligations remain for business review; no registration was guessed.
