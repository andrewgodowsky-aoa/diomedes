# W00 memory and context baseline

Date: 2026-10-06. Package: NC-MEM-LC-2026-10-06.1. Delivery: DIO-227.
Investigation: DIO-239. Epic: DIO-226.

## Boundary and source identity

This slice freezes portable contracts and exercises existing harness behavior.
It does not implement the W01 ledger or the W04 compaction correction. W01 is
not started. Focused execution, independent review and all four local
repository gates passed. This is local W00 acceptance, not merged completion.

- Feature: memory-context-contracts; owner: primary Codex architect.
- Branch: `feature/memory-context-contracts`.
- Worktree: `F:/Diomedes/diomedes-wt/memory-context-contracts`.
- Initial published main/base: `9f14078eef3d864f4c2569ac61ce791577cf8b2c`.
- Updated pre-test main/base: `30b35903ffffbd02eb987e534966405fe7bcec3d`.
  The feature branch was fast-forwarded after PR #239 landed. Its Console
  changes do not change the reconciled harness, memory-related shared types,
  control-plane or dependency files; the exact relevant diff was empty.
- Composed-gate base: `c02ddac80a48e2ee247d72d6e172ad754e2c1286`.
  PR #240 changed only the three canonical documents. The branch was again
  fast-forwarded before the composed gates. No executable source or test changed.
- Original package inspected base: `cb2e756257de92a6091659200213cdcb79829700`.
- Addendum inspected base: `189556d0342647a4a1076124d13403fe2dc36d89`.
- The context-assembly/native-agent/context-accounting blobs still match the
  original package. Exact hashes and owners: [source map](../../evidence/memory-context-w00/source-map.md).
- The primary checkout was dirty on another branch. This work uses a new clean
  worktree; no unrelated changes were copied, reset, staged or removed.
- Exclusive claim: `claim_muwea9i0_074bd432`, node `NC-MEM-LC.W00`, role `astra`,
  host `Andrews-Desktop`, process 40792/start `2026-10-06T03:08:37.1866520Z`.
  Claimed paths are the new contract/test/fixture files, this record,
  `docs/product/memory-context/` and `evidence/memory-context-w00/`.

The live Linear W00 issue was Backlog, with no blocker, and gates W01/W11.
H18/H11/H13/H09/H20 remain their existing work owners. Existing completion
ledgers are not closed by this slice. The unified run order and completion
ledger were read; their older implementation/review labels are evidence,
not a reason to rebuild existing source.

After a fresh issue read, DIO-227 was moved from Backlog to In Progress to
reflect this execution (confirmed `2026-10-06T09:26:51.798Z`). Its description,
labels, priority and dependency relations were preserved. No issue was closed.

## Reconciliation decisions

At initial reconciliation, repository and cloud Pillars, Roadmap and Project
Memory each reported `2026-10-05.1`, with divergent bodies. After PR #240,
repository versions are `2026-10-06.1`. A fresh cloud read reports Pillars
`2026-10-05.1` and Roadmap/Project Memory `2026-10-06.1`. The cloud owner-default
checkpoint and repository subscription-preference amendment still differ.
DIO-222 continues to own this reconciliation. This slice authors no canonical
body changes and does not claim synchronization or new route qualification.

The current source map corrects several assumptions in the handoff:

- The native prepared JSON guard is 262,144 JavaScript string code units,
  inclusive. It is separate from UTF-8 request bytes, H18's `utf8-bytes/4`
  estimate, the conservative call-cost bound, and a declared native window.
- Preparation remains a recorded pure transform with cost zero. Retrieval,
  extraction, model compaction, remote counting and mutations require their
  own admitted steps. No such operation is added here.
- Tool registration requires underscore-compatible names such as
  `memory_search`. No new tool is registered by W00.
- Runtime/RunService, Trust, Store, source restrictions, model transcripts,
  accounts, funding and capability packs retain their existing authorities.
- Effect is not adopted in current source. Reuse Promise/AbortSignal ports
  until a qualified shared lifecycle port exists. One operation has one
  retry/cleanup owner. Live fibers/scopes never become portable records.
- SI/DIO-139 owns the shared learning pipeline with H10/P04. Pack hooks are
  still separately open. Dreaming must not create another curator or scheduler.
- No SQLite driver is adopted or packaged-qualified in current source.
  W01 must qualify a local driver/transactional adapter on the actual target
  runtimes without migrating the existing file-backed run authority.
  W00's `node:sqlite` in-memory probe passed four checks each under host
  Node 22.23.2 / SQLite 3.51.3 and Electron 44.2.0 / Node 24.20.0 /
  SQLite 3.53.4 on Windows x64. This establishes an available candidate,
  not packaged-app persistence, crash recovery or macOS qualification.
