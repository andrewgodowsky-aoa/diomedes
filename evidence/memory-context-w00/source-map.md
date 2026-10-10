# W00 current-source and owner map

Observed: 2026-10-06. Package: NC-MEM-LC-2026-10-06.1. Issue: DIO-227.

This is bounded source and live issue reconciliation, not runtime acceptance.
The mapping author ran no tests, provider calls, migration, dependency installation,
or application/source edits. The sole authored file is this evidence record.
The parent owns baseline execution, claims, integration and acceptance.

## Source identity and authority

- Worktree: `F:/Diomedes/diomedes-wt/memory-context-contracts`.
- Branch: `feature/memory-context-contracts`.
- Inspected HEAD: `9f14078eef3d864f4c2569ac61ce791577cf8b2c`.
- Repository was clean at initial inspection. Before saving this record, only
  the parent's authorized `docs/product/memory-context/` import was untracked.
- Repository Pillars, Roadmap and Project Memory each identify version
  `2026-10-05.1`. Parent separately verified cloud versions and retained DIO-222
  divergence. This lane does not certify cloud/repository body equivalence.
- Read live AGENTS.md and `docs/harness/RUNTIME_VERIFICATION.md` and `CHANGES.md`
  before historical `CURRENT_STATE.md`. Historical runtime inventories are not
  used as present-day implementation claims.
- Read package W00 implementation requirements and supplied
  `C:/Users/andre/Downloads/AI_PROJECT_RECONCILIATION.md` as evidence. Attachments
  do not create new execution, publication, spending or migration authority.

| Baseline path | Exact Git blob |
| --- | --- |
| `server/harness/context-assembly.ts` | `3fbf31e7aee4dce5ef10c06550fc8375e211cb49` |
| `server/harness/native-agent.ts` | `532665fe2e3d9f100770db037e55cc8cfa74aa6b` |
| `shared/context-accounting.ts` | `472c4ac7b94d9d7902ee488246ed14ecb7fd81e4` |
| `server/harness/run-service.ts` | `c88f8aeda7046f24e303b29b23c6612d77c5187a` |
| `services/control-plane/src/migrations.ts` | `49b5ad92fe69078bc11a1d96a846e93c31f9a4b8` |
| `package-lock.json` | `0b3fc2aa67eb5ad4695e940eaf1bd9fc8866014e` |

The context-assembly and native-agent blobs match the supplied reconciliation.
All source line references below refer to this inspected baseline.

## Existing owners and reusable seams

