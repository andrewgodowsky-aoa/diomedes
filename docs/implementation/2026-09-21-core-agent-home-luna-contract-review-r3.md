# Home Luna and Stop contract review, third proposal

2026-09-21. Independent review of the separate author's third proposal.
The default/migration policy, existing lookup reuse, removal of cancellation
stores/timers and atomic command comparison are accepted design choices.
Three bounded corrections remain before the contract is accepted as a whole:

- The additive driver method must validate project/run ownership through its
  existing `get(projectId, runId)` before reading the active map. That await
  belongs before the atomic active-command comparison and abort, not between
  them. The method must not ignore its project argument.
- A held-preparation test must assert no provider dispatch after cancellation
  and truthful saved state. An abort before any durable command can be 404 or
  unresolved; the proposal must not require a fabricated interrupted outcome
  for every preparation boundary. The recorded turn decides when interruption
  is confirmed.
- Aborting fetch can end local pending state promptly, so the last sentence of
  section 4 cannot promise a second Stop press after activeness. Remove that
  promise. No timer, polling scheduler or new cancellation store is needed.

These are corrections to the specification, not implementation work. This
review and earlier reviews remain unchanged. The author must make the bounded
correction and return the exact proposal for final independent acceptance.
