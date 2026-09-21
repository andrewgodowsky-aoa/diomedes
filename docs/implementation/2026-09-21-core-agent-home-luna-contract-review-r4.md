# Home Luna and Stop contract review, final proposal

Date: 2026-09-21. Exact proposal commit:
`4643f717435096e78d835cec2b4a56194f781a61`.
The separate contract author made the final corrections; this reviewer
inspected the complete proposal and the final diff against the current source.

**Accepted as the bounded contract for implementation in PR #29.** This is
design acceptance only. No Home routing or Stop implementation has been
accepted, and no runtime or provider proof is claimed by this report.

The proposal now explicitly supersedes I-19/I-20's literal Claude pin, uses a
shared typed default without importing the separately owned AWS server code,
preserves marked explicit choices, and migrates unmarked pins only at an
intentional provisioning write. Both the client's cached Home shortcut and
Store's bound early return are addressed. Reads remain pure. The project Work
route, Mode, permissions and old-command replay identities remain separate.
The shared predicate belongs in `shared/engines.ts` as its file plan specifies;
it can import `isModelApiRoute` without editing the AWS-owned module.

Stop reuses the existing host lookup and durable result reads. Both additive
driver methods validate the project/run before comparing and signalling the
active command with no awaited gap. They do not change general controls or
introduce another cancellation store. Pre-durable 404 and idle are truthful
uncertainty, not a fabricated stopped result. The request signal handles the
client's own transport/preparation cancellation; its exact runtime behavior
must be measured. The prior fixed-delay retry and consume-once marker are gone.

Client identity is issued at its actual dispatch claim, including the current
same-window and cross-window branches. Settled read-only recovery issues no
interrupt identity. Stop before ensure or lock acquisition cannot later send;
late results retain visit ownership fences. The proposal no longer promises
a second Stop press after aborting fetch ends pending state. The bounded Home
route control and caption use the existing thread PUT; the existing project
Console picker remains its explicit route-choice path.

Earlier proposals and all three change-request reviews are retained. The
second raw proposal remains in the evidence archive; none of its text is
silently treated as accepted. Andrew's original inclusion/default decisions
and explicit single-file ownership transfer authorize implementation. They
do not authorize a live provider call, credential handling or changed Work
routing. The original AWS owner retains those responsibilities.

Implementation must return to a reviewer who did not author it, with real
driver/Store/HTTP and browser evidence under fake providers, immutable existing
oracles, and guard removal/red/byte-restoration/green checks. All final composed
gates must run on the resulting exact candidate before PR #29 leaves draft.
No package item is DONE before its exact accepted code reaches main.
