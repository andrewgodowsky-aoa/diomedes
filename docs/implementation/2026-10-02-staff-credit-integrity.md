# Staff credit integrity on current main

Staff credit corrections now use a required request identity and commit the credit adjustment and audit receipt together through a dedicated, restricted database login. Operations retains the original request through uncertain replies and clears it only after validating the returned correction. This reconstruction is for app [PR 182](https://github.com/andrewgodowsky-aoa/diomedes/pull/182) and Operations [PR 8](https://github.com/andrewgodowsky-aoa/diomedes-ops/pull/8); it is source and local verification, with no deployment or live permission changes.

## Current bases and preserved behavior

The app was rebuilt on main `f72c6ace14c89201425e33f90fb096bdbdda8f4d`; Operations was rebuilt on main `e4fa25867b4b7191fda7344a78830a9529f942bf`. Both remote main heads were fetched again after verification began and remained unchanged. The old PR heads, `9dab598710321dbf415a17509f8e7bc88b06ab4b` and `2318cdb05e03b8b6113692fdd09f6f7e0bf4aad6`, supplied implementation history rather than validation evidence. Their obsolete screenshots and evidence files were not reconstructed.

Migrations 001 through 015, existing runtime and gateway grants, purchased-credit holds and purchases, member limits, and Operations monthly Individual terms are preserved. Permission changes in the existing SQL files are explanatory comments only. In particular, the current gateway's verified top-up INSERT authority remains permitted; it is not granted to the staff login.

The canonical pillar, roadmap and project-memory document versions remain `2026-09-27.2`. No roadmap status or shipped-capability claim changes. This slice advances scoped authority and truthful attribution through restricted-role refusal tests and atomic audit receipts.

## Correction and client contract

`POST /ops/customers/:id/funding` requires exactly `{ requestId, credits, reason }`. IDs match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, credits are whole numbers from 1 through 100000, and the trimmed reason contains 1 through 500 characters. The authenticated staff person, organization and request ID determine the adjustment and audit IDs. A successful response is the committed `CreditAdjustmentRow`, including the original month and timestamp on replay.

The transaction takes the staff lock, rechecks current staff permission, finds the organization, and takes its funding lock. Existing receipts must match the request terms and the complete correction record. Changed terms return `409 funding_request_conflict`; missing or inconsistent receipts return `409 funding_receipt_conflict`. Audit failure rolls back the correction. An uncertain commit can be retried with the original ID without adding another credit or receipt, including after a month boundary. Disabled staff cannot replay an earlier success.

`STAFF_FUNDING_DATABASE_URL` accepts only the reviewed `cp_staff_funding` login or suffix on the runtime database's Neon endpoint. There is no runtime or gateway fallback. The unapplied staff SQL template grants SELECT on operators, organizations and feature grants, and SELECT/INSERT on periods, adjustments and audit. It grants no UPDATE, DELETE, purchased-credit, member-limit, credential, reservation or settlement authority. Missing configuration refuses corrections with `503 staff_funding_unavailable`.

Grant issuance remains its own audited action. Its optional credit allocation and allocation receipt share a separate staff transaction, with current authority and grant state checked again. This slice does not make grant issuance idempotent.

Operations saves the request before sending and scopes it to the actual service URL, authenticated person and customer. Reloading or signing out retains unresolved terms. Changed terms are refused before another POST. A successful response must match the deterministic adjustment ID and correction fields before persistence is cleared; malformed successes remain unresolved. Customer-refresh failure after that acknowledgement cannot resurrect the request. Automatic bearer refresh retains the original body, stops across explicit staff/service changes, and cannot adopt a late refresh into a new sign-in. Tokens and staff keys remain in the main process.

## Verification on October 2 2026

All results below are fresh runs on the reconstructed source, on macOS arm64. Focused results are subsets of the broader suites and are not added to their totals.

| Gate | Result | Local evidence |
| --- | --- | --- |
| Staff HTTP, customer access and worker funding | 54 passed, no skips | `server-green.log` |
| Restricted PostgreSQL staff suite | 9 passed, no skips | `postgres-focused.log` |
| Full control-plane units | 976 passed, 55 skipped; 54 files passed, 5 skipped | `control-plane-unit.log` |
| Control-plane typecheck and Worker dry-run build | Passed | `control-plane-typecheck.log`, `control-plane-build.log` |
| Root typecheck and build | Passed with a 4 GiB Node heap | `root-typecheck.log`, `root-build.log` |
| Root units | 8983 passed, 32 skipped; 540 files passed, 2 skipped | `root-unit-final.log`, `root-unit.json` |
| Required root UI, native UI and Field browsers | 36 passed, no skips | `root-browser.log` |
| Operations units against this exact app checkout | 55 passed, no skips | `operations-unit-final.log` |
| Operations typecheck and build | Passed | `operations-typecheck.log`, `operations-build.log` |
| Operations correction browser | All 8 checks passed | `operations-browser.log` |

The local PostgreSQL 18.0 instance listened only on loopback and used an owned disposable database. The harness migrated all 15 current migrations, created unique restricted roles, and removed its schema and roles after testing. Five cases exercised actual PostgreSQL privileges, concurrent replay, audit rollback, a lost COMMIT acknowledgement, and allocation/audit consistency; the other four checked configuration and SQL protocol. Authentication in these cases used the faux account service, not live staff authentication. The 55 control-plane skips belong to other opt-in integration suites; the 32 root skips are mostly Windows cases. They are not passing coverage.

The browser used the built Operations page and its real local bridge against this app's faux handler. It lost a reply after a committed correction, reloaded the page, refused changed terms, switched staff, returned a malformed successful replay, retried the original ID without duplicate credit/audit, failed a customer refresh after valid acknowledgement, and checked Support's read-only controls.

Local logs are retained in the worktree's ignored `.superpowers/staff-credit-current/` directory. Reproduce the PostgreSQL suite only with `DIO132_TEST_DATABASE_URL` pointing at an explicitly disposable loopback `dio132_validation_*` database and `DIO132_TEST_ALLOW_RESET=yes`. Operations tests and `node tests/funding-browser.mjs` require `NECTOVIA_APP_REPO` to name this rebuilt app checkout; run its build before the browser script. The root browser suite requires a fresh root build. No test used live permissions or real credits.

## Fresh review and publication boundary

An independent source review examined both reconstructed diffs and reported no outstanding actionable findings after fixes. Its acknowledgement finding was demonstrated by 13 failing regression cases before implementation and passing cases afterward. Three staff/service refresh races likewise failed before the context guard and passed afterward; a same-context refresh case verifies the retained body. The reviewer read the regression and browser fixtures but did not execute the gates.

The intended publication is the two existing PRs ready for review. The staff SQL remains a review template and the configuration is not activated. No merge, service deployment, release, or live database permission application is included. Windows execution, packaged Electron acceptance and live authentication remain outside this local verification.
