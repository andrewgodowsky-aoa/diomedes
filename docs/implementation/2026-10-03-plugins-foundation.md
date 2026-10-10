# Plugins foundation

Status: open draft, rebased and independently audited below.
The original slice's gate results are historical. Draft integration remains open.
Owner: Codex, current Plugins foundation request.
Work order: `PLUGINS-211-AUDIT` (bounded PR audit; not a completed numbered prompt).
Feature: `plugins-foundation`.
Branch: `feature/plugins-foundation`.
Worktree: `F:/Diomedes/diomedes-wt/plugins-foundation`.
Original base: `4dbbd885e9363d29c0f66fbcd21ab89fa0d5ee78`.
Final rebase base: `6c697d142315038cf62e6a1a721ce3afada4ea77`.

## Scope

The [joint architecture](../harness/PLUGINS_ARCHITECTURE.md) reconciles Andrew's
tools/prompts/plugins proposal with the pinned extension contract. It records
the existing owners, pending skill-body implementation and phased delivery path.

Settings > Plugins uses the existing pack manager and endpoints. The person
selects a project, reviews installed packages, components, publisher declaration,
digest, runtime support and recent contribution-load records, then uses the same
install/activation/update/rollback/removal actions. A project switch discards
pending confirmations and inspected folders. Failed list reads hide actions
until a successful refresh rather than leaving stale success-shaped state.

No new installer, scheduler, permission system or executor. No imported scripts
or vendor plugins run. The existing capability entry in Task permissions remains
another entry point to the same component. No dependency or manifest revision.

## Independent audit, 2026-10-05

Requested work: rebase PR #211, audit the Plugins foundation against the refreshed
extension-authority and capability-pack contracts, repair actionable findings,
and rerun focused tests and repository gates. Executable third-party extensions
remain outside this draft.

Original head: `9775b280b51dc329c2477b13da179a73af0dc64e`.
Initial audit base: `c25056e858bd82a4a9e9867cef968eae4b9e7260`.
First clean rebase candidate: `0dd3ff01b3a4fadf05624ed185aa1824f66ff172`.
Main had advanced by 27 commits from the merge base, with no overlapping changed
paths. PR #206 remains an open draft at `2d447935947b43b769fd2da687189990a3d7b7cc`;
its refreshed contract is consumed by the existing pinned links, without copying
its unmerged documentation into this PR. All three canonical mirrors remain
`2026-09-27.2`.

| Audit area | Source boundary and independent evidence |
| --- | --- |
| Install versus activation | Device-wide installation leaves all projects off. Activation registers an index in the chosen project. The other project and authority records stay unchanged. |
| Project switches and stale responses | Plugins keys PackSettings by project. The Task permissions parent is also keyed by project/task/route. Browser cases cover a delayed inventory read and a delayed activation response. |
| Provenance and digest | Local payloads and installed manifests verify their content digests. The built-in publisher/namespace is reserved. Publisher strings are declared; no signature or independent publisher verification is claimed. |
| Runtime support | The view consumes the host's wired/declared result. Imported v1 declarations remain declared-only. No imported code is executed. Component-specific support remains future work with SK1. |
| Recorded loads | Only loaded receipts count. Real pins retain their recorded version, component digest and request through update/rollback. Index registrations and refusals do not count as use. |
| Rollback and removal | Rollback revalidates saved bytes and dependency compatibility. Active/dependent packs block removal. History and load receipts survive deactivation, removal and restart. |
| Runtime/Trust authority | Independent owned counter probes traverse install, activation, metadata load, update, rollback, deactivation and removal. Each denied Runtime call reaches zero hooks and zero effect handlers; authority records stay unchanged. |

Three actionable UI findings were reproduced separately on the rebased original
code: 0 passed, 3 expected failures, 0 skipped. The bounded fixes are:

- A dependency confirmation from an inspected folder can reappear beside a
  newly inspected package, while still pointing at the old folder. Editing or
  checking a folder now clears the pending confirmation.
- A successful HTTP response carrying `storeProblem` hides actions but retains
  a dependency confirmation, which can return after retry. That response now
  clears both the confirmation and inspected package.
- Load rows omit the recorded component identity and content digest. The package
  digest alone does not identify the older body a recorded request loaded. Load
  rows now show the recorded pack/kind/component identity and body digest.

The architecture now explicitly preserves authenticated runner/root/contribution
broker bindings, durable gate/action/configuration/revision decisions, and host
ownership of Need/grant/phase, acceptance, assignment, reviewers, worker consent,
handlers and effect metadata. Existing trusted callbacks do not qualify those
future third-party boundaries.

The first-base validation passed 136 focused unit tests, all 9 pack/Plugins
browser cases, TypeScript, Vite, 36 required browser cases and the full unit suite
(9,682 passed, 0 failed, 5 existing skips, 569 files). The full count includes the
focused tests; these rows must not be summed.

Main advanced during the gate run through PR #222 to
`6c697d142315038cf62e6a1a721ce3afada4ea77`. Its two control-plane signing-key paths
have no overlap with this PR. Both PR commits were rebased cleanly onto that
head, now 29 main commits beyond the original merge base. The final validation
below uses that base; the first-base evidence remains retained separately.

