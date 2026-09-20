# H01 durable event recovery candidate

Base: `80263205133c410d590549efd1c8f40cedf33b1c`.
Feature: `adapter-event-recovery`, branch `feature/adapter-event-recovery`.
Actual implementer model: `gpt-6-astra`, MI-DEMO bounded worker.
Canonical documents read: Pillars 2026-09-19.1; Roadmap and Project Memory
2026-09-19.2. No product definition or roadmap status changes.

## Implemented behavior

`GET /api/projects/:id/harness/runs/:runId/events/stream` observes the existing
RunService/FileRunStore event history over SSE. It does not dispatch a model,
recover a run, resolve an effect, write an event, or create another lifecycle.
The host signals only after a persisted run save. Each subscription reads fresh
snapshots through `host.get`, using the same project lookup, saved-record checks,
secret scrubber and current authorization as the existing JSON event route.

Each durable frame has `event: harness-event`, numeric `id: <seq>`, and the
unchanged versioned HarnessEvent in JSON `data`. The cursor is scoped to this
run's URL. `after` defaults to zero; a supplied `Last-Event-ID` overrides it,
because EventSource retains its original URL during automatic reconnect. Both
supplied values must be strings of decimal digits representing safe nonnegative
integers. Empty, negative, fractional, non-finite, exponent, repeated-query and
unsafe-integer values receive HTTP 400. A cursor ahead of the authorized saved
snapshot receives HTTP 409 with `event_cursor_ahead` and `lastSeq`; the server
never silently resets it. The JSON event route now rejects future cursors too.

The subscription is installed before the initial snapshot. Save notifications
coalesce behind one reader, which sends only `seq > cursor`; replay and live
delivery cannot race into duplicate or reordered events. Backpressure pauses
writes until `drain` and retains a cursor and wake-up flag, not an event queue.
The last queued frame may be lost when a socket drops; reconnect resumes from
the last id actually received by the client, replaying its missing suffix.
Clients should retain that per-run cursor and render each sequence once.

Completed records remain observable without fabricating another terminal event.
The stream stays open until the client/host closes it or a read/authority check
fails. A reconnect from the current tail waits for new events. Abort, response
close/error, host shutdown and failed initial reads remove subscriptions,
Store listeners, drain listeners and the heartbeat timer.

Every delivery batch, drain and relevant Store change rechecks `host.get`.
A 15-second heartbeat also rechecks idle or backpressured connections when an
authority change has no Store notification. A failed check after headers closes
the transport without appending an event or reporting completion. A new request
receives the existing HTTP error. This preserves current host authority behavior:
`codex-report` checks its stored prototype Trust reference and current
`project.read` capability/generation; local fixture/text routes do not acquire
Business session or tenant authentication from this change.

## Verification

The final focused run passed **150 tests in nine files**, zero failures and zero
skips. Evidence lives under
`F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/runs/mi-demo-20260919/adapter-event-recovery/`.
`focused.json` and `focused.log` are the actual final outputs, not historical sums.
Final `tsc --noEmit` and `git diff --check` also exited 0. Source line endings
were normalized after the focused run; executable code did not change.

Command (existing installed dependencies, one worker):

```text
vitest run tests/h01-event-recovery.test.ts tests/h01-event-stream.test.ts tests/h01-adapter-contract.test.ts tests/h01-conformance.test.ts tests/h01-runtime-seam.test.ts tests/h01-preview-repair.test.ts tests/independent-h01-20260917.test.ts tests/codex-engine.test.ts tests/harness-host.test.ts --maxWorkers=1
```

The 21 new tests use real Express HTTP sockets, Store, HarnessHost, RunService and
FileRunStore in owned temporary folders. They cover invalid/future cursors,
foreign project/run lookup, Last-Event-ID precedence, persisted replay after a
dropped reader/restart, a save racing initial subscription, tail continuation,
two readers, no second scripted provider dispatch after replay/restart, initial
abort cleanup, host shutdown, malformed saved events, authority revocation,
generation changes, stalled readers and idle authorization rechecks. The
backpressure test controls the HTTP write/drain signal; it is not an OS-level
slow-network benchmark. Codex I/O and authority are explicit synthetic fixtures.

