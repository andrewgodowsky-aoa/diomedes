# Stripe sandbox plan catalog

Continuation: [account billing and developer keys](2026-10-07-account-billing.md)
supersedes the earlier readiness limits below. The owner clarified both paid app
usage and the customer API. The plugin now verifies live activation and the
Mercury payout bank. The dependency problem was resolved using an existing
complete worktree dependency folder; full TypeScript now passes. Historical
first-pass results below are retained as evidence, not current status.

Owner request: 2026-10-07, Mercury setup, payment-provider comparison and preparation for real tier payments and paid API usage. Andrew explicitly approved a new isolated worktree after the existing checkout was found dirty.

Work order: B04.CATALOG, a bounded prerequisite of DIO-44. Owner: Codex in chat `01a114a7-e090-7373-8c29-ae107a5b08fa`. Branch: `feature/stripe-plan-catalog`. Worktree: `F:/Diomedes/diomedes-wt/stripe-plan-catalog`. Base: `bae249b60ffafa3934d775c6d59fbac80990a83e` from freshly fetched `origin/main`. The local `main` and primary checkout were older and were not changed.

Pillars, roadmap and project-memory repository mirrors all report version `2026-10-06.1` at that base. No product definition changes. No cloud canonical write. B04/DIO-44 remains open; this does not implement subscription fulfillment or certify live payments.

## What this slice does

`scripts/stripe-plan-catalog.ts` accepts a reviewed JSON manifest derived from the public site's `src/data/pricing.ts`. It prepares one Product and one monthly USD Price per paid plan. It validates all six unique plans, integer amounts and a source commit. No commercial prices or user configuration are committed with the script.

The default is offline preparation, with no credential or network use. `--inspect` reads a sandbox and reports missing objects; `--apply` creates missing Products and Prices. Both online modes require `STRIPE_SANDBOX_KEY` and the expected `--account acct_...`. Test keys and matching account identity are required before any catalog request. Use a restricted key with only the account read and Product/Price permissions needed for the chosen operation, supplied through a secure local environment. Never put the key in a command argument or manifest.

The tool checks the whole existing catalog before writing. It refuses mismatched or archived objects, duplicate lookup keys, live objects, different amounts, billing cadences, credit descriptions and quantity transforms. Stable Product IDs, versioned lookup keys and request idempotency keys support safe inspection after an interrupted run. Writes can partially succeed: a failure is reported, and a fresh inspection/retry reconciles existing objects. It never changes, archives or deletes existing objects, transfers lookup keys, creates customers, creates Checkout Sessions, subscribes anyone or issues grants. Product/Price metadata is descriptive and cannot grant runtime access or credits.

This follows the existing account service's REST/fetch convention and pinned API version `2026-08-26.dahlia`; it adds no SDK or dependency. A Stripe API-version upgrade is a separate verified change. Redirects are refused, requests have a deadline, and Stripe/transport error contents are not printed.

## Run

From this worktree, using the existing `tsx`:

```powershell
& .\node_modules\.bin\tsx.cmd scripts/stripe-plan-catalog.ts --catalog C:/path/to/reviewed-catalog.json
& .\node_modules\.bin\tsx.cmd scripts/stripe-plan-catalog.ts --catalog C:/path/to/reviewed-catalog.json --inspect --account acct_EXPECTED
& .\node_modules\.bin\tsx.cmd scripts/stripe-plan-catalog.ts --catalog C:/path/to/reviewed-catalog.json --apply --account acct_EXPECTED
```

Manifest schema: `version`, `sourceCommit` (full Git SHA), `currency: "usd"`, and `plans` containing `id`, `name`, `amountCents`, `includedCredits`, plus optional `existingProductId` for a reviewed Dashboard-created Product. Existing mappings must be unique; missing mapped products fail rather than being recreated. IDs: `individual`, `business`, `workflow-starter`, `managed-small`, `managed-standard`, `managed-plus`. All six are required exactly once. Refresh and review the pricing source before applying; the source hash records provenance and is not an automatic attestation that the numbers are approved.

## Dashboard preparation

