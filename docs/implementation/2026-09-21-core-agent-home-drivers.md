# Core agent Home: message-scoped Stop on the conversation drivers

Date: 2026-09-21. Repaired under independent finding HDR-R1 the same day.
Base: ff02829ee626661e22d6019ab4088eef90f77658
Contract: docs/implementation/2026-09-21-core-agent-home-luna-contract.md
Accepted contract review: docs/implementation/2026-09-21-core-agent-home-luna-contract-review-r4.md
Independent driver review: docs/implementation/2026-09-21-core-agent-home-drivers-review.md
(reviewed candidate fa8466c93385a95922dfce7dd931d7e53125f03b).
Lane: bounded driver lane only. The narrow transfer `claim_mub7hn6w_6940be2f` covered
`server/harness/model-session-run.ts`; the parent's `claim_mub87boe_17e907b3` covered this
lane's other three authorized paths (`server/harness/claude-session-run.ts`, the new test
file, this record). The distinct server/shared and client lane holds
`claim_mub87b3u_bbb2be33`; none of its paths are touched here.

## Files changed

- `server/harness/model-session-run.ts` - additive `interruptCommand` on `ModelSessionRuns`,
  inserted between `drive` and `control`. No other method touched.
- `server/harness/claude-session-run.ts` - identical additive `interruptCommand` on
  `ClaudeSessionRuns`, inserted between `drive` and `control`. No other method touched.
- `tests/conversation-interrupt-drivers.test.ts` - new file. Real drivers over a
  FileRunStore-backed RunService; only the provider transports are faked. Repaired under
  HDR-R1: teardown now owns every created driver's lifecycle (see "Independent review
  outcome").
- This record.

## Exact method signature

```ts
async interruptCommand(
  projectId: string,
  runId: string,
  commandId: string,
): Promise<{ state: 'requested' | 'idle' | 'superseded' }>
```

Body, identical in both drivers:

```ts
await this.get(projectId, runId);
const active = this.active.get(runId);
if (!active) return { state: 'idle' };
if (active.commandId !== commandId) return { state: 'superseded' };
active.controller.abort();
await active.promise.catch(() => undefined);
return { state: 'requested' };
```

## Ordering guarantees

1. `get(projectId, runId)` runs first and validates both the run's existence and its project
   ownership and capability before any active entry is read or signalled. A foreign project or
   unknown run rejects `unknown_run` through the same error path every read uses.
2. The `active` read, the `commandId` comparison and `controller.abort()` are one synchronous
   block: there is no `await` between the comparison and the signal, so a turn that replaced the
   named command between the read and the signal cannot be aborted.
3. `active.promise` is awaited only after the signal is sent, so `requested` is returned only
   once the turn's own promise has settled (the `finally` in `request` has already deleted the
   entry by then, which is what makes a duplicate Stop answer `idle`).
4. `requested` is a transport acknowledgement only. It claims that the abort signal was
   delivered to the exact active command, not that the turn durably recorded an interruption.
   The turn's saved step output remains the authority, read through `turnResult` and the
   existing outcome read.
5. The method does not go through `control`, writes no control receipt step, adds no
   cancellation map, timer or scheduler, and calls no provider transport directly. On the
   native driver the existing merged request signal is the mechanism; `session.interrupt()` is
   not invoked.

## Authority guards and the named test that kills each removal

All test names below are inside `describe` blocks `ClaudeSessionRuns.interruptCommand` and
`ModelSessionRuns.interruptCommand`; each runs against both drivers.

- Project/run validation before signalling (`await this.get` first):
  - `a Stop for another project is refused by the existing lookup and cannot abort the turn`
    fails if the project check is removed, moved after the signal, or bypassed: the call would
    resolve instead of rejecting `unknown_run`, and `transports.aborted('a')` would show the
    foreign Stop reached the turn.
  - `an unknown run is refused through the existing error path` fails if the run lookup is
    dropped: `interruptCommand('p', 'never-run', 'a')` must reject `unknown_run`, not answer
    `idle`.
