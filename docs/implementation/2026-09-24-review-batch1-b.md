# Independent review, batch 1 (b): H11, H04, P01/P03, editor guard

Date: 2026-09-24 · Lane `review-batch1-b` · Branch `review/h11-h04-packs-editor-guard` · PR #88

This is the independent review that the DONE rule requires for four features from overnight batch 1.
The reviewer wrote none of the code under review. Every finding here that is marked fixed has a
test that failed on the reviewed code and passes on this branch. No existing test was weakened,
skipped or deleted. Two existing tests had their inputs resized to the stricter accounting and kept
every assertion; both are noted below.

| Feature | Linear | Verdict |
|---|---|---|
| H11: nested project rules and inspectable delivery | DIO-16 | **ACCEPT WITH FIXES** |
| H04: kept OpenCode sessions | DIO-9 | **ACCEPT WITH FIXES** |
| P01 + P03: pack manifests and lifecycle | DIO-27, DIO-29 | **ACCEPT WITH FIXES** |
| Editor guard | DIO-85, DIO-87 | **ACCEPT WITH FIXES** |

None of the four is a REJECT. Each feature does what its implementation record says in its main
path, keeps to decision 14, and brings no second runtime, authority or surface. The findings are
gaps at the edges: budgets, crashes, collisions, refusals and exits. None of them is a design fault.

## Method

For each feature I read, in order: the implementation record
(`docs/implementation/2026-09-24-*.md`), the Linear scope, the standing decisions in `AGENTS.md`
(1–14), the code, and then the tests. Each probe was written to pass only if the code behaves
correctly. Every probe that failed became the failing test for its fix, and I ran it red on the
reviewed code before writing the fix. Probes that could not be reproduced are listed as
**suspected**, never as findings.

Severity:
- **P0**: data loss or authority widened.
- **P1**: the person is told something untrue, or loses work, on an ordinary path.
- **P2**: an edge case, a crash window, or a gap in defence in depth.

## H11: nested project rules and inspectable delivery (DIO-16): ACCEPT WITH FIXES

Checked and correct:
- **Path guard.** Nested discovery never enters a linked folder: a symlink or junction dirent is not
  a directory. A linked instruction file is refused by `safeAbsolute` at every component and becomes
  an `unreadable` record. A folder swapped for a link after discovery is refused at run time.
  Swapping one between a folder's `projectFile` check and its `readdir` can leak only file *names*:
  every read goes back through the guard.
- **Scope.** `pkg/api` never covers `pkg/apiary`, because the comparison is a whole folder at a time.
- **Authority.** Every file enters at `project` authority, and every instruction rule owns its own
  `guidance:` key in `resolveRules`, so no file overrides another through resolution.
- **Budget honesty.** The `truncated` flag is set only for `no-room` and `over-file-limit`.

Fixed:

1. **P2: the instruction section overran its budget.** `server/harness/instruction-delivery.ts`
   spent the budget on body bytes only. Each applied file also adds a rule line, and then either two
   delimiter lines or a left-out line.
   - With 32 nested files in scope and 128 KB of sources, the section weighed **23,104 bytes against
     its 12,000-byte share**. That ate the reserve which keeps an admitted selection from being
     refused once instructions sit behind it (`native-work.test.ts` states that invariant).
   - Fix: the frame, and every file's worst-case left-out line, are reserved before any body is
     weighed. The prompt's left-out line is now one short fixed reason per kind; the full reason,
     with its numbers, stays on the record. With the same input the section is now 11,736 bytes, and
     the five strongest files are sent.
   - Test: `the whole section, not only the bodies, stays inside its budget when many nested files
     apply`.
   - Resized input: the existing test `when only one fits…` now uses a budget of `product + 5000`
     (was `+ 4000`), because it now pays for its frame. Its assertions are unchanged.
2. **P2: sibling folders were told that one governs the other.** The precedence sentence said
   "Where two disagree, the earlier one governs", but the order is total. For work in both `pkg/api`
   and `pkg/web`, that told the model `pkg/api`'s file overrides `pkg/web`'s on `pkg/web`'s own
   files. The sentence now scopes precedence to files that apply to the same file.
   - Test: `work in two sibling folders is not told that one sibling governs the other`.
3. **P2: colliding rule ids silently dropped a file.** A nested rule id is a 41-character slug plus a
   32-bit FNV digest of the path. A birthday search found a colliding pair in under a second:
   `a×41/10kb0/AGENTS.md` and `a×41/k6yj/AGENTS.md`.
   - Before: work covering both sent one file twice and left the other out of the record entirely.
   - Now: the stronger file keeps the rule, the other is excluded with the reason named, and only
     the kept file's rule reaches resolution.
   - Test: `two files whose rule ids collide are both accounted for, never one silently dropped`.
