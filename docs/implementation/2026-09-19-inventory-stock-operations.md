# MI03 pure stock-command preparation

Candidate subset only, at base `80263205133c410d590549efd1c8f40cedf33b1c`.
Consumes the exact nine-file MI02 review tree
`536a0c3a32300b020de60307cec489186cfb5e96`, release
`MI02-pure-records-v1`, contract version 1 / revision 2026-09-19.2.
All predecessor files are unchanged. This is not full MI03 acceptance.

## Implemented boundary

`server/inventory/commands.ts` exposes `prepareInventoryCommand(document,
untrustedIntent, hostContext)`. `server/inventory/ledger.ts` validates and
reduces the proposed contents of one future existing-Store text document.
Neither module opens files, writes state, calls a model, admits work, resolves
authority or registers a route/service. A typed context is not authentication.

The document holds catalog balances, append-only operation intent, receipt and
before-image records together. A transfer returns one complete proposed
document. Both endpoint versions are checked; no intermediate debit is exposed.
The result is `prepared` with expected document version and semantic digest,
or `recorded-match` with the original supplied receipt. Neither means applied,
durable or authorized. Both require fresh host authorization before any future
effect or disclosure of a saved receipt. A proposal is not a replay capability.

Host context supplies scope, person attribution, current time, document and
endpoint versions, receipt ID and a proposed History linkage. The strict client
command admits none of those authority fields. Parsing preserves complete
intent, including reason/job/correction/count evidence and both expected
versions. Same operation ID with any changed intent, actor or scope refuses.
The planner never retries an effect or interprets an unknown outcome as failure.

Quantity operations use safe integer minor units with exact item unit/scale.
Receive and transfer additions check overflow before constructing a result.
Use/transfer/absolute targets cannot undercut known reservations. Unknown
on-hand permits an absolute count/adjustment, but not arithmetic. Unknown
reservations explicitly refuse all stock preparation under this conservative
initial policy. Read-only/untracked catalog data still retain null; they are
never converted to zero. A different untracked-reservation write policy needs
its own review.

Adjust is an absolute target with a reason, as MI00 specifies. Record-count
requires evidence later than the prior physical count, at or after the current
record observation and last movement, and no later than host time. A count
changes physical-count evidence without inventing a movement. Other operations
retain count and source provenance; old evidence is not made fresh by a use or
receive. Before-images and the full intent preserve superseded count evidence.
An absolute adjustment that leaves the quantity unchanged appends its receipt
without inventing a new movement timestamp.
The stricter current-observation condition applies to this proposed stock
transition; MI02 opening-count intent preparation is unchanged.

Corrections name an existing receipt and append a reasoned exact inverse:
receive/use reverse one another; transfers reverse endpoints; adjust/count can
be restored by adjust only if the prior amount was known and the target version
has not changed since that receipt. A receipt can be corrected once. These are
domain compatibility checks, never authorization for a correction. Arbitrary
history links and compensation that overwrites intervening absolute stock are
refused. Existing records are never rewritten or deleted.

The document validator checks receipt/intent/scope consistency, arithmetic,
prior-record continuity, current balances against final receipts, correction
references, monotonic event times and non-reused document/location versions.
Operation, receipt and History identities cannot collide within the document.
Schema validation cannot establish that supplied records actually came from
Store; trusted current reads are a separate host responsibility.

Limits preserve MI02 catalog ceilings and cap operation history at 10,000.
The whole minified JSON document, including full intent, receipts and prior
images, must fit the existing Store `MAX_TEXT_BYTES` (8 MiB). An oversized
initial snapshot or proposed append refuses explicitly. No deduplication or
receipt eviction is implemented. An eventual archival design must retain
authoritative operation uniqueness/status; this work supplies none.

## Exact future host and sink integration plan (not implemented)

These anchors were inspected in the assigned baseline, not H07's unaccepted
worktree. H12 v3's accepted local `assertAuthorized` implementation was read
from its frozen review files only. No H12 or H07 code was imported.

1. **Resolve identity and target using existing owners.**
   `server/workspaces.ts` currently exposes `currentPerson()`, `organization()`,
   `membershipOf()` and the explicit output binding used by `briefTarget()`.
   Its default person has `development-fixture` assurance; it is not verified
   shared identity. `server/trust/authority.ts` owns `currentAuthority`, stored
   reference generation checks and the optional `TrustBackend`; absent resolver
   fails closed for production claims. B03/MI01 must provide verified session,
   current membership, organization tenant, pinned Project target and person
   mapping through these owners. Never derive person from a client field or
   substitute a Harness principal string for a person without that mapping.
   Stock read/write/correction policy must resolve current item/location rights.

