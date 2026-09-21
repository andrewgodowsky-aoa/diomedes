# Home composition review, first full execution

Verdict: changes requested for one fixture; full composed acceptance withheld.

The independently accepted Home contract, drivers, server and client were composed
at `de13b6ec1a80f4d1a962be6ba231748cefe29c95`. This execution tested the clean
integration commit `89f0d16514416a48558ab9cb51cb81c6057a2910`, including its ledger.
The reviewer did not author the implementation or the failing fixture.

## Independent execution

- Identity: role `astra`, PID 43452, process start
  `2026-09-21T04:32:24.4162630Z`, integration worktree `core-agent-bot`.
- Exclusive heavy slot: `slot_mube6xge_ec7ab377`, released after the failure.
- Frozen admission, AWS, R4, R2 and historical review payload checks passed before
  the commands ran.
- TypeScript: exit 0.
- Full Vitest, one worker: 251 files passed, one failed; 4,681 tests passed,
  one failed, four skipped, 4,686 total. Exit 1, duration 482.39 seconds.
- Build, page and full browser checks did not execute because the wrapper stopped
  after the failed full suite. The worktree remained clean.

Evidence is retained under
`F:/Diomedes/deliverables/core-agent-continuation-20260921/`:
`home-composed-final-r1-results.json`, `home-composed-final-r1-tsc.log`,
`home-composed-final-r1-vitest.log`, and
`home-composed-final-r1-unit-results.json`. The wrapper was
`run-home-candidate-gates.ps1 -Candidate 89f0d16514416a48558ab9cb51cb81c6057a2910
-Label home-composed-final-r1 -Worktree F:/Diomedes/diomedes-wt/core-agent-bot`.

## HCF-1: native turn-identity fixture assumes the old Home default

`tests/conversation-turn-id.test.ts`, test
`the page names a command's answer exactly as the server projected it`, failed
on its first message POST at line 73, through the response assertion at line 32:

```text
409 {"error":"Turn AWS Bedrock (GPT-5.6 Luna) on in Settings before sending."}
expected false to be true
```

The fixture creates the real app with `scriptedEngineService`, which scripts only
Claude Code. It enables that provider and selects its model, then provisions Home
without making an explicit thread route choice. Under the accepted Home contract,
that newly provisioned thread defaults to AWS. The global model selection does
not override the thread's default. This failure happens before the original
command/answer identity assertions and supplies no evidence that those identities
are wrong.

Required correction: keep this fixture's real native session/projection coverage,
explicitly choose its scripted Claude route for the provisioned Home thread, and
preserve every original identity assertion, command, response and schedule. No
product change or default weakening is requested. The original full-suite red
execution above precedes the correction. A separate author must make the fixture
change; the reviewer must inspect the diff and execute it independently.

After the correction, all composed gates remain required on the final candidate.
PR 29 remains draft. There is no merge, release, deployment or live-provider proof
in this review. Earlier immutable bounded acceptance reports remain in force for
their explicitly tested scopes.