- Managed migrations currently enumerate 001-019; numbering belongs to the
  control-plane migration owner at merge time. W00 allocates and runs none.

These are integration boundaries, not permission to delay W00 on the entire
Effect/skills/managed-store programs.

## Frozen contracts

`shared/memory.ts` owns strict `SourceRef`, `MemoryProposal`, `MemoryRecord`,
`MemoryUseReceipt`, source-snapshot binding and issued-source shapes.
`shared/continuation.ts` owns the strict capsule and optional narrative shape.
These modules are not yet consumed by the production harness. The original
package remains unchanged under `docs/product/memory-context/`.

| Surface | Host-owned fields and checks | Generated content |
| --- | --- | --- |
| Memory proposal | Issued source IDs/locators, current scope and epochs are supplied separately | kind, bounded body, proposed source locators only |
| Stored memory | identity/revision, tenant/workspace/scope, lifecycle, epistemic status, source references, epochs, times, dependencies and retention | A model never supplies an authenticated record |
| Capsule | task/run, snapshot, goal, exact constraints and evidence, runtime/memory/coverage refs, revision/index | open questions and next intentions only, neither executable |
| Use receipt | run/step, actual supplied sources, snapshot/epochs, rendered digest, compiler and measured/estimated/unknown accounting | No model-issued receipt or grant |

Zod strict objects reject unknown keys rather than silently removing them.
Text is not trimmed or normalized. Character bounds count Unicode code points,
matching the seed JSON Schema and existing interaction-contract convention.
JavaScript integer fields must be safe integers. No unknown revision, digest,
usage, timestamp or epoch is filled with an invented default.

`resolveMemoryProposalSources` performs a pure exact-span lookup against a
host-issued source snapshot. It refuses a different tenant/workspace/snapshot,
changed access/deletion epoch, an unissued locator or ambiguous revisions.
It returns copies of the proposal and issued references. It does not read data,
establish truth, promote a fact, authorize an effect or assert tenant security
of a storage service. W02 must resolve originals with adjacent qualifications
and recheck current rights; a digest proves byte identity only.

`MemoryHostContext` reuses `HarnessPrincipal`, `HarnessLabel`, `WorkspaceRef`
and `HardRestrictions`. Workspace identity is host-resolved from the current
person/account and WorkspaceRef, not inferred from projectId or model text.
Identity generation, source access epoch and deletion epoch remain separate.
Restrictions pointers require live resolution and intersection by their owner.

The persisted schemas deliberately retain the seed's separation of shape from
semantic admission. An empty evidence list, a parsed `live-verified` enum,
timestamp text or equal snapshot does not establish verified/current evidence.
W01/W02 own temporal/source/retention checks; W03 owns actual supplied-evidence
receipts and token-quality consistency; W04 owns capsule activation/lineage and
exact-constraint validation. CoveragePlan remains the package seed for W05,
not an implemented coverage service. No opaque provider payload, credentials,
live Effect state or independently executable grant is in a capsule.

## Baseline and reproduction

The fixture uses owned fictional data for tenant-a and tenant-b, plus a local
scripted ModelSessionRuns transport. It exercises actual `compactTurns`,
`selectHistory`, `ModelSessionRuns`, `NativeAgent`, `RunService` and FileRunStore.
The scripted adapter records the downstream request; it does not simulate a
model's belief or authorize an order. No external network call is made.

DIO-239 cases are a later answer correction, a later user correction and an
exception after a long first sentence. Normal tests freeze current loss and
preserved original references. An explicit desired-invariant mode requires
the exact critical text to survive, producing ordinary failures on the same
source. Controls put the correction first or in recent retained history.
See [reproduction scope](../../evidence/memory-context-w00/baseline-reproduction-scope.md)
for exact commands and the boundary between expected and executed results.

The issue mentions M14/L01/L03, but the actual package M14 is uncertain-effect
recovery. W00 does not claim M14 coverage. L01 is the W00 acceptance case;
the correction fixtures reproduce W04/L02's missing invariant and contribute
development evidence toward W04/L03, not
full rollover acceptance or a customer incident. Existing History is preserved.

The final RED run has 9 ordinary assertion failures, 12 passing controls and
zero skipped tests. All failures are the intended exact-correction-survival
assertion: six actual selector/compactor cases and three actual downstream
dispatch cases. The same candidate in current-behavior mode plus the contract
suite has 70 passed, zero failed and zero skipped. GREEN characterizes the
existing limitation and validates controls; it is not a compaction repair.
`baseline-red-observations.json` and `baseline-current-observations.json` each
retain nine synthetic traces, including original text, source identities,
digests, selected context and the three final dispatched requests.