| Owner | Current seam | W00 constraint or gap |
| --- | --- | --- |
| H18 / DIO-23 | `server/harness/context-assembly.ts:112,182`; `server/harness/conversation-history.ts:16` | Existing first-sentence compaction and recency/lexical selection remain bounded by 12 turns and 24,000 characters. Own omitted turns can be summarized; carried omitted turns are explicitly not summarized (`context-assembly.ts:237`). This is not a durable memory ledger or exhaustive coverage proof. |
| H11 / DIO-16 | `server/harness/instruction-delivery.ts:235,501,530` | Reuse assembled instructions, delivery evidence and per-message rules. Memory is attributed context, never authority. Instruction section budgeting is already byte-based (`:84-93`). |
| H13 / DIO-18 | `server/harness/native-loop.ts:404,528`; `server/harness/native-agent.ts:251`; `server/harness/run-service.ts:831,907` | Runtime owns preparation, steps, replay, leases, approvals, budgets and uncertain effects. Capsules must reference those durable records rather than replace their state machines. |
| H09 / DIO-14 | `server/agents.ts:192,334`; provider bindings and `server/engines/model-api-core.ts:976` | Agent/profile resolution is a pinned historical snapshot, not revived authority. Read the admitted route, source restrictions, rate card and live spend boundary. No historical model default is a memory invariant. |
| H20 / DIO-25 | `server/evaluation/route-inventory.ts:24`; `server/evaluation/route-matrix.ts:50,302`; `server/harness/evaluation.ts:89` | Reuse route inventory and four states: proven, declared-not-proven, unsupported, mismatch. W00 fixture results cannot prove whole-route, packaged or funded-provider acceptance. |
| Hooks / DIO-137, DIO-144 | `server/harness/run-service.ts:297,813`; `server/harness/lifecycle.ts:111` | Lower-level hooks already run after policy on copies, followed by policy recheck. `installGovernance` and `resolveExecution` have no production callsites in current server source. No hook-registry/shared hooks implementation is present. Do not assume declarative pack hooks are integrated. |
| SI / DIO-139, H10 / DIO-15, P04 / DIO-30 | `server/guidance.ts:346,430,457`; `server/task-skills.ts:43`; `server/pack-contributions.ts:341,378` | Existing proposals, recorded writes, digest-linked revisions and pinned contributions are reusable. DIO-139 owns the shared SI/Refine pipeline. Dreaming must propose through that extension, not add a second curator or active-skill store. |
| Effect / DIO-162 | `server/harness/native-agent.ts:48-54`; `server/harness/run-service.ts:241` | Current ports are Promise/AbortSignal. No Effect dependency appears in inspected root/control-plane manifests or locks. Preserve this narrow port until a qualified shared boundary exists. Runtime remains owner of durable IDs, policy, effects, spend and reconciliation. |
| Automation and Ready | `server/automation-scheduler.ts:7-16`; `server/ready-scheduler.ts:4-15` | Automation occurrence admission carries pinned procedure input; Ready calls ordinary Work admission with a durable command identity. Preserve their distinct responsibilities. No new memory-plugin scheduler. |

The existing skill path checks active/known/fitting before loading and pins exact
pack version/body digest (`server/task-skills.ts:54-75`). It does not grant scope.
The broader learned-skill delivery gap remains: `assembleSkillSection` takes
`CapabilityPackId` and resolves built-ins (`instruction-delivery.ts:599-619`),
while installed workflow contribution bodies are canonical manifest JSON
(`pack-contributions.ts:115`). The strict pack contribution kinds currently omit
hooks (`shared/pack-manifest.ts:201`). These are adjacent owners, not W00 fixes.

Do not mistake `server/execution.ts` for an integrated current spending path.
Its `resolveExecution` has no production caller, and its introductory inventory
still says no spend ledger exists. Current provider dispatch uses
`server/engines/model-api-core.ts` and `server/spend-exposure.ts`.

## Four different sizing contracts

1. Prepared JSON: `native-agent.ts:86` checks
   `JSON.stringify(json).length > 262144`. This is JavaScript string length in
   UTF-16 code units, not a UTF-8 byte ceiling.
2. H18 accounting estimate: `shared/context-accounting.ts:29-35` labels and
   computes `ceil(UTF8 bytes / 4)`. Unknown model windows remain unknown.
3. Spend-reservation input bound: `shared/token-bound.ts:13` computes
   `bytes + 1024 + messages * 16`, shared with the managed gateway. This is
   distinct from the H18 estimate and from exact provider-reported usage.
4. Actual route request limits: `server/engines/model-api-core.ts:478-488`
   sets Conversation to 200,000 request bytes / 4,096 output tokens and Work to
   400,000 request bytes / 16,384 output tokens. Serialized transport bytes are
   guarded at `:179`; request-content bytes and hold ceiling at `:532-543`.
   Managed Nectovia additionally clamps request bytes to 262,144
   (`server/engines/nectovia.ts:239`).

Instruction delivery has another bounded allocation: 160,000 request bytes and
a 20,000-byte reserve (`instruction-delivery.ts:84-93`). A larger declared model
window alone does not increase any of these limits.

## Preparation, authority and lifecycle constraints

- `validatePrepared` preserves run/capability/transcript identity, permits only
  original tool descriptors and cannot remove a source restriction
  (`native-agent.ts:77-98`). Its result is copied.
- Preparation is a recorded pure, zero-cost transform (`:259-266`). Do not hide
  extraction, embeddings, reranking or funded compaction inside that transform.
