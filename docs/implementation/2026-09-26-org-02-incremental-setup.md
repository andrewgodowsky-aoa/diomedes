# ORG-02: a business setup survives a change in the questions

| | |
|---|---|
| Brief | ORG-02 (incremental configuration and schema migration), the questionnaire half, decision package SC-2026-09-26.1 |
| Branch | `feature/incremental-setup`, worktree `F:/Diomedes/diomedes-wt/incremental-setup` |
| Base | `feature/organization-setup` at `b8bd433` (ORG-01). This branch is stacked on ORG-01 and merges after it |
| Contract | `shared/setup-question-changes.ts`: the change table, the carry and the plan a person reads. This page is its prose |
| Status | Built. Not merged and not deployed. Needs no migration. One account-service refusal is added, so the Worker changes |

The intake's questions carry a revision, `BUSINESS_SETUP_SCHEMA_REVISION`, which has always been 1. Before ORG-02, a desktop that opened a setup saved under any other revision treated it as stale. Resuming it replaced every answer with none and saved the result.

For a setup saved by a newer build, that was destructive. Once the account service keeps each business's setup (ORG-01), a desktop still on an older build would have emptied the business's current setup for everyone. The service keeps every revision, so the answers would not be lost. But the live setup would be blank, and the next person to open it would be asked everything again.

## What a desktop does with a setup now

Each stored setup is read through the H21 migration framework against the questions this build asks (`readSetup` in `server/workspaces.ts`):

| Saved under | Shown | Resume | Answer, back, compile |
|---|---|---|---|
| This build's questions | As before | As before | As before |
| Earlier questions (`stale`) | What resuming keeps, asks again, asks new and no longer asks, each with why (`carry`) | Carries the answers across, then asks only what changed | `409 stale_setup` until resumed |
| Newer questions | "Saved by a newer version of Nectovia. Update Nectovia on this computer to continue it." No answers are shown, because this build cannot say what they mean (`unreadable`) | `409 setup_newer`, nothing written | `409 setup_newer` |
| A revision no build carries (below 1, not a number, or older than the oldest this build reads) | "Saved in a form this version can't read" | `409 setup_unreadable`, nothing written | `409 setup_unreadable` |

The workspace list says the same in one line: `questions` on a business's setup summary is `earlier`, `newer` or `unreadable`. A setup this build cannot read is never offered as resumable, and "Review the setup" waits until a setup saved under earlier questions has been resumed.

## Carrying answers across

Every revision of the questions after the first declares what changed from the one before it, in `QUESTION_SET_CHANGES`:

- `added`: new questions, which are asked;
- `changed`: questions whose meaning or accepted answers changed, which are asked again;
- `removed`: questions no longer asked.

Each entry says why, in words a person reads before resuming. A question the entry does not name is carried as it is. The entry must therefore name every question whose meaning changed, not only the reworded ones.

Resuming carries each untouched answer exactly as it was given: the same value, words, person and time. A carry step changes only the answers and the revision. The resume that runs it then sets the state, the cursor and the proposal from the current questions, so nothing reads a carried record any other way. Answers are never reinterpreted, and nothing is invented to fill a gap. An answer under a new question's id is not carried into it, because it belongs to something else.

Because a carried answer is byte for byte what was stored, ORG-01's attribution rule treats it as unchanged. A Manager can resume the owner's setup, and the answers it keeps stay the owner's.

The answers that are not carried are not deleted:

- for a business the account service keeps, they stay in the earlier revision;
- for a business kept only on one computer, the file as it was is copied beside itself first (`<org>.json.v<n>.<digest>.bak`, the H21 backup name) and never removed automatically.

The shipped table is empty. Revision 1 is still the only revision of the questions. The next revision adds its entry, `{ from: 1, ... }`, in the same change that raises `BUSINESS_SETUP_SCHEMA_REVISION` to 2 and edits `BUSINESS_QUESTIONS`.

`tests/setup-question-changes.test.ts` pins a fingerprint of what the revision 1 questions accept: ids, kinds, whether each is required, option ids, whether "other" is allowed, length limits, and which questions are conditional. Prompts and reasons are left out, since rewording a question does not change what its answers mean and each answer keeps its own words. If the fingerprint fails, someone changed what a question accepts. They then decide whether stored answers still mean what they meant (update the fingerprint), or not (raise the revision and add a change entry).

## H21

`server/migrations/registry.ts` registers two families:

