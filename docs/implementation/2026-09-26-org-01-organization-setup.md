# ORG-01 and SET-01: the business setup belongs to the business

Integration update, 2026-09-27: the [combined integration record](2026-09-27-setup-export-integration.md)
supersedes the verification and publication status below. This page preserves the original lane record.

| | |
|---|---|
| Briefs | ORG-01 (organization-owned configuration persistence) and the persistence half of SET-01 (adaptive intake), decision package SC-2026-09-26.1 |
| Branch | `feature/organization-setup`, worktree `F:/Diomedes/diomedes-wt/organization-setup`, from `c5eca16`, with origin/main `5d5a581` merged in |
| Migration | `services/control-plane/migrations/008_organization_setup.sql`, plus one grant in `scripts/runtime-permissions.sql` |
| Contract | `shared/organization-setup.ts` is the contract: the record, the service's screening and the one load decision. This page is its prose |
| Status | Built. Not merged, not deployed, and migration 008 is not applied to any Neon branch. See "State of this branch" for what has run |

Until now the intake was saved as one JSON file per business on the computer that answered it, at `<data>/workspaces/setup/<org>.json`. A second computer, an invited Manager or a new owner found no file and was asked the first question again. Now the account service keeps every revision of the setup for the business, and each computer keeps a tagged copy of it.

## What the account service keeps

`control_plane.organization_setups` holds one row per revision: `(tenant_id, organization_id, revision)` is the key, `record` is the setup as JSON, and `written_at` and `written_by` say who saved it. A trigger refuses every `UPDATE` and `DELETE`, so a correction or an owner transfer adds a revision and never rewrites one (decision 10: history is evidence). The record must name its own business and tenant (a `CHECK`), must be `v: 1`, and is at most 64 KiB. The Worker login `cp_runtime` may only `SELECT` and `INSERT` it.

Every call carries the person's bearer. Every refusal is `{ "error": "<one sentence>", "code": "<code>" }`.

| Method and path | Who | Answer |
|---|---|---|
| `GET /account/organizations/:id/setup` | Any active member | `{ organizationId, tenantId, revision, record, writtenAt, writtenBy }`. Revision 0 with `record: null` means nothing is stored yet |
| `POST /account/organizations/:id/setup` `{ expectedRevision, record }` | The Business owner or a Manager | `200` with the same shape for the new revision, `expectedRevision + 1` |

| Refusal | Status | Code |
|---|---|---|
| No bearer, or an ended sign-in | 401 | `sign_in_required` |
| Not an active member of this business | 403 | `not_a_member` |
| An Employee writing | 403 | `role_not_allowed` |
| A revision someone else saved first | 409 | `setup_conflict` |
| A record answered under earlier questions than the business's latest revision (added by ORG-02) | 409 | `setup_newer` |
| A record the schema refuses (extra fields, bad ids, over the bounds) | 422 | `invalid_setup` |
| The record names another business or tenant | 422 | `setup_wrong_organization` |
| An answer or question text that looks like a key, password or card number | 422 | `setup_secret_like` |
| A changed answer not given by the person saving, a new setup not started by them, or a change to who started it and when | 422 | `setup_attribution` |
| The millionth revision | 409 | `setup_revisions_exhausted` |

The service stores the record and does not interpret it. What each question accepts stays the desktop's rule (`validateAnswer`), so a new question set never needs a Worker deploy. There is no entitlement check: setting a business up is not the paid Agent (decision 14 applies the other way round too: a stored setup authorizes nothing).

Attribution is checked against the verified writer, never a field of the request. Unchanged answers keep whoever gave them, which is how an owner transfer leaves the previous owner's answers as theirs.

## What a computer keeps

```
<data>/workspaces/setup/<org>.json                  the setup, in the same shape as before
<data>/workspaces/setup/<org>.sync.json             { organizationId, tenantId, personId, generation, revision, fetchedAt }
<data>/workspaces/setup/<org>.before-sync[-n].json  a setup only this computer held, set aside
```

The setup file keeps its old shape on purpose: the workspace service loads it by organization id, and configuration activation compares against its answers. `server/organization-setup.ts` owns all three files.

Each time a signed-in business's setup is opened, `decideSetupLoad` decides what it is:

