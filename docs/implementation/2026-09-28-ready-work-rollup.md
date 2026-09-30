# Ready work rollup, 2026-09-28

- **Branch:** `integration/ready-work-rollup`, rebuilt on origin/main `1af37e0`, which includes
  #173, #174 and #176.
- **Worktree:** `F:/Diomedes/diomedes-wt/ready-work-rollup`.
- **Owner:** the Opus lane.
- **Andrew, 2026-09-28 03:02 EDT:** "check over local commits and unpushed branches and such,
  combine as much as possible into one pr that can be pushed when i'm ready."
- **Andrew, 2026-09-30:** "push dio 125". The merge waits for him.
- **The Automations fix joins by a merge commit,** so the commit that was verified keeps its
  identity.

## In this branch

| Work | Commit | State |
| --- | --- | --- |
| Automations need a paid plan (review F01) | `a07848e` | Verified alone on base `0f20384`: the new test 4 of 4, the 30 affected files, `tsc`, and a full root vitest of 492 of 492 files with 8,245 passed. Verified composed on `1af37e0` here; see Gates. |
| The Individual plan and Automations | `3d13051`, `3abe8c8`, corrected by `1129fa8` | First written when an Individual plan covered a one-person business. Main now says Individual covers Personal work only (`shared/individual-plan.ts:33`), so `1129fa8` turns the Harbor test into a refusal and rewrites decision 4. Individual-tier Automations wait on the person-level grant (DIO-128). |
| Main, 2026-09-30 | `5b26be4` | origin/main `5f97d97` merged in, with no conflicts. |

## Gates

**2026-09-30, on `5b26be4` (the rollup merged with origin/main `5f97d97`)**, under slot
`slot_muon47q8_2489523c`, 21:51 to 21:59Z:

- `npm ci` at the root: passed. Root `tsc --noEmit`: passed.
- Full root vitest: 518 of 520 files, 8,649 passed, 2 failed, 5 skipped.
  - `tests/automations-paid-plan.test.ts`: the Harbor case failed. Main refuses it by the
    Personal-only rule, as it should. Corrected by `1129fa8`.
  - `tests/automation-weekly-brief.test.ts`: one case failed on a Windows rename EPERM in the run
    store's temp file under load. Alone it passes 8 of 8. The same file flaked the same way in a
    full run on another branch that day, so it isn't this branch's change.
- Vite build: passed. Playwright `ui`, `native-ui` and `field`: 36 passed. The two rewritten
  evidence screenshots were restored.
- After `1129fa8`: `tests/automations-paid-plan.test.ts` 5 of 5, `tsc --noEmit` clean.

**Earlier record (2026-09-28, base `1af37e0`):**

**The full run** was on the earlier composition `7e7f1a7` (tree `2bda312`), which also held the
read-connector fixtures. It ran under slot `slot_mul4b9br_e92406f6`, from 10:41:54Z to 10:58:21Z:

- `npm ci` at the root and in `services/control-plane`: passed.
- Root `tsc --noEmit`: passed.
- `tests/automations-paid-plan.test.ts`: 5 of 5 passed. The fixture files are below.
- Full root vitest at 2 workers with 90-second timeouts, as CI runs it: 496 of 497 files passed, with 8,289 tests passed, 7 failed and 4 skipped. The one failing file is `tests/read-connector-fixtures.test.ts`, the same 7 cases as the focused step.
- Vite build: passed.
- Playwright `ui`, `native-ui` and `field`: 36 passed. The run rewrote two evidence screenshots, and the rebuild restored them.

**The recheck** was on this branch, rebuilt without the fixtures (tree `15f51d0`), under slot
`slot_mul5ebqn_41146cce`, from 11:12:16Z to 11:12:51Z:

- Root `tsc --noEmit`: passed.
- `tests/automations-paid-plan.test.ts`: 5 of 5 passed.
- Only documents changed after the recheck: this record, and one line of the paid-only write-up
  saying when its CHANGES.md entry goes in.

**Why the full run carries over:**

- The rebuilt tree differs from `2bda312` only by nine deletions: the fixture tests, their fixture
  folder, their two write-ups, and this record's earlier version. Every other file is identical.
