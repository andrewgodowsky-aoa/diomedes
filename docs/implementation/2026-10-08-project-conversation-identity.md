# DIO-299: durable project conversation identity

Work order: project-conversation-identity. Owner: Codex, current chat.
Branch: `feature/project-conversation-identity`.
Worktree: `F:/Diomedes/diomedes-wt/project-conversation-identity`.
Initial base: `24fe1e5c04ccb325d0b894dbc3589ed27f6ada69`.
Current base: `939285a010286807571d59af4ef6a912324e6f49`, freshly fetched
`origin/main`. PR #256's picker cleanup arrived during validation; the feature
branch fast-forwarded to it without conflicts or changes to the identity patch.
Acceptance contract: [DIO-299](https://linear.app/diomedesdevs/issue/DIO-299/a-projects-own-conversation-is-found-by-a-guess-give-it-a-marker-of).
Pillars, Roadmap and Project Memory read at version `2026-10-06.1`.

Scope: use the existing Conversation, Store lock, project state, Agent-page
selector and phone provisioner. Persist identity independently of Agent, mode,
route, task binding and conversation lineages. Preserve history and the existing
Projects/Teams architecture. No merge, deployment or live-profile migration.

## Implementation and persistence

`Conversation.conversation: 'project'` is written in the same atomic project-state
save as the new conversation. `diomedesThread` reads only that marker on a
project-attached thread. Mode, Agent picks, engine, lineages and the most recently
attached work task cannot remove identity. The existing Store lock serializes
provisioning from windows and phones. Failed writes use the existing recovery and
reload path before a retry, including a failure reported after the save completed.

`ProjectState.projectConversationIdentity: 1` records that legacy selection has
already run. New projects start at this revision, so ordinary threads never enter
the migration. Existing projects receive it at startup, including projects with no
qualifying conversation. Recovery applies the migration to the prepared snapshot
before persisting it, and reload after a failed mutation persists a newly migrated
snapshot before returning it.

This is an additive normalization within project-state schema version 1, following
the existing Store migrations for conversation fields and cloud sharing. It adds
the marker and migration revision; it does not replace, merge or delete threads,
turns, lineages, History, tasks or Team records. Engine migration remains the
existing provisioner's responsibility and respects `engineChoice: 'person'`.

For an unmarked legacy project, migration preserves exactly the oldest qualifying
thread that the old reader selected, including its id tie breaker. A marker already
present takes precedence. Legacy records contain no independent evidence of which
thread was intended as primary, so migration cannot retrospectively distinguish a
historically misidentified ordinary thread. It preserves the prior selection, as
DIO-299 specifies, rather than guessing again or losing its history. After this
one-time step, readers and provisioning never use the heuristic.

## Traced consumers

- `shared/types.ts`: the marker and additive migration revision use existing records.
- `server/store.ts`: creation, startup, locked provisioning, failed-mutation reload,
  atomic state persistence and prepared-write recovery carry the same identity.
- `client/console/DiomedesHome.tsx` and `diomedes-view.ts`: the Agent page already
  reads the shared selector. Its existing state route carries the marker.
- `client/console/Shell.tsx` and the thread PUT route: Agent/playbook changes update
  existing mode/request fields without replacing the Conversation. Ordinary thread
  POST and PUT cannot set or clear the host-owned marker.
- `server/relay/ports.ts`: phone resolution already uses Store provisioning, and
  therefore returns the same marked conversation as the page.
- `server/team/service.ts` and `server/durable-controls.ts`: new Team and forked
  task threads construct ordinary Conversation records and do not copy the marker.

No new conversation service, endpoint, client cache, authority or route is added.
The reserved cross-project Home conversation retains its own existing binding.

## Verification

Tests run in owned temporary profiles with existing installed dependencies. No
provider calls, installed application, live customer profile or database is used.

- Before implementation: 24 project-conversation tests, 9 passed, 15 failed,
  0 skipped. The failures reproduced route-based misidentification, pre-message
  Agent/playbook changes losing identity, and the missing durable marker.
- Final focused run on `939285a`: 206 passed, 0 failed, 0 skipped across 7 files. Includes 28 project
  conversation cases, page selection, phone provisioning, Home compatibility,
  migrations, old modes and durable controls. Evidence:
  `F:/Diomedes/deliverables/project-conversation-identity/focused-current.json`.
- Full Vitest suite on `939285a`: 608 files passed; 10,292 tests passed, 0 failed,
  5 skipped. Evidence: `full-current.json` and `full-current.log` in the same folder.
- Required browser gate (`ui.spec.ts`, `native-ui.spec.ts`, `field.spec.ts`):
  36 passed, 0 failed, 0 skipped, 0 flaky. Evidence: `browser.json` and `browser.log`.
- Final `tsc --noEmit`, `vite build` and `git diff --check`: exit 0. The build
  reports a nonfatal bundle-size warning. Evidence: `typecheck-current.log` and
  `build.log`.
- The final typecheck first caught a missing `mode` in the newly added prepared
  snapshot test fixture. The fixture was corrected and typecheck passed; production
  code was unchanged. The full and final focused runs include that corrected fixture.
- The full-suite run on the initial base was interrupted after main advanced.
  It has no final counts or verdict and is not acceptance evidence. The final
  suite above ran on the refreshed base with saved JSON and progress output.

The five full-suite skips are the pre-existing Devin sign-out case, two process-table
platform checks, one Windows short-path privacy case and one unsupported-platform
sign-in case. No skipped test is counted as passed. All DIO-299 cases ran.

The first attempted test run collected no tests because the isolated checkout
lacked the control-plane dependency link. Linking the existing dependency folder
resolved it; no package or lockfile changed.

## Boundaries

Pillar impact: preserves one Project/Conversation architecture, truthful routing
and durable history. No product definition, permission, billing or Team authority
changes. Roadmap and issue completion are not advanced by this local candidate.

No merge, deployment, release, package or live-profile migration has occurred.
GitHub Actions remains disabled (fresh repository permissions read: `enabled: false`)
under the recorded CI stop. Hosted CI and installed/customer acceptance are unrun.
The tested repair is ready for a draft PR under the owner's standing commit/push
instruction; it is not a merged or released feature.

Changed files: `shared/types.ts`, `shared/diomedes-thread.ts`,
`server/project-conversation.ts`, `server/store.ts`,
`tests/project-conversation.test.ts`, `tests/diomedes-view.test.ts`, and this report.