| The service | This computer's copy | Shown |
|---|---|---|
| answered | any | The service's revision, and the copy is replaced by it |
| refused (signed out, not a member) | any | The refusal. The copy is never used in its place |
| unreachable | tagged for this person, business, tenant and access generation | The copy, read-only, with the reason. Nothing can be saved |
| unreachable | anything else, or none | A load error. Never a blank setup |
| has no setup route (a Worker from before 008) | any | This computer's own setup, as before ORG-01 |

The access generation is this person's generation for the business on this computer. A role change or removal the computer has heard of bumps it, so a copy fetched before cannot be shown after, even offline.

A save names the revision its content was read with. The desktop holds the setup and that revision together in memory and reads them in one step, so a refresh landing between reading the setup and saving it cannot let a save overwrite what the refresh brought. A stale revision is a `409 setup_conflict`. The conflict carries what the business holds now, and the Console reloads to show the other person's work. There is no queue of offline edits that could win later.

### A setup saved before ORG-01

A setup file without a tag was saved on this computer before the service kept setups. When the service holds none for the business, the file becomes its revision 1, but only when the person opening it may configure the business, started the setup and gave every answer in it. The service's attribution check would refuse anything else anyway. Otherwise the file is set aside as `<org>.before-sync.json` (numbered if that name is taken, never overwritten) and offered again the next time its author opens the business. A file the service refuses to hold, for example one with a card number in an answer, is set aside and not offered again that run. An untagged file that differs from the business's setup is set aside before the business's replaces it. Nothing is deleted.

## Rollout and rollback

