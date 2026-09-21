# CD-01 bounded repair handoff

Addressed to the active Claude implementation owner, PID 68088, checkout
`F:/Diomedes/diomedes-wt/core-agent-contract`. The coordination role is `fable`;
that is an ownership seat, not a delegated-model selection.

Production files were kept read-only, as Andrew instructed. Claims
`claim_muatf92y_3a198c32`, `claim_muav2at2_cbb1f914`, and
`claim_muavu3k2_5518698b` cover the relevant app, interaction and Runtime files.
No repair commit, merge, provider acceptance, package or publication is claimed.

The independently tested owner successor is
`d11c468e69e279ab0c2581bbdeb6cf113e166d7a`, preserved at
`F:/Diomedes/diomedes-wt/interaction-authority-review`.
The original rejected checkout and evidence at `core-agent-driver-review`
remain unchanged. Owner HEAD subsequently moved through `4e2c93c` to
`26b33ff3fec77786d88b1dd3b1cf1a79bff82696` for reserved-home repairs.
The results here do not certify those later commits. Source comparison shows
they do not change the interaction service, source Runtime or host admission
boundaries identified in this handoff.

## Confirmed starting evidence

The preserved original run on `265a33c0a4af898929f70661eff46f72be456388`
failed all three independent counterexamples (3 failed, 10 fixture cases skipped
by that original filter). The fresh d11c468 run did not filter those fixtures:
90 passed, 1 failed, 0 skipped across six collected files. The cancellation and
pending-answer counterexamples pass; real Ask after `action-selected` still
admits one Work session. Exit 1 is rejection evidence.

The first typecheck found only two `unknown` type errors in the independent
test copy. Its helper now has an explicit `ClaudeSessionRuns` type. No test
assertion or production file was changed. The archived original stays byte-identical.
Final matrix and gate results are recorded separately in `REVIEW-RESULT.md`.

## Exact owner repair boundaries

1. `server/interaction-service.ts` / `AdmissionSource`, `settle`, `select`, `read`:
   carry server-resolved source project, thread, message/command identity,
   lineage run/generation (existing run identity may supply the equivalent),
   immutable proposal digest, and pinned target. These are check inputs, not grants.
   Reconstruct the child command from the immutable decision and saved child input.
   Save all intent needed for exact replay, including execution-route choices,
   before child admission; do not reconstruct an old command from changed settings.

2. `server/app.ts` / `interactionHost.createTask` and `.startWork`:
   check the current thread, non-retired lineage, source message, saved selection,
   target and the intersection of saved/current restrictions at EACH new child
   admission. `resolved.control` and `located.restriction` sampled before awaited
   phase writes are insufficient. Preserve a task that validly committed before a
   later restriction; refuse only the prohibited new Work.

3. `server/harness/run-service.ts` / existing `serialize` and
   `server/harness/claude-session-run.ts` / `assertLive`:
   a read under Store.locked does not serialize against model-step failure,
   `cancel`, denial in `decide`, `complete`, `fail`, or startup `recover` in the
   Runtime queue. Replace the liveness-only read at admission with a narrow
   callback/fenced equivalent owned by RunService. A suitable boundary must
   validate current principal/project scope, lifecycle and source generation,
   then hold the existing source-run queue through the child's durable admission
   commit. It must not call `claim`, `record`, `step`, `cancel`, or reacquire the
   same source queue from inside that callback.

4. Lock order is Store -> source RunService queue -> child receipt/state commit.
   Current HTTP cancel already uses Store -> RunService queue. Runtime-only
   transitions use that same source queue without acquiring Store. Do not add
   an inverse Runtime queue -> Store acquisition. Phase writes happen outside
   the bounded admission callback. Cancellation/narrowing first means no new
   prohibited child; child commit first preserves that child's identity.