2. **Read and prepare under the existing single data owner.**
   `server/index.ts` and `desktop/main.mjs` take `claimDataFolder()` from
   `server/lock.ts` before startup. That process identity lock, plus
   `Store.locked()` in `server/store.ts`, is the present local ownership design.
   Read one guarded stock document with `Store.current()` through the existing
   Files/path checks. Keep its actual byte hash for `WriteInput.expected`;
   the planner's semantic digest and version are additional checks, not a
   substitute for that hash. Re-read/replan inside the admitted owner's critical
   section. An in-memory queue is not proof of multiprocess or hosted atomicity.
   H21/B01 must qualify their actual shared owner/CAS semantics separately.

3. **Bind stock identities to one recorded write.**
   `Store.writeRecorded()` currently clones Project state, checks file expected
   hashes, creates/merges a History entry, saves before/after objects, writes a
   prepared journal and applies files before persisting state. Use one stock
   document containing balances plus operation identity plus receipt, with
   `merge: false`; never separate balance and receipt writes. Stock operation ID,
   stock receipt ID and existing Store History entry ID have different meanings.
   History is not a stock-operation uniqueness authority. `Store.addEntry()`
   currently creates the actual History ID internally. Therefore the host cannot
   pass an invented History ID and claim it is linked. The Store owner must
   expose a narrow recorded preparation seam that allocates its actual History
   entry once and supplies the real ID while finalizing the document, expected
   bytes, admission and journal together. Atomically bind CAS, idempotency and
   the stock receipt at that owner; do not add a second inventory writer.
   Allocation in this pure context is only a proposal until that seam exists.

4. **Check authority at the actual effect and again on restart.**
   `Store.applyWrite()` runs a final path/hash check and optional `beforeEffect`
   immediately before `durableWrite()` replacement; `Store.recover()` examines
   prepared journals and rechecks current scope grants for existing authorized
   Need writes. Baseline generic writes do not constitute a stock authority
   path. The owner must bind fresh verified membership/target/stock capability,
   revocation and current run attempt to the actual single-document effect and
   journal recovery. The H12 local release's `RunService.assertAuthorized()`
   requires configured `authorizeStep` and checks owner/fence/lease/attempt and
   current host policy. A pre-handler check or old successful barrier cannot
   authorize the later rename or recovery. Preserve RunService/Store lock order;
   do not make its queued policy callback await a reentrant run mutation.
   H07 currently owns these sink files and its candidate is unaccepted; coordinate
   after its independent verdict instead of duplicating those changes.

5. **Qualify acknowledgement, replay and recovery.**
   Return applied/already-applied only after the actual owner proves the stock
   document, receipt/operation and recorded History/journal are settled. A lost
   response requires authorized status reconciliation by full identity at the
   same owner; uncertain effects never trigger automatic resend. Failed CAS
   returns a refreshable conflict and never silently retries against new stock.
   On restart the existing journal must reconcile the whole stock document and
   evidence using fresh authority before any dispatch. If it cannot prove the
   outcome, leave it uncertain and block further effects. Add actual owned
   process crash, data-folder contention, two independent worker, revocation
   during final write, changed-actor replay and recovery tests at this seam.
   A persisted RunService observation alone is not proof of stock completion.

Next executable integration: after independent MI03 pure review and acceptance
of the owning H07/H12/H21 subset, give the Store/Trust host owner the narrow
single-document recorded preparation/CAS/authority seam above. Integrate this
planner there with fresh host tests. B03 shared identity, routes, actual device
and operator proof retain their original gates.

## Verification and remaining gates

Focused public-interface tests cover all five commands, exact endpoint/unit
binding, malformed intent, integer limits, unknown quantities/reservations,
immutable inputs, replay identity, history continuity, corrections, count
chronology and the combined document/history size ceiling.

The explicit in-memory CAS fixture plans two four-unit uses from five at version
7. Its controlled replacement accepts one proposal, conflicts the other, and
leaves one unit and one proposed receipt. Fault fixtures before planning, after
planning and after replacement/before response show only whole old/new
documents and read-only reconciliation. These fixtures do not exercise Store,
disk, real recovery, native processes or physical devices.

The lane evidence directory records exact commands, current test counts, raw
hashes and patches. TypeScript passed under the shared slot. Final focused
verification includes the unchanged MI00/MI02 producer and independent suites.
The final combined run passed 309 tests in six files, with zero failed/skipped:
82 MI03 cases and 227 predecessor regressions. Formatting and final TypeScript
both passed; the no-op adjustment regression has preserved red-to-green evidence.
No full suite, Vite/browser/build, packaged/installed app, provider, deployed
service, physical device or human demonstration was run for this pure lane.

PILLAR IMPACT: deterministic inventory preparation and preserved evidence;
current identity/effect authority is deliberately left with its existing owners.
ROADMAP IMPACT: MI03 pure candidate prepared; full MI03 and MI-DEMO remain OPEN.
Independent MI03.R is pending. No main merge, commit, push, publication,
deployment, installation or website change. No application registration exists.
