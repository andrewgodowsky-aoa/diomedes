Reading the revised artifact to verify each applied correction.# HLR Review r2: Fixture Corrections Verified

## Verdict

All six fixture corrections from the original review are correctly applied in the revised artifact. The two schedules and their claim-proving assertions are unchanged. No test execution occurred; this remains a static review, and nothing here asserts or implies product acceptance.

## Original findings vs revision

**1. Settings payload (was spec lines 69-75).** Resolved. Lines 97-106 now send the proven shape verbatim: `work`, `detail`, `familiarity: 'new'`, `resumeAt: 'done'`, `completedAt`, matching `tests/home-luna.spec.ts:143-152`. The conditional beforeEach-red path is eliminated.

**2. Serial guard and fixed port (was spec line 16).** Resolved. Line 16 adds `test.describe.configure({ mode: 'serial' })`, preventing same-file tests being distributed across workers. Line 17 adds `DIOMEDES_ROUTE_REVIEW_PORT` env override with default 47641, matching the home-luna pattern (`DIOMEDES_LUNA_UI_PORT`, line 21) and using a distinct variable so both specs can be overridden independently.

**3. Missing dist freshness guard (was spec line 61).** Resolved. `expectFreshBundle` is ported verbatim at lines 49-68 and invoked with `fs.access` at lines 86-88 before the static mount at line 89. Running it per-test in `beforeEach` rather than `beforeAll` is correct here since a fresh app is created per test.

**4. `delete` without cast (was spec line 146).** Resolved. Line 178 now reads `delete (historical as { engineChoice?: string }).engineChoice`, matching `home-luna.spec.ts:257`.

**5. pageerror capture (previously absent).** Added: `pageErrors` at line 23, listener registration at lines 70-72, and the `toEqual([])` assertion inside `afterEach` at line 118. Placement after server close is equivalent to the home-luna convention: if close itself rejects, the test already fails. Trivial parity nit only: the assertion carries no message string where home-luna line 166 includes one; optional.

## Schedules confirmed unchanged

HLR-01 (lines 121-171) is byte-equivalent in logic to r1 lines 89-139: gate ordering, the held-first-PUT interception, `secondResponse`/`oldResponse` waiter registration before their respective triggers, `firstHandled` confirmation, the double-rAF flush, and the claim assertions at 164-165 are all identical. HLR-02 (lines 173-196) matches r1 lines 141-164 except the added cast; the seed, SLOW send, `seen` gate, and pending-state assertions at 188-191 are identical. The claim-proving lines remain: HLR-01 at 163-165 (163 is server truth), HLR-02 at 188-191 (188 is server truth, 181 is seed truth).

## Retained execution-time limitations

- **Double-frame flush, lines 161-162.** Still a heuristic rather than a gate. `toHaveValue` resolves on first match, so a stale repaint landing later than two frames would produce a false green on buggy code. Practically near-impossible given response consumption is confirmed at 157-158; the guarantee is empirical, not structural.
- **`route.fetch` fixture error, line 134.** If the fetch inside the held handler throws, `firstCommitted` never releases and line 144 waits to test timeout. The failure remains cleanly fixture-attributable.
- The SPA fallback route (`application.get('/{*path}', ...)`) remains omitted and remains unneeded: navigation is only to `/`, which static serving resolves.
- The interception still assumes project and thread ids are URL- and glob-safe, consistent with the reference convention.

## Final statement

The revision is a faithful application of the prior findings with no introduced defects found by static inspection. The artifact is sound as a counterexample: a legitimate red lands at lines 164-165 (HLR-01) and 190-191 (HLR-02); any earlier red is fixture-attributable. This review claims nothing about whether the product code is correct and does not alter or retract the retained original report.