The owner signed into Mercury and Stripe through the in-app browser. Stripe's browser context confirmed `livemode: false`; the Dashboard identifies the selected account as `diomedes.net (Mercury [Test mode])`. Its entire product catalog was initially empty. Six Products and monthly Prices were created through Dashboard forms using public pricing version `2026-10-05.1` at site commit `f823f49688672156aa8c1161255e958ecce0e520`. Each Product has its plan ID metadata; each Price has a versioned lookup key and descriptive plan, credits, source commit and catalog version metadata. The local external manifest preserves these native Product IDs. No customer, charge, subscription, entitlement or live catalog was created.

Account-specific IDs, public amounts, a browser receipt and screenshot are retained outside Git in the current chat's output folder. Stripe plugin discovery still returned `UNAUTHORIZED` after the owner reported reconnecting. Dashboard access worked; the CLI's online reconciliation has not been run against Stripe. The owner was handed the final onboarding agreement submission; activation and a successful payout are not established by catalog creation.

## Required continuation

- Confirm the intended Stripe sandbox/account through the plugin when its expired connection is restored. The plugin's account-specific implementation planner was inaccessible because account discovery required reauthentication; current Stripe documentation and the plugin's local billing, payment and security references informed this preparation.
- Reconcile existing merchant-created Products/Prices before choosing this namespace. Stable IDs prevent this tool duplicating its own objects; they cannot detect every independently named human-created product. Do not run against an unreviewed existing catalog.
- Keep Individual customer ownership separate from Business organizations. Derive the Stripe customer and plan eligibility on the server; never accept an arbitrary customer's ID from a browser.
- Implement subscription Checkout, authenticated customer portal creation and subscription/invoice handlers through the existing verified router/inbox. Only a verified paid invoice and current subscription state can extend entitlement and allocate a new included-credit period. Handle duplicates, reordered events, failures, cancellations, refunds and disputes without reviving revoked authority.
- Read actual invoice/subscription boundaries for billing periods. Do not bill a calendar month as a fixed 31 days. Starter needs exactly three monthly payments and an explicit end behavior; creating its monthly Price does not implement its 90-day commercial term. Managed includes Business, not an additional Business charge.
- Configure founding discounts separately and privately after eligibility is confirmed. A blanket 30% coupon would wrongly discount included usage. The Individual launch-credit offer remains unresolved in DIO-266 and is not applied here.
- Preserve existing server-quoted credit purchases. On-plan and no-plan rate settings are separate from monthly Products/Prices. A new public developer API would also need a defined API contract, credentials, metering and spending limits; the owner's meaning of "paid API" is pending.
- Use separate Stripe sandboxes for development and CI. Do not assume a test key identifies a separate sandbox instead of the account's shared test mode; verify the selected sandbox in the Dashboard.
- Before live use, inspect Stripe Tax settings and active registrations, select the correct product tax treatment, and test the calculation. This catalog does not enable tax or register the company anywhere.

## Verification

Focused unit tests: 31 passed, 0 failed, 0 skipped. Focused TypeScript check of the new script and tests: passed. These checks use a local fake Stripe server function and do not prove online CLI reconciliation or hosted application acceptance.

After the exclusive test slot became free, the full repository TypeScript gate ran and failed with 72 diagnostics. The primary checkout's shared dependency folder is missing packages used by current main, including `ai`, AI SDK provider packages, `mermaid` and `katex`; the log also contains consequent type errors. No diagnostic names either new TypeScript file. The focused TypeScript check passes. This is an environment limitation, not a claim that the whole application passes.

Full unit, Vite and browser gates remain unrun following that failed prerequisite. No commit, push, merge or deployment. Dashboard Product/Price provisioning is complete in test mode; online CLI reconciliation, sandbox checkout, a live payment and Mercury payout reconciliation remain unrun. DIO-44/B04 is not DONE.

## References

- [Stripe Products](https://docs.stripe.com/api/products/create)
- [Stripe Prices](https://docs.stripe.com/api/prices/create)
- [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Customer portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [DIO-44](https://linear.app/diomedesdevs/issue/DIO-44/b04-stripe-hosted-checkout-and-customer-portal-in-test-mode)
- [Merged billing foundation, PR 231](https://github.com/andrewgodowsky-aoa/diomedes/pull/231)
