# Diomedes foundation: exact approval receipts and recovery

Date: 2026-09-08. Scope: the next bounded M1 slice after durable task Work admission.

**Verified:** native proposals now carry exact proposal, action and base identities,
expire after one hour, and produce a durable decision receipt before any approved
write. Workbook and Console recover lost responses and display the recorded decision
and execution outcome. Prepared writes recover through the existing journal; an
accepted decision without a prepared write becomes explicitly not applied on recovery.
Work and approval now share the smallest proven command identity/conflict primitives.
**M1 as a whole remains partial.**

## Authority, base and attribution

- The continuation is governed by the supplied continuation prompt and the existing
  [Work foundation handoff](2026-09-08-work-admission.md). The original September 8
  implementation prompt was read before its consolidated brief. Attached documents
  supply task requirements within the owner's request; they do not independently
  authorize commits, deployment, account changes or unrelated work.
- Main checkout inspected: `F:\Achilles\diomedes`, HEAD
  `218f325d2a902c53b089045dd24496890063a702`. Fable's `c7c7b54` and `218f325` work is
  inherited. Main's separate `scripts/package-desktop.mjs` edit remains untouched.
- Implementation checkout: `F:\Achilles\diomedes-wt\codex-approvals`, branch
  `codex/approval-receipts-20260908`, created from `218f325`. The frozen foundation's
  26-file patch was imported before work. All 15 source hashes in its verification
  record were checked against the frozen originals and the saved baseline snapshot.
  The foundation baseline passed 278 deterministic tests in this checkout.
- The original checkout `F:\Achilles\diomedes-wt\codex-foundation` is preserved.
  Its Git HEAD remains `bd33d40`; its uncommitted state already includes the later
  Fable commits and verified Work admission. Comparing this continuation only to
  that old HEAD would misattribute inherited changes.
- The owner released the rebuild hold when Fable finished. Builds and tests used
  the isolated checkout, synthetic projects, independent data/profile directories
  and ports. No live user data was migrated or copied into a smoke profile.
- The owner's later instruction authorized exactly one Astra architecture/code
  review and skipped further plan writing. One Astra review was used. Muse through
  OpenCode Go handled bounded analysis, client code, smoke script and final review.
  The primary agent reviewed and revised the code and ran the verification. No
  Fable delegates were used. No additional Astra invocation was made.
- The requested verification, debugging, code review, system design, architecture
  and scoped subagent workflows were applied. The initial plan predating the skip
  instruction is archived in ignored output; this document records completed work.

The exact [changed-file list](2026-09-08-approval-files.md) and
[`approval-changes.json`](../../evidence/approval-changes.json) distinguish authored
code/refreshed evidence from byte-identical inherited files. The two local patches are:

- `output/approvals/approval-continuation.patch`: changes after the frozen foundation.
- `output/approvals/foundation-and-approvals.patch`: both slices against `218f325`.

Both patches include binary screenshots and pass `git apply --check` against their
intended checkouts. They were not applied there. Temporary indexes were used to make
the patches; the normal indexes were not staged. No commit, amend, push, main merge,
public deployment, external message, dependency installation or account change was made.

## Durable contract

New native Needs carry version 1 approval identity. The action digest binds destination
paths and raw UTF-8 before/after hashes. The base digest binds every explicitly selected
source, including selected documents that the proposal does not modify. The proposal
digest also binds project/Need/task/session identity, creation/expiry, the displayed
explanation, consequence, file list and preview. Changing the explanation, destination,
selected base or proposed bytes requires a new identity.

`POST /api/projects/:id/needs/:needId/resolve` accepts a strict v1 command containing
command ID, decision and the three digests. It accepts no caller-supplied actor or scope
and cannot grant permission for the whole task. Receipts record `actor: local-client`
and `scope: local-prototype`; these are honest local provenance labels, not authenticated
human or device identities. `GET /api/projects/:id/needs/:needId` retrieves the durable
decision and its current execution outcome through the existing project boundary.

The receipt is immutable after admission. It contains the command/payload identity,
project/Need/task/session references, actor/scope, three digests, creation/expiry/decision
times, decision and durable decision-event ID. Execution is a separate record with
`pending`, `applied`, `conflicted`, `not-applied` or `declined` state and its write-event
reference. A granted decision does not claim that a write completed.

