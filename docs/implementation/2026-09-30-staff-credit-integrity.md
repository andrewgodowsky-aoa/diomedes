# DIO-132: staff credit corrections and allocation receipts

Prepared for review, 2026-10-01 UTC. Uncommitted and unpublished; no deployment,
database role, secret, customer balance or billing-plan change was performed.

## Verified scope and baseline

Application base: `5f97d97e61300c08002d7767bbbb179c1882a5fc` (fresh `origin/main`).
Operations companion base: `d4bae6674c508127363591d3f83b4b275b8b3f56` (fresh
`origin/main`). Both branches are `feature/staff-credit-integrity`, in isolated
Windows worktrees. Original dirty checkouts and other lanes were preserved.

Work order: feature `staff-credit-integrity`, prompt `DIO-132`; owner Andrew's
delegated GPT6.1Sol xhigh Windows lane, thread
`01a0f4ac-2870-70c6-874f-00f0de04d009`. Application worktree:
`F:/Diomedes/diomedes-wt/staff-credit-integrity`. Operations worktree:
`F:/Diomedes/diomedes-ops-wt/staff-credit-integrity`.

The current DIO-132 description matches the code. The Worker constructed the
CommercialService's funding adapter with `DATABASE_URL` (`cp_runtime`), whose
credit permissions are read-only. The gateway's `cp_funding` correctly lacks
staff correction and top-up writes. Giving either login extra writes would also
expose the existing `addFunding` random-per-call adjustment ID and separate audit
transaction. Grant allocation likewise committed before its audit.

Open application PRs 179, 180 and 181 were checked before editing. PR 180's
Individual funding scope excludes DIO-132, and PR 181's automation work is
separate. No duplicate staff correction implementation was found. The three
canonical repository mirrors read for this lane are version **2026-09-27.2**.
This record does not claim the issue is shipped or DONE.

## Bounded implementation

`CommercialService.addFunding` requires a bounded `requestId`. Its adjustment
and audit IDs are SHA-256 hashes of the operation, authenticated person,
organization and caller request ID. The authenticated actor is never accepted
from the request body. Under the shared staff lock, the service rechecks current
operator authority, verifies the organization and takes its funding lock.

Credit insertion and the immutable audit receipt share one client, transaction
and commit through `StaffFundingRepository`. Replays validate the receipt's
actor, organization, request and terms and return the original adjustment,
including its original month. Changed terms return 409. An adjustment without a
matching receipt fails for reconciliation rather than adding credit again.
Concurrent replays serialize; an audit failure rolls both writes back. A lost
commit acknowledgement can be retried with the same request identity.

The production factory uses only a separately validated
`STAFF_FUNDING_DATABASE_URL` naming `cp_staff_funding` on the same database and
endpoint as the runtime URL. Missing or invalid configuration refuses corrections
with `staff_funding_unavailable`; there is no write fallback. The SQL template
allows SELECT on operators, organizations and feature grants, and SELECT/INSERT
on credit periods, adjustments and Operations audit. It grants no top-up,
reservation, settlement, credential, grant-mutation, UPDATE or DELETE authority.
Existing `cp_runtime` and `cp_funding` grants are unchanged. The template was not
applied to any deployed database.

Optional grant credit allocation now rechecks staff and the active grant and
commits its credit period with its allocation audit. Grant issuance and its own
audit retain their existing transaction and optional-allocation failure response.
The whole grant endpoint is not made request-idempotent by this patch.

Operations persists a correction identity and terms before POST, scoped by
backend, authenticated staff person and customer. A failed or uncertain reply
retains the request across reopening; changed terms require resolving that
request first. Only successful acknowledgement clears it. Inputs are validated
before persistence. Tokens remain in the existing main-process boundary.

## Verification and limits

Evidence is in `evidence/dio-132/`:

| Check | Result |
| --- | --- |
| Initial staff regression red run | 7 failed, exposing retry identity, missing key and split allocation/audit defects |
| Final focused control-plane run | 7 files passed; **105 passed, 5 skipped**, zero failed |
| Operations retry helper | **6 passed**, zero failed; its new input-validation regression failed before the fix |
| Full application suite | 519 files passed; **8,646 passed, 5 skipped**, zero failed |
| Full control-plane suite | 48 files passed, 4 skipped; **744 passed, 45 skipped**, zero failed |
| Full Operations suite, including faux HTTP integration | 6 files passed; **35 passed**, zero failed |
| Required UI/native UI/field Playwright | **36 passed**, zero failed |
| Application and Operations Vite builds | Passed |
| Application root, control-plane and Operations typechecks | Passed |
| Tracked and new-file patch whitespace checks | Passed |
| Real PostgreSQL role cases | **5 skipped**; no disposable local PostgreSQL runtime was available |

Initial broad verification was blocked by another live lane's shared heavy slot.
After that lane released it, the coordinator granted this lane
`slot_muoskqr0_398cca2f`. All available broad checks above then ran once in
sequence, and this lane released the slot immediately afterward. The 45 skipped
control-plane tests include the five DIO-132 database cases; they are not counted
as passes. The focused and full-suite totals are separate runs and are not summed.

The production Worker factory tests inject authenticated faux accounts and a
recording Neon client. They prove URL selection and shared SQL transaction
protocol, not PostgreSQL privilege enforcement. The opt-in database harness
requires a loopback-only `dio132_validation_*` database and explicit reset flag;
it creates unique disposable login roles, applies migrations 001–010 and the
reviewed templates, and exercises real role refusals, concurrency, rollback,
lost commit acknowledgement and allocation/audit consistency. Authentication in
that harness remains faux. These real database cases have not been executed.

The remaining publication check is the real-role run, followed by Andrew's
exact-patch approval. PR 180 must be
composed and reviewed separately; no Individual migration, billing redesign or
automation change is included. Server and Operations API changes need coordinated
rollout: old callers without `requestId` receive 422. The new restricted login
and Worker configuration need a separately approved operational rollout; until
then production staff corrections refuse explicitly. The existing shared staff
lock serializes staff correction transactions and may constrain throughput.

The Operations browser preserves one unresolved correction per scope and refuses
changed terms. Resolving a permanently refused or corrupted saved request is a
manual reconciliation task; this patch adds no cancellation or recovery UI.
It does not infer that separate browser tabs or different actors represent the
same human intent when they submit different request IDs.
