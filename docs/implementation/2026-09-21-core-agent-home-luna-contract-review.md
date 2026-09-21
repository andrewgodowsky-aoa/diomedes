# Home Luna and Stop contract review, first proposal

Date: 2026-09-21. Source baseline: `2120ae6`, unchanged in the relevant
implementation at `d813494`. Proposal preserved in the adjacent contract file
from the separate author's frozen-source output. This is independent source
and contract review, not execution of an implementation.

**Changes required. No implementation acceptance is granted.** The intended
AWS default, separation from Work routing, named refusal without fallback,
explicit project for actions, and command-specific Stop are in scope. The
following proposal details are not accepted.

## HLC-R1: consume-once in-memory cancellation is not a durable command outcome

Section 3 proposes a per-run `voided` set, consumed on the first request, and
deliberately allows a later Send again of the same command to dispatch. The
schedule is: Stop records A in memory, request A consumes the mark and rejects,
then a duplicate or restart requests A again and dispatches it. No durable
turn result proves interruption. This introduces a second cancellation store
and breaks the existing rule that the same command recovers its own recorded
outcome. Remove this design. Use existing driver/runtime recording and
ordering, or return a truthful not-active/not-found result without claiming a
pre-admission cancellation guarantee. The client must still prevent its own
not-yet-dispatched request after Stop. Specify the exact gap and its handling;
do not solve it with an unbounded or consume-once memory marker.

The proposed native control step also reuses the target message command ID as
its control request ID. Existing control identity has different intent from
the message. Specify a distinct deterministic control identity if a control
step is used, while separately comparing the target message identity at the
actual abort point. Test delayed A Stop after B starts on the same lineage.

## HLC-R2: existing Home never reaches the proposed migration write

The proposal says Home migrates on next ensure. At
`client/console/DiomedesHome.tsx:191`, ensure returns the existing Home binding
without calling POST. Schedule: load an old Home with a Claude pin, send a new
message, reuse the binding, and still send to Claude. Explicitly amend the
send-time ensure behavior or another authorized write boundary. Reads remain
pure. Replay of an old command must retain its original driver and identity.

## HLC-R3: Stop needs exact delivery identity across all client branches

Section 4 must cover the existing same-window `inFlight` branch, which returns
an existing promise before acquiring the lock, plus a cross-window waiter and
Send again whose displayed command settled while it waited. Text equality
alone must not authorize interrupting whichever command is currently stored.
Define when this delivery receives an exact dispatch identity, when it is
cleared, and how an already-resolved or read-only recovery path avoids a Stop
POST. A pre-ensure or lock-wait Stop must prevent later dispatch, and must not
publish a newer visit's result. The existing command-bound storage and visit
fences remain authoritative.

## HLC-R4: routing proposal must be executable and internally consistent

Section 2 says all four Claude-only sites should reference the default
constant, but the Home update guard must allow supported explicit choices,
not require the default constant. Separate the supported-route guard from
the default written by provisioning. Name the exact thread type that gains
the choice marker and the existing UI through which a choice is available.
The Diomedes page currently has no route picker supplied by this plan; do not
claim visible selection without identifying or adding its bounded UI path.

The legacy migration default can follow Andrew's explicit decision to make
Home and project conversations default to Luna: unmarked system-era pins
migrate on the next explicit ensure, while new marked choices persist. State
the one-time compatibility effect plainly. Historical unmarked project pins
cannot be distinguished retrospectively. Do not turn that limitation into a
new approval gate when the authorized default is otherwise implementable.

## HLC-R5: boundary updates and exact acceptance

The AWS owner handoff is now authorized by Andrew: `The owner has stopped
editing; transfer this file`. The pinned tool split the old claim. Only
`server/harness/model-session-run.ts` is claimed for this implementation as
`claim_mub7hn6w_6940be2f`; all residual AWS paths are reserved for their owner.
Update the stale ownership paragraph in the proposal. No provider setup,
credentials, live call or spend authority moved with this file.

Use new tests for the new contract and explicitly supersede only the old
Claude-pin expectations that conflict with it. Frozen admission and AWS
oracles and historical reviewer files stay unedited. Every new guard needs an
independent removal/red/byte-restoration/green check, with survivors disclosed.
The corrected contract needs independent review before implementation starts.
This review remains unchanged when a successor proposal is written.
