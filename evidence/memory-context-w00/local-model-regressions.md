# W00 local-model regression reconciliation

Observed October 6, 2026. This is a source and scoring-metadata inventory. It
contains no subject model response or evaluator answer key. The companion
`local-model-regressions.json` records exact paths, SHA-256 identities, counts,
qualifications and unresolved gaps. No inference or tests ran for this record.

## What is available

The lab at `F:/Diomedes/local-models` retains the original 115K occupied business
reconciliation and the simulated recovery cases referenced by the AI-project
addendum. They are known development regressions. They are not untouched final
evaluation cases, and their historical results are not current product
acceptance.

| Historical run | Passed | Failed | Skipped | Unrun |
| --- | ---: | ---: | ---: | ---: |
| qwen-business-115k-v1 | 0 | 1 | 0 | 0 |
| qwen-business-115k-high-v1 | 0 | 1 | 0 | 0 |
| ornith-business-115k-v1 | 1 | 0 | 0 | 0 |
| ornith-agent-failures-v1 | 6 | 9 | 0 | 0 |
| qwen-agent-failures-v1 | 15 | 0 | 0 | 0 |
| ornith-agent-diagnostics-v2 | 0 | 3 | 12 | 0 |
| ornith-agent-finalization-v1 | 9 | 1 | 0 | 5 |

The ledger runs each recorded 115,164 input tokens, zero cached tokens and the
same prompt digest. The task joins revised orders, cumulative receipts and
invoices while preserving tenant scope, per-SKU quantities, source identity and
a proposal-only grant. Existing audit metadata records authorization, per-SKU
shape and grant-source failures in both Qwen runs. The single Ornith pass does
not establish general long-context reliability.

The occupied ledger tests absent payment authority. It does not by itself test
grant revocation. The neighboring generated conversation source contains
payload-bound approval invalidation; that remains a distinct case rather than
an inferred property of the ledger.

Recovery cases are `schema_binding`, `exhausted_discovery`, `unknown_outcome`,
`stale_receipt` and `coding_repair`, normally at seeds 8041, 8042 and 8043. The
diagnostic run selects three cases at seed 8042. These use simulated tools and
are not reproductions of Unity or production workflows.

All three original Ornith unknown-outcome cases repeat a read-only status call
after a terminal receipt. This is an efficiency failure, not duplicate mutation
evidence. Original stale-receipt failures are JSON parsing failures, which do
not prove stale-state belief. The finalization control passes schema binding,
exhausted discovery and unknown outcome three times each. Its one stale-receipt
failure is an extra-field shape failure despite current-state values, according
to the retained audit metadata. Five cases remain unrun. Removing terminal
tools and constraining the final answer is a harness mitigation; it does not
show repaired weights or spontaneous stopping.

## Historical identity is incomplete

The 115K records retain a prompt hash but no verifier source hash, full saved
prompt or per-answer runtime binding. Current `long-workflow.py`, its preserved
earlier `evidence/long-workflow-v1.py`, the shared request helper and current
reasoning profiles are available with separate hashes. They must not be
silently assigned to historical runs.

The recovery records name four different historical verifier hashes. None
matches current `agent-failure-benchmark.py`. All four available audit source
snapshots preserve another shared revision, also different from the recorded
run hashes. This bounded search leaves exact historical verifier bytes
unresolved; it does not claim those bytes are absent from all machine history.

Download receipts identify Qwen3.6 35B UD-IQ3_S and Ornith 1.5 35B
AD-Q4_K-IQ4_XS separately. Their different quantizations remain a confound. Phase
receipts identify llama b11146, 131,072 allocated context, Q8 KV, no MTP, one
slot, six threads, batch 512 and microbatch 256. Ornith uses its official
template and Qwen its embedded template. These are phase associations rather
than per-answer runtime bindings. Exact historical placement, hardware state
and resolved request budgets remain incomplete.

The preserved earlier ledger source specifies seed 92837, temperature 0.6,
top-p 0.95, top-k 20, thinking enabled, a 4,096 total output cap and disabled
prompt reuse. The current High profile reserves 8,192 reasoning tokens within
12,288 total output tokens, plus a 1,024-token input margin. The historical High
record stores the profile name without resolved profile bytes. Neither source
description closes the missing historical binding.

## Business Trials package and splits

The original 192-case/16-business package is present under
`F:/Diomedes/local-models/audit/business-trials`. Both original ZIPs, the
canonical manifest, registers, run-manifest template and verifier assets have
measured file identities in the companion JSON.

| Population | Train | Development | Test | Cases | Scored stages |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original package | 120 | 24 | 48 | 192 | 224 |
| Audit extensions | 0 | 11 | 1 | 12 | 18 |
| Combined register | 120 | 35 | 49 | 204 | 242 |

Another 32 derived long-input variants use eight parent cases and add no
independent tasks. Including them gives 274 prepared response slots. All 204
register rows are `DID_NOT_RUN`; this preparation register is not a census of
every later execution elsewhere.

The source split is explicitly business-disjoint with shared skill/template
families. It is not a chronological split. `NCT-AUD-11` derives from test cases
`NCT-IT-11` and `NCT-LG-12`; exclude it from training and development smoke and
do not count it as an independent held-out family. Use `scenario-register` as
the allowlist. A superseded development-folder copy exists, so globbing a split
folder is unsafe.

Canonical selected inputs come from
`canonical/model-inputs-pack/model_inputs/`. Evaluator directories, private
fixtures, keys and future-turn directors remain outside subject retrieval and
Dreaming. Deliver only the authorized next turn of a multi-turn episode.

The strict response adapter keeps `verified_pass=false`,
`manual_review_required=true` and `semantic_review=DID_NOT_RUN`. The supplied
legacy grader does not automatically call it. Batch reconciliation, semantic
grading and live model integration remain unqualified.

Live DIO-213 requires a 50-100 task bank shared with DIO-149. The recovered import
does not establish which bank currently owns that program. W00 records the
available import without declaring it DIO-213's active bank or replacing its
split and version.

## Retention and training boundary

DIO-213, read live with an October 6 update, requires Bedrock stage-0 outputs to
be scored and discarded. Memory capture must be off when the evaluation
protocol forbids output retention. Retain scoring receipts or metadata only
within that protocol. A reference in this inventory is not training or memory
promotion permission.

The issue allows training data from code, permitted self-hosted open weights or
DeepSeek's own API with synthetic prompts pending AWS clarification. It forbids
training on outputs from Opus, GPT, Gemini, Grok and the listed coding agents.
Every training example needs provenance. Customer content requires explicit,
forward-looking, revocable organization opt-in; business facts remain in
retrieval. These are recorded project constraints, not a new interpretation of
provider law or fresh data-use authority.

## W00 disposition

Register these cases as development regressions with the existing source and
scoring identities. Keep the following open:

1. Historical recovery verifier source bytes and complete ledger replay inputs.
2. Per-answer runtime, resolved budget, template and hardware bindings.
3. DIO-213's active task-bank designation.
4. Independent final-test freeze and chronological splits.
5. Real-harness comparisons with and without memory/capsules, including revoked
   authority, and fresh verifier qualification.

This record does not claim a sealed evaluation, trained adapter, accepted model,
runtime implementation, deployment or production acceptance. New replay work
must preserve model, quantization, template, sampler, budgets, cache state,
harness/compiler revision and hardware identity before attributing a change to
memory. No W01 work is performed here.
