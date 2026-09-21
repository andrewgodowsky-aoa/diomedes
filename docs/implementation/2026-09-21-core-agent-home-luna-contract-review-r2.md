# Home Luna and Stop contract review, second proposal

Date: 2026-09-21. Source is unchanged at `88b737b`. The separate author's
complete second proposal is retained as
`F:/Diomedes/deliverables/core-agent-continuation-20260921/home-contract-r2-swe-output.md`.
The first proposal and R1 review remain unchanged in Git.

**Changes required before implementation.** The consume-once cancellation
store is removed, existing Home's send-time POST is specified, the default and
supported-route guard are separated, and the explicit choice marker has a
named UI path. Those corrections address the primary R1 findings. Three
remaining source/contract mismatches must be corrected, without another runtime.

1. `InteractionHost.locate` already performs the required command/thread/run
   lookup and is what `InteractionTurns.outcome` uses. Reuse it. Do not add the
   proposed `locateCommand` interface and duplicate every test host. Its
   `settled` flag describes the run, while `answered` and `turnResult` describe
   the message's result. Distinguish them when returning `settled`.
2. The proposed pre-admission paragraph wrongly says `host.resolve` wrote a
   dispatched command record before `request()`. `locate` finds the driver's
   turn step; `request()` installs its active entry synchronously while its
   asynchronous drive is starting. The fixed-delay retry is neither an
   ordering guarantee nor consistent with the claim that Stop remains visible
   after aborting the local send. Remove that guarantee and the timer-based
   workaround. The client can prevent its own pre-dispatch send and abort its
   message transport; the HTTP connection signal is already forwarded into
   the resolved input. A command-specific interrupt may truthfully be unknown
   or idle during preparation. Do not call that a durable stopped result.
   Verify the request-signal path under a held preparation step, and verify
   interrupt separately after the driver has the active command. Duplicate
   Stop need not return the identical status after the command settles; it
   must remain bound to A and never affect B.
3. `AWS_BEDROCK_ROUTE` is declared in `server/engines/aws-bedrock.ts`, not
   `shared/engines.ts`. A browser-shared default must not import the server
   implementation or edit that separately owned AWS file. Name a type-checked
   shared literal or other dependency-safe existing representation.

Native driver ordering must also be stated without an accidental guarantee:
comparing and signalling the exact active entry can use its existing abort
controller, which already feeds the turn input. If a native control step is
used instead, the active comparison must happen at the actual interrupt point
and a replayed idle/superseded receipt must not be treated as a new abort. A
new control journal is not mandatory; the recorded turn outcome remains the
authority on both routes. Preserve the existing general control methods.

The original unmarked Home's early return in `provisionHome` must be covered:
an existing binding still needs the locked default/choice check before return.
The Home UI currently lacks a route display; identify its bounded props/view
change if the contract requires that display. Preserve the existing Console
choice path without claiming it exposes the hidden Home project.

Return an ASCII-only successor proposal, without em dashes. The raw second
proposal is preserved outside Git because it contains prohibited punctuation;
the reviewer has not silently edited its bytes or accepted an altered version.
No application implementation or new acceptance test has been authored yet.
