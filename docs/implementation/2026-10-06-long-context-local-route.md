# Long-context local route (DIO-247)

Status: contract frozen before implementation; verification pending.

Work order: `long-context-local-route`, DIO-247, owner Andrew, builder Codex,
branch `feature/long-context-local-route`, worktree
`F:/Diomedes/diomedes-wt/long-context-local-route`. Base is
`c02ddac80a48e2ee247d72d6e172ad754e2c1286`, refreshed from origin/main.
Pillars, roadmap and project memory are version `2026-10-06.1`.

## Admission contract

Only the selected local route receives profile-derived allowances. Other routes
retain their current constants, bodies and instruction budgets. File counts,
path guards, source visibility, account eligibility and tool authority do not change.
Conversation history, range retrieval and compaction are outside this lane.

The budget uses the names and equation from NC-MEM-LC section 8:

`inputRoom = min(nativeTotalWindow, qualifiedTaskTotalWindow, configuredTotalWindow) - outputReserve - protocolAndNextToolReserve - safetyMargin`

The descriptor's contextTokens bounds the native window until the server reports
its actual window. Optional qualifiedTaskTotalWindow and configuredTotalWindow
may narrow that envelope. When absent they use the descriptor's bounded window;
that fallback is not evidence of task qualification. A measured occupied prompt
is not a qualified total window. Reserve the selected output allowance, 2,048
tokens for protocol and the next tool, and 1,024 safety tokens. Images retain
their additional per-image reservation. W04 can absorb this local budget without
renaming its terms. Serialization admission remains a separate guard.

An offline reconstruction of the existing 2,100-row ledger produced 287,775
UTF-8 bytes, SHA-256
`2151f1e6e455f6cd063f8252377665fd8cb75c36b4ab490e748ba452c9a367a9`.
This matches the recorded prompt with 115,164 measured tokens: 2.49883 bytes per
token. Use four bytes/characters per context token as an admission envelope,
including margin. This ratio is not a tokenizer or a claim about arbitrary text.
The source envelope is bounded at 8,000,000 bytes/characters. Request and template
envelopes allow JSON escaping and instructions, with a 24,000,000-byte hard cap.
The existing apply-template, tokenize and inputRoom refusal remains the
authoritative context check. One live tokenizer confirmation is still required.

Local prompt caching is enabled. It reuses an exact token prefix in the person's
own local server. Cache reuse does not grant access to another thread's content;
the host still constructs and authorizes every request independently. A shared
server slot may reuse common prefixes or evict a prior request; the GPU proof
must measure restoration after an advisor uses that slot.

## Optional descriptor fields

Each profile may add `effortBudgets`, with both `medium` and `xhigh` entries.
Each entry contains `thinking` (boolean), `reasoningTokens` (nonnegative integer)
and `outputTokens` (positive integer). Reasoning must leave room for a final
answer inside outputTokens; outputTokens cannot exceed the profile's allowance.
Thinking off requires zero reasoning tokens. Missing or malformed entries are
refused with the field name. Without this map, numeric effort is not sent and
the old `reasoningBudget` field remains unused. Named reasoning_effort is always
sent, including inside chat_template_kwargs.

`measuredRates` may contain `occupiedContextTokens`, `prefillTokensPerSecond`
and `decodeTokensPerSecond`. Rates are positive finite measurements and occupied
context must fit the profile. These are deadline inputs, not a qualification claim
for other workloads or permission to exceed the actual context window.

## Streaming and time

Streaming reconstructs content, reasoning and at most one tool call. It retains
the byte ceiling, served-model check, complete-finish check and token-accounting
refusal. Progress carries total, cache, processed and time_ms from the server.
Final usage and timings remain evidence. Cancellation and malformed/truncated
streams must not produce a successful final answer or execute a partial tool.

With measured rates, a call ceiling is at least the existing allowance and the
estimated prefill plus output duration with a 50 percent margin and 30 seconds
of overhead. The actual call uses tokenized prompt size; lease and turn ceilings
use the full profile envelope, so they cannot expire before an admitted call.
Without rates, existing absolute deadlines remain. A separate idle deadline
resets only on validated progress or generated content, reasoning or tool data.

Proposed reading sentence: `Reading the document.` Progress is an observation,
not model output. DIO-200 owns the thread component; this lane must provide the
event and leave rendering to that owner while its claim remains active.

## Coordination and acceptance

PRs 236 and 187 overlap server/app.ts; PR236 has its active claim. The coordinator
also reserves server/native-work.ts for the integrator and refused this lane's
claim. Required integration edits will be returned as patches, not applied over
those boundaries. DIO-200 holds client/console/ThreadView.tsx and related files.
server/native-loop-routes.ts is read-only while PR236 holds its claim, per
Andrew's DIO-247 addendum.

Andrew confirmed ATS is closed and no further games will run while he is away.
Every heavy command requires the shared slot. No model worker is
stopped by this lane. GPU runs, local advisor restoration and the paid advisor
remain separate acceptance items; the paid advisor requires approval at run time.

Each completed slice needs its own real gate counts and local commit. This brief
authorizes local slice commits after passing gates, but no push, PR, merge or
deployment. DIO-247 remains In Progress until the accepted implementation is merged.

The reading event is `engine-prompt-progress`, with the active attempt's project,
thread, request, run, step, attempt and fence, a dense channel sequence, the four
counters, and the fixed sentence above. It follows the existing ordered and
fenced publication path. It does not contain model-supplied text. UI integration
and the Work source picker still require their owners' handoff.

The provider's stream order and numeric reasoning condition were checked in
[b11146 server-task.cpp](https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/server-task.cpp)
and [server-common.cpp](https://github.com/ggml-org/llama.cpp/blob/b11146/tools/server/server-common.cpp).
The finish event precedes the usage-only event; timings are retained from final
events. Numeric reasoning requires template thinking end tags. A tighter host
output cap also bounds the numeric reasoning allowance, leaving at least one
token for the answer.

Additional guards found while implementing: prepared model requests have a
262,144-character limit and Work's contextMessage has a 160,000-byte limit.
The local adapter supplies a bounded UTF-8 allowance to preparation, separate
from authority validation. Work serialization accepts a host-resolved local
profile only on the local account. Other routes retain both default limits.

Implementation is a draft. The integrator patches remain unapplied. Root type
checking passed after correcting the new fixture's transcript field. The focused
six-file suite first passed 116 tests. Adding two host admission regressions
produced 116 passed, 2 failed, 0 skipped: both new checks reproduce the old
128 KB refusals in the claimed integration paths. Type checking after those
two additions is pending the heavy slot. Full-suite, build, Playwright and GPU
acceptance remain unrun. Nothing is committed, pushed or merged.

The temporary handoff contains integrator.patch plus
integrator-work-serializer.patch, both checked without modifying their targets.
The second patch supplies the host-resolved local profile to Work's context
serializer. Review both with the uncommitted supporting changes in this worktree.

## PILLAR IMPACT

Pillar 07: improves the selected local resource without changing model, provider,
payer or authority. Runtime and Trust continue to authorize all effects. Evidence
must distinguish source tests, GPU measurements and installed-app acceptance.