- Absent-active guard (`if (!active) return { state: 'idle' }`):
  - `with no active turn the answer is idle, before any turn and again after it settles` fails
    if the guard is removed: `active.commandId` on a missing entry throws, and the post-settle
    duplicate Stop would throw instead of answering `idle`.
- Command-identity guard (`active.commandId !== commandId` answered `superseded`):
  - `a Stop for a settled command while another is active answers superseded and aborts nothing`
    fails if the comparison is removed or weakened: the Stop naming settled command `a` would
    abort live turn `b`, which the test detects via `transports.aborted('b')` and via B never
    producing `answer:b`.
  - `a Stop whose lookup was delayed sees the active entry as it stands then, not as it was`
    fails if `active` is read before `get`: the stale snapshot answers `requested` for the
    settled command while the newer command owns the turn, and that newer turn is aborted
    (independent mutants D9 and D10 confirmed this red). It does NOT kill a
    single-microtask `await Promise.resolve()` inserted between the comparison and
    `controller.abort()`: independent mutants D11 and D12 inserted exactly that and
    survived. The absence of an awaited gap in the accepted source is confirmed by source
    inspection in the review, not by a test kill.
- Signal-then-await ordering (`controller.abort()` synchronously, `await active.promise` after):
  - `a Stop for the running command is signalled, and the recorded outcome stays the authority`
    fails if the abort is dropped (`transports.aborted('a')` stays false), if `await
    active.promise` is dropped (the `settled` flag is still false when the ack resolves), or if
    the await is moved before the signal (the test deadlocks against the held transport and
    times out).
- Acknowledgement is not a durable claim:
  - the same first test reads `turnResult` after the ack and asserts the real recorded outcome,
    which differs per driver (see below); a fabricated "stopped" result would be caught here.
  - `a replayed command reads the recorded outcome and dispatches nothing again` fails if a
    redispatch sneaks in: `transports.sent('a')` must stay 1 on both drivers.

## Delayed-lookup schedule (as the test forces it)

1. Arm the transport gate for `a`, send `a`, await `entered` (the provider call is in flight).
2. `delayNextGet()` arms the driver's next `get` to wait on a release; the gate wraps the real
   method on the fixture instance and calls through after the wait. It delays scheduling only;
   it does not forge runtime state.
3. `interruptCommand(projectId, runId, 'a')` is invoked while A is still the active command; its
   validation read suspends inside the gate.
4. A's transport is released and A settles; the driver's own `finally` deletes A's active entry.
5. The transport gate for `b` is armed and `send('b', 'follow-up')` runs; `request` registers B
   as the active entry synchronously.
6. The get gate is released; the interrupt's validation completes and the `active` read finds
   B's entry, so `b !== 'a'` answers `superseded`.
7. Assertions: B's transport was never aborted, B completes with `answer:b`, the interrupt
   resolved `superseded`.

## What the fixture found: model interruption versus native reconciliation

The two drivers do not record a signalled Stop the same way, and the tests assert each real
outcome rather than a uniform one:

- `ModelSessionRuns` (`aws-bedrock`): the turn step on the conversation run is a local `tool`
  step; the provider exchange is an external `model` step inside the turn's own child run. When
  the merged input signal aborts, the child call rejects, `agent.run` rethrows, and the
  turn-step catch observes `input.signal?.aborted` and returns `{ response: null, interrupted:
  true }`, which commits as a succeeded step. The request promise resolves with
  `interrupted: true`, `turnResult` reports `{ answered: false, interrupted: true }`, the run
  parks back to waiting, and a replayed command reads that record without dispatching again.
