# Autonomy/workbench: current-main reconciliation

Date: September 11, 2026. Status: review-ready documentation and verification patch,
uncommitted. The candidate application code already exists in current main.

## Source decision

- Main: `e69d4a26ddef5f603b970fab1dec17e728368e43`.
- Candidate: `integration/autonomy-workbench-20260910` at
  `32ee98c5efd7e1c687b3c6019e2b3fe1967b3970`.
- `git merge-base main integration/autonomy-workbench-20260910` returns the
  candidate tip; `git log main..integration/autonomy-workbench-20260910` is empty.
  Main is nine commits ahead of the candidate. There is no remaining committed
  implementation to port or cherry-pick.
- The candidate checkout has only three modified screenshot files. They were
  not imported or changed.
- New worktree: `F:/Diomedes/diomedes-wt/autonomy-main-ready-20260911`.
  Branch: `codex/autonomy-main-ready-20260911`, created directly from local main.
  The starting worktree and index were clean. No remote update is claimed.
- All application source, tests, package versions and dependencies remain at
  main. This preserves its path-alias guards, History-retention removal and
  later product contracts rather than replacing them with the older candidate.
- Main's six existing modifications were left in place: `QUESTIONS.md`,
  `server/lock.ts`, `tests/backend.test.ts`, and the three screenshot changes.
  Their SHA-256 hashes matched before and after verification; see the evidence
  manifest. They were not copied into the new worktree or included in this proof.

The patch adds a historical-status notice to the September 10 report and this
fresh handoff with its evidence manifest. Earlier claims of an uncommitted
candidate describe that earlier run. In particular, the roadmap's historical
integration paragraph is not evidence that its source still needs merging.

## Fresh required gates

All commands ran in the isolated worktree with existing local dependencies.
The production client was built before Playwright. Ports 5174 and 47632 were
free before the browser run and after its owned servers closed.

| Gate | Result | Source |
| --- | --- | --- |
| TypeScript, `node node_modules/typescript/bin/tsc --noEmit` | PASS, exit 0 | `test-results/main-ready/typecheck.log` |
| Full Vitest suite, four workers | 1,401 passed, 1 skipped, 0 failed; 82 files | `test-results/main-ready/unit-results.json` and `unit.log` |
| Production client, `node node_modules/vite/bin/vite.js build` | PASS, exit 0 | `test-results/main-ready/build.log` |
| Full configured Playwright suite | 52 passed, 0 skipped, 0 failed, 0 flaky; 11 files | `test-results/main-ready/browser-results.json` and `browser.log` |

The 52 browser tests include the exact required selection: `ui.spec.ts` (17),
`native-ui.spec.ts` (3), and `field.spec.ts` (7). These 27 are part of the
52, not another run or an additional total. Candidate-specific coverage also
includes autonomy, reviewer, Agent, AI adapters, updates, workspaces,
configuration and allowance surfaces. No failing run was hidden by a retry.

The one unit skip is `path privacy and 8.3 aliases a short name standing in for
a guarded directory is still refused`. This volume does not generate the
required short-name alias. It is unverified locally, not a passing test.

Commands and SHA-256 hashes for logs, machine-readable results and built client
assets are in
[`autonomy-main-ready-20260911.json`](../../evidence/autonomy-main-ready-20260911.json).
Verbose results remain in ignored `test-results/main-ready/`.
Test-generated tracked screenshots were copied into
`test-results/main-ready/captures/evidence/` before restoring only those
generated changes in this new worktree. The fresh inspector and 800px Board
captures were personally inspected; this is not an exhaustive visual audit.
The final patch contains no screenshot refreshes.

## Pillar and roadmap impact

Read versions: Pillars `2026-09-10.1`, Roadmap `2026-09-10.8`,
Project Memory `2026-09-10.7`.

No product definition, authority boundary, or roadmap completion status changes.
Fresh synthetic tests support the existing scoped-authority, attribution and
shared Console contracts (Pillars 06, 07, 09 and 12). They do not establish
general unattended autonomy, production Business identity, paid entitlement,
OS containment, or universal connector support. Canonical versions and cloud
documents were left unchanged.

## Build, publication and deployment

The client build is verified against main source plus documentation changes.
No desktop package was created, live installation replaced, live provider call
made, actual downloaded upgrade installed, cloud document written, commit
created, push performed, or release published. Previous packaged and live-provider
reports remain historical evidence, not results of this run.

Everything in this patch is uncommitted and the normal index is empty.
Proposed commit message: `Record current-main autonomy reconciliation and fresh gates`.

Changed files:

- `docs/implementation/2026-09-10-integration-autonomy.md`
- `docs/implementation/2026-09-11-autonomy-main-ready.md`
- `evidence/autonomy-main-ready-20260911.json`
