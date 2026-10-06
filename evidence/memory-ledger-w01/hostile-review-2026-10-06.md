# W01 hostile verification: findings before fixes

Date: 2026-10-06. Latest owner instruction: final verification rounds; report
findings and failures before making fixes. No implementation or test-source
fixes were made in this round. No commit was made.

## Verdict and boundary

Fresh independent reviewer: native OpenAI `gpt-6.1-sol`, high effort, fresh
context, read-only. Route chosen under the standing native-Codex policy rather
than the skill's stale Muse/GLM default. No outside provider or fallback.
Brief: `hostile-verify-brief.md`.

Reviewer verdict: **ACCEPT WITH FIXES for the source-claim boundary**. Runtime
acceptance remains pending. The parent does not approve a commit with these
findings unresolved.

HEAD: `063035ed9feee446352dbf445208577d021c71d4`.
Pending, uncommitted main merge: `26714bd4817352ec4baf8b1cb473e43785a1ee06`.
The parent reconciled this main before the latest report-before-fixes instruction.
The merge has not been committed. W01 implementation and test hashes still match
the initial `candidate.json`. Main changes are context, not W01 author changes.

The reviewer independently opened the cited files. The parent re-read both
finding paths and their existing assertions, checked candidate hashes and
confirmed SQL LIKE wildcard semantics in the official SQLite documentation.
No test, database open, schema migration, build or typecheck was executed.

## F1: P2, high confidence, user objects can escape schema validation

`server/memory/local-store.ts:24-25` defines the actual schema query with
`name NOT LIKE 'sqlite_%'`. The same expression at line 172 decides whether an
unversioned database is empty. `_` is a single-character wildcard in SQLite
LIKE, not a literal underscore. User-created objects such as `sqliteXforeign`
and `sqliteXtrigger` are therefore excluded along with internal objects.

Parent reproduction to run in a disposable directory:

1. Create a version-zero database containing `CREATE TABLE sqliteXforeign(id TEXT)`.
2. Close it and call `LocalMemoryStore.open` on that file.
3. Required result: `unsupported_memory_schema`, preserving the foreign file.
4. Source-derived path: line 172 sees no visible object; initialization at
   lines 142-152 may proceed; actual-schema comparison at lines 178-179 excludes
   the foreign table as well.
5. Additional control: add an extra `sqliteXtrigger` trigger to an otherwise
   valid ledger. The same actual-schema filter omits it.

The recovery cases at `tests/memory-store-recovery.test.ts:226-258` cover generic
foreign/unversioned objects and a removed required trigger, but not this naming
class. Proposed correction, **not applied**: exclude the literal `sqlite_`
prefix consistently, then add both negative assertions.