Under the existing Store lock:

1. Validate protocol, scope and identity. An identical saved command returns its original
   receipt before checking expiry or entering the writer. Different payload, decision
   or command family under that ID returns a conflict.
2. For a new decision, verify the active proposal and selected base revisions. Check
   the actual admission timestamp against expiry immediately before mutating the Need,
   including after asynchronous source checks. Exact expiry equality is refused.
3. Save the decision receipt and event through the atomic JSON state writer. A failed
   admission persist reloads durable state; it cannot save an in-memory phantom receipt
   through an error handler.
4. A grant enters `writeRecorded` with its approval ID, exact action and `merge: false`.
   The writer verifies the pending granted receipt, session/task linkage, action digest
   and selected bases before preparing the existing content-addressed journal.
5. The prepared journal includes approval linkage and the completed execution, session,
   task and team state. Completion is not a separate best-effort persist after the write.
6. Recovery validates receipt/event/write linkage before applying anything. It verifies
   content-object hashes, completes matching prepared writes and preserves divergent
   outside replacements. A failed recovery blocks later locked reads and mutations
   until recovery and reload succeed.

Recovery preserves supported outside text as a recorded outside change. For a target
that became a directory, binary/non-UTF-8 file, oversized file or unsafe path, the known
path/text refusal is recorded as an explicit unrecorded conflict. Recovery does not
follow links or snapshot unsupported bytes. Other IO failures still fail closed.
The decision remains the same across recovery; its execution reports the conflict.

An accepted decision with no prepared journal is durably marked `not-applied` during
restart/error recovery. It is never dispatched again by a retry. An undecided proposal
interrupted by restart expires under the inherited conservative Work recovery policy.
This closes the tested local write ambiguity without inventing an external-effect adapter.

## Shared authority and desktop behavior

`server/command-admission.ts` centralizes bounded command IDs, digest shape and creation,
version opt-in, a project-scoped Work/approval command namespace and replay conflicts.
The existing adapters retain their concrete schemas, authorization, persistence and
dispatch responsibilities. A fixed known Work v1 payload still produces its original
digest, which is covered by a regression test. No parallel Store, dispatcher framework,
database or runtime was introduced.

The client persists compact IDs/digests in `sessionStorage` before sending. Identical
concurrent actions share an in-flight promise. An ambiguous response gets at most one
automatic retry with the same command; both-lost responses retain uncertainty. Changed
or opposite input cannot silently replace a pending decision. A response clears pending
state only when its complete receipt matches identity, scope and coherent timestamps.
An HTTP 200 alone is insufficient.

Existing state refresh and SSE resynchronization reconcile pending decisions after
reload without additional requests or timers. Corrupt storage is preserved and reported
without preventing independent valid records or the project/team view from loading.
Each command family has at most 32 pending browser entries; an approval entry is bounded
to 4,096 characters and contains no preview text or source contents.

Workbook and Console keep the current layout and design language. Proposal controls
show expiry; completed Needs show the execution outcome and an expandable Decision
record. The whole-task allowance is unavailable for exact native proposals, including
Console tasks whose existing permission setting is task-wide. Legacy sample controls
remain available and unversioned sample decisions are not automatically retried.

## M0/M1 gate matrix

