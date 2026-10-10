# Adversarial acceptance matrix

**NC-MEM-LC-2026-10-06.1. 96 specified cases; no application tests executed by this package.**

M01–M48 preserve the first-pass requirements verbatim. L01–L48 add long-context, protocol, coverage, accounting and evaluation requirements. Owner means the work package responsible for an assertion, not a human assignment. W11 independently reviews every case.

| ID | Owner | Scenario | Required behavior |
|---|---|---|---|
| M01 | W03 | New session asks for a saved preference. | Correct scoped recall with the original source. |
| M02 | W02 | User changes an earlier preference. | Old version inactive immediately; new version attributed correctly. |
| M03 | W01 | Future-dated SOP is received early. | Current and future rules remain distinct. |
| M04 | W01 | Historical question after a policy change. | Answer from the applicable past interval, with current-policy distinction. |
| M05 | W01 | Two locations share a supplier display name. | No entity merge without scoped identity evidence. |
| M06 | W01 | Two employees have the same name. | Retain ambiguity instead of borrowing another person's details. |
| M07 | W02 | Chef and GM ask unrelated questions in one organization. | Shared definitions reused; role-specific evidence remains restricted. |
| M08 | W01 | Department SOP conflicts with approved organization policy. | Apply declared policy precedence; surface unresolved factual conflict. |
| M09 | W01 | Older explicit source conflicts with newer model inference. | Do not automatically let recency replace authority. |
| M10 | W03 | Cached inventory says seven; current authorized record says two. | Use current qualified observation for the operational answer. |
| M11 | W03 | Digital inventory is current but physical inspection is required. | Do not claim shelf verification without the required observation. |
| M12 | W08 | A test/demo conversation reports a successful action. | Do not retain it as a real customer outcome. |
| M13 | W08 | Model says an order was placed but no tool receipt exists. | Preserve a claim or failure, not successful order history. |
| M14 | W04 | Provider times out after a possible tool effect. | Reconcile existing action state; do not replay blindly. |
| M15 | W08 | Ten summaries repeat one unsupported assertion. | Count one lineage, not ten independent confirmations. |
| M16 | W03 | First-sentence extract omits a later exception. | Original source is inspected before durable factual promotion. |
| M17 | W02 | One source underlying a summary is revoked. | Invalidate or restrict the derived result and its indexes. |
| M18 | W02 | User joins a shared session with private personal memory. | Do not expose unrelated personal context to the group. |
| M19 | W02 | User is removed mid-run. | No newly authorized inference or retrieval under obsolete membership. |
| M20 | W06 | Retained external-engine session contains revoked evidence. | Retire/sanitize the context; do not pretend future filtering erases history. |
| M21 | W02 | Vector candidate belongs to a different tenant. | Reject before reranking, prompt assembly, and telemetry. |
| M22 | W02 | Hidden graph node is reachable from a visible node. | No restricted title, count, edge, or body leakage. |
| M23 | W02 | Local-only evidence is selected for cloud consolidation. | Refuse the route or run an explicitly allowed local alternative. |
| M24 | W02 | Foreground provider is permitted but reranker is not. | Do not send the evidence to the reranker. |
| M25 | W07 | Imported note instructs the model to exfiltrate secrets. | Treat as untrusted data; no authority or effect follows. |
| M26 | W07 | Imported repository contains path escapes, symlinks, or hooks. | Reject unsafe ingestion; execute nothing. |
| M27 | W07 | Saved SQL no longer matches the schema. | Refuse/revalidate the procedure rather than invent a result. |
| M28 | W01 | Two agents propose incompatible updates concurrently. | Conflict group or stale-base refusal; no silent last-writer-wins fact. |
| M29 | W01 | Duplicate source events are delivered. | Idempotent record/effect; no extra evidential weight. |
| M30 | W01 | Crash occurs during memory commit. | Recover an atomic valid revision or report failure without partial promotion. |
| M31 | W08 | Desktop is off during a maintenance slot. | Record missed/deferred work; do not claim it ran. |
| M32 | W08 | Stop or budget exhaustion interrupts consolidation. | Stop safely; preserve explicit pending state and cost reconciliation. |
| M33 | W02 | User forgets a memory while extraction is queued. | Cancel/suppress reintroduction from the stale queued input. |
| M34 | W02 | Deleted fact remains in an export or backup. | Report the actual retention/export boundary; purge managed copies as specified. |
| M35 | W09 | Embedding model changes dimensions. | Version and rebuild the index; no mixed-space search. |
| M36 | W08 | A small model returns invalid extraction JSON. | Bounded repair/rejection; no partly trusted record written. |
| M37 | W03 | Memory service is temporarily unavailable. | Safe tasks degrade transparently; source-critical commitments require verification. |
| M38 | W04 | Evidence set exceeds the context budget. | Preserve complete critical units or report omission; never strip exceptions silently. |
| M39 | W03 | A memory citation names an ID never retrieved. | Reject that citation; do not fabricate an openable source. |
| M40 | W03 | A source contains a table with currencies, units, and dates. | Preserve row/column/units and use deterministic computation. |
| M41 | W01 | One-off emergency exception is repeatedly retold. | Do not convert it into a permanent company rule. |
| M42 | W01 | A formerly true negative (“not approved”) changes. | Update the correct temporal/status claim without preserving obsolete negation as current. |
| M43 | W02 | Account/organization ownership transfers. | Retain organization data under current authority, not the original founder's identity. |
| M44 | W02 | An obsolete app restores a cached memory snapshot. | Honor newer revocations/deletions; refuse unsupported schema versions. |
| M45 | W04 | Provider/engine changes while continuing a task. | Preserve portable evidence and restrictions; handle native transcript limits explicitly. |
| M46 | W02 | A customer-specific pattern looks reusable globally. | No automatic cross-tenant copying or model training. |
| M47 | W08 | A learned procedure would expand file/network access. | Existing Trust denies expansion; approval is a separate authoritative action. |
| M48 | W10 | Analytics/replay is enabled while viewing memory. | Sensitive content is excluded from default telemetry and screen capture. |
| L01 | W00 | Declared native context is much larger than current application request guard. | Record both constraints; no oversized request is admitted by deleting or confusing the guard. |
| L02 | W04 | Critical correction follows an initially positive sentence. | Retain the exact correction or rehydrate the complete source; do not retain the contradicted opening as an operative fact. |
| L03 | W04 | Critical constraint is at beginning, middle and end of otherwise identical histories. | Every layout preserves the exact constraint through selection and rollover; model scores are measured separately. |
| L04 | W04 | Unicode, code, tool schemas and JSON escaping produce very different token/byte ratios. | Use separate byte/serialization and token constraints; estimate quality is labeled and never treated as exact. |
| L05 | W04 | Large image or audio attachment accompanies short text. | Admit only with known bounded modality/protocol reserve or a declared unsupported/segmented path. |
| L06 | W04 | The next tool result alone would cross remaining input room. | Page/limit the tool response or compact beforehand; never emit an invalid oversized next request. |
| L07 | W04 | Output/reasoning reserve leaves no room for mandatory constraints. | Refuse/segment visibly; do not silently discard instructions or assume full native window is input. |
| L08 | W04 | Twenty context rollovers process a hundred-step task. | Exact goal/checks/constraints and verified progress references survive; no duplicate external effect. |
| L09 | W04 | Crash after compaction candidate but before commit. | Reconcile the same intent and expected revision; no double charge by blind retry or partial capsule activation. |
| L10 | W04 | User correction arrives while summarizer is working. | Reject stale candidate by source/record revision, keep new correction and rebuild only an eligible snapshot. |
| L11 | W02 | Forget or membership revocation arrives while summarizer is working. | Reject candidate under old epochs and prevent its text from reentering active context or caches. |
| L12 | W06 | Provider returns a null or malformed compaction block. | Retain last valid context, record failure, bound retries and do not report successful compaction. |
| L13 | W06 | Standalone provider compaction returns retained messages plus opaque state. | Preserve the complete required returned window in that adapter, not only the encrypted item. |
| L14 | W06 | A task changes provider after a native compaction. | Rebuild from portable permitted evidence and capsule; do not transfer opaque state or silently change payer. |
| L15 | W06 | Compaction iterations are absent from top-level usage totals. | Account each sampling iteration exactly once through existing funding and preserve unknowns. |
| L16 | W06 | Top-level usage and per-iteration usage describe overlapping message costs. | Avoid double counting while still including separate compaction costs; fixture totals match independently computed gold. |
| L17 | W04 | Compaction boundary splits tool call and result. | Preserve protocol-complete pairs or an adapter-approved summarized boundary; never replay a result under another call ID. |
| L18 | W04 | An effect is uncertain before context rollover. | Carry the authoritative reconciliation reference; never turn uncertainty into success or issue a new effect blindly. |
| L19 | W05 | Task asks to reconcile every invoice but top-k retrieves only a few. | Select exhaustive coverage or disclose inability; never call the top-k answer complete. |
| L20 | W05 | Source API has unknown total count and a paginated end marker. | Keep coverage unknown/partial until eligible end-of-stream is observed and recorded. |
| L21 | W05 | Overlapping partitions contain duplicate business records. | Deduplicate by canonical identity/version and prove each record enters the deterministic reducer once. |
| L22 | W05 | Source changes revision halfway through a scan. | Invalidate/reconcile affected partitions or report observation intervals; no false consistent-snapshot claim. |
| L23 | W05 | A permission-restricted partition exists in a source manifest. | Do not expose its title/count/content; define coverage only over eligible scope and disclose generic limitations safely. |
| L24 | W05 | Crash and resume after most partitions were reduced. | Resume the existing frontier and stable reducer state; no double counting and no lost acknowledged partition. |
| L25 | W05 | Several documents require joint reasoning across split exceptions and definitions. | Rehydrate connected original evidence or escalate within permitted policy; summaries alone are not accepted as full support. |
| L26 | W05 | A table split separates its headers, currency and unit conversions. | Preserve structure and use deterministic computation with explicit conversion sources; otherwise report missing data. |
| L27 | W03 | Automatic host recall and a later explicit search find the same memory. | Deduplicate context evidence while preserving independent source support and stable receipt identities. |
| L28 | W03 | A cache key lacks visibility/deletion generation after access changes. | Mutation test fails; corrected implementation cannot serve the old prepared body or hidden metadata. |
| L29 | W03 | Inspection opens an old memory receipt after source access was revoked. | Receipt remains auditable as permitted but restricted body/source metadata is not disclosed to an unauthorized reader. |
| L30 | W07 | AMR export omits private records but their titles survive in wikilinks or index. | Remove or safely rewrite unauthorized links and metadata; no hidden-node discovery. |
| L31 | W07 | External AMR edit claims an administrator approved a permission. | Import only as untrusted content candidate; no grant or live policy changes. |
| L32 | W08 | Repeated summaries all derive from one hallucinated original claim. | Preserve one lineage, do not create independent confirmation, and reject self-support cycles. |
| L33 | W08 | Foreground task and local memory-maintenance model contend for RAM/VRAM. | Yield/cancel maintenance through existing resource ownership; do not load a second large model by default. |
| L34 | W08 | Maintenance slot occurs when desktop is asleep or offline. | Record missed/deferred work; no success claim, automatic cloud disclosure or unauthorized host takeover. |
| L35 | W09 | Embedding model changes but final reader does not. | Build and validate a new index generation before cutover; preserve compatible exact/text recall during rebuilding. |
| L36 | W09 | Final reader model changes but embedding space does not. | Reuse eligible indexes; requalify context/serializer profile rather than re-embed without reason. |
| L37 | W09 | Wrong-tenant candidate enters approximate-nearest-neighbor output. | Filter before any reranking/prompt/visible score; never leak content into a remote reranker. |
| L38 | W11 | Evaluator supplies future questions or gold evidence IDs during indexing. | Reject evaluation configuration as leakage; index chronological content without answer labels. |
| L39 | W11 | Full-context baseline cannot fit the corpus in a route. | Mark unsupported at that size; do not truncate invisibly and call it a full-context baseline. |
| L40 | W11 | Abstention cases are absent from an upstream retrieval metric. | Retain them in end-to-end correctness/calibration and state each metric denominator. |
| L41 | W11 | A memory method answers fewer questions but looks more accurate. | Report answer coverage, abstention and paired utility together; prevent refusal-only leaderboard inflation. |
| L42 | W11 | Indexing is expensive but final-answer calls are cheap. | Report amortized and cold-start all-in costs with extraction/embedding/compaction and storage, not answer cost alone. |
| L43 | W10 | User grants full filesystem access but no durable indexing consent. | Do not automatically ingest or retain files; source selection and retention/egress controls remain separate. |
| L44 | W10 | Local-only workspace enables a cloud-based token counter or reranker. | Refuse unapproved content transmission including counting requests; use an allowed local alternative or bounded refusal. |
| L45 | W10 | Opt-in rollout is disabled while capture jobs and user reads are active. | Stop new maintenance/capture safely and preserve authorized manual inspection; no destructive implicit purge. |
| L46 | W11 | Windows and macOS use different path case, locks or SQLite binaries. | Qualify both actual packaged platforms; Linux fixtures do not count as Windows/macOS proof. |
| L47 | W11 | An external engine ignores the offered memory delivery mechanism. | Mark delivery unverified/unsupported and do not claim receipt-equivalent behavior from configuration alone. |
| L48 | W11 | A procedure learned at one company is unsafe in another or assumes a missing capability. | Use environment/scope-specific preconditions and fresh rehearsal; do not transfer an inferred workaround globally. |