- `business-setup` (`workspaces/setup/*.json`, version field `schemaRevision`, current `BUSINESS_SETUP_SCHEMA_REVISION`, oldest 1): the steps are built from `QUESTION_SET_CHANGES`, so a table with a gap fails `familyProblems` in `tests/migrations.test.ts`. A golden fixture of a real revision 1 file (`tests/fixtures/migrations/business-setup.v1.json`, including one answer saved before answers kept their question's words) reads as current.
- `business-setup-tag` (`workspaces/setup/*.sync.json`, ORG-01's copy tag): listed with its own reader, which refuses any `v` but 1.

The setup's own `v` field is its envelope, which the account service holds at 1. It is not the questions' revision.

## The account service

The service still stores the record without interpreting it. One structural rule is added in `services/control-plane/src/organization-setup/service.ts`: a write answered under earlier questions than the business's latest revision is refused, with `409 setup_newer` and nothing written. A desktop with ORG-02 refuses before it sends anything. The rule is there for any desktop that has ORG-01 without ORG-02, so a build too old to read a business's setup cannot empty it.

## Configuration

Compiling a proposal now refuses a setup saved under other questions (`server/configuration-routes.ts`): `stale_setup` until it is resumed, `setup_newer` or `setup_unreadable` otherwise. A proposal is only ever built from answers given under the questions this build asks.

Nothing else about configuration changed. The active configuration stays active until a new one is activated, and the change list marks each field `new`, `inherited`, `changed`, `removed` or `unsupported` against the previous proposal. Both existed before ORG-02, and the carry test runs through them.

## Acceptance cases

The brief's four cases, and where each is shown:

| Case | Where | What is shown |
|---|---|---|
| Adding HR leaves accounting configuration unchanged | `tests/incremental-setup-carry.test.ts`: "the active configuration stays active…" | **Departments do not exist yet (DEPT-01), so this is not shown as written.** The closest structure is shown: after activation, the questions change and one answer is revised. The new proposal marks the budget `changed` and every other field `inherited`, and the revision 1 configuration stays active until the new one is activated |
| A new required field prompts only affected administrators | The same test, and "a Manager resumes the owner's setup…" | After a carry, the next question is the first changed or new one; answered questions are not asked again. Only owners and Managers are asked; an Employee sees that setup is waiting and is asked nothing. "Affected" means every administrator of the business, because there is no per-department scope to narrow it |
| A failed migration keeps the previous working revision | `tests/incremental-setup-app.test.ts`: "a setup a newer version saved is refused…"; `tests/incremental-setup-carry.test.ts`: "a carry that fails writes nothing…"; `tests/workspaces.test.ts`; the service test in `services/control-plane/tests/organization-setup.test.ts` | Every route refuses a newer setup and no revision is written. A carry that cannot run writes nothing, keeps no backup, and leaves the active configuration active. The service refuses a write that would take a setup back to earlier questions |
| A concurrent change conflict is visible without silent overwrite | `tests/incremental-setup-app.test.ts`: "two computers resuming at once…" | Both computers read the same revision before either saves. One resume is saved; the other gets `409 setup_conflict`, and both then show the saved one |

The carry itself runs as the build that ships revision 2 would run it. `tests/incremental-setup-carry.test.ts` uses `vi.mock` for a revision 2 build with a sample change table: the spending cap asked differently, the first-run question new, and a fax-number question no longer asked. It covers a business kept on one computer, with its configuration, and a business the account service keeps.

## What this does not do

- **No real revision 2 of the questions ships.** The builder prompt asks for "one questionnaire migration". The migration mechanism ships and is proven with a sample revision 2. Changing the questions customers answer is a product decision that has not been made, and shipping one to exercise the mechanism would ask every business to resume.
- **No department extension.** The prompt's "department-extension scenario" needs departments, which do not exist (DEPT-01).
- **Configuration manifests are still per computer,** as ORG-01 left them.
- **A setup no build can carry is a dead end on that computer.** A setup saved under a revision this build does not carry is refused, and nothing offers to start over. Starting over would put a blank setup in front of the business's record. Today no path produces one: the service refuses revisions below 1, and every desktop writes 1.
- **Older desktops in the field.** A desktop without ORG-01 keeps setups on its own computer, so a newer setup cannot reach it. A desktop with ORG-01 but without ORG-02 would still offer to resume a newer setup; the service's `setup_newer` refusal stops the write. ORG-01 and ORG-02 should still ship in the same release.
- **Rollback.** Nothing is migrated at ship time, because the table is empty. Reverting the branch returns the old behaviour, including emptying a setup saved under other questions on resume. Do not revert once any build has raised the revision.

## State of this branch

| Gate | Result |
|---|---|
| The ORG-02 files, the H21 tests, ORG-01's desktop tests, the workspace tests and the configuration route tests (7 files) | 109 tests passed on the first run |
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run --maxWorkers=4` | 476 files; 8,095 passed, 4 skipped |
| Control plane `npm test` | 40 files passed, 3 skipped; 605 passed, 33 skipped (the skipped files need a PostgreSQL database) |
| Control plane `npm run typecheck` | exit 0 |
| `npx wrangler deploy --dry-run` | exit 0; 1,257.61 KiB, gzip 240.88 KiB |
| `npx vite build` | exit 0 |
| `npx playwright test` | 254 passed, 5 failed, 49 did not run |

All of these ran at b8bd433 plus this change, under one heavy slot, on 2026-09-26.

Four of the five Playwright failures are main's own reds, which fail the same way without this change: `diomedes-home.spec.ts:185`, `home-luna.spec.ts:232`, `artifacts-ui.spec.ts:1434` and `home-route-ownership.review-20260921.spec.ts:140`. The 49 that did not run are the serial files behind them.

The fifth, `h03-claude-controls.spec.ts:261` ("a waiting message can be withdrawn, and Stop ends the answer gracefully"), is a flake that predates this change:

- Run alone on this branch, it failed 1 run in 2.
- Run alone on the base b8bd433, which has none of this change, it failed 2 runs in 3.
- In each failure, "Carry on", sent after Stop and Send again, got no answer within 12 seconds.
- This change touches no conversation code.

New and changed tests:

- `tests/setup-question-changes.test.ts`: 14, pure;
- `tests/incremental-setup-carry.test.ts`: 4;
- `tests/incremental-setup-app.test.ts`: 2;
- `tests/workspaces.test.ts`: the old stale-draft test, which expected resuming to empty the answers, is replaced by two tests, for a newer setup and for a revision no build wrote;
- `tests/migrations.test.ts`: the golden fixture;
- `services/control-plane/tests/organization-setup.test.ts`: 1.
