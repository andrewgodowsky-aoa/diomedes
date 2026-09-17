# B00 — zero-budget vendor decision and shared commercial contracts

Date: 2026-09-16. Node `B00.I` of the unified execution package
(`Diomedes_Unified_Execution_Package_2026-09-13`, prompt `03a`). Implementation
lead: Devin (SWE-2) occupying the fable integrator seat per the recorded
precedent. Independent review on 2026-09-17: the repaired B00 subset passed
`B00.R` (prompt `04a`). See [the independent acceptance record](2026-09-17-swe2-independent-acceptance.md)
and `evidence/unified-20260913/B00.R.json` for the exact interface digest,
integration scope and current results. H01 did not pass and is excluded.
This document began as the producer's implementation record; `B00.I.json`
is retained unchanged as historical evidence, not the current verdict.

Base: `e2c1e15` (main `5da4fec` merged with the C00 record through `8ff9136`),
worktree `diomedes-wt/devin-b00-h01-20260916`, branch `devin/b00-h01-20260916`.

## 1. What was built

`services/control-plane/contract/` — a provider-neutral contract module (new
top-level tree; `tsconfig.json` include widened for it):

- `contract.ts` — `CONTROL_PLANE_CONTRACT_VERSION = 1`; `verifySubject`
  (hosted-source-only verified external-subject mapping; a development
  fixture is refused by source, never by field quality); `assertMembership` /
  `assertionStale` (tenant-bound membership stamped with live Trust
  generations); `EntitlementSnapshot` + `snapshotAt` (active/expired/revoked/
  unknown read at observation time) and `snapshotFromView` (today's
  `EntitlementView` can only adapt to `none`); `kindEligibility`
  (`unknown` for unclassified kinds — never coerced to free); the
  discriminated `ManagedAdmission` outcome union (`denied | accepted |
  running | finished | failed | uncertain`); `decideAdmission`, the gate
  order as a pure predicate matching `ManagedGateway.admit`;
  `CredentialLease`/`leaseUsable` (opaque host-held handle, generation- and
  expiry-checked, no secret material); `FeatureAvailability` (evidence-bound,
  not price-bound); `payerKindFor` (the only bridge between the managed-usage
  and execution payer vocabularies); `CONTROL_PLANE_SOURCES` (the one
  authority per domain) and `CLOUD_SCHEDULER = null`.
- `vendors.ts` — `VENDOR_ALLOWLIST` (existing Cloudflare Workers static-assets marketing, Cloudflare
  Workers Free control-plane, WorkOS AuthKit identity, Neon Free Postgres,
  Stripe test-mode-first; Vercel recorded as a non-selected future adapter)
  with per-vendor rejected paid add-ons; `SPEND_POLICY` deep-frozen at USD 0
  new fixed and USD 0 unapproved variable; `applySpendOverride` — a refusal
  record for any questionnaire/model/settings input.
- `fixtures.ts` — the named normative scenarios: `active`, `expired`,
  `unknown`, `development-fixture`, `security-suspended`, each with its
  expected admission decision.
- `index.ts` — the module surface.

`server/managed-gateway.ts` — `GatewayDependencies` gains `billingStatusFor`,
and a security suspension refuses the managed path (`security_suspended`)
before entitlement is consulted. The check sits only on the managed branch:
a suspended company account cannot hold a person's own BYO key or a local
route hostage.

## Repairs after independent review (2026-09-17)

Codex's independent review (`swe2-b00-h01-review-20260917`) found the expiry
and clock predicates failing open on `NaN`. The repairs, all fail-closed:

- `leaseUsable` refuses an unreadable observation clock and an unreadable
  lease expiry before any comparison — `Date.parse` results are proven
  finite, never assumed.
- `snapshotAt` reads an unreadable clock or marker as undetermined: an
  `active` claim degrades to `unknown`, while a recorded refusal (`none`,
  `revoked`, `expired`) is never re-labelled.
- `assertMembership` refuses an unreadable observation time.
- `ManagedGateway.admit` returns a controlled `invalid_clock` refusal instead
  of minting `new Date(NaN)` into a `RangeError`.