| Requirement | Status now | Evidence and remaining boundary |
| --- | --- | --- |
| Canonical host and authority | verified | Existing Express host, Store, Work/native/team services and guarded writer reused. Fable document cache and slim session/SSE behavior retained. |
| F01 command identity and idempotency | verified for Work Start and native approval; partial overall | Concurrent/lost-response/restart tests, common command namespace, original Work digest regression. Composer and direct team entry points still need durable admission. |
| F02 actor, client and project scope | partial | Strict requests; forged actor/scope, foreign Host/Origin, missing mutation header and cross-project access refused. Real actor/device authentication is missing. |
| F03 admission before dispatch and recovery | verified for this slice; partial overall | Decision saved before writer; failed persist, unprepared acceptance, six process-crash phases and recovery latch tested. No general durable queue or automatic dispatcher. |
| F04 exact approval identity | verified for new native text proposals; partial across future adapters | Exact displayed proposal/action/base, one-hour expiry, async expiry boundary, immutable receipt, opposite decision, stale read-only source and journal linkage tested. Legacy samples retain their old behavior. |
| F05 guarded write journal | verified for supported text and tested outside conflicts | Exact bytes/receipt bound at preparation and recovery; damaged objects and tampered journal refused; binary/oversized/directory replacements preserved as conflicts. |
| F06 restore without Git | verified for supported text | Existing BOM/CRLF, newer-edit/force-restore regressions plus byte-exact restore in the real packaged approval smoke. Binary editing remains outside the writer. |
| F07 uncertain external effects | missing, intentionally deferred | No real external effect path added. Future consequential adapters require durable uncertainty and reconciliation before safe redispatch can be claimed. |
| F08 cancellation | verified for the existing bounded path | Full native tests retain stop/late-result behavior and cleanup. Cancellation is not reversal of completed effects or provider charges. |
| F09 engine/tool boundary | partial | Existing deterministic native/team boundary suite passes; real guarded native proposal verified. QUESTIONS O1 remains: team tool-host rejection is not a universal pre-execution veto. |
| Durable authorized event replay | missing | Existing durable History and receipt references support local resync. Ordered authorized cursors and authentication are prerequisites before M2 remote/phone readiness. |
| V01 compatibility/version handling | partial | Additive Need fields; legacy samples and unversioned Work starts retained; unsupported versions/corrupt durable receipts fail closed. Old native decision clients must refresh to send v1. Future incompatible schema migration still needs backup/rollback design. |
| V02 performance/lifecycle | partial, measured slice verified | No added timers/processes/dependencies; zero-IO approval replay; bounded receipt metadata; built bundle, directory and capacity measurements below. Large retained state and multi-project/error-path cost remain scale limits. |
| V03 desktop/UI | partial, selected surfaces verified | 19 built-browser tests, packaged smoke, actual native packaged approval/restart/restore and primary visual inspection. No claim of complete keyboard/assistive technology, 150% scaling, phone or long-transcript proof. |

## Verification and bug fixes

All commands below ran in the isolated approval checkout. Logs under `output/approvals`
are ignored local evidence. The durable
[`approval-verification.json`](../../evidence/approval-verification.json) binds 68 source
files, logs, screenshots and package hashes to these checks. Historical proof files keep
their original scope; `native-work-proof.json` is the inherited earlier run, not a new
run of its updated script.

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline deterministic tests | PASS: 278 | `output/approvals/baseline-tests.log`, before continuation changes. |
| Full deterministic suite | PASS: 361 tests, 14 files, 86.24 s | `node node_modules/vitest/vitest.mjs run --maxWorkers 2 --no-file-parallelism`; `full-tests.log`. Includes 46 approval host/crash tests, 36 approval client tests, 33 Work admission tests and 45 native Work tests. |
| TypeScript, production client, Windows package | PASS | `npm.cmd run build`; `build.log`. Electron 44.2.0 package created successfully. Final `npm.cmd run check` also passes after smoke-script edits. |
| Built production browser suite | PASS: 19 tests, 29.4 s | `node node_modules/@playwright/test/cli.js test --config output/approvals/playwright-built.config.ts`; `browser-tests.log`. Independent Edge profiles; test model/catalog fixtures. |
| Existing packaged desktop smoke | PASS | `node scripts/desktop-smoke.mjs`; `desktop-tests.log`, refreshed `evidence/desktop-proof.json`. Both Work surfaces recover lost responses; isolation, 1.24x font scaling, close/service stop/data-lock release and restart verified. |
| Real native packaged approval | PASS: exactly one generation | `node scripts/approval-desktop-smoke.mjs`; `approval-desktop-tests.log`, `evidence/approval-desktop-proof.json`. Requested Luna low, runtime verified `gpt-5.6-luna`, pinned runtime 0.153.4. |
| Artifact/source parity | PASS | Packaged client bytes equal the production browser-tested bundle. Packaged server equals a fresh esbuild of current source using packaging options; packaged desktop main equals source. Hashes in verification JSON. |
| Independent review and root reconciliation | Three defects fixed; no new P1/P2 in final review | One Astra report, primary failing regressions then fixes, Muse final read-only review. Agent review is static evidence; the primary test runs provide behavioral proof. |
| Patch and source hygiene | PASS | Both patches pass apply checks at their intended bases; `git diff --check` passes through temporary indexes. Main remains at `218f325` with only its pre-existing packaging edit. |