RED evidence is preserved: the first corrected-fixture run had 13 failures due
to the absent SSE endpoint and three fixture protocol-version failures. The
fixture protocol version was corrected before the green run; those three
failures are not production defects. Existing H01 tests provide regression
proof for a real OpenCode fixture SSE socket drop, one uncertain dispatch,
`reconcile_required` across restart, and no fabricated completion.

The previously accepted H01 repair commit
`e20d7ca00d730b747c991c89d3359f4a8385d65b` is an ancestor of this base. Its exact
independent verdict is retained at
`F:/Diomedes/deliverables/codex-h01-repair-20260917/independent-review/VERDICT.json`.
That verdict does not independently accept this new patch.

## Proposed prerequisite subset

Name: `H01-local-durable-event-recovery-v1`.
Origin: `H01.I-replay`; consumes adapter contract v1, harness record v1 and
unified contract revision `2026-09-13.1`, without changing those contracts.
Allowed proposed consumers: `MI00.I`, `MI06.I`, `B01.I` for local implementation
of persisted per-run cursor/event semantics only. The detached result binds this
proposal to the complete patch, exact base, candidate tree and file hashes.
Independent review accepted the exact production bytes in
`H01-local-durable-event-recovery-v1`; see the September 20 landing record below.

Required invariants are persisted ordered events, cursor continuation without
duplicate effects, no provider dispatch on observation, one existing runtime,
current supported authorization before delivery, and parked uncertain outcomes.
The tests above prove the local producer boundary. B01/B02/B03 and MI01 must
provide their actual storage ownership, verified subject/session/tenant access,
revocation and remote subscription enforcement before exposing this surface to
Business/mobile clients. The existing prototype authority is not a safe
substitute. Any change to the listed production modules, event/authority
contracts, storage semantics or consumed baseline invalidates affected reviews
and requires fresh composition proof.

## Explicit exclusions and remaining gates

The old `/api/events` state/preview feed and client preview reconnection are
unchanged and do not gain durable replay. There is no global cross-run cursor,
append-only storage migration, compaction/reset protocol, shared-service tenant
auth, native provider reconnect/resume guarantee, or new provider control.
Full H01/MH-1 conformance is still open. Fixture events do not certify real
provider behavior or native containment.

The local subset has passed independent review and fresh landing gates. No live
provider, packaged or installed app, physical iPhone/iPad, deployment or full H01
acceptance is claimed. No prompt is marked DONE by this subset.

Pillar impact: advances durable evidence and recovery (06/09) through the
existing runtime and authority. No semantic conflict identified. Roadmap impact:
accepted local prerequisite only; no full-prompt or product-release claim.

## September 20 landing verification

The feature branch `feature/durable-event-recovery` reconstructs all five files
of independent review tree `2d8c61cbfb6e5875e68978c002fc40893080840c` on
`80263205133c410d590549efd1c8f40cedf33b1c`. Its production modules and both
recovery test files match the accepted raw SHA-256 manifest. The only additional
test change is the requested handler-entry latch in `h01-event-stream.test.ts`,
reused from the subsequent accepted local composition. It replaces a 50 ms wait
without changing the reconciliation assertions.

Fresh landing checks on September 20: TypeScript and Vite passed; 2,295 unit
tests passed, zero failed, one existing Windows short-name test skipped;
46 browser tests passed, zero failed or skipped. The browser selection includes
the three required app suites and both H01 repair suites. Generated tracked
evidence was archived and the original bytes restored after validation.

Detailed logs are in
`F:/Diomedes/deliverables/continuation-20260920/durable-event-recovery/gates-1/`.
The independent verdict and exact source hashes are in the existing coordination
run `mi-demo-20260919/adapter-recovery-review/VERDICT.json` and
`candidate.manifest.json`. Publication is governed by the reviewed feature PR;
these checks do not certify native routes, remote tenancy or physical devices.