- Saved context is revalidated before dispatch without rewriting its bytes
  (`:276-277,302`). Source epoch/revision refusal needs explicit W00 proof;
  the existence of this port does not establish that memory implementation.
- Host labels and trusted preparation may supply source restrictions; tool
  outputs are data, never policy declarations (`:101-124`). Unenforcing external
  adapters are refused (`:274-275`).
- Tool names match `^[a-z][a-z0-9_-]{0,63}$` (`server/harness/tools.ts:89`): use
  `memory_search`, not `memory.search`.
- `RunService` returns successful observations on replay (`:831`), preserves
  uncertain effects (`:834-855`) and reserves units/model/tool calls before
  handler dispatch (`:907-924`).
- Provider calls reserve through SpendExposure (`model-api-core.ts:976-983`),
  execute once without SDK retries, and retain uncertain dispatch/usage
  (`:915,1027,1202,1315`). Preserve root-job and attempt budgets; use one retry
  owner. Cancellation does not prove that an external effect never happened.
- Keep provider-native continuation private. Existing opaque transcript refs
  bind run/model/prefix and canonical bytes (`model-transcripts.ts:94-98`).
  Portable capsules must not invent cross-provider transcript compatibility.
- Consult-memory and contribute-memory consent remain separate. Disabling
  contribution must stop extraction/maintenance; disabling consultation must
  also gate tools and carried learned material. Neither setting deletes live
  authoritative task state or establishes legal/evidence deletion.

## Persistence and migration disposition

**Local:** The actual supported implementation in inspected source is durable
JSON: `RunStore` / `FileRunStore` (`run-store.ts:22,122`) with write, fsync and
atomic rename (`:95-119`). Windows replacement retries repeat the rename only,
never a handler. Local record families already use
`server/migrations/framework.ts`, `files.ts` and `registry.ts:179`.

There is **no adopted product SQLite driver** in inspected manifests/locks/source.
The parent's later capability probes below establish built-in `node:sqlite`
availability on two Windows runtimes, not product-driver adoption.
Packaged SQLite support is **unqualified**, not declared impossible. The app
hosts the service inside Electron (`desktop/main.mjs:401,440`), locked to
Electron 44.2.0. Packaging supports Windows x64 and macOS arm64
(`scripts/package-desktop.mjs:127-129`). A host Node feature check would not prove
the packaged runtime. W01 must qualify its driver across those packaging targets
through the authorized dependency/security review before adoption. This lane
ran no driver probe, install or packaging test.

**Managed:** `services/control-plane/src/migrations.ts:7` owns contiguous,
named, hashed PostgreSQL migrations, advisory transaction locking and immutable
history verification. `scripts/migrate.ts:28` currently lists **001 through 019**.
Thus 020 is only the next candidate number at this snapshot, not a reservation:
`:31-32` allocates 016+ in merge order, requiring a fresh sequence read before
authoring/merge. No managed-memory schema is adopted by W00.

The migration runner permits approved disposable validation targets or pinned
`accounts_staging`; production is explicitly disabled (`scripts/migrate.ts:12-24`).
W02 must coordinate through this owner and current complete migration sequence.
No live database, role grant, migration or data validation occurred here.

## Live Linear checkpoint

Read-only connector responses on 2026-10-06:

| Issues | State |
| --- | --- |
| DIO-23 H18, DIO-16 H11, DIO-18 H13, DIO-14 H09, DIO-25 H20 | In Progress |
| DIO-15 H10, DIO-122 persistent business setup/governed learning | In Progress |
| DIO-227 W00, DIO-139 shared skill pipeline | Backlog |
| DIO-137 pack hooks, DIO-144 hook registry/schema | Backlog |
| DIO-162 Effect, DIO-163 EF-A, DIO-164 EF-B | Todo |
| DIO-222 canonical body reconciliation | Backlog |