- `verifyAuthorization` refuses an unreadable authorization expiry or
  observation time.
- `AllowanceLedger.reserve` refuses a non-integer or non-finite
  `maxMicroUsd` (`invalid_ceiling`) and an unreadable reservation clock
  (`invalid_clock`) before any hold is written.

`vendors.ts` gained the dated evidence layer: every selected vendor carries
its finite free-tier `limits`, dated primary `sources` (`asOf` ISO dates) and
an explicit `accountState: 'unverified'` — no account was observed or
provisioned. The independent pass corrected the existing site's hosting
description, Neon's finite Free quotas and Stripe's fees. Stripe Billing
pay-as-you-go remains the planned integration; it adds a variable fee and
is not enabled here. Processing, disputes and optional products have their
own fees. The zero is permission for new spend, not an observed account bill.

The independent pass also repaired invalid membership/lease generations,
missing or future entitlement issuance, invalid snapshot revisions and an
empty revocation marker. Each now refuses authority rather than accepting
matching invalid values. Historical records and explicit revocation retain
their precedence.

`server/app.ts` — wires `billingStatusFor` to the existing
`BillingEventProcessor.statusOf`. No new service, no new writer.

`docs/product/personal-business/09_ZERO_BUDGET_VENDOR_DECISION.md` — the
vendor/features/fees decision in the PB series' vocabulary.

## 2. What was deliberately not built

No B01–B04 functionality: no control-plane worker, no WorkOS integration, no
checkout, no hosted membership service, no scheduler, no live credentials.
`entitlementFor` still answers `none`; the contract exists so installing real
predicates is a matter of producing records these predicates consume — not of
widening types. Unknown never coerces: unclassified charge kinds refuse,
unknown entitlement refuses, and `unknown` availability is a readable state.

## 3. Acceptance mapping

| required case | where it is proven |
|---|---|
| Personal with cloud offline uses local/BYO | contract/gateway cases plus a fresh `createApp` HTTP fixture dispatching BYO once through the real `EngineService`, with no hosted identity or entitlement |
| dev-fixture cannot become verified by editing settings | contract refuses fixture provenance; the HTTP acceptance test submits forged paid/hosted settings, receives 400, and verifies fixture assurance remains |
| paid invoice cannot override suspension | contract fixture `security-suspended` + `ManagedGateway` test `a paid invoice cannot override a security suspension` |
| missing rate-card limit is unknown, managed refuses | `kindEligibility` → `unknown` → `charge_kind_unknown` refusal |
| USD 0 cap cannot be changed by questionnaire or model output | `applySpendOverride` refuses both shapes; `SPEND_POLICY` frozen |
| one identity source | `VENDOR_ALLOWLIST` has exactly one selected `identity` vendor: `workos-authkit` |
| one local writer | `CONTROL_PLANE_SOURCES.allowanceWriter = server/managed-usage.ts` (the `AllowanceLedger`) |
| one budget semantic | `CONTROL_PLANE_SOURCES.budgetSemantics = shared/managed-usage.ts` (integer micro-USD + versioned rate card) |
| no cloud scheduler | `CLOUD_SCHEDULER = null`; `CONTROL_PLANE_SOURCES.scheduler = null` |

## 4. Evidence

The independent integration run passed TypeScript, the production web build,
1,921 unit tests (one skipped, zero failed, 104 files), and all 67 browser
tests. This includes 22 contract cases, 18 new independent B00 cases and 16
gateway cases. Counts are from one final integration run, not historical sums.
Exact commands and logs are in the acceptance record linked above.

The producer's mixed B00/H01 repair suites and the full corrected review
candidate are archived under
`F:/Diomedes/deliverables/swe2-acceptance-20260917/`; those suites are not part
of the B00-only merge. `B00.I.json` describes that older mixed candidate.

The HTTP acceptance test uses an explicit transport fixture; it proves host
admission and settings isolation, not a real provider response. No live
provider, account provisioning, packaged application, publication or deployment
was exercised. `verifySubject` validates a trusted hosted record's shape and
provenance; it is not an OIDC/JWT verifier or a new effect-permission authority.