The one-time Astra review identified three concrete issues that were reproduced before
fixing them:

| Finding | Fix and regression evidence |
| --- | --- |
| P1: expiry could pass during asynchronous base validation, then an expired receipt could be stored | Admission now obtains, checks and records one synchronous decision timestamp. The controlled boundary test failed with HTTP 200 instead of 409 before the fix and passes now. |
| P1: a failed journal recovery could allow newer successful metadata to be erased by later recovery | A recovery-required latch runs repair/reload before subsequent locked operations. The new task-create regression failed with HTTP 200 during the unresolved fault before the fix; now it refuses until repaired, and later successful work survives restart. |
| P2: an outside binary/oversized/directory replacement could keep startup recovery from completing | Known unsupported target replacements become explicit preserved conflicts. Parameterized process-crash fixtures verify preservation, first/second restart and receipt replay; ordinary unexpected IO still fails closed. |

Red-phase evidence is retained in `recovery-regressions-red.log` and
`crash-tests-initial.log`; the final full suite passes these regressions. Recovery also
rejects a tampered prepared action, a missing approval link, a mismatched receipt and
damaged content-addressed bytes before writing. Repairing a damaged fixture object allows
recovery to finish with the original receipt and exact intended bytes.

Process exit tests cover before decision, after persisted decision, prepared journal,
first applied file, all applied files and finalized state (child exits 80-85). They verify
no automatic model resend, at most the original local write transaction, stable receipts
and a second restart. Separate tests cover grant/decline races, opposite decisions,
storage failures, changed payloads, stale selected sources, backwards time, unsupported
versions and corrupted durable state without rewriting it.

Browser coverage drops the first approval response in Workbook, and both responses in
Console followed by reload reconciliation. It tests pending storage, corrupt-storage
reporting, exact decision details and no horizontal overflow. Native generation in those
tests is injected. The separate real packaged run performed one genuine Luna generation,
lost its first approval acknowledgment, retried the identical command, restarted the app,
replayed without a new run/write and restored the original bytes. It used only its own
synthetic project/profile and the existing native sign-in, with no credentials copied.

Original and restored SHA-256 in that real packaged run:
`d359422d94ff64f54a3420d8fc1bb32c9bc54f8ba36d1bd6fbd1df02059a0e9e`.
The primary agent inspected the actual packaged Workbook proposal and expanded Console
Decision record in `evidence/screenshots/approval-desktop-workbook.png` and
`approval-desktop-console.png`. No page errors were recorded. The package is at
`release/Diomedes-win32-x64/Diomedes.exe`; keep its release folder together.

The separate older native smoke script and real team smoke were updated for the v1
decision protocol but were not independently run with additional real model calls in
this slice. Native/team deterministic tests pass; the new packaged smoke supplies fresh
real native approval evidence. It does not establish a new real team-tool-host guarantee.

## Performance evidence and limits

[`approval-performance.json`](../../evidence/approval-performance.json) records exact
bytes and measurements. The client comparison uses the same installed dependencies and
the previously verified post-Fable and foundation production bundles.

