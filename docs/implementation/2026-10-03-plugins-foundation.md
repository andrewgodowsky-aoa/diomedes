# Plugins foundation

Status: first implementation slice complete; all four local repository gates passed.
Independent implementation review and integration remain open.
Owner: Codex, current Plugins foundation request.
Work order: `PLUGINS-FOUNDATION` (new owner request; not a completed numbered prompt).
Feature: `plugins-foundation`.
Branch: `feature/plugins-foundation`.
Worktree: `F:/Diomedes/diomedes-wt/plugins-foundation`.
Base: `4dbbd885e9363d29c0f66fbcd21ab89fa0d5ee78`.

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

## Verification

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

## Source and acceptance matrix

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
- `tests/pack-lifecycle-ui.spec.ts`
- `docs/harness/PLUGINS_ARCHITECTURE.md`
- `docs/implementation/2026-10-03-plugins-foundation.md`

## Acceptance boundary

Pillars 02, 05, 09 and 14 advance through shared composition, discoverability,
truthful provenance and explicit project activation. No pillar meaning changes.
No roadmap prompt is marked DONE. This is the manager/inventory prerequisite;
the U1-U5 and EXT01-EXT07 end-to-end acceptance cases remain open.

Independent implementation review, packaged desktop, real provider and
custom-skill execution are not established by this record. Those four validation
categories were not run. GitHub Actions was not run and remains stopped under
`F:/Diomedes/CI-STOP.md`. No deployment, release or installed-app replacement is
part of this work. The branch is a review candidate, not a merged or shipped
plugin-system milestone.