4. **P2: turning the pack off hid what a run had been sent.** The thread line rendered only while
   an active pack had a file on record. Turning Software Engineering off after a run therefore hid
   that run's delivery record: files that had been applied could no longer be inspected
   (decision 14).
   - Fix: the line now stays whenever the newest run sent something. It reads "Project instructions
     last sent", and the sent files stay readable.
   - Test: `H11-UI-04` in `tests/instructions-inspector.spec.ts`, red on the reviewed component.

Not fixed (observations):
- **Folder-name case in discovery.** Discovery lowercases names before checking `SKIPPED_FOLDERS`;
  the documents walk does not. A `Build/AGENTS.md` therefore appears in Files but is never
  discovered. It is never applied, so decision 14 holds.
- **Case in work paths.** On a case-insensitive disk, a work path spelled with a different case
  from the disk (possible only through the API; the Console selects from the listing) is judged
  out of scope. The miss is safe and is recorded.
- **Hard links** are not detectable by the path guard. This is true of every document, not only
  instruction files.
- **Known gaps already recorded** in the H11 record are not repeated here: bound hits are not
  recorded, discovery is not re-run at each run start, and filenames are matched exactly.

## H04: kept OpenCode sessions (DIO-9): ACCEPT WITH FIXES

Checked and correct:
- **Sessions.** One server and one session per conversation. The checkpoint is written busy before
  the prompt and idle after.
- **Queue.** The cap of 8 is enforced. Steering is idempotent by command id and delivered in order.
  Stop and close cancel what is waiting. A steer is never delivered to the wrong session.
- **Process cleanup.**
  - Every failure after `start()` stops the server: fork refusal, a failed lookup, a model mismatch.
  - On POSIX, a detached process group is killed with `kill(-pid)`. On Windows, `taskkill /T /F`
    takes the whole tree.
  - No fixture process was left alive after start, close, resume, and `closeAll`.
- **Controls** are derived from the contract alone: `steer: host` shows as `queued`, never `live`.
  The steer route is absent on `claude-sessions`.
- **Attribution** is the runtime-reported OpenCode model. A model other than the one selected is
  refused.

Fixed:
1. **P1: a delivered steering message never appeared in the thread.** OpenCode kept the message and
   its answer; the thread did not show them. The person's next message was answered as turn 3 of a
   thread showing two.
   - Fix: `steer()` takes an `onDelivered` callback that runs before the message reads `delivered`.
     The route passes the same idempotent `recordResult` a turn uses. A failed projection is stated
     on the acknowledgement.
   - Test: `a message sent while OpenCode answers is shown in the thread once it is sent, attributed
     like any other turn` (`tests/h04-opencode-session-routes.test.ts`).
2. **P2: an OpenCode session deleted while connected stuck the conversation for ever.**
   - Before: every 404 became a failed abort, an `uncertain` checkpoint, and a run in
     `reconcile_required` for ever. The documented "restarted fresh" path was never reached.
   - Fix: a 404 on `prompt_async` means the prompt was not sent, so the session stays idle
     (`SESSION_INVALID`). The OpenCode profile also confirms a live session still exists before a
     turn is recorded, so a resume starts fresh and says so.
   - Tests: `a prompt OpenCode refuses because the session is gone was not sent…` and `a session
     deleted in OpenCode while connected is refused as not sent, and a resume starts fresh and says
     so`.
3. **P2: a refused fork left a child run to reconcile.** The child run stayed `reconcile_required`
   and the same fork command could never be retried.
   - Fix: the OpenCode profile (`openBeforeTurn`) opens its connection after admission and before
     the turn step, so a refusal parks the run with nothing to reconcile. The Claude profile does
     not set the flag, and its tests pass unmodified.
   - Test: `a refused fork leaves nothing to reconcile, and the same fork command goes through once
     the cause is fixed`.

Not fixed:
- **P2: a steered message skips `prepare`.** Cloud sharing is re-checked when the message is sent,
  and Settings and the account route are re-read at admission. The per-message `consent: true` of a
  turn is not asked. See question 2.
- **P2: a narrow race between `verify()` and `prompt_async`.** A session deleted in those few
  milliseconds still ends `reconcile_required`, because `RunService` marks every failed external
  model step that way; the checkpoint stays idle.
- **P2, suspected: freshness decided on weak evidence.** Any 404 on `GET /session/:id` starts fresh,
  including a route-level 404. So does a 200 whose id differs from the one asked for.
