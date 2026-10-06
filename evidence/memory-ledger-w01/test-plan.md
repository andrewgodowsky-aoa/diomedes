# W01 regression authoring and deferred execution

Status: AUTHORED_UNRUN. Date: 2026-10-06.

Base: `063035ed9feee446352dbf445208577d021c71d4`, the current-main/W00
integration base assigned by the parent. Worktree:
`F:/Diomedes/diomedes-wt/memory-ledger`. Parent claim:
`claim_muwj0kw7_d2f36c88`. Canonical repository mirrors read at version
`2026-10-06.1`. Package: `NC-MEM-LC-2026-10-06.1`, W01 / DIO-228.

The owner deferred ALL tests while other heavy tests run. This lane authored
tests and inspected source only. It did not run tests, collect tests, typecheck,
build, probe Node/Electron/SQLite, install packages, invoke paid models, change
production data, commit, push, merge or deploy. No RED or GREEN exists from this
lane. Independent source review by another worker is separate from these tests.

## Authored inventory

| File | Authored cases after explicit parameter expansion | Execution |
| --- | ---: | --- |
| `tests/memory-ledger.test.ts` | 53 | DID_NOT_RUN |
| `tests/memory-store-recovery.test.ts` | 32 | DID_NOT_RUN |
| Total | 85 | DID_NOT_RUN |

These are a static authoring inventory, not Vitest discovery output. Executed:
0 passed, 0 failed, 0 skipped. Authored but unrun: 85. Existing
`tests/memory-contracts.test.ts` is also unrun in this lane; its count is not
included above. Type/build/package/platform/runtime gates remain DID_NOT_RUN.

Fixtures are fictional. `tests/fixtures/memory-ledger/fixture.ts` uses the actual
`LocalMemoryStore` and `MemoryService` in a disposable `mkdtemp` directory. It
supplies a deterministic clock and independent host epoch callback. No mock
database, active profile, source credentials or customer data is used. Cleanup
requires the exact temporary parent and owned directory prefix.

## Acceptance mapping

| ID | Concrete authored assertions | Limit |
| --- | --- | --- |
| M03 | A future-effective revision preserves the current SOP before its start; applies at the half-open boundary; never falls back after its end. | Ledger selection, not model answer quality. |
| M04 | Historical valid time and recorded knowledge time select different revisions after a correction. Recorded end time names the later correction while the historical snapshot excludes its future body. Correction-shortened intervals do not revive the old open-ended claim. | Source chronology, not semantic interpretation. |
| M05 | Equal supplier aliases in east/west scopes retain separate identities. Foreign tenant lookup returns no entity. | No inferred identity merge. |
| M06 | Two same-name people remain ambiguous; an earlier frozen snapshot retains its earlier unique result. | No external identity qualification. |
| M08 | Host precedence selects a currently applicable, source-supported policy; both conflict claims remain inspectable. Missing temporal query refuses. Future or later-retracted claims cannot win. | Policy metadata is host input, not a new Trust authority. |
| M09 | Newer inference cannot claim policy authority or beat an older explicit source by recency. Equal eligible priorities remain unresolved. | No model reasoning evaluation. |
| M28 | Stale CAS refuses; two real SQLite connections capturing the same revision cannot both win. | No distributed managed-store acceptance. |
| M29 | Exact command replay returns the original receipt without revisions/events; payload, expected revision, source and operation conflicts refuse; outbox acknowledgements survive reopen per consumer. | No remote effect delivery guarantee. |
| M30 | Exception injection at all three commit boundaries rolls back all rows; independent reader sees no uncommitted revision; abrupt child exit at each boundary recovers without explicit adapter rollback/close; retry commits once. | Authored only; hardware power-loss and packaged Electron remain unqualified. |
| M41 | Retelling the same original source revision at another locator adds no independent lineage and does not extend a one-off exception. A derivative cannot widen either known source interval boundary. | No semantic rule induction or general Dreaming acceptance. |
| M42 | A formerly negative claim gives way at the effective boundary; prior truth is retained for earlier valid times; expired or retracted text cannot become current again. | No live permit/approval authorization. |

