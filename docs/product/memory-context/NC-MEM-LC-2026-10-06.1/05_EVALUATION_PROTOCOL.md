# Evaluation protocol: memory, native context and long-running execution

**NC-MEM-LC-2026-10-06.1.** Required protocol; no model results are claimed.

## 1. Questions the evaluation must answer

Does memory improve next-session work? Does the context controller preserve exact constraints across rollovers? Can a task inspect all required evidence rather than a flattering top-k subset? Does a larger input help or hurt the exact reader and task? Are corrections and revocations respected while work is in flight? What does the entire system cost per accepted task?

Do not answer these questions with a single needle-retrieval score, a subjective demo or an unrelated vendor leaderboard. Distinguish deterministic software invariants from stochastic model reasoning. A scripted adapter can prove delivery, idempotency and context serialization; it cannot prove that a real model correctly uses the delivered evidence.

## 2. Experimental arms

Run each eligible arm with the same source chronology, question set, reader, quantization, route, permissions, task budget and tool access:

| Arm | Mechanism | Purpose |
|---|---|---|
| A0 | Existing H18 behavior | Real application baseline |
| A1 | Raw full-context input, only where it truly fits | Test the value of native long context; no hidden truncation |
| A2 | AMR-compatible scoped notes, no native memory controller | Format-only baseline |
| A3 | Native exact/full-text memory + source receipts | Simplest governed retrieval |
| A4 | A3 + continuation capsules and bounded compaction | Isolate long-horizon benefit |
| A5 | A4 + temporal/semantic/graph retrieval | Isolate retrieval complexity |
| A6 | A5 + incremental observations and governed Dreaming | Isolate maintenance benefit and cost |

Also compare compaction alone without cross-session memory for a subset: it distinguishes a good rollover mechanism from actual durable recall. Do not compare a stronger reader in the new arm to a weaker baseline. Keep indexing corpus and causal observation times identical; maintenance cannot see future user corrections.

## 3. Workloads

**Fast deterministic core:** the 96 cases in eval/acceptance.json. Map each to concrete repository assertions. Core tests include two tenants, two departments with restricted overlap, local-only content, late corrections, invalid citations, mixed Unicode, over-budget requests, opaque provider items, crash/retry and forgotten-source suppression.

**Synthetic business episodes:** tools/generate_long_horizon_fixtures.py creates an original fictional environment with 512 inventory rows by default, cross-session corrections, exact stock reservations, unknown physical inspection and a hundred-step/twenty-rollover schedule. Agent input and evaluator gold are separate. The script generates data, not a running Nectovia harness or a benchmark score. Additional cross-industry scenario specifications are in eval/business-scenarios.json.

**Native-context sweep:** 8K/32K/64K/128K only on routes that actually support the size after reserve/serialization constraints. Include beginning/middle/end placement, distractors, negation, multiple needles, joins, dependent exceptions, counts and exact aggregation. Unsupported sizes remain unsupported rather than truncated trials.

**Long-horizon sweep:** at least 100 scripted steps and 20 forced rollovers, then model-led tasks with varying horizon. Include process restarts, paused approvals, unknown external effects, changed source snapshots, task forks, membership changes and provider-compatible/incompatible resumptions.

**Optional external tracks:** pinned RULER for synthetic long-window sanity; pinned cleaned LongMemEval for conversational time/update/abstention; LongMemEval-V2 small/medium tracks for learned workflows, gotchas and false environmental assumptions. Sources S07–S11. Review code/data/model licenses separately before downloads or commercial redistribution. Do not package external datasets or silently install their GPU stacks into the product.

## 4. Leakage controls

Split by business/environment and episode family, not adjacent questions from the same session. Separate training/tuning, development and held-out evaluation. Give indexers only historically available source content and operational metadata. Gold answer IDs, answer_session_ids, has_answer flags, future questions and expected results stay exclusively in evaluator storage. Freeze prompts, route configuration and indexes before the confirmation split.

Original LongMemEval retrieval-specific exclusions do not remove abstention from end-to-end reporting. Publish each metric's numerator, denominator and missing/unsupported counts. Selective answering must show answer coverage beside accuracy. Do not count a refusal as a correct answer to a fully supported low-risk question.

Public benchmarks can be contaminated by prior model training. Include private original synthetic held-out scenarios and clearly distinguish their evidential value. No public benchmark result proves safe access control; those assertions are deterministic and adversarial.

## 5. Measures

Measure source/citation validity and entailment separately. An openable correct document with the wrong passage is not sufficient support. Score current versus historical answers, fact updates, negations, ambiguity handling, unsupported claims, false certainty and appropriate abstention.

Long-horizon measures include exact constraint retention, verified objective completion, duplicate effects, recovery correctness, dropped/open questions, capsule drift, compaction failures, rehydration accuracy and tool-protocol validity. Exhaustive tasks require source-manifest coverage and exact deterministic totals, not a plausible narrative.

Efficiency includes cold and warm retrieval p50/p95, time to first useful evidence, overall task latency, maintenance queue lag, resident memory, CPU/GPU contention and input/output/cache tokens. Report original source size separately from delivered prompt size and native window.

All-in cost includes source ingestion, embeddings, reranking, observers, compaction, Dreaming, delegated workers, corrections, final generation, storage, backup and transport. Count provider sampling iterations correctly. Show both cold-start total and amortized cost over stated reuse counts; credits or free trials do not make underlying usage disappear.

## 6. Gates and interpretation

**Non-negotiable deterministic gates:** no observed cross-tenant/revoked-source exposure; no unauthorized effect or permission promotion; no forbidden-route call; no deleted-source resurrection; no falsely complete exhaustive task; no duplicate uncertain effect. Every required critical case must have an assertion and passed evidence on the candidate. A finite pass is not a universal security proof.

**Proposed model-qualification policy:** use at least three independent runs for stochastic tasks when affordable, paired seeds when the route meaningfully supports them, and clustered/paired bootstrap intervals by environment/episode. Freeze the sample plan and budget first. Report a 95% interval rather than cherry-picking one pass. A default accelerator must show a positive supported quality gain, or a supported cost/latency improvement with quality noninferiority. An initial noninferiority margin of two percentage points is a reviewable experimental default, not a product guarantee; critical safety outcomes have no such tolerance.

For insufficient sample size or overlapping intervals, report inconclusive and retain the simpler qualified default. Do not tune against the held-out confirmation set. Choose a larger sample through an explicitly authorized budget rather than claiming significance from a noisy small result.

**Product readiness:** prove local data persistence and actual Windows/macOS packaging, current supported external-engine delivery, retained-session retirement, restricted managed database roles and authorized hosted calls. The supported matrix can intentionally exclude a provider-specific accelerator, but the core ledger/recall/continuity/correction/deletion requirements cannot be replaced by stubs.

## 7. Reproducible evidence record

Every run records package revision, source SHA, test IDs, fixture/data hashes, environment, hardware, model/provider/reported version, quantization, tokenizer, context profile, prompt/compiler version, index generation, data-policy class, seed/repetition, permissions, budget/usage receipt IDs, metric denominators, failures and excluded cases. Do not store raw secrets or protected customer inputs in public evidence.

Model results must not be mixed with package validation. tools/validate_package.py checks this handoff's internal consistency; it does not execute the product's tests. The included fixtures and gold calculations likewise are not an Nectovia model benchmark.