Parent reference: [SQLite LIKE semantics](https://www.sqlite.org/lang_expr.html#like).
This is a source finding, not an executed reproduction or observed customer incident.

## F2: P2, medium-high confidence, initialization bypasses the WAL ceiling

`server/memory/local-store.ts:99-105` accepts `maxWalBytes: 1`. Lines 139-152
enable WAL and directly create/commit the initial schema. The WAL reservation
refusal is in `write()` at lines 207-223, outside that initialization path.

Parent reproduction to run in a disposable directory:

1. Open a nonexistent ledger with `limits: { maxWalBytes: 1 }`.
2. Required result: capacity refusal before schema writes exceed that ceiling.
3. Source-derived path: schema creation and commit do not consult the WAL limit.
4. Measure the open result and WAL size during initialization. No observed byte
   size or execution outcome is claimed in this report.

The existing assertion at `tests/memory-store-recovery.test.ts:195-201` reopens
an already initialized store and attempts a ledger write. It does not test
first-time schema creation. Proposed correction, **not applied**: enforce the
reservation policy during initialization or refuse incompatible limits before
changing the target; add a new-file control.

## Independent claim scorecard

CONFIRMED means source behavior and authored assertion coverage, not executable,
packaged-platform or production qualification. Line anchors are relative to the
named file in this worktree at the hashes below.

| Claim | Classification | Independent anchors |
| --- | --- | --- |
| C1 Strict source-backed shapes; lifecycle/epistemic separation | CONFIRMED | `shared/memory.ts:38-78`; `shared/memory-ledger.ts:12-73`; `service.ts:116-120`; ledger test 129-134; contracts test 32-75. |
| C2 Scoped primary/reference paths; alias ambiguity | CONFIRMED | `schema.ts:16-101`; `local-store.ts:23,191-196`; `service.ts:251-262`; ledger test 14-69,343-363; recovery test 153-162. |
| C3 Stale revision refusal; immutable source metadata | CONFIRMED | `service.ts:96-99`; `local-store.ts:334-340,402-412`; `schema.ts:103-108`; ledger test 72-78,106-126; recovery test 106-120. |
| C4 Valid/recorded time; succession; unknown bounds | CONFIRMED | `service.ts:107-114,212-244`; ledger test 231-323, including unknown bounds 271-275. |
| C5 Exact replay; changed-command refusal | CONFIRMED | `store.ts:7-18`; `service.ts:88-94`; `local-store.ts:424-440`; ledger test 81-103; recovery test 27-39,362-369. |
| C6 Atomic revision/event/receipt; rollback; hard-crash coverage | CONFIRMED | `service.ts:174-192`; `local-store.ts:207-237,309-325`; recovery test 42-60,83-103. |
| C7 Explicit conflict precedence; no inference/effect authority | CONFIRMED | `service.ts:116-117,265-303`; ledger test 366-447. |
| C8 Suppression generations and external restore floors | CONFIRMED | `service.ts:56-74,195-206`; `local-store.ts:517-570`; ledger test 212-226; recovery test 280-287,305-349,372-380. |
| C9 Resource bounds; actual schema validation; migration/readability | PARTIAL | `local-store.ts:27-30,99-105,168-182,199-223,449-457,496-522`; recovery test 167-302. F1 and F2 remain unresolved. |
| C10 Deterministic snapshots/outbox positions; callback lifetime | CONFIRMED | `local-store.ts:224-226,243-247,309-325,443-493`; ledger test 137-143; recovery test 124-150. |
| C11 Separate existing authority; no model/network under a Store lock | CONFIRMED | Ledger imports/operations; `registry.ts:59-72,194-198`; existing `server/store.ts:445-474,560-574`, `server/harness/run-store.ts:122-161`, `server/lock.ts:248-280`; recovery marker 204-223. |
| C12 Initial 85 authored cases; no executed acceptance claim | CONFIRMED | 36 ledger declarations plus 17 parameter expansions = 53; 24 recovery declarations plus 8 expansions = 32. `candidate.json:12-33`; initial implementation report 105-109; test plan 19-28. |

Totals: 11 CONFIRMED, 1 PARTIAL, 0 REFUTED, 0 FABRICATED, 0 UNVERIFIABLE.
Requested precision formula: `11 / (12 - 0) = 91.67%`. This is a claim-audit
score, not a test pass rate or probability of correctness.

Known-answer checks:

- Explicit lazy opening: confirmed at `local-store.ts:92-107`.
- No profile opened by normal implementation imports: confirmed by module reads.
- Hard-crash child: `tests/fixtures/memory-ledger/crash-child.ts:19-27` writes
  the boundary marker and calls `process.exit(86)`; the later throw is failure
  to reach that boundary. Authored coverage only.
- Actual-object comparison exists at `local-store.ts:111-116,178-182`, but its
  coverage is incomplete because of F1.

## Scope compliance

W00 is present locally through `b9ffd6eebaf6ebd552f488be2dffc893f73ead24`, with
its review evidence retained. The reviewer did not requalify W00. W02 source
authorization, managed persistence/purge, and W04 continuity runtime were not
added. No provider route, model call, active-profile startup wiring or purge
implementation appears in the W01 candidate. No unrelated author delta was
found beyond the declared main context and W01 files. Repository canonical
versions remain `2026-10-06.1`; DIO-222 remains separate.

## Exact reviewed SHA-256

| File | SHA-256 |
| --- | --- |
| `shared/memory-ledger.ts` | `12354312c52c379c1fd8246c4cddb54ea84a1e1b7fcec7a64492c2dafb96ae08` |
| `server/memory/store.ts` | `99fa0ff194a2ccc7a1776a73840ab1f2248dad49d7b4f3862ba315559b3d0129` |
| `server/memory/service.ts` | `24c21b696a9145a901411aacf17429428e74f205e4d856d3cfc82dee0b809316` |
| `server/memory/local-store.ts` | `b59e9b17b29da56f096d7a7ead5c280f44bd4968175260dde95647da2cc50ada` |
| `server/memory/schema.ts` | `b35dbce7decab39acd786033845c9d9ebf0a97ad46fc60726168826bc19f3827` |
| `tests/memory-ledger.test.ts` | `17fd7c7ec253740273a8c28dae3fa39cb663ed3bab9dcec469f8339c18d1abea` |
| `tests/memory-store-recovery.test.ts` | `05715f4da09af79b223751c42014c121cd56cbd9fc59a4fe4d6a68c3d83cfa60` |

## Executed failures and outstanding proof

No W01 tests executed in this round: **0 passed, 0 failed, 0 skipped; 85 authored
W01 cases unrun**. The existing contracts suite, typecheck, full unit suite,
build, browser tests and platform qualification are also unrun. The two findings
are source defects, not a claim of two executed test failures.

The shared test slot remained held by Opus for DIO-245 in `payg-local-guard`,
slot `slot_muwnbf9n_76f3ada7`, during inspection. The inspected recent Opus
coordination journal did not provide W01 evidence. This does not establish that
Opus never reviewed W01 elsewhere; any such result needs its exact candidate
identity and logs before reuse. Existing W00 counts are not W01 validation.

`run-mutations.mjs` was authored before the owner's clarification, then the
worker stopped writes. It is unexecuted and unverified, and its README remains
unwritten. It supplies no RED proof. No fixes, commit, push, activation or
deployment occurred in this review round. Findings must be reported to the
owner before a repair round.
