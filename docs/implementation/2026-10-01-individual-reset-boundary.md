# DIO-128: the Individual reset boundary (2026-10-01)

Repository: `andrewgodowsky-aoa/diomedes`. Branch: `feature/individual-reset-boundary`, built on
main `41786c7` (PR #184) merged with PR #180's head `0fa92a6` (the Individual funding candidate,
migration 011), which is still unmerged. This patch therefore carries PR #180's commit as well.

Andrew directed on 2026-10-01 that the 2026-09-30 reset-boundary plan be implemented and
published as a pull request. That plan recommended subscription-anniversary months; this record
treats the direction to build it as the selection of that policy for implementation. It is not
a claim that canonical pricing, the launch checklist or the Drive documents were updated (see
"Cloud and other repositories" below).

The three repository canonical mirrors report version **2026-09-27.2**. Nothing here changes a
pillar's meaning: Individual stays Personal-only, 1,000 credits per paid month, no carryover.

## The rule

- An Individual billing period is `[startsAt, endsAt)`, a subscription-anniversary calendar month
  in UTC, computed from the subscription's verified effective start (`anchorAt`) and a zero-based
  index: never by adding 31 days, and never from the previous, possibly shortened, boundary. A
  January 31 anchor runs to February 28 (or 29), then March 31, then April 30, all at the anchor's
  UTC time of day. A September 30 anchor's first term ends October 30. Daylight saving changes
  nothing. (`shared/individual-period.ts`)
- One paid term funds exactly 1,000 credits. Unused credits expire at `endsAt`. The next paid term
  starts at 0% with 1,000 credits. A renewal date alone grants nothing.
- Business and explicit agreements keep their UTC calendar months (`periodIdFor`, `monthBounds`).

## Implemented

**Issuance (`services/control-plane/src/commercial.ts`).** The catalog's Individual plan now has
`termDays: null` and `billingInterval: 'month'`; every other plan keeps its day count. A complete
Individual grant (the Agent with included usage, or the full phase-2a template) records the one
term it pays for as `billingCycle`. The server computes both boundaries. A person's first
subscription anchors at `validFrom` (or now). Every later complete grant must name its term: a
renewal names the next index, a replacement after withdrawal names the same term under its own
reference, and a genuinely new subscription after a lapse names a new anchor. The validity
interval must lie inside the term; a submitted end date cannot move it. Refused: an elapsed term,
a term overlapping another recorded term, a term over a still-current grant from before monthly
terms, or over a current explicit agreement on the account. One reference pays for one term: an
identical replay returns the original grant (no new audit row, no revision bump); any other replay
of that reference is refused. Limited overrides keep explicit dates and cannot carry a term.
Historical grant records are read unchanged; the record's tombstone rule keeps a term immutable.
Operations' person view gains `individualTerm` (anchor, current term, next term).

**Funding (`services/control-plane/src/funding.ts` and adapters).** `allocateIndividualPeriod`
records a term's row, `individual:<startsAt>`, on first use: exactly 1,000 credits, bounds equal
to the term, only while the term is current, never overlapping another term. A row that exists is
returned unchanged whichever current grant asks, so grants naming one term share one balance and
the row's historical source is never rewritten. `reserve` takes the server-resolved term
(`individualCycle`), reads the time after taking the billing-scope lock, and refuses an ended term
(`period_ended`). Without a term (Business, agreements, grants from before terms) it keeps the
calendar month, except that a calendar Individual or agreement row no longer funds a moment an
anniversary term covers (`period_superseded`). `markDispatched` reads the time after the lock and
releases an unsent hold whose Individual period has ended instead of sending it, even after a
renewal (`period_ended`). Dispatched and uncertain holds, late settlement, the original payer and
period, job caps and the company ceiling are unchanged. The faux store now enforces the period
key, as PostgreSQL does. `FundingTransaction.periods` is new, in both adapters.

**Gateway (`managed-inference.ts`).** Individual `ensurePeriod` resolves the current term from the
person's current complete grants (`currentIndividualCycle`), allocates it if absent and binds the
reservation to it. It never selects a term by which grant ends last, and a current term grant
whose term is not in force never falls back to a calendar month. Grants without a term keep the
calendar path. Business is unchanged.

**Migration 012 (`012_individual_subscription_periods.sql`).** Additive; 001 to 011 are
byte-identical. It replaces the 003 period-id check with one that keeps every `YYYY-MM` id and
admits `individual:<UTC start>` for Individual rows only; replaces 011's calendar-only source
function so a term row must be exactly the term its source grant names (bounds recomputed from
the anchor with PostgreSQL's clamping month arithmetic, id equal to its start, recorded inside
the term, 1,000 credits), while grants without a term keep 011's calendar rule; serializes on the
ledger's own advisory lock and refuses overlapping terms; and adds a reservation trigger: a new
hold binds to an Individual period it was reserved in, a calendar row no longer funds a moment a
term covers, and no Individual hold is dispatched at or after its period's end. Re-saving an
existing reservation is never blocked, so late settlement lands under 011's foreign key. No role,
grant or permission is widened; the new invoker function reads only rows `cp_funding` already
reads. `scripts/migrate.ts` registers it.