- **P2, suspected: sent steers reported as not sent.** A steer that was sent and whose own turn
  then fails is marked `rejected`, or `cancelled` if interrupted.
- **P2, suspected: a finished answer reported as failed.** If the idle save fails after OpenCode
  finished the turn, the turn is reported failed.
- **P2, suspected: orphaned forked sessions.** A forked or fresh OpenCode session created at open is
  orphaned in the person's history if the command fails before the first busy save.
- **Low: the steer idempotency window.** It covers only the last 24 entries per run. An older id
  falls back to replaying the durable turn.
- **Live OpenCode 1.18.4 remains unverified**, as the H04 record says.

## P01 + P03: pack manifests and lifecycle (DIO-27, DIO-29): ACCEPT WITH FIXES

Checked and correct:
- **Activation is not authorization.** No consumer reads a manifest as a grant: only the listing
  route and `PackSettings` read manifests. `grantsAuthority` and `acts` are the literal `false`.
- **Route ids and file paths.**
  - Route ids match `PACK_ID_PATTERN`, so there is no traversal into `objects/`.
  - File paths refuse `..`, absolute paths, backslashes, drive letters, NUL, leading dots, and
    duplicates that differ only in case.
  - Links are refused at every level.
- **Crash recovery.** A crash at `staged`, `placed` or `committed` recovers. Unreferenced objects
  and staging are swept.
- **Concurrency.** HTTP operations are serialized by `store.locked`.
- **Unknown store version.** It is refused before any write, including the `interrupted` append.
- **Uninstall of an in-use pack.** It is refused across every project.
- **Dependency resolution.** Cycles and conflicting ranges are refused by name. `^1.0.0` never
  admits `2.0.0-beta`.

Fixed (each with a test; see the commit messages for the test names):
1. **P2 (P1 once contributions run): update and rollback could strand a dependency.** They could
   leave a pack on while its new dependency was off. They now refuse (`dependency-off`), naming the
   project and the dependency.
2. **P2: a damaged dependent stopped protecting its dependency.** The dependency could then be
   turned off and uninstalled.
   - Dependencies are now recorded in the store at install.
   - A damaged pack is judged by that record.
   - A damaged pack with no record blocks the changes it might need, by name
     (`damaged-dependent`).
3. **P2: a crash during first-open preinstall lost Software Engineering and Small Business for
   good.** Missing preinstalled packs are now installed on every open, unless an uninstall of them
   is recorded.
4. **P2: installed packs were not re-verified.** A verified manifest was cached for the life of the
   process, and payload files were never re-checked after install. Every action now re-verifies the
   manifest digest and each file's size and sha. A damaged pack will not turn on.
5. **P2: the publisher display name "Diomedes" was not reserved.** A local folder could show
   "Diomedes · digest verified". The name is now reserved with the id, ignoring case.
6. **P2: the digest was taken after the schema trimmed strings.** So a padded manifest that
   `sealManifest` had sealed was refused as a digest mismatch. Padding is now refused, not trimmed.
7. **P2: prereleases compared as plain strings.** `1.0.0-beta.10` sorted below `beta.2`. They now
   follow semver 2.0 §11.
8. **P2: a `store.json` holding `null`, or JSON of another shape, was replaced or crashed.** Only a
   missing file means no store yet; anything unreadable is refused (`unreadable-store`) and left
   untouched.
9. **P2 (Windows): payload paths accepted device names and trailing dots or spaces.** Names like
   `con` and `nul.txt`, and segments ending in a dot or space, are refused with `relativeName`'s
   rule. An instruction-file rule also refuses `.` and `..`.

Not fixed:
- **P2: the outward-capability refusal is a denylist of name prefixes.** `email-customers`,
  `upload-files` and `wire-money` pass it, while `postgres-read` is refused. A request is never a
  grant, so this is defence in depth only. See question 1.
- **P2, suspected: `acquireDirectory` checks a file, then reads it.** A time-of-check/time-of-use
  window; the sha check still pins the content.
- **P2, suspected: one bad variant file poisons the catalogue.** A variant file whose name the path
  pattern refuses would reject the whole bundled catalogue, and that rejected promise is cached.
- **P2, suspected: in-memory drift on a failed write.** If `jsonWrite` fails inside the `completed`
  append, the in-memory `packs` has already changed.
- **By design: a damaged pack with no recorded dependencies blocks every other uninstall** until it
  is removed. This is the conservative option.
