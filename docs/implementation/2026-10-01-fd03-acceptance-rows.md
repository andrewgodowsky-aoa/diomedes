# FD03 acceptance rows A05/A06/A07 — deterministic-tier evidence

2026-10-01 · lane `fd03-acceptance-rows` · base `a0d752e` (origin/main at branch time)

## Scope taken

Work order `reference/work-items/FD03.md` ("Grounded capability and readiness
projection with shipped product knowledge"). The projection and shipped-knowledge
loader are already merged (`server/readiness/projection.ts`,
`server/readiness/product-knowledge.ts`, `server/readiness/instructions.ts`,
`shared/readiness.ts`, `resources/product-knowledge/`); existing coverage is
route-behavior only (`tests/fd03-readiness-routes.test.ts`, 82 lines — mounted
route, project scoping, no probing). The named acceptance rows had no executable
evidence; this slice adds it.

**No production code was changed.** The diff is one new test file plus this record.

## What was added

`tests/fd03-acceptance-rows.test.ts` — 10 tests against the production seam:
`loadProductKnowledge` (the real shipped-set loader: real temp dirs, real sha256
digests, real schema validation) and `projectReadiness` (the pure projection over
`ReadinessRuntimeSnapshot`). The A06 baseline test loads the *actual shipped*
`resources/product-knowledge/` — not a fixture copy.

## Row-by-row result

| Row | Requirement | Evidence |
|-----|-------------|----------|
| A06 | availability from facts, cited sources, no aspiration | Shipped bundle loads conflict-free at build `0.2.2`; projection enumerates exactly `ROUTE_CONTRACTS` keys (no invented capability); all five axes on every capability carry `source.kind`+`id`+`freshness.state`; `implemented` is a `build`-sourced axis carrying the build digest |
| A06 | `ready` is derived | `capability.ready === every axis === 'yes'` asserted per capability; with no evidence every external route is `verified: unknown` / `installed: unknown` and `ready: false` |
| A06 | evidence gating is per-capability | `validatedEvidence` for `sample` alone → `sample.ready === true` with `verified.source.kind === 'validated-evidence'`; the same-static-local sibling `native-fixture` stays `verified: unknown`, `ready: false` |
| A06 | staleness is carried | a `claude-code` observation 10 min old (> `ENGINE_FRESH_MS` 5 min) reports `installed: yes / freshness: stale`, `healthy: unknown`, `ready: false` — stale facts are shown stale, not refreshed or hidden |
| A05 | missing tool/containment/control blocks | workflow `needs-steer` (route `sample`, command `steer` → `command-unsupported`); workflow `needs-absent` (connector `no-such-connector` → `capability-missing`); workflow `needs-claude` (unproven axes → `axis-missing` blockers naming `route:claude-code:<axis>`); every workflow reports `routeSwitch: 'explicit-only'` and `selectedAlternatives: []` |
| A07 | missing index | `loadProductKnowledge` on an index-less dir → sole conflict `missing-index`, `resources: []`, `bundleSha256: null`; in the projection every route's `verified` axis is `unknown`/`stale` (product-scoped conflict) and `workflows: []` |
| A07 | old docs / new build | index `buildVersion 0.2.1` vs installed `0.2.2` → `build-version` conflict whose detail names both versions |
| A07 | new docs / old build | index+resource `buildVersion 0.3.0` vs installed `0.2.2` → two `build-version` conflicts (index-level and resource-level), both naming both versions |
| A07 | stale qualification | verified qualification past `staleAfterMs` → `stale-qualification` conflict; the resource still loads — the conflict bounds what it may claim |
| A07 | scoped, no overclaim | resource claiming `route:sample` contractVersion 99 → `contract-mismatch` scoped exactly `['route:sample']`; with identical fresh evidence on both, `sample.verified` degrades to `unknown`/`product-knowledge` while `native-fixture.verified` stays `yes` and `native-fixture.ready` stays `true` |

## Honest limits

- **Deterministic tier only.** The acceptance matrix pairs A06/A07 with a
  live-model tier ("answers resolve…", "produce scoped uncertainty" in a real
  model reply). That tier needs an authorized route and stays recorded-not-run;
  these tests cover the contract half.
- **A05's packaged half** ("shown and blocks" in the shipped install) is route-
  plus-packaged per the matrix; this slice proves the blocking semantics, not
  the packaged surface.
- `sample`/`native-fixture`/`harness-runtime` are the static-local routes whose
  `installed`/`healthy` axes are build facts — used deliberately as the
  evidence-gating contrast class against external routes.
- `manifest-mismatch` (connector conflicts) is exercised only through the
  `capability-missing` blocker path here; the connector-manifest claim path in
  `projection.ts` is untested by this file — flagged for the reviewer as an
  adjacent uncovered branch, not hidden.

## Verification

- `npx vitest run tests/fd03-acceptance-rows.test.ts` — 10/10 pass (~43 ms).
- `npx vitest run tests/fd03-readiness-routes.test.ts` — unchanged, still green.
- Four gates (`tsc --noEmit`, full `vitest run`, `vite build`, Playwright) —
  pending the shared heavy-test slot; diff touches no production file.

## Remaining for FD03

- Gates under the slot; independent review (Astra) against the matrix text.
- Live-model tier evidence, when an authorized route exists for it.
- Connector-manifest `manifest-mismatch` coverage if the reviewer wants the
  adjacent branch exercised.

## Frozen patch identity

- Base: `a0d752e94a6a83ba9cd3b7277361dd2986d56014` (origin/main, PR #192)
- `tests/fd03-acceptance-rows.test.ts` sha256 `7f35eb07e12a06e8a08f22877c352b1d6fc14849bdb1b8a4df2dd686d2891c56`
- This record sha256 `bc761b76b68ae588a52e2d8258b46cf95e30c8270f47874dc2f423e3c6a38460` (hash taken before this section was appended). The final record hash is reported in the frozen evidence packet alongside this file — embedding it here would be self-referential.
- Production files changed: none.
- `npx tsc --noEmit` on this worktree: clean (2026-10-01, base `a0d752e` + this file).

## Final gate evidence (2026-10-01, slot_devingate_a1b2c3d4)

- npx tsc --noEmit: clean.
- npx vitest run: 531 files, 8752 passed, 5 skipped, 0 failed (278s) — includes the 10 A-row tests.
- npx vite build: built in 9.72s.
- npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts: 36 passed (1.3m).

Status: READY FOR INDEPENDENT REVIEW. No push/merge performed.
