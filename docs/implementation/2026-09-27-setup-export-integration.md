# Setup, export and coverage integration - 2026-09-27

## Work order and scope

Andrew authorized completing the lane handoff's suggestions, applying the Neon prerequisite,
and merging and pushing the result to main. This work integrates the existing bounded slices
from SC-2026-09-26.1. It does not mark the wider briefs or the Unified Execution Package DONE.

- Work item: SC-INTEGRATE.
- Owner: Codex; coordination reviewer seat `astra`, session process 18712.
- Branch: `feature/setup-export-integration`.
- Worktree: `F:/Diomedes/diomedes-wt/setup-export-integration`.
- Integration base: `8daf0c1ac010e4335dd5105e18d860b6b4915460`, fetched main.
- Evidence directory: `F:/Diomedes/deliverables/setup-export-integration-20260927`.

| Included work | Source commit |
| --- | --- |
| Home link specifications repair | `f9553c9df9c0aa90d6a2ec05d3fef76e62fcfe3b` |
| Pillar amendments, PR 161 | `830fdc1122eaedcf5a980396286e097dfabf2fc4` |
| 80-brief source reconciliation | `62ef7cc49ac824e6ca4b7f02e9e02cafbb39025a` |
| ORG-01, organization-owned setup | `b8bd43392fa6e346c87d0e39a061b7531218d8e8` |
| ORG-02, incremental questions | `f97f62ed27d1d8b1cf0e9c6a7c3805ec7ec47d29` |
| OPS-05, owner export | `0bce9b9e134d87e27927df5404b0784a45a8123d` |
| DATA-01, coverage planner | `769cf5f225eb40770f06a9fb0756bccaa3d8ccec` |

All merges were conflict-free. ORG-01 and ORG-02 are composed into one candidate, so the
account service does not receive an intermediate release that discards earlier answers.
The individual lane records and the 80-brief inventory retain their historical findings;
their status paragraphs are superseded by this integration record and its publication evidence.

## Repairs made during integration

The live questionnaire now names Nectovia and ships schema revision 2. Its revision-1 carry
step records a wording-only change: no question is added, removed or given a new meaning.
Every existing answer retains its original prompt, value, author and timestamp. The frozen
revision-1 fixture still contains the original wording. The application regression exercises
an actual revision-1 owner answer resumed by a Manager and verifies both stored revisions.

DATA-01 preserves the supplied capitalization in its smaller-workflow and refusal messages.
The regression names `Toast tips`; the planner no longer changes it to `toast tips`.

Real PostgreSQL verification found that the setup-only advisory lock did not exclude a
membership change. Setup writes now take the same organization row lock as AccountService.
An independently connected transaction could acquire that lock before the repair; afterward
PostgreSQL refuses it with `55P03` while the setup transaction holds it. This uses existing
organization privileges and does not permit updates to stored setup revisions.

The database suite also exposed a settlement read that selected `rate_card_version` from a
table without that column. It now joins the immutable reservation on both tenant and
reservation ID. Real database readback verifies the retained period and rate-card version.
The older funding fixture was brought up to migration 005's feature-grant foreign key;
the cross-tenant refusal now references a real grant belonging to the other tenant.

An additional export regression switches from owner to Manager while the cloud response is
pending. The existing application check refuses the write and creates no export files.
No production export change was needed for this case.

The expanded browser run exposed an unrelated Ask test race: it pressed Enter while the
previous streamed answer still had Send disabled. The retained trace shows that exact
disabled state. The specification now waits for Send to become enabled before submitting
the next message, without changing application behavior or adding a fixed sleep.

The previously reported H03 failure also reproduced. Its trace shows Send again racing the
original interruption and receiving `SESSION_BUSY`. The test now waits until the command's
durable outcome says it was interrupted before testing replay and the next message. The
Stop acknowledgement alone only says that stopping was requested.

## Verification

