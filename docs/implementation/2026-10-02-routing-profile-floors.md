# Routing profile floors (DIO-152), 2026-10-02

Before this change, Balanced and Lowest cost behaved like Strict. The Console saved Strict's
restrictions for every new account, and the evaluator applied stored restrictions to every profile.
The Balanced exceptions that the 09-27.1 disclosure described could not be created or validated.

## Owner decisions

Andrew answered on 2026-10-02 at about 21:40 EDT:

- **E1.** The Balanced hard floor is no training only. This replaces the issue's proposed
  `BALANCED_RESTRICTIONS` with zero retention.
- **E5.** Lowest cost is also no training only, and picks the cheapest qualified route across
  providers and models. His example: when OpenAI direct is cheaper than Azure for the same model,
  Lowest cost uses OpenAI even though OpenAI retains content. Strict stays US, verified zero
  retention and no training. Balanced prefers zero retention above the no-training floor.
- **E6.** A new consent version now: `NC-SETUP-2026-10-02.1`.

The following were taken from the issue's recommendations, not from owner answers:

- **E2, E3 and E4** are moot. The new version has no exceptions.
- **E7.** `ZZ` means "region not pinned".

## Behavior

| Profile | Hard floor | Order among eligible routes |
| --- | --- | --- |
| Strict | `STRICT_RESTRICTIONS`, unchanged: US ingress, decryption and processing, verified zero retention, no training, no transient cache | Published order |
| Balanced | `NO_TRAINING_RESTRICTIONS`: no training; an evidenced transient provider cache is allowed | Verified zero retention first, pinned US second, published order within a rank |
| Lowest cost | `NO_TRAINING_RESTRICTIONS` | Bounded estimate for this request, primary included. A price tie goes to the Balanced privacy rank, then published order (the setup document's "Prefer US/ZDR when otherwise equivalent") |

- **Floors.** `PROFILE_FLOORS[profile]` is added to every evaluation. A stored row can only narrow
  it. For Strict this is the same `STRICT_RESTRICTIONS` push as before.
- **Verified zero retention for ranking.** This uses the same evidence Strict demands, including
  the AWS retention-mode check.
- **Pinned US.** Every recorded country must be `US`. An OpenRouter route also needs US ingress on
  an entitled connection and entitlement evidence (issue item 5).
- **Unpinned routes.** A route recorded with `ZZ` is refused with `geography_unpinned` wherever a
  restriction names countries.
- **Reference price.** Lowest cost still never goes above the primary's reference price
  (`reference_price_limit`, unchanged). The disclosure promises this.
- **No exceptions.** Balanced under the current version has no exception path. A Balanced row
  accepted under 09-27.1 keeps its old exception gate until the owner saves again. The stricter
  "preferred" test (AWS retention mode, OpenRouter proof) applies to that legacy gate too, which
  only narrows it.

## Writes

- **Writes require the current version.** `routingPreferenceWriteSchema` accepts only
  `NC-SETUP-2026-10-02.1` with an empty `exceptions` list.
- **Old rows still parse.** Stored rows accept both versions.
- **Weak limits are refused.** `acceptPreference` returns 422 when the posted restrictions are
  weaker than the chosen profile's floor (`restrictionsCover`).
- **Server-stamped acceptance.** `acceptedAt` and `acceptedBy` were already set on the server.
  With exceptions gone, there is no client timestamp left to stamp.
- **The Console writes the floor.** It writes exactly `PROFILE_FLOORS[profile]`. The limits line
  shows the chosen floor. A notice names what saving gives up when the chosen floor is looser than
  the stored one. A row saved under 09-27.1 asks to be saved again.
- **Browser coverage.** `tests/operations-routing-journey.spec.ts` drives the relaxation step: Strict
  to Balanced, the notice, acceptance, revision 2. The issue's offers panel no longer exists.

## Mandatory default

The default mandatory floor was `PRIVATE_RESTRICTIONS`. It forbade transient caching for every
account, so routes with automatic provider caching (Azure OpenAI prompt caching) could never serve
anyone. The default is now `DEFAULT_MANDATORY_RESTRICTIONS`, which is no training with an evidenced
transient cache allowed. Strict still forbids the cache through its own floor.

The first global publication writes the live default into its `mandatory` field, and later
publications carry it forward (`routing.ts`, publish). On 2026-10-02 the live accounts database
held no tier policy and no routing preference (read-only query on `accounts_staging`), so the new
default is the one the first publication will record. `PRIVATE_RESTRICTIONS` itself is unchanged,
because `STRICT_RESTRICTIONS` spreads it.

## Selection and receipts

- **Uncapped list.** `resolveRoutingCandidates` also returns `ranked`, every eligible route in
  order before the attempt cap.
- **Rechecks.** The gateway rechecks a selected route against `ranked`. Price ranking under the
  larger encoded envelope can reorder routes, which would push a still-eligible selected route out
  of the capped window.
- **Publication preview.** The preview reports `ranked` as each tier's eligible list. An override
  whose eligible primary is outranked no longer fails the "primary conflicts" check.
- **Receipt reason.** When the profile ranks an eligible primary lower, the receipt and the
  `X-Nectovia-Fallback-Reason` header say `ranked_by_profile`, not `primary_unavailable`.
- **Advertised route.** The snapshot's advertised route uses the 1-token preview envelope, where
  prices nearly tie, so it usually stays the primary. The real request ranks by its own estimate.

## Limits and follow-ups

- **Disabled fallback.** With `fallbackEnabled: false` only the primary is a candidate. Lowest cost
  then cannot choose a cheaper route, and Balanced cannot move a retaining primary behind a
  zero-retention backup. Staff enable fallback (`maxAttempts` may stay 1) to let a profile choose
  among routes. A real providers-by-models matrix belongs to DIO-145.
- **Receipt wording.** A first attempt that the profile ranked ahead of the primary reads "Chosen by
  the routing preference." on the receipt, not "Backup reason". Nothing else reads the
  `X-Nectovia-Fallback-Reason` header.
- **Installed builds.** The Console ships inside the desktop app; the Worker serves no Console
  assets. After this deploys, a build that predates it gets a 422 when saving routing settings. A
  rebuild from main is needed first.
- **No migration.** `account_routing_preferences.record` is JSON with no check on `consentVersion`
  (migration 010).
- **Consent document.** The new dated disclosure for the Drive setup-quiz document is drafted in
  `F:/Diomedes/deliverables/dio152-routing-profile-floors-20261002/` for Andrew's approval. Drive
  was not edited.
- **Untested recheck.** No dispatch test forces the encoded-envelope reorder. It depends on exact
  provider-body byte counts. The pure tests cover the uncapped `ranked` order.

## Gates (2026-10-02, under the heavy slot, from main d91a94f plus this change)

- Root `npx tsc --noEmit` passed.
- Root `npx vitest run`: 9,016 passed, 5 skipped, 1 failed. The failure was
  `tests/remembered-approvals.test.ts`, a 15-second `vi.waitFor` timeout under load. That file passed
  65 of 65 alone.
- `npx vite build` passed.
- Playwright: `tests/ui.spec.ts`, `tests/native-ui.spec.ts`, `tests/field.spec.ts` and
  `tests/operations-routing-journey.spec.ts`, 36 passed. The journey saves Strict through the new
  screen.
- `services/control-plane`: `npm run typecheck` passed. `npm test`: 970 passed, 55 skipped (52 files
  passed, 5 skipped).
- The Postgres-backed `scoped-routing-postgres.integration.test.ts` was skipped. It needs a
  disposable database.
- Follow-up (receipt wording, journey relaxation step, plainer unpinned message), same night:
  root tsc passed; the two routing test files passed (79); `npx vite build` passed; the same four
  Playwright specs passed (36).
