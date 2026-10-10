# Item 08: bounded conversation history and lane recap

Feature: bounded-conversation-history. Work item: performance audit 08 of 09.
Worker: GPT-6.1 Sol, max reasoning. Branch: `feature/bounded-conversation-history`.
Worktree: `F:/Diomedes/diomedes-wt/bounded-conversation-history`.
Source baseline: `92bc57bd678865390f17291beb382642769e73e5` (origin/main).
Canonical repository documents reviewed: Core Pillars, Live Roadmap and Project
Memory, all version `2026-10-06.1`.

The parent integrator holds the edited paths under coordinator claims
`claim_mv1p3qjz_42cb995e` and `claim_mv1p5qm6_d0e17c79`. The latter covers the
confirmed live recap path, `server/lane-recap.ts`; there is no
`server/harness/lane-recap.ts` at the baseline. This worker's authorization is
limited to this item and its own commit. Parent integration and combined gates
remain separate work.

## Why

Both callers built strings for every eligible exchange before discarding most
of them. `boundedHistory` kept only the last 12, and `laneRecap` used only the
last one. A reverse traversal can stop as soon as it has those exchanges, making
the reads and string construction depend on the required tail instead of every
earlier answered message.

## Implementation

`recentAnsweredTurns` visits the newest run and step first, skips ineligible or
excluded steps, stops at its exchange limit, and reverses the selected tail to
return chronological order. Both readers use the same per-step conversion as
`answeredTurns`. The full reader continues to return all eligible exchanges
with their original chronological indexes for context selection and lineage
evidence.

`boundedHistory` selects at most 12 exchanges before the existing 24,000-character
cut and per-run message accounting. `laneRecap` selects one exchange before its
existing prompt cleanup and 2,000-character cut. Framing, decision removal,
null/empty fields, eligibility, exclusion, run ordering and Unicode-safe cuts
retain their existing semantics. A newest prompt-only or empty-answer exchange
still yields no recap rather than falling back to an older answer.

The change operates on durable records already supplied by the caller. Runtime,
Trust, admission, source scope and evidence retention keep their current
authorities. No roadmap status or product definition changes are required.

## Deterministic verification

New probes instrument array element access and prompt getters in 10,000-step
answered runs. They assert both output correctness and exact operation counts;
they contain no elapsed-time threshold. Additional parity coverage compares
bounded output and message accounting with the full reader's original tail
across runs, exclusion, absent/blank fields, Agent framing, decisions and long
Unicode answers. Recap cases cover missing lines, failed/non-turn steps and
latest exchanges with no spoken answer.

The parent held shared slot `slot_mv1p7jaz_2e92f9bf` and granted this worker the
exclusive targeted-test turn. Both runs used:

```powershell
./node_modules/.bin/vitest.cmd run tests/conversation-history.test.ts tests/lane-recap.test.ts --maxWorkers=1 --minWorkers=1
```

| Run | Passed | Failed | Skipped | Result |
| --- | ---: | ---: | ---: | --- |
| RED, unchanged implementation | 20 | 2 | 0 | Exit 1; both operation-count regressions failed |
| GREEN, reverse traversal | 22 | 0 | 0 | Exit 0; both test files passed |

RED started at 21:11:35 local time on 2026-10-09; GREEN at 21:12:29.

| Probe | RED step reads | RED prompt reads | GREEN step reads | GREEN prompt reads |
| --- | ---: | ---: | ---: | ---: |
| Bounded history, 12 returned | 10,000 | 10,000 | 12 | 12 |
| Lane recap, 1 returned | 10,000 | 10,000 | 1 | 1 |

`git diff --check` passed after the source and test changes. The shared test turn
was returned to the parent immediately after GREEN.

## Limits and publication status

Sparse eligible messages can require scanning older step metadata until the
requested tail is found; a run with too few eligible exchanges must still be
examined to establish that fact. Full indexed history readers intentionally
remain proportional to full history. This is operation-count proof for these
two bounded callers, not a runtime latency benchmark.

TypeScript, the full unit suite, Vite, browser, installed desktop and provider
verification were not run by this worker. The parent owns combined validation
and integration. This lane has not pushed, merged, released or deployed.
GitHub Actions remains stopped under `F:/Diomedes/CI-STOP.md`; the worker commit
uses `[skip ci]`.