**Personal read.** `GET /account/usage` (control plane, real and faux Worker) and
`GET /api/account/usage` (desktop) answer the signed-in person's own credits for the current
term. Read-only and person-bound: nothing in the request names a person, account or period.
Before first use it projects the term's 1,000 credits at 0% with `allocation: 'pending'`;
afterwards ledger totals with `recorded`. `renewal` says whether the next term is already paid
for. No account, no current plan, a disabled account or a failed read is unavailable, never zero.
The desktop drops an answer for another person, another account, a non-Individual plan or an
ended period, and reuses a verified answer for at most 15 seconds and never past its period.
This is implemented in `CommercialService.personUsage` rather than the plan's suggested
`UsageService.individualUsage`, because the commercial service already owns the person's grants
and account; the read still goes through `FundingService`.

**Console.** Account settings shows "Your Individual credits" with the existing usage renderer,
parameterized by scope: period-neutral words ("Used this billing period"), the exact UTC end as
"Current credits expire …", and "a new allowance needs a renewal" or "the next billing period is
paid for and starts then". At the end the old figures stop showing and the section reads again;
the browser never computes a balance. Business usage keeps its calendar-month wording. Nothing
renders before the person has an Individual account.

## Verification

Run on this Mac (Node 22, `NODE_OPTIONS=--max-old-space-size=4096`, real `TMPDIR`, Vitest at two
workers) against commit `242e852`, in a detached checkout outside `.claude/` (the desktop path
guard refuses `.claude`, so running the root suite inside a `.claude/worktrees/` checkout fails
654 path-guard tests for reasons unrelated to this patch). Logs: `evidence/dio-128/2026-10-01/`.

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx vitest run` | 525 files passed, 2 skipped; 8,668 tests passed, 32 skipped |
| `npx vite build` | pass |
| Playwright `ui`, `native-ui`, `field` | **not run**: the Chromium binary is not installed on this Mac; 13 failed at browser launch, 23 did not run |
| control plane `npm run typecheck` | pass |
| control plane `npm test` | 47 files passed, 5 skipped; 749 tests passed, 52 skipped |

The Playwright gate is therefore outstanding. PostgreSQL is not installed on this Mac, so the three PostgreSQL
suites (`individual-funding-postgres`, `postgres`, `scoped-routing-postgres`) were **skipped, not
passed**. The new 012 cases in `individual-funding-postgres.integration.test.ts` and migration 012
itself have therefore never run against a real database. That is the first gate before review
is complete.

## Not done here

- **Operations (`diomedes-ops`) and the site (`diomedes-site`).** Not checked out on this Mac and
  not reachable with its credentials. Required, in their own repositories: Operations'
  `IssueIndividual` must stop computing a 31-day, end-of-day `validUntil`, submit an explicit UTC
  start or `billingCycle: { anchorAt, index }` (the person view's `individualTerm.next` gives a
  renewal's), and show the server-returned term; `Customers.tsx` should show the current term and
  usage beside explicit agreements. **Until Operations is updated, issuing a complete Individual
  grant from its current form is refused** (`outside_billing_period`), which is the safe failure
  but blocks staff issuance; deploy the two together. The site's pricing data and page need the
  Individual-only anniversary, expiry, renewal and cancellation wording and the removal of the
  stale sole-proprietor exception (DIO-136).
- **Browser journey.** `tests/operations-routing-journey.spec.ts` needs `NECTOVIA_OPS_REPO` and was
  not run.
- **Cloud and other records.** The canonical Drive pricing document, the September 30 launch
  checklist, the Drive Pillars/Roadmap/Project Memory, DIO-128 and PR #180's description were not
  edited. The repository mirrors of the three canonical documents are unchanged so they keep
  matching their Drive versions. Proposed canonical wording, for the owner to apply: "An
  Individual billing period runs from the subscription's verified start to the same day and UTC
  time the next month (clamped to a shorter month's end). Each paid period includes 1,000
  credits, which expire at its end; nothing carries over, and a renewal date alone grants
  nothing." `docs/business/PRICING_STRATEGY_2026-09-15.md` and `QUESTIONS.md` O45 carry it.
- **Rollout.** No migration was applied anywhere, nothing was deployed, and the real database's
  state (whether 011 is applied, whether funded Individual rows exist) was not inspected. Before
  rollout: verify the Worker environment and applied migrations, rehearse 011-to-012 on a
  disposable copy, and follow the existing-customer treatment in the plan (legacy grants keep
  their calendar funding through their current term; an active agreement is never topped up).
- Self-service checkout and automated payment collection remain separate launch requirements.

## Required status report

**Pillar impact:** advances billing clarity, bounded spending, durable history and the
Personal/Business separation (Pillars 09 and 12) without changing their meaning. Proof: the
period, issuance, funding, gateway, migration and UI tests named above.

**Roadmap impact:** DIO-128's reset boundary moves from recommended to implemented in source and
verified offline within the boundary above. DIO-128 stays In Progress: real-database
qualification, Operations and site changes, rollout and checkout remain.

**Build / publication / deployment:** source and offline tests only. No package, release,
migration or deployment. Publication is a pull request, if this Mac can be authenticated to
GitHub; nothing is merged to `main` by this record.