The following results come from this combined worktree, not a sum of earlier lane runs.
Credentials remained in process environment variables and were not written into evidence.

| Check | Result | Evidence |
| --- | --- | --- |
| Root TypeScript | Passed | `typecheck.log` |
| Full root unit suite | 8,142 passed, 4 skipped; all 480 files passed | `unit-final.log` |
| Client build | Passed | `vite.log` |
| Required browser specifications plus repaired regression specifications | 63 passed, including all 36 required cases | `playwright-gates.log` |
| Control-plane TypeScript | Passed | `control-typecheck.log` |
| Control-plane unit suite | 619 passed, 34 skipped; 42 files passed, 3 skipped | `control-unit.log` |
| Worker build dry run | Passed | `worker-build.log` |
| Real PostgreSQL migration and behavior suite | 13 passed | `neon-migrations-final.log` |
| Real PostgreSQL restricted runtime role suite | 12 passed | `neon-runtime-role.log` |

The ordinary control-plane run skips tests that require an explicitly pinned database. The
two opt-in runs above separately qualify migrations, setup locking and history, funding
readback, setup/export access through the restricted login, and forbidden mutations.
Other historically pinned database suites were not redirected to a different database.

The initial expanded browser run finished with 288 passed, 3 failed and 19 not run. The
63-case qualification above passed all three required files plus the complete Ask,
Claude-controls and pack-lifecycle files. The two timing repairs are described above;
the pack installation passed unchanged after a transient Windows folder rename refusal.
The external acceptance record and integration PR carry the final expanded browser result.

Initial failures are retained in the evidence directory: obsolete funding fixtures, the
nonexistent settlement column, the independently reproduced membership-lock gap, and one
root assertion still expecting questionnaire revision 1. Corrected results are recorded
separately rather than treating any of those failures as passes.

## Neon prerequisite

The disposable branch was `br-billowing-mud-aep6ypto`, named
`setup-export-validation-20260927`, in project `small-wave-81999606`. Qualification used
the synthetic `b01_validation_setup_export` database. The copied `accounts_staging` database
then upgraded from migrations 001-007 to 008; a repeat migration applied nothing.

After those checks, the approved `accounts_staging` database on branch
`br-old-star-aepf7zk6` was pinned to
`ep-wandering-thunder-ae6gfq19.c-2.us-east-2.aws.neon.tech` and upgraded. The runner applied
only migration 008 and verified previous migration hashes. The only additional runtime grant
was `SELECT, INSERT ON control_plane.organization_setups TO cp_runtime`.

Post-change inspection confirmed read and append access, with UPDATE, DELETE and TRUNCATE
all refused by privileges. A repeat migration applied nothing. Evidence is in
`staging-before.log`, `staging-migration.log`, `staging-after.log` and
`staging-idempotent.log`. The disposable branch was deleted and the project branch listing
confirmed it was absent. No test reset ran against the shared staging database.

If application code must be rolled back, retain the additive table and its history.
Do not drop it or remove setup revisions as part of a code rollback.

## Product and publication boundaries

Core Pillars is 2026-09-26.1 after incorporating PR 161. Live Roadmap and Project Memory
remain 2026-09-25.2. This implements the existing direction in Pillars 03, 05 and 09:
honest input coverage, resumable setup, owner-controlled exit and durable attribution.
No new product meaning or permission expansion is introduced. Roadmap status is unchanged.

ORG-01 keeps questionnaire revisions in the account service. Configuration manifests and
other device-held export categories remain local. DATA-01 is still a pure planner; it is
not connected to readiness. Departmental capability packs are not part of this integration.

The source candidate and database prerequisite are distinct from publication. The integration
pull request and external acceptance record identify the final main commit, hosted checks
and Worker deployment. Browser tests use synthetic accounts. A successful Worker deployment
and unauthenticated route checks do not prove a signed-in installed-desktop journey.
No desktop package, installer or release is produced by this work.
