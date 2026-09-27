# DATA-01 coverage matrix - 2026-09-26

## Work order

- Feature and work item: DATA-01, the first slice of the authorized
  data-coverage planner, from decision package SC-2026-09-26.1.
- Owner: Opus, a bounded worker under the integrating session's written work
  order; coordination seat opus, process 32132.
- Branch: feature/data-coverage.
- Worktree: F:/Diomedes/diomedes-wt/data-coverage.
- Base: 8daf0c1ac010e4335dd5105e18d860b6b4915460, fetched origin/main.
- Claim: claim_muj4882l_1b10617e, limited to `shared/data-coverage.ts`,
  `tests/data-coverage.test.ts`, `tests/fixtures/data-coverage/` and this record.

Canonical mirrors inspected: Core Pillars 2026-09-22.1; Live Roadmap and Project
Memory 2026-09-25.2. The repository mirrors do not yet carry SC-2026-09-26.1, so
the work order's frozen contract is the specification for this slice. No product
definition changed.

## Direction

Choose realistic input routes before a workflow is sold or switched on. For each
field a workflow needs, the planner says which authorized route can supply it,
how current that route's evidence is, whether it refreshes often enough, what it
costs, and why every other route was passed over or refused. When coverage falls
short it offers one of the workflow's own narrower versions, or declines the
automation claim in plain words. It never fills in missing information.

This follows Pillar 03 (exports, email and files are first-class inputs when a
direct API is unavailable), Pillar 05 (show ready only after verification) and
Pillar 09 (a change of route never silently widens data classes or permissions).

## Current state at the base commit

- Need kinds. A playbook input is `PackSkillInput`: a label, `required`, a
  `need` string and `howToProvide` (`shared/capability-packs.ts:78-86`). The
  Small Business pack declares `read-project-files` and seven read needs
  (`shared/capability-packs.ts:231-264`). The playbooks use them: the month-end
  close checklist (`shared/small-business-skills.ts:135`) and the restock
  planner (`:359`), whose stock counts and par levels are both
  `read-inventory` (`:369`, `:381`).
- Data kinds. `CONNECTOR_DATA_KINDS` is the same needs minus project files
  (`shared/read-connectors.ts:10-24`).
- Kind-level matching. `skillConnectorMatch` counts a kind as covered when any
  approved connector provides that kind (`client/console/skill-connectors.ts:43-52`;
  the comparison is on `:47`). It cannot tell menu stock from ingredient counts,
  because both are `read-inventory`.
- Freshness. Readiness has `FreshnessState` (`shared/readiness.ts:16`),
  `ReadinessFreshness` with `staleAfterMs` (`:24-28`) and
  `ValidatedReadinessEvidence` with an evidence id, source, validation time and
  `staleAfterMs` (`:237-248`). The predicate that judges them is `isFreshAt`
  (`server/readiness/projection.ts:21-30`), which is private to server code.
- Workflow readiness. `WorkflowReadiness` (`shared/readiness.ts:266-276`) and
  `workflows()` (`server/readiness/projection.ts:478-560`) judge the route and
  connector requirements that product knowledge declares. They have no notion of
  a data field, `routeSwitch` is `explicit-only`, and `selectedAlternatives` is
  always empty (`server/readiness/projection.ts:556-557`). The shipped product
  knowledge declares two workflows, `sample-draft` and `claude-code-draft`,
  neither with data fields (`resources/product-knowledge/core.json`).
- Toast. The manifest's one operation is a read with vendor scope `stock:read`
  (`server/connections/toast.ts:142-144`). Its limitations say the stock data is
  menu stock, not ingredient inventory (`:162`), and "Standard API access has no
  sandbox. No real vendor access verified." (`:165`). Its standing rule says
  Toast does not establish physical ingredient inventory (`:110`).
  `docs/connections/RESEARCH.md` records documentation read on 2026-09-09, not an
  authenticated account (`:3-5`): `stock:read` and `stock:write` are separate
  scopes (`:16`); Standard API credentials are read only, scoped to approved
  locations, and need an eligible employee, Manage Integrations permission and
  RMS Essentials or above (`:17`); partner and custom paths differ (`:19`); and
  it sets out the intended discovery order (`:70-75`).

