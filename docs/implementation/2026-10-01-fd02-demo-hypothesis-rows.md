# FD02 acceptance-row mapping + demo-hypothesis rows

Devin (SWE-2 Max), 2026-10-01. Evidence-only slice: one new test file; no
production code touched.

## Reconciliation (correcting a stale conclusion)

An earlier audit called FD02 "unimplemented" — that was wrong. The claim came
from grepping the parked main checkout (`F:/Diomedes/diomedes` HEAD `c6db9d6`,
a docs-branch tip predating the FD02 merge) for one literal (`prospect`).
Against `origin/main` = `a0d752e` the feature is present:

- `shared/discovery.ts` — record schema, brief schema, provenance classes,
  hypothesis/outcome model, deterministic Markdown export.
- `server/discovery/service.ts`, `server/discovery/routes.ts`,
  `server/discovery.ts`.
- `client/console/Discovery.tsx`, `DiscoveryPage.tsx`, `LeadWorkers.tsx`.
- Suites: `tests/fd02-discovery.test.ts` (10), `fd02-discovery-routes.test.ts`
  (7), `fd02-adversarial.test.ts` (16), `fd02-discovery-ui.test.ts` (4),
  `fd02-discovery.spec.ts` (browser).

## Named-row → evidence map (deterministic tier)

| Row | Contract | Covering evidence |
|---|---|---|
| A08 | Process map + owner-scoped facts | `fd02-discovery.test.ts`: "no-account process map…", "active selection is server-owned…refuses a different operator"; `fd02-adversarial`: foreign-operator selection/evidence refusals; `fd02-discovery-routes`: spoofed/stale mutations rejected. **Packaged-tier cell (installed-app isolation): NOT covered — recorded-not-run.** |
| A09 | Owner-facing view | `fd02-discovery-ui.test.ts`: scoped render without developer context, clear empty state; `fd02-discovery.spec.ts` browser spec exists (not in the required Playwright gate list — run separately). |
| A10 | Export + corrections + outcomes | `fd02-discovery.test.ts`: "a correction propagates into export without fabricating confirmation", "hypothesis outcomes are append-only…remains exportable"; routes: recorded exports across restart. |
| PD-01 | Fixed public transitions | `fd02-discovery.test.ts`: "import creates public facts only and fixed public transitions…"; `fd02-adversarial`: public-lineage laundering + replay-fork refusals. |
| PD-02 | Typed import, bounded public fields, no network | `fd02-discovery.test.ts`: strict JSON/Markdown front matter with `fetch` spied-absent, data-only YAML, non-http/credential-bearing source refusals; routes: unchanged-Files-import binding; adversarial: service-level resource limits. |
| PD-03 | One distinguished demo hypothesis + append-only outcomes | outcomes half: `fd02-discovery.test.ts` append-only test. **Distinguished-hypothesis half: WAS UNCOVERED — this slice adds it** (below). |
| PD-08 | Scoped owner view; pilot promotion stays with B03/B11 | `fd02-discovery-ui` scoping tests; `fd02-discovery.test.ts` "pilot remains promotion-only" (409, promotion-path wording). |

## What this slice adds

`tests/fd02-demo-hypothesis.test.ts` — three rows against `DiscoveryService`:

1. Exactly one `demoHypothesis` fact exists, is `hypothesisFactId`, is
   `hypothesized`; a second add is refused by field **and** by label
   (409 `invalid_discovery_fact`, "one demo hypothesis").
2. `correctFact` on `hypothesisFactId` → 409 `immutable_demo_hypothesis`
   ("record its outcome instead"); `setHypothesisOutcome` still appends and the
   fact itself is unchanged (`replacesFactId: null`, original value).
3. Adversarial persistence: a stored record forged to carry a second
   `demoHypothesis` fact is rejected by `service.active` → 409
   `invalid_discovery_record` (schema's exactly-one rule fails closed on load).

## Results

- `npx vitest run tests/fd02-demo-hypothesis.test.ts` — **3/3** (first run, 119 ms, 08:58Z).
- FD02 family regression `npx vitest run tests/fd02-demo-hypothesis.test.ts tests/fd02-discovery.test.ts tests/fd02-discovery-routes.test.ts tests/fd02-adversarial.test.ts tests/fd02-discovery-ui.test.ts` — **45/45** (13.2 s, 08:59Z).

## Frozen identity

- Base: `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (origin/main, PR #192)
- Production files changed: **none**
- New files: `tests/fd02-demo-hypothesis.test.ts` `c86010451e43bdbaebc14ae93863e07d0939bbe33e4139f104efc3c4ea2c336b`
- Environment note: this worktree junctions `node_modules` and
  `services/control-plane/node_modules` to `credit-allotments` (byte-identical
  lockfile); without the second junction `fd02-discovery-routes.test.ts` cannot
  collect (`@neondatabase/serverless` missing).

## Remaining limits

- A08 packaged-tier cell (installed-app, multi-instance isolation): not run —
  requires packaging + the shared heavy slot.
- `fd02-discovery.spec.ts` browser spec: not in the required gate list; a
  Playwright run for it is queued behind the same slot.
- Live demonstration evidence: not run.
- FR-D assembly and FD04 are separate work items, out of scope.
- The final record hash is reported in the evidence packet alongside this file.

## Final gate evidence (2026-10-01, slot_devingate_a1b2c3d4)

- npx tsc --noEmit: clean.
- npx vitest run: 531 files, 8745 passed, 5 skipped, 0 failed (276s) — includes the 3 demo-hypothesis tests.
- npx vite build: built in 9.32s.
- npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts: 36 passed (1.3m).

Status: READY FOR INDEPENDENT REVIEW. No push/merge performed.
