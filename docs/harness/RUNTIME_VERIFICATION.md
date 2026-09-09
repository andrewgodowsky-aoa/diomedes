# Native harness runtime delivery, 2026-09-09

Continuation: [NR-02 packaged proof and NR-03 adapter verification](NR02_NR03_VERIFICATION_2026-09-09.md).
The report below describes the earlier published packet and is retained as evidence.

Worktree: `F:\Achilles\diomedes-wt\codex-harness-runtime`.
Branch: `codex/harness-runtime-20260908`.
Base: main `86ee91d8357080a7d2aa41206281d68502dd5c2e`.
Boundary merge parent: `fable/harness-boundary`,
`c777c4178d254fb057447c33d046884029818b3b`.

The foundation and approval receipts already landed in main at `0ad3951`.
Neither old dirty Codex worktree was edited or committed. The boundary merge and
runtime changes were held at the user's checkpoint until the user authorized
committing and publishing them to the Diomedes GitHub repository on 2026-09-09.

## What runs now

`createApp` creates the harness host after Store journal recovery. The
`format-report` capability reads shipped synthetic lines, formats them
deterministically, requests an exact Need approval and writes `Harness report.md`
through `Store.writeRecorded`. The Session and Task mirror the durable run,
including waiting, completion, cancellation and reconciliation. Existing Work
admission still excludes a second active Session in the same project.

The adapter is scripted. No Codex/provider request, external tool, credential
lease or model-generated result is part of this path. The run store, Session
bridge, HTTP routes, approval receipt, filesystem journal, History write and
child-process crash recovery are real implementations exercised through
`createApp` over temporary data folders.

## Invocation

Trusted in-process caller (this method acquires Store.locked itself):

```ts
await app.locals.harness.bridge.startNativeRun(
  projectId,
  null, // or an existing Task id
  'format-report',
  'Format the shipped fixture.',
  localHarnessPrincipal(projectId),
);
```

The existing non-GUI Work endpoint also accepts this fixture request:

```http
POST /api/projects/<projectId>/work/start
Content-Type: application/json
X-Diomedes-Client: 1

{"capabilityId":"format-report","taskId":null,"instruction":"Format the shipped fixture."}
```

The returned Session is visible through the existing state/SSE Session mirror.
In the desktop, the existing Work, Review and Board/thread surfaces consume those
records and the existing approval helper submits the Need decision. There is no
new fixture picker. A task without a thread can be opened from the Console Board
through its existing Open thread action. Browser rendering was not exercised in
this packet, so this is a host/state and client-helper proof, not visual proof.

Read `GET /api/projects/<projectId>/needs` and resolve the open Need through the
existing endpoint, copying all three digests verbatim:

```http
POST /api/projects/<projectId>/needs/<needId>/resolve
Content-Type: application/json
X-Diomedes-Client: 1

{"protocolVersion":1,"commandId":"my-fixture-decision","resolution":"go-ahead","proposalDigest":"<from Need>","actionDigest":"<from Need>","baseDigest":"<from Need>"}
```

Reuse the same command id and payload when retrying a lost response. Use
`resolution: "declined"` to cancel without writing. An expired decision is 409;
stop and start a new fixture to get a fresh approval window.

Routes, under `/api/projects/<projectId>/harness`:

| Method and path | Result |
| --- | --- |
| `GET /runs` | IDs, states, capability/version, Task and Session ids |
| `GET /runs/<runId>` | Scrubbed v1 run; opaque transcript references only |
| `GET /runs/<runId>/events?after=<seq>` | Events strictly after the cursor and `lastSeq` from the same snapshot |
| `POST /runs/<runId>/cancel` | Scoped cancellation through the person's principal; client header required |

The existing `/work/<sessionId>/stop` and `/note` routes also select the harness
bridge for a fixture Session. Saved Work-start command receipts for the fixture
route are not part of this packet; supplying their protocol fields is refused.

## Verification

The combined baseline passed `npm run check` and all 460 Vitest tests. The final
`npm run check` and `npx --no-install vitest run` both exited 0: all 483 tests
passed across 18 files. Gate results, timestamps, exit codes and file hashes are recorded in
`evidence/harness-runtime-verification.json`; corresponding command output is in
the ignored `evidence/harness-runtime-*.log` files. Both commands use existing
dependencies through a local `node_modules` junction; no package was added.

The 22 host tests cover:

- One Session/Task, fixture output, before-step and event logs, exact intent
  binding, one-hour expiry, immutable receipt replay and one History write.