Before this slice nothing in the repository assigned a workflow's fields to
routes, judged a route's refresh cadence against a field's acceptable age, or
bounded what a fallback route may read.

## What was built

### Module contract

`shared/data-coverage.ts` exports `coverageMatrix(workflow, routes, { now })`.
It is pure: no clock, filesystem or network, and only type imports, so it loads
nothing at run time. The same input gives the same output, and it never changes
its inputs. Duplicate field or route ids are refused with an error rather than
guessed between.

Inputs reuse the existing vocabulary:

- A `CoverageField` is a playbook input's `label`, `required` and
  `howToProvide`, plus an `id`, a `need` that is a `ConnectorDataKind`, an
  acceptable age named `staleAfterMs`, its source of truth, the outputs it feeds
  (`effects`) and the data scopes needed to read it (`access`).
- A `CoverageRoute` has a kind, a name, the field ids it reads, the plain-word
  data scopes it reads or sends data to, its access (`granted`, `available` or
  `unavailable`, with a reason), its plan and access requirements, how often it
  refreshes (0 is on request, null is not known), a cost note, its evidence, and
  for a fallback the primary route it falls back from.
- `CoverageEvidence` is readiness evidence's id, source and `staleAfterMs`, plus
  when it was observed and whether it is `validated` or only `documented`.
- A workflow declares its own narrower versions, widest first, each with the
  fields it cannot run without.

Routes are evaluated in the order of `COVERAGE_ROUTE_KINDS`: approved
integrations, customer APIs, database views, report exports, email and files,
then partner or custom routes, then browser-assisted work. Within a kind the
declaration order decides. For each field, every route that declares it reads
that field is checked for access, for the scopes the field needs, for the
fallback bound and for freshness, and every failure is reported. A verified
route is chosen over a pending one; among equals, the earlier one in the order.

For each field the matrix returns the chosen route or none, its evidence state
(`verified`, `pending` or `unavailable`), the evidence age, the evidence judged
as a `ReadinessFreshness`, the freshness verdict as a `FreshnessState`, the cost
note, a plain detail, and every candidate with its verdict (`chosen`, `usable`
or `rejected`), the rules that refused it and a plain reason.

For the workflow it returns `complete`, `pending` or `incomplete`; the missing
required fields and, separately, the missing optional ones, each with its
`howToProvide`; the chosen routes still awaiting verification; a summary of
every route with its access, requirements, cadence, cost and evidence; and
either a narrower version that is fully covered or a plain decline.

### The rules in code

1. Customer before partner. `COVERAGE_ROUTE_KINDS` puts every customer-owned
   read route before `partner-api`. A route the business cannot use is
   `unavailable` and refused for access with its reason, and it never refuses a
   field that another route covers.
2. Freshness. `cadence()` refuses a route whose refresh interval is longer than
   the field's acceptable age, or whose interval is not known, and says both
   durations.
3. Required fields. The status is decided by required fields only. Any required
   field with no usable route makes the workflow incomplete; an optional one is
   listed in `missingOptional` and changes nothing.
4. Fallbacks. `judgeCandidate()` refuses a fallback whose scopes are not a
   subset of its primary route's approved scopes, naming the extra scopes, and
   refuses a fallback whose primary is not declared.
5. Verified means current. `assess()` derives the evidence state: `unavailable`
   when access is unavailable; `verified` only when access is granted, the
   evidence is validated, and it is fresh at `now` under the same predicate as
   `isFreshAt`; otherwise `pending`. Documentation never verifies a route.
6. Unknown stays unknown. A field with no usable route has no route, evidence
   `unavailable`, no evidence age, unknown freshness and nothing borrowed from a
   refused route. A row has no place to carry a value or a record count.

### Fixtures

All fixtures are synthetic and say so.

- (a) `tests/fixtures/data-coverage/restaurant.ts`: a three-location restaurant's
  daily sales and stock check. Toast Standard API access (read-only) is a
  customer route with documented, pending evidence that cites RESEARCH.md and
  `toast.ts:165`. A Toast partner integration is unavailable. A nightly sales
  email is a fallback inside the Standard API route's scope, and a
  browser-assisted Toast Web export is a fallback that would reach labour and
  guest contacts. Ingredient counts are an optional field that no route reads,
  although Toast reads the same kind of data.