- `ClaudeSessionRuns` (`claude-code`): the turn step is itself the external `model` step. The
  signal abort reaches the native session's controller while the provider never acknowledged a
  stop, so the session marks its checkpoint `uncertain` in memory and persists nothing new (the
  durable record stays `busy`). The driver's clean-interrupt classification (`checkpoint.state
  === 'idle'`) does not apply, the connection is disposed, and the step lands
  `reconcile_required`, taking the run with it. The request promise rejects `CANCELLED`,
  `turnResult` returns `null`, and replay or follow-up is refused `RECONCILE_REQUIRED`.

Consequence for the contract: `requested` acknowledges only that the signal reached the exact
active command. On the model route the durable record then reads `interrupted: true`; on the
native route it reads reconcile_required. Both are truthful; neither is fabricated as stopped.
The fake session mirrors the real one's abort semantics exactly (uncertain in memory, no extra
persist), so the difference above is engine behaviour, not test construction.

## Independent review outcome (review commit 45eafc6cda4cb49ba2c35c94fb6e63d5c7b70884)

The independent reviewer typechecked the candidate (exit zero), ran five focused files green
(75 tests; 14 of them the new driver cases), then applied twelve guard/order mutants
separately on both drivers with byte-restored source between runs:

- Red as intended: D1 and D2 (project/run validation removed), D3 and D4 (absent-active
  guard removed), D5 and D6 (command comparison removed), D7 and D8 (await of the signalled
  turn removed), D9 and D10 (`active` captured before the awaited lookup).
- Survived, disclosed: D11 and D12 (one `await Promise.resolve()` inserted between the
  comparison and `controller.abort()` on each driver). The first version of this record
  predicted the delayed-lookup test would kill any inserted await; that prediction was too
  broad and is corrected in the guard map above. A survived mutant is not converted into
  authority evidence.

HDR-R1 repair, this revision: the earlier test file closed each driver only at the end of a
successful test body, so a failing assertion left driver work racing the temporary-root
removal; the D8 and D10 reproducers each logged a secondary `ENOTEMPTY` from the cleanup
hook on top of the intended assertion failure. Teardown now owns every created driver: each
fixture registers its root at creation and its driver once constructed, and `afterEach`
awaits `closeAll()` for every registered driver before removing that driver's root, even
when the test body rejected. The first close or removal failure still surfaces; nothing is
retried or swallowed. No behavioral assertion or controlled schedule changed, and both
production drivers are byte-identical to the reviewed candidate.

## Risks and known limitations

- The independent reviewer executed the suite green and the guard mutants red against the
  pre-repair test file. The HDR-R1 repair itself has not been executed: this session ran no
  test, typecheck, build or command. The parent's re-review reruns the D8 and D10
  reproducers unchanged apart from this lifecycle repair, requires the intended assertion
  failure without the cleanup `ENOTEMPTY`, restores source bytes, and reruns green.
- `delayNextGet` monkey-patches the public `get` on the fixture's driver instance to gate one
  read. If `get` ever becomes non-writable or private, the fixture needs a different schedule
  gate; the method under test is unchanged either way.
- `interruptCommand` is not yet reachable from the service or HTTP surface. The server/shared
  lane (`claim_mub87b3u_bbb2be33`) owns declaring it on the driver interface the interaction
  service uses and wiring the Stop route; this lane's classes satisfy such an interface
  structurally.
- The native driver's durable answer to a signalled Stop is `reconcile_required`, which is
  heavier than the model route's `interrupted` record. That asymmetry predates this lane and is
  preserved deliberately; any future reconciliation or resume flow for Home is owned elsewhere.
- `closeAll`, `control`, the durable control receipt, cost/egress authorization, and the native
  connection lifecycle are unchanged.

## Status

Produced for independent review and repaired once under HDR-R1. This session executed no test,
typecheck, build or command; the execution evidence cited above is the independent
reviewer's, not this lane's, and the repair itself awaits the parent's rerun of the D8 and
D10 reproducers. No acceptance is claimed or implied: acceptance belongs to the parent.