1. **Validate 008 on a disposable Neon branch first.** Run the two opt-in suites in `services/control-plane` against a `b01_validation_*` database on that branch:
   - `npm run test:postgres` (all eight migrations, then the setup table's compare-and-set, trigger, foreign key and checks);
   - then `npx vitest run tests/postgres-role-independent.test.ts` (the `cp_runtime` grant: setup rows can be read and appended, never updated or deleted).

   Each run needs these variables: `CP_TEST_DATABASE_URL`, `CP_TEST_ALLOW_SCHEMA_RESET=yes`, `CP_APPROVED_ISOLATED_BRANCH=yes`, `CP_TEST_BRANCH_ID` and `CP_TEST_EXPECTED_HOST`.
2. **Apply migration 008 and the `cp_runtime` grant to Neon before the merge.** A merge to main deploys the Worker. A Worker with the route but without the table fails every setup read, and the desktop shows that as a load error for every signed-in business. The desktop cannot tell that apart from an outage, and should not try.
3. A desktop build without ORG-01 never calls the route, so the Worker can ship first.
4. A desktop with ORG-01 against a Worker without the route gets the Worker's exact 404, "This account action was not found.", and keeps the setup on the computer as before. So the desktop can also ship first, and a Worker rollback falls back to local setups rather than to load errors.
5. Setups saved during such a rollback are local only. When the route returns, the business's revision wins, and a local setup that differs from it is set aside, not merged.
6. Rolling the table back is not supported. Revisions are append-only by design. Dropping the table loses every business's setup.

## Limitations

- **Configuration manifests are still per computer.** Only the questionnaire record (answers, state, cursor, proposal digest) belongs to the business. A proposal compiled or a configuration activated on one computer is not seen on another. That is the next slice, with ORG-02.
- **No drafting offline.** While the service can't be reached a copy is read-only. Offline drafting would need a merge rule for answers.
- **The copy is not encrypted.** It is plain JSON, like every other workspace file. Both the desktop and the service refuse credential-like answers, so it holds none.
- **An old setup moves only when one person wrote all of it.** A setup answered by two administrators on one computer before ORG-01 is set aside, and the business starts from its first question.
- **One Worker read per open.** Opening the setup always reads the business's current revision. An answer is saved against the revision held in memory and relies on compare-and-set rather than a read first.
- **Employees don't open the questionnaire.** The service lets any member read a business's setup. The desktop still gates the questionnaire to owners and Managers; an Employee sees where setup stands.
- **Not run on Cloudflare or Neon.** The Postgres adapter is checked for its SQL and its grants, both ways, against a recording client. The account service ran as the faux cloud in-process. The two opt-in PostgreSQL suites now carry ORG-01 cases (rollout step 1), but they have not run.
- **The local fallback depends on the Worker's exact words.** The desktop recognizes a Worker without the route by the 404 message "This account action was not found." That sentence is written separately in `services/control-plane/src/worker.ts`, `server/business/identity-host.ts` and `server/accounts/session.ts`. If the Worker's wording changes, that fallback becomes a load error. The failure is conservative: never a blank setup.

## Acceptance cases

| Case (ORG-01) | Where it is shown |
|---|---|
| Close and reopen, and a second computer signing in, do not repeat the intake | `tests/organization-setup-app.test.ts`: quitting and reopening; a second computer resumes |
| An owner transfer preserves the setup and its history | `tests/organization-setup-app.test.ts` and `services/control-plane/tests/organization-setup.test.ts`: owner transfer |
| A network failure is a load error, not an empty setup | `tests/organization-setup-app.test.ts`: a setup that cannot be loaded; `tests/organization-setup-sync.test.ts` |
| A stale copy cannot revive a revoked membership | `tests/organization-setup-app.test.ts`: a person removed, online or off; `decideSetupLoad` cases in `tests/organization-setup-sync.test.ts` |

The brief's builder prompt also asks for invitee entry. In `tests/organization-setup-app.test.ts`, "a Manager invited later" covers a person who was not a member when the owner answered. Before they accept, their computer refuses the business. After they accept the invitation in the account service, refresh and switch to the business, the intake continues from the owner's answers. Their answer then becomes the next revision, in their name.

SET-01's "resume and revise without losing original answers or conflating businesses": every answer keeps the words of the question it was given against (`BusinessAnswer.prompt`), every revision is kept, and a record naming another business is refused by the host, the service and the database.

## State of this branch

The integrating session ran these gates on 2026-09-26 in this worktree, on the whole branch with origin/main 5d5a581 merged in (b170347):

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (root) | exit 0 |
| `npx vitest run --maxWorkers=4` (root) | 473 files passed; 8,073 tests passed, 4 skipped; exit 0 |
| `npm test` (services/control-plane) | 40 files passed, 3 skipped (the opt-in PostgreSQL suites); 604 tests passed, 33 skipped; exit 0 |
| `npm run typecheck` (services/control-plane) | exit 0 |
| `wrangler deploy --dry-run` (services/control-plane) | bundles; one copy of zod; 1,257 KiB, 241 KiB gzipped |
| `npx vite build` | exit 0 |
| `npx playwright test` (all specs, which include the named gate) | 257 passed, 4 failed, 47 did not run, in 10.8 minutes. Every spec on this change's surfaces passed in full: `ui.spec.ts` 17, `native-ui.spec.ts` 11, `field.spec.ts` 8, `workspace-ui.spec.ts` 5, `configuration-ui.spec.ts` 3. The PNGs the run rewrote under `evidence/` and `docs/verification/` were restored |
| New tests | `tests/organization-setup-sync.test.ts` 25, `tests/organization-setup-app.test.ts` 8, `services/control-plane/tests/organization-setup.test.ts` 11, `services/control-plane/tests/organization-setup-postgres.test.ts` 7, the 008 case in `tests/migrations.test.ts`, and the opt-in ORG-01 cases above |

The four Playwright failures belong to main, not to this branch. They fail on origin/main 5d5a581 alone, which was checked in a separate worktree, with the same refusal on the page: "The Nectovia Agent works for a business. Switch to a business workspace that includes it…". The four are `diomedes-home.spec.ts:185`, `home-luna.spec.ts:232`, `artifacts-ui.spec.ts:1434` and `home-route-ownership.review-20260921.spec.ts:140`. Main's 5d5a581 made paid work need a project with a business owner, and these specs send on a Home that nobody linked. The 47 that did not run are the serial specs after those failures: `diomedes-home.spec.ts` 31 and `home-luna.spec.ts` 16. Before the merge, on c5eca16, this branch passed all 308.

Not run: the two opt-in PostgreSQL suites, which need an approved disposable Neon database. Both were stale on main: they expected 4 and 2 applied migrations. They now count the migrations themselves, and each carries an ORG-01 case. Also not run: anything on Cloudflare, and a packaged desktop build.