| Measurement | Result |
| --- | --- |
| Production JS entry, post-Fable `218f325` | 306,872 bytes; 92,198 gzip bytes. |
| Production JS entry, inherited Work foundation | 311,395 bytes; 93,873 gzip bytes. |
| Production JS entry, this continuation | 319,840 bytes; 95,812 gzip bytes. Continuation growth: 8,445 raw / 1,939 gzip bytes, +2.07% gzip. Both slices combined: +3,614 gzip bytes, +3.92%. |
| Cached project state with 3,000 files | 14 ms in the final deterministic suite. |
| Work command replay | 50 requests in 111.5 ms in the final full suite; no scans, document reads, persistence or additional adapter calls. This is not a controlled comparison with the prior 52.2 ms run. |
| Approval replay at 1,024 decisions | 50 requests for the last retained receipt in 57.2 ms; zero project scans, document reads and persistence writes. |
| Capacity metadata | 1,421,150 bytes for 1,024 approval identity/receipt/execution records; full synthetic persisted state 3,225,268 bytes, including existing Need previews and other state. |
| Rejected commands at capacity | Separate one-project probe: 10 conflicts averaged 50.6 ms, range 45.6-76.6 ms. Each reloads/validates persisted metadata; zero document IO is not zero metadata IO. |
| Full HTTP state at capacity | Ten warmed reads averaged 62.6 ms, range 54.1-72.3 ms, including receive/parse. Payload 3,231,009 bytes. Metadata initialization measured 107.7 ms. |
| Added lifecycle/dependency work | No new dependencies, timers or background processes. Receipt reconciliation adds no network request to the existing state refresh. |

Receipts are capped separately at 1,024 Work and 1,024 approval receipts per project.
Known replay remains available at the limit; new admission is refused and receipts are
not silently evicted into executable keys. A future retention/pagination design must
preserve spent-command identity. Closing or clearing a browser session can remove client
pending identity; cross-device or browser-lifetime deduplication is not claimed.

The retained full Need previews and receipts are still included in routine state. The
3.23 MB capacity response is an explicit remaining scaling limitation. Rejected locked
commands reload and validate every registered project's metadata, including proposal
hashing. The extra probe covers one project only. Neither case should be advertised as
a general low-latency guarantee. Large transcript/multi-project scale, long-lived idle
CPU/RAM, event-log growth and a complete desktop resource budget remain unmeasured.
This slice does not claim to fix all existing app slowness.

## Architecture decisions and next slice

The requested layers are responsibility boundaries within the current host:

| Responsibility | Current placement and future boundary |
| --- | --- |
| Desktop | Workbook/Console render Need, receipt and execution truth; client retry storage is not the approval authority. No new visual system or runtime-driven animation was introduced. |
| Core | Existing native/sample adapters retain model/context/capability semantics. Requested configuration and runtime-verified model identity remain distinct. |
| Runtime | Store serialization, command primitives, receipts, journals, cancellation and recovery own durable execution identity. Future deterministic workflow steps, checkpoints, scheduling and workers should use this authority. |
| Trust | Host/Origin/client/project guards, strict schemas, exact approvals and guarded paths enforce current policy. Authenticated actors, narrower worker credentials, revocation and information-flow rules remain later work. |
| Observatory | Command/Need/run/decision/write IDs, observable events and content hashes form traceable evidence. No private reasoning is recorded and no evaluation/optimization platform was added. |
| Interop | The existing native and team boundaries remain bounded. MCP, MCP Apps, ACP, A2A and external APIs/events are distinct future integrations, each subject to runtime identity and policy. |

No speculative middleware/workflow framework was built. The two passing concrete command
families justify the shared primitives; larger abstractions should follow another real
path. Local write recovery is not reused as an invented external success guarantee.
When a consequential external adapter exists, prepare/dispatch/confirmation/uncertainty
and reconciliation must be durable, with no blind retry after a lost acknowledgment.

The next smallest implementation slice is durable admission for the existing composer
send path, followed by direct team entry points using these same primitives. Preserve
thread, source, requested mode/model and context identity; test lost response, changed
payload and restart without duplicate model dispatch. Measure state growth and rejected
admission cost while extending that path. Authenticated durable event replay/cursors
must follow before remote/phone readiness. Broader M1 still precedes M2 and recorder,
workflow-builder, cloud-worker, MCP Apps, A2A and automatic optimization implementation.

Remaining proof boundaries also include physical power loss (tests use process exits and
IO injection), arbitrary outside-process filesystem races between final checks and atomic
replacement, unsupported binary editing, and actual remote actor/client isolation. The
current text writer is not a cross-process filesystem transaction or a remote service.

Proposed commit: `Add exact approval receipts and journal-linked recovery`.
The [full changed-file list](2026-09-08-approval-files.md) includes both this continuation
and the inherited uncommitted foundation needed for a combined review. Committing remains
the owner's checkpoint.