### Final-base validation

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Full repository Vitest, 569 files | 9,682 | 0 | 5 |
| Focused plugin/pack unit cases, included in the full run | 136 | 0 | 0 |
| Combined browser gate: 9 pack/Plugins and 36 UI/native UI/Field cases | 45 | 0 | 0 |
| Control-plane WorkOS identity cases for the new main change | 59 | 0 | 0 |
| TypeScript | 1 check | 0 | 0 |
| Vite production build | 1 check | 0 | 0 |

The full unit count includes the focused cases; the rows must not be summed.
The five existing skips are the same cases listed in the original verification
below. Control-plane identity tests use offline fixtures. Browser journeys use
the owned test profile, not the installed desktop or live providers.

The first final-base combined browser run passed 44 cases and failed 1, with
0 skipped. `PACK-UI-02` received HTTP 500 when the existing pack service's
`fs.rename(staging, target)` refused the local update with Windows `EPERM`.
The failed operation was recorded and the current version stayed at 1.0.0.
The saved trace and failed operation identify the filesystem refusal, but not
its cause. The exact unchanged case then passed (1/0/0), followed by the full
unchanged combined suite (45/0/0). This intermittent remains unresolved; the
successful repeats do not establish a rename fix or complete runtime acceptance.
No speculative retry or pack-service change was added to this draft.

The tested implementation and test blobs are unchanged by the final audit-result
annotations. Formatting and `git diff --check` pass. Logs, browser profiles and
the failed trace are retained in the requesting chat's `work/` directory;
generated tracked screenshots were copied there and restored before commit.

## Original verification, 2026-10-03

Focused results on this candidate:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Plugin inventory, pack manifest, contributions, lifecycle, routes and playbook driver | 116 | 0 | 0 |
| Full repository Vitest run, 567 files | 9,644 | 0 | 5 |
| Pack browser journeys, including four new Plugins cases | 6 | 0 | 0 |
| Core browser gate: UI, native UI and Field | 36 | 0 | 0 |
| TypeScript | 1 check | 0 | 0 |
| Vite production build | 1 check | 0 | 0 |

The browser cases exercise the real Store and lifecycle in an owned test profile:
project activation with unchanged grants, local import/update/rollback/removal,
declared-only custom components, attributed load records, pending-action reset,
a late response from the previous project and a failed list with explicit retry.
The projection tests retain old version/run pins and reject index/refusal records
as evidence of a body load. The rendered Settings screen was inspected at
1440 x 900. No interactive control of the installed desktop was used.

The full Vitest count is from one run and includes the focused unit tests;
the rows must not be summed. Its five skips are existing cases in
`conversation-engines.test.ts` (1), `sign-in-recheck-wiring.test.ts` (1),
`paths.test.ts` (1) and `dev-server-guard-platform.test.ts` (2).
TypeScript initially found missing dependencies in the shared main checkout's
older installation. The successful runs use the existing `windows-release-0-2-2`
dependency trees through local junctions; no package installation, manifest or
lockfile change occurred. Formatting passes with existing line endings preserved.

Local logs and screenshot are under this worktree's ignored `test-results/`:
`plugins-full-vitest.log`, `plugins-core-browser.log`, `plugins-build.log`
and `plugins-settings.png`. The core browser run regenerated two tracked
screenshots; its fresh copies were preserved there and the tracked versions
restored so unrelated evidence does not enter this patch.

## Original source and acceptance matrix, 2026-10-03

| Capability | Main/source | This slice's fresh proof | Packaged/live |
| --- | --- | --- | --- |
| Pack lifecycle and task-permission entry | Existing | 116 focused unit tests and 6 browser cases | Not run |
| Settings > Plugins and inventory details | New candidate | Browser cases and rendered screenshot | Not run |
| Built-in playbook delivery | Existing | Existing scripted driver regression passes | Not run |
| Custom skill-body delivery | Separate SK1 candidate | Not run in this lane | Not run |
| Joined prompt receipt/setup audit | Joint plan | Not implemented here | Not run |
| Marketplace, isolated handlers, executable hooks, custom views, continuous advisor | Joint plan and pinned contract | Not implemented here | Not run |

## Changed files

- `client/Settings.tsx`
- `client/console/PluginSettings.tsx`
- `client/console/PackSettings.tsx`
- `client/console/plugins.css`
- `shared/plugin-inventory.ts`
- `tests/plugin-inventory.test.ts`
- `tests/plugins-foundation-review-independent.test.ts`
- `tests/pack-lifecycle-ui.spec.ts`
- `docs/harness/PLUGINS_ARCHITECTURE.md`
- `docs/implementation/2026-10-03-plugins-foundation.md`

## Acceptance boundary

Pillars 02, 05, 09 and 14 advance through shared composition, discoverability,
truthful provenance and explicit project activation. No pillar meaning changes.
No roadmap prompt is marked DONE. This is the manager/inventory prerequisite;
the U1-U5 and EXT01-EXT07 end-to-end acceptance cases remain open.

The bounded independent source audit and owned probes are complete. The Windows
update rename intermittent above remains unresolved. Packaged desktop, real
provider and custom-skill execution validation were not run. Executable extension
qualification remains outside this PR. GitHub Actions was not run and remains
stopped under `F:/Diomedes/CI-STOP.md`. No manual deployment, release or installed-app
replacement is part of this work; automatic Workers builds are a separate status.
The branch remains an open draft for integration review. No plugin-system
milestone is marked merged, shipped or fully accepted.