5. Do not wrap the entire current `admitWork` in a new source-run lock.
   `server/native-work.ts::start` awaits Agent registry/file/instruction preparation
   and baseline capture; `server/work.ts::start` awaits document enumeration,
   snapshots and baseline capture. Resolve preparation through those existing
   owners, then enter the source guard immediately around final validation and
   durable receipt/session mutation. Revalidate prepared scope under the guard.
   Provider dispatch, human waits, and background work must not be awaited in
   that guard. `AgentRegistry.resolve` reads local definitions; it is not a
   model-provider call. Existing Store locking over preparation is not proof that
   adding another lock over it is safe. Keep the change limited to the two
   existing Work start paths and their interaction caller, without a new runtime.

6. `server/app.ts::interactionHost.receipts` currently uses only `findCommand`
   and family checks. Use existing command parsers/digests and `assertReplay`
   (or their Store owner equivalents) before trusting an existing child.
   A command ID bound to a different task/work payload must conflict, including
   recovery without the parent receipt phase. Do not skip the digest check just
   because a task/session ID exists. Existing valid receipts are read evidence;
   they must be returned under current read authorization without fresh execution
   authorization, provider dispatch, usage reservation, or phase writes.

7. `server/interaction-service.ts::select` rejects settled runs before looking
   for an existing exact selection receipt. Split receipt-only replay from new
   selection/admission: validate the old selection identity/digest/target and
   bound child intent, return its committed receipt, and only then apply current
   execution authority to a genuinely new effect. GET/message replay working
   does not establish that `/select` retry works.

8. `server/interaction-service.ts::outcome` hard-codes `interrupted: false`.
   Read durable turn completion/result evidence from the driver consistently
   with the decision and lifecycle. `locate().answered` means the Runtime step
   succeeded; an acknowledged interruption can succeed with no response, so that
   boolean alone is not a completed answer. Preserve genuine interruptions,
   missing-evidence unresolved outcomes, pending/partial non-interruption, and
   the old command/run identity. Do not widen the outcome union unless required;
   update its validators/consumers together if it changes.

9. Concurrent identical `select` calls currently yield one HTTP 200 receipt and
   one HTTP 409 `blocked: step already in flight`, with one task/Work session.
   The duplicate is safe from double admission in the tested schedule, but does
   not converge to the same receipt as required. Make immutable phase recording
   and same-intent admission join/read the existing result through the current
   Runtime owner. Do not add a conversation-wide lock across inference. Conflicting
   intent must still fail, and uncertain persisted state must reconcile rather
   than dispatch again.

## Concrete artifacts

- `SWE-MAX-mode-bindings-PARTIAL-UNAPPLIED.patch`: exact two-file proposal for
  items 1-2, normalized from the first SWE-2 Max session. `git apply --check`
  passes against d11c468. It was NOT applied, compiled or accepted, and does not
  solve items 3-9. Treat it as review material, not a release patch.
- `swe-max-patch-output.txt`: original author output, including its explicitly
  admitted residual Runtime window.
- `swe-max-independent-review-output.txt`: separate fresh SWE-2 Max review.
- `tests/interaction-authority.matrix-20260921.test.ts` in the review checkout:
  real HTTP/Store/RunService/session-driver/task/Work tests with only providers
  faked. Barriers control the schedules; no timing sleep orders the races.
- `run-matrix-gates.ps1`: exact pinned-slot runner and gate commands.

The source guard is process-local ordering, not a claim of atomic multi-file
crash recovery. Recover a committed child by its validated durable receipt when
the parent receipt phase is missing; preserve uncertainty as reconciliation.
The restart test uses graceful teardown after an injected missing parent phase,
not an OS process-kill or a torn Store/RunStore write. Source-cancel ordering and
receipt identity do not alone prove every existing child stop/reconciliation path.

After owner implementation: commit the exact bounded repair in the owner lane,
provide the commit and gate logs to independent review, rerun the complete
matrix and unfiltered fixtures on that commit, and retain the original failures.
No full CD-01, live provider, packaged release or website-download acceptance
follows from this fake-provider seam review.