- (b) `tests/fixtures/data-coverage/month-end-close.ts`: a landscaping company's
  month-end close from QuickBooks Online reports exported weekly, verified by a
  checked Files import. The export passes the two month-end fields and fails the
  real-time cash field. A live bank feed through an aggregator would meet the
  real-time need but is refused because it widens both permissions and
  processing.
- (c) In `restaurant.ts`: a no-access set, where the restaurant's Toast plan is
  below RMS Essentials and it holds no partner agreement, which produces a
  decline; and a partial-access set, where only a verified daily sales CSV is
  available, which produces the narrower morning sales summary.

## Acceptance mapping

| Acceptance evidence | Test in `tests/data-coverage.test.ts` | What it asserts |
|---|---|---|
| Toast read-only customer route is considered before partner-only rejection. | `Toast read-only customer route is considered before partner-only rejection.` | With the routes declared partner first and reversed, the Standard API route is evaluated first and chosen for both Toast fields with pending evidence; the partner route is refused as unavailable with its reason; the workflow is pending, not incomplete. |
| A weekly export is rejected for a real-time requirement. | `A weekly export is rejected for a real-time requirement.` | The verified weekly export is refused for the 15-minute cash field on freshness, with both durations in the reason, and chosen for the two month-end fields. |
| Missing required field makes coverage incomplete. | `Missing required field makes coverage incomplete.` | The month-end close is incomplete with the cash field in `missing`; the same gap on an optional field leaves it complete. |
| Fallback route does not expand data processing or permissions. | `Fallback route does not expand data processing or permissions.` | The browser export (wider permissions) and the aggregator (wider processing) are refused naming the extra scopes; the in-scope email fallback stays usable and serves only what it reads; a fallback with no declared primary is refused. |

The work order's other tests are `unknown stays unknown`, `a narrower
alternative is offered only when fully covered, and a plain decline otherwise`
and `purity: the same input gives the same output, and the input is not
mutated`. Two more cover rule 5 (`a route is verified only on current validated
evidence`) and the duplicate-id guard.

## Validation

Both gates ran in this worktree on base 8daf0c1 plus this patch, each under the
shared heavy slot and one at a time.

- `npx vitest run tests/data-coverage.test.ts --maxWorkers=4`: 1 file, 9 tests
  passed, none skipped, exit 0 (slot `slot_muj4tiuf_45fbbbf3`).
- `npx tsc --noEmit -p .` at the worktree root: exit 0 with no diagnostics
  (slot `slot_muj4w1am_9caa78c7`).

Under the first slot, each rule was also broken on purpose, one at a time, and
the focused file run again: customer before partner, cadence, status from
required fields only, the fallback bound, documentation never verifying,
borrowing a refused route's evidence, and offering a narrower version covered
only by pending evidence. Every break failed the test named for that rule, and
the module was restored byte for byte. The first pass showed that the
documentation rule was masked, because the Toast route is also not set up, so
the rule 5 test now checks a set-up route with documented evidence too. The
checking script was scratch work and is not part of the patch.

## Remaining limitations

- It is not wired into readiness or the Console. Nothing outside its tests calls
  `coverageMatrix`; `WorkflowReadiness` still has no data fields and
  `selectedAlternatives` is still empty.
- Routes are declared inputs, not discovered. What a route reads, its scopes,
  cadence, cost and evidence are whatever the caller declares; nothing checks
  them against a connector manifest, a connection instance or a Files import.
- Scopes are plain-word strings compared exactly. There is no shared scope
  vocabulary yet, and vendor scopes such as `stock:read` are not mapped to them.
- The freshness verdict judges cadence, not the last delivery: an overdue weekly
  export still passes a month-end field.
- No real Toast access has been verified. That the Standard API route reads
  yesterday's sales is a fixture declaration awaiting that verification.
- The freshness predicate mirrors `isFreshAt` rather than sharing it, because
  shared code cannot import server code. A change to one must be made in both.
- Only the two gates the work order names were run, not the repository's four.

## Status

Built, not merged. Committed on feature/data-coverage; not pushed, no pull
request. DATA-01 is not DONE under the workspace's completed-prompt rule.