- **Not applied: an update to the lane's own record.** The P01/P03 record does not yet mention
  re-verification of payload files, the reserved publisher name, the store-shape refusal, or the
  `dependency-off` and `damaged-dependent` refusals. This review records them here instead of
  editing another lane's record.

## Editor guard (DIO-85, DIO-87): ACCEPT WITH FIXES

Checked and correct:
- **Every way out of the editor is gated.**
  - Every `setEditing` goes through the gate, Close, or the rescue copy.
  - Every Console-reachable `setSelected`, `setShowSettings` or `setLanding` in `App` goes through a
    guarded helper.
  - Palette navigation is wrapped.
  - No IPC menu command navigates.
- **Gate lifecycle.** Installing and removing the gate is keyed and ordered.
- **Electron.** `will-prevent-unload` treats `preventDefault` as allow-unload, and its dialog is
  modal to the right window.
- **Settled kind.** It latches once and never changes under writing.

Fixed:
1. **P1: Quit asked about unsaved writing after the service had stopped.** Menu Quit and Cmd+Q ran
   the service shutdown in `before-quit`, before the windows closed and asked. "Keep writing"
   therefore returned the person to an editor whose Save could not reach the service, with the data
   lock already released.
   - Fix: the shutdown now runs in `will-quit`, once every window has closed.
   - Test: `quitting asks about unsaved writing before the local service shuts down`, a structural
     check. A packaged Electron run was not possible here.
2. **P2: words typed during "Save my writing as a separate file" were lost.** The editor now stays
   put and keeps the backup.
   - Test: `DIO-85: words typed while the rescue copy is being written are not lost`.
3. **P2: the rail's Files item closed the editor, or asked first.** It is not an exit and no longer
   goes through the gate.
4. **P2: a second exit while the question was open left focus on the clicked button.** The question
   takes focus back.
   - Test for 3 and 4: `DIO-85: a second exit while the question is open puts the keyboard back on
     it, and the Files pane is not an exit`.
5. **P2: an editor whose file the listing could not be read for, or did not have, said "Opening"
   for ever.** It now says so and offers Try again. Typing stays blocked until the kind settles.
   - Test: `DIO-87: a file the listing does not have says so and can be looked for again`.

Not fixed (suspected):
- Leaving while a save is in flight, with the backup working, can make the next open show a false
  "someone else changed this file".
- A `settings` event from another window that resets onboarding swaps the Console for Setup with no
  gate.
- A render error unmounts the editor through the ErrorBoundary with no gate.
- If the rescue path's own `load()` fails, no listing runs, so the editor reads "Opening" until the
  next state event. The error bar still reports the failure.

## Questions for Andrew (each with the default this branch takes)

1. **Outward-capability requests: denylist or allowlist?**
   - Proposed default: an allowlist drawn from Trust's own capability vocabulary, so any request
     outside it is refused at install.
   - Until decided, the denylist stays, and a request is still never a grant.
2. **Should a queued steering message carry the same per-message consent as a turn?**
   - Proposed default: yes. The steer body would carry `consent: true`, and the route would re-run
     the cloud-sharing check that a turn gets.
   - Today it re-checks cloud sharing when the message is sent, and asks for no separate consent.
3. **A damaged pack with no recorded dependencies blocks uninstalling any other pack. Is that the
   right conservative stance?**
   - Proposed default: yes, until the damaged pack is uninstalled or repaired.

## Gates (this branch, Linux, final run)

Run on the tree of the commit that adds these counts:

- `npx tsc --noEmit`: clean.
- `CODEX_HOME=$(mktemp -d) node node_modules/vitest/vitest.mjs run --maxWorkers=3`: **361 files
  passed, 1 skipped; 6435 tests passed, 16 skipped, 0 failed.** The first run hit the known
  "Electron failed to install" in three native-auth files. After `node node_modules/electron/install.js`
  those files pass 80 of 80, and the full rerun above is clean.
- `npx vite build`: ok.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
  tests/instructions-inspector.spec.ts tests/pack-lifecycle-ui.spec.ts tests/editor-guard-ui.spec.ts`:
  **50 passed.** H04 adds no Playwright spec: it has no Console surface yet.

PILLAR IMPACT: none against. Decision 14 is strengthened: applied instructions stay inspectable,
and damaged or stranded packs do not turn on. Decision 8 is strengthened: steered answers are
attributed in the thread.

ROADMAP IMPACT: no status change. All four features are reviewed with fixes. H04's live acceptance
and the Console decision remain open, as its record says.

BUILD STATUS: branch and draft PR only. No version bump, no native-runtime hash, no canonical-doc
edit.