Additional assertions cover tenant/workspace/scope collisions, foreign references,
immutable old revisions/source links, exact operative active dependency revisions,
stale-reference refusal, frozen snapshots, explicit unknown temporal bounds,
malformed intervals, lifecycle/epistemic separation, and current-epoch content
suppression with omission counts.

A future dependency successor bounds a derived claim even when its pinned
predecessor has an open-ended stored interval. Ending the child exactly at the
successor start is allowed; extending past that half-open boundary refuses.

## Recovery, schema and resource cases

Exception fault points are `after-entry`, `after-event`, and `before-commit`.
Those cases verify explicit rollback and close/reopen. They do not stand in for
abrupt-process recovery.

The distinct `crash-child.ts` cases use the existing `node --import tsx` test
pattern. The child accepts only the owned temporary ledger path, writes a marker
for the requested boundary, then exits with code 86 without adapter close or
rollback. Each parent spawn is hidden on Windows, limited to 20 seconds and 8 KiB
of output. A startup failure, timeout, wrong exit or absent boundary marker is a
failure, never a skip or successful crash. The parent reopens the real disk
database, requires exactly the pre-crash backup state, retries the same logical
update, then requires two total revisions/events and identical replay receipt.
All three hard-crash cases remain AUTHORED_UNRUN.

The initial schema has only empty version-zero initialization to version one.
Tests check its metadata and a neighboring run-file preservation marker. Newer,
foreign-application and nonempty unversioned databases must be refused without
changing database bytes. There is no fabricated historical version migration.
Dropping the monotonic epoch trigger while preserving the stored schema digest
must also refuse opening; digest metadata alone is not schema integrity proof.
Logical backup/restore round trips preserve revisions, aliases, commands,
events and consumer positions. Malformed event/command bindings and forged
fingerprints refuse atomically.

Restore requires independent current floors for every backed-up scope, retains
additional current scopes absent from the old backup, takes componentwise epoch
maxima, and refuses a populated destination. Each of identity, access and
deletion generations is independently checked against stale snapshots/replay
after reopen. The service must expose omission counts and no stale body; raw
adapter retained history is not an authorized user retrieval surface.

Capacity tests cover transaction bytes, snapshot entries, backup bytes, outbox
page bounds and WAL reservation refusal. Failures preserve earlier history.
Restore also obeys the explicit transaction byte limit and refuses oversized
backups without exposing even one partially restored scope.
Full database-volume stress, latency benchmarks and platform packaging are not
claimed by this bounded authoring lane.

## Deferred RED and GREEN protocol

When the owner permits execution and the parent obtains the required test slot:

1. Freeze exact candidate paths/hashes, runtime executable and SQLite version.
   Run only against disposable profiles. An unavailable native driver, missing
   import or invalid fixture is an environment/setup failure, not RED evidence.
2. Run the two authored suites plus `memory-contracts.test.ts` with the local
   installed Vitest executable. Preserve raw output and exact per-suite counts.
   Type/build/packaged runtime checks require their own authorized evidence.
3. In an isolated disposable baseline/mutation candidate, challenge scope/foreign
   reference checks, stale-CAS refusal, atomic entry/event/command persistence,
   epoch filtering, interval replacement and command identity. Require a real
   failed behavior assertion, not a loading/type error. Preserve both the
   mutation diff and failed assertion. A remaining database constraint that
   still blocks the bad behavior means the mutation did not demonstrate the
   intended counterexample; do not manufacture a RED claim.
4. Return to the frozen corrected candidate, run targeted GREEN and the required
   review. Candidate changes invalidate earlier evidence for affected cases.

No execution commands in this document were run by this lane. Authoring these
cases does not close W01, W11, the memory epic, or any release gate.

## Later-slice limits

W02 still owns live source authorization, retention/purge, transitive forgetting,
queue suppression, managed PostgreSQL isolation and retained-session handling.
The W01 epoch/reference regressions do not certify that full path. W03 retrieval,
W04 context continuity, W08 Dreaming, model calls, installed engines and provider
qualification are also outside this evidence. The tests assert deterministic
ledger behavior and never infer effect permission from stored memory.