An initial attempt collected no tests because the first shared dependency
directory lacked `ai`. The first executable RED attempt exposed a fixture
assertion that compared a pending input wait before and after its legitimate
resolution. The repaired assertion compares every original answered turn and
its entire completed source step. Both preliminary failures are retained and
excluded from final behavioral counts. TypeScript's first attempt also found
missing control-plane dependencies. Matching-lockfile dependency junctions
were reused, with no install or manifest edit; the final type check passed.

## AI-project qualifiers

| Qualifier | Owner and disposition |
| --- | --- |
| AI-C01 | W00: current canonical/source precedence and existing work owners mapped; historical Achilles proposals remain historical |
| AI-C02 | W00/W04/W06/W08: Promise/AbortSignal and existing durable lifecycle ports mapped; future cancellation/cleanup qualification stays with the implementing slice |
| AI-C03 | W07/W08: SI/DIO-139 plus H10/P04 is the one promotion pipeline |
| AI-C04 | W03/W08/W10: consult and contribute settings remain independent; no setting implemented here |
| AI-C05 | W00/W04/W05/W11: exact local assets registered; missing historical source/runtime bindings remain gaps, not reconstructed facts |
| AI-C06 | W02/W08/W11: no evaluation-gold or forbidden/discard-required outputs in memory/training; no model outputs copied by W00 |
| AI-C07 | W00/W02/W06/W11: actual routes, migration sequence and packaging runtime mapped; source checks do not establish deployment |
| AI-C08 | W10/W11: Personal/local, cross-industry and separate computer/indexing permissions preserved; no UI/entitlement change here |

The [local-model regression register](../../evidence/memory-context-w00/local-model-regressions.json)
binds recovered 115K/recovery evidence to exact files and recorded hashes.
Historical scores are not fresh W00 results. The 192-case Business Trials import
has a business-disjoint split, not a chronological split, and is not proven to
be DIO-213's active Stage 0 bank. Missing historical verifier bytes, per-run
runtime binding and final-test freeze remain explicit. No model comparison,
training-data export, protected budget use or subject-output retention occurred.

## Verification and acceptance

Pillar impact: this contract advances P13/P14's distinction between governed
memory, evidence and scoped knowledge, while preserving P06/P09 authority and
funding. No pillar definition changes. No roadmap item is marked complete.

Package ZIP SHA-256:
`f7e4584fecc966bdb103ce012383ebc1850868d6bf799b9c4f2f7261a56379b7`.
All 57 original files were imported into the owned worktree after archive-path
checks. Scoped Git attributes preserve the package and raw evidence bytes
across checkouts without changing any original package file. The unchanged
package validator passed 142 base checks, zero failures.
Its six optional JSON Schema checks are unrun because jsonschema is absent in
both the existing system and bundled Python environments. The explicit
`--schemas` invocation reports that missing dependency; nothing was installed.
This is package integrity evidence, not product acceptance.

Focused product execution and independent review are complete. TypeScript passed.
The first full-suite process disappeared without a final report or captured
exit status; its cause is unresolved and no counts are inferred from the partial
log. The separate two-worker run completed with 10,223 passed, zero failed and
five skipped, exit 0. Its full report includes the 70 focused cases; the counts
are not additive. The shared slot was released to the waiting PR #236 lane
after that active run finished.

The user subsequently authorized running the remaining tests now if possible.
The build passed with a chunk-size warning. The three required browser files
passed 36 tests, zero failed, skipped or flaky, using one worker and separate
ports 5184/47642/47644. Their data, build output and dependency cache were
separate from the active UI lane. No other lane's slot or processes were
changed. See `parallel-validation-authorization.json` for this bounded exception
to the repository's scheduling guideline. The two tracked screenshots written
by the existing browser tests were restored to their clean pre-test versions.

The independent reviewer accepted the completed build/browser records and
verified all five implementation/fixture hashes still matched the reviewed
candidate. [Acceptance](../../evidence/memory-context-w00/acceptance.json) and
[independent review](../../evidence/memory-context-w00/independent-review.md)
contain exact results and evidence hashes. No product source changed during
these final gates. L01 and the W00 contract baseline are locally accepted;
the remaining 95 package cases remain with their owning slices.

This record is the pre-publication checkpoint. The review branch may be
published under the user's standing commit/push instruction, with `[skip ci]`
to suppress the repository's automatic Cloudflare build integration. Actual
remote status must be checked after publication; local gates are not hosted CI.
W00 is not marked DONE or merged, and W01 has not started. No deployment, live
migration, installed-app replacement, paid provider evaluation or customer-data
processing is accepted by this record. DIO-222 remains separate.