- Restart with an unanswered Need; completed-run event reconnect from a saved
  cursor over another app instance using the same temp folder.
- Expired and declined decisions; changed identity; independent project scope;
  missing client header; invalid cursors; existing Session Stop dispatch.
- A second fixture or sample Work start receives 409; thread permission is
  mirrored while the fixture retains its explicit approval policy.
- Outside edits stay untouched and result in a failed run with a not-applied
  execution receipt.
- Unknown effects stay `reconcile_required`, retain the waiting/went-wrong
  presentation after restart, refuse completion and do not restart automatically.
- Unknown version, malformed v1 step, null record, inconsistent principal scope
  and duplicate run IDs cannot break unrelated app/project startup; rejected run
  files are preserved.
- An initial claim failure cannot revive a queued run through pending mirrors.
- A listing begun before creation cannot erase the new run's lookup. The
  regression test reproduced the lost lookup before the cache revision fix.
- Secret scrubbing of durable errors, logs, events and returned transcript refs.
- On Windows, transient atomic-rename contention is retried; a permanent failure
  surfaces after six attempts and leaves the prior record unchanged.
- Actual child-process exits after decision persistence, after journal creation
  and after the document write but before step commit. Reopening recovers one
  applied receipt and one History write, then completes the harness observation;
  reopening again adds neither another write nor another completion event.

One additional client test exercises a bare harness intent hash through the
existing compact pending-command storage and lost-response retry. The existing
foundation, approval, native Work, team and harness boundary suites remain gates.

The first host pass exposed the prefixed-versus-bare action digest mismatch; the
server and client helper were fixed. A later pass encountered a real Windows
`EPERM` during atomic run replacement; the bounded retry and permanent-failure
test address that observed failure. The full-suite pass also exposed expiry
extension under disk latency; the optional absolute decision deadline fixes it.
The existing 200 ms cached-state timing guard was preserved after one loaded run
measured 250 ms; it measured 12 ms in the final full suite. Expected injected
failures are printed by negative tests and are distinguished from the final test
exit code.

Two read-only Muse reviews used OpenCode Go. Verified findings informed receipt
validation, startup handling, failed claims and duplicate ID handling. The
suggestion to bypass Store decision receipts was rejected. Per-event plain and
technical lines remain as the packet requires; no log compactor or background
timer was introduced. Review reports were treated as leads, then checked in code
and tests.

## Changed files and commit

Commit message: `Integrate native harness host and format-report fixture`.

Runtime changes and evidence:

```text
README.md
client/approval-decisions.ts
docs/harness/CHANGES.md
docs/harness/RUNTIME_VERIFICATION.md
evidence/harness-runtime-verification.json
fixtures/harness/report-lines.txt
server/app.ts
server/approval-admission.ts
server/harness/adapters.ts
server/harness/approval.ts
server/harness/bridge.ts
server/harness/capabilities/format-report.ts
server/harness/fixture-adapter.ts
server/harness/host.ts
server/harness/routes.ts
server/harness/run-service.ts
server/harness/run-store.ts
server/native-work.ts
server/secrets.ts
server/store.ts
shared/types.ts
tests/approval-decisions-client.test.ts
tests/harness-host-child.ts
tests/harness-host.test.ts
```

The merge also brings Fable's existing boundary files: `shared/harness.ts`,
`server/harness/{adapters,index,native-agent,policy,present,run-service,run-store,tools}.ts`,
`tests/harness{,-negative,-present}.test.ts` and
`docs/harness/{CURRENT_STATE,GPT6_RUNTIME_PACKET,HARNESS_INTEGRATION_MAP,VERIFICATION}.md`.
The runtime changes to adapters/run-service/run-store are listed explicitly above.

## Limits and next packet

No Windows executable was rebuilt, no running app/service was restarted and no
live project data was used. No browser or Playwright claim is made. No OS sandbox,
real provider, workflow graph, general replay/reconciliation UI, inbox, broker,
environment, MCP Apps, A2A, transfer or optimization implementation is included.
No settings, LocalAI/Hermes files, user Codex configuration or pinned binaries
were changed. The verification snapshot predates the user's subsequent commit and
GitHub publication authorization. The repository's Git history records publication.

Migration and rollback details, including the optional Need binding and older
reader limitation, are in `CHANGES.md`. The next bounded implementation is the
Codex `EngineAdapter` using a run-scoped egress grant, as specified in section 3
of `HARNESS_INTEGRATION_MAP.md`.