- Nothing else in the repository references those files.
- The Vite build and the Playwright specs don't read them.
- A full rerun on this exact tree is about 25 minutes under the slot, if a matching tree is wanted.

This branch changes nothing under `services/`, so the control plane's own typecheck, test and build
are not rerun.

## Left out: the read-connector fixtures

- **The candidate** is `9d67510`, the integrator's candidate for `28d07bb`. Its first run was the
  focused step above:
  - `tests/read-connector-fixtures.test.ts`: 7 of 8 cases failed.
  - `tests/read-connector-windows-launch.test.ts`: 5 of 5 passed.
- **Where each per-kind case fails:** line 182, the revoked read in the same conversation.
  - It expects 503 `RUNTIME_UNAVAILABLE`, the refusal in `server/harness/native-agent.ts:360`.
  - Main answers 409 `PROVIDER_ERROR`, from `server/engines/model-api-core.ts:998`.
  - That wording already existed at the fixtures' base `af0fbec`, so the expectation is the likely
    cause.
  - Lines 185 and 186 never ran. They check the offered tools and the receipts after revocation.
- **Handed back:** the owner, claim `claim_mukwcg7q_82ea1d47`, has the note at
  `F:/Diomedes/NOTE_TO_ASTRA_2026-09-28_read-connector-fixtures.md`.
- **Rejoining:** the fixtures can rejoin once they pass. The scope-removal mutation and O10 stay with
  the owner.

## Not in yet: PR #169

- Its rebased head `8ce8314` (on `2e6c785`) conflicts with #176 in `server/engines/service.ts`.
- Its owner has a Vertex setup fix, uncommitted in staged tree `793c575`, that passed its browser
  cases and a short `tsc`. Its full combined gates are still to run.
- It can join when its owner has a head built on current main with its gates passed, if Andrew wants
  it in this PR.
- Every push to a PR branch starts a CI run, and GitHub minutes are nearly used up.

## Joins when its owner's gates pass

| Work | Commit | State |
| --- | --- | --- |
| Account session and sign-in authority | `feature/accounts-security-audit`, at `accfa55` | It has not yet rebased over #176's changes to `server/accounts/session.ts`. |

## Later

- **Operations routing** is a work-in-progress checkpoint (`07dc5ba`). Andrew moved its migration
  to 010.

## Left out, and why

- **Checkpoints from the night of 09-27** that the integrator excluded. Its record gives the
  reasons.
  - Change Review subfolders, `a351355`
  - Supervision thresholds, `0637dee`
  - Guidance lineage, `9bfe24d`
  - Flake tracker, `b2887c1`
  - Connection reauthentication, `195c09a`
  - WorkOS account creation, `7e3ab48`, which is not buildable on purpose
- **Review branches,** whose failing tests are the point: `review/codex-conversation-driver` and
  `review/free-harness-paid-agent`.
- **Covered by #169 already:** `feature/acp-live-engine-update` and
  `feature/session-restore-across-updates`.
- **Branches from 09-23 and earlier:** 700 to 1,450 commits behind main, and superseded, already
  released or never reviewed. About 211 of them are the 09-20 sweep's `recovery/*` and
  `chore(wip): preserve` snapshots.
- **Six stashes,** all of them safety stashes kept by the #169 chat.
- **Sibling repositories need their own PRs.**
  - Operations: an `ops-branch-reconcile` checkpoint with unrun tests, and routing's own work.
  - Android: an unverified device presence checkpoint.
  - The site: parked, with stale snapshots only.
  - iOS: nothing unpushed.

## At push time

- This is one PR carrying the Automations work.
- **`docs/harness/CHANGES.md`:** the F01 write-up carries a proposed entry for it. Main hasn't
  updated that file since 0.1.1, and only #169 adds entries now, so the entry joins whichever of
  the two lands second.
- **If #169 joins:** either merge #169 on its own first, or close it as superseded.
- **What #169 brings:** its two outstanding proofs, the AWS Luna reasoning and the installed-app
  Thinking and restart check, plus the Worker deploy.