W00 blocks W01/DIO-228 and W11/DIO-238. H18 relates to W00/W03/W04/W11 and
DIO-239. DIO-139 is a child of DIO-122 and relates to H10/P04. None of these
workflow states closes full feature acceptance. DIO-222 remains separate.

## Parent evidence checkpoint after source reconciliation

Before final baseline execution the parent fast-forwarded the worktree to
`30b35903ffffbd02eb987e534966405fe7bcec3d`. An independently inspected Git diff
from the original `9f14078eef3d864f4c2569ac61ce791577cf8b2c` was empty for
`server/harness`, `shared/context-accounting.ts`, `shared/harness.ts`,
`shared/routing-policy.ts`, `server/workspaces.ts`, `services/control-plane`,
`package.json` and `package-lock.json`. The relevant source map remains valid.

The parent executed the final desired-invariant RED baseline using test
SHA-256 `85fbfbb1c9fb9f4df168bb68332418360b55fbafb37beccc1b607165edff0a44`.
The mapping author inspected the resulting artifacts, not reran the tests:

| Artifact | SHA-256 |
| --- | --- |
| `red-final-vitest.json` | `fa3ddc0017b34986422569db3f70f2f5794e4b20e521d11683447acee6cb67e7` |
| `red-final-vitest.log` | `3ad94ba64d0ffb3a2c2b19c229f0d61b42f293cccde5966fb0da532be7388cb7` |
| `baseline-red-observations.json` | `600f2432cc645d7f6b9a12e89052741c8fd8fd9f2c5cfddbfa2358aec3aef10e` |

Paths in this table resolve beside this record. The runner reports **9 failed,
12 passed, 0 skipped, 21 total**. All nine failures are the intended exact
correction-survival assertion, not setup, source-precondition, epoch, replay or
serialization failures. The observation artifact contains six selector cases
across two synthetic tenants and three real ModelSessionRuns/NativeAgent cases
using an offline injected transport.

Independent inspection confirms that all nine original histories contain the
critical correction/exception, retain source references, and keep completed
source steps unchanged; all nine delivered contexts omit that critical text
while retaining the earlier approval wording. Full persisted prompt/answer
equality is checked before compaction. The real driver records and delivers the
selected summary through NativeAgent. The source-level DIO-239 loss is therefore
reproduced in this bounded fixture. This is not evidence of model hallucination,
an executed unauthorized action, customer impact or a corrected implementation.

The parent also ran `sqlite-runtime-probe.cjs`. Inspected
`sqlite-host-node.log` records Node 22.23.2 / SQLite 3.51.3; inspected
`sqlite-electron-probe.json` records Electron 44.2.0 / Node 24.20.0 / SQLite
3.53.4, both Windows x64. Each records **4 passed, 0 failed** for composite
tenant/record keys, duplicate refusal, rollback and FTS5. The probe source opens
only `:memory:` and closes its database. These are runtime-capability results,
not packaged-app, persistent-store/crash, macOS, performance or W01 acceptance.
No SQLite dependency or product persistence choice is adopted here.

## Remaining evidence boundaries

Final parent reconciliation advanced the composed-gate base to
`c02ddac80a48e2ee247d72d6e172ad754e2c1286`. Its diff from `30b3590` contains
only the three canonical documents (PR #240), with no executable change.
Repository versions are now `2026-10-06.1`; refreshed cloud Pillars remains
`2026-10-05.1`, while cloud Roadmap and Project Memory report `2026-10-06.1`.
Cloud owner-default text and the repository subscription-preference amendment
still differ. DIO-222 owns that divergence; no canonical body was authored here.

- Final parent baseline execution evidence is linked in the checkpoint above;
  the parent implementation record owns normal-mode and combined gate results.
- No packaged SQLite qualification, all-route proof,
  live-provider proof, managed migration proof or full SI/Effect/hook acceptance
  is established by this map.
- DIO-213 fixture recovery is owned by the separate baseline lane; this map
  neither duplicates that search nor claims its datasets or outputs accepted.
- Source refs and blobs must be refreshed if the candidate changes these files.
