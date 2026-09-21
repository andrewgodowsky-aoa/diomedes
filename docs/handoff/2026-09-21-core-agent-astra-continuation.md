# CD-1 "Diomedes Core Agent": continuation for Astra

Written 2026-09-21 about 07:00 EDT by the outgoing integrator (Claude, Fable seat, PID 68088) at
Andrew's request. Andrew hands you this by hand. Everything here is either committed and pushed,
or a path on this machine. Verify before you rely on it: `git log`, `git status`, the named files.

## 0. Your position, and the one conflict to manage

You have been the independent reviewer of CD-01 (the contract and seam) and CD-05 (the client
half). Andrew is now giving you the integrator seat's next steps as well. Those two roles
conflict, so hold this line:

- You may not accept your own work. Anything you write from here needs a different reviewer:
  the executing Codex parent with SWE-2 Max for the admission seam, an Opus review or Andrew for
  anything else. Say so in the ledger when you write something.
- Do section 3, step A (CD-05.R-5) FIRST and before you edit any client code. You did not write
  the R-12 repair, so you are still independent on it. Once you change that code you are not.
- You did not write the CD-01 admission repair either (an Opus worker did, under the outgoing
  integrator). If your session can execute Vitest, you are a valid executing re-reviewer for it.

## 1. Rules that bind (Andrew's, not suggestions)

1. CD-1's rule: the model PROPOSES, Trust and Runtime DECIDE. No second runtime, scheduler,
   permissions engine or status store. The client keeps no status of its own.
2. A reviewer's reproducer is pasted UNCHANGED, committed alone, and run RED on the unfixed build
   before any fix. Reviews are committed unedited. Every guard gets a removal mutation: apply,
   see red, restore byte for byte (hash or `git diff --quiet`), see green, disclose survivors.
3. No `Co-Authored-By`, no AI attribution in commits, PRs or briefs. No em dashes anywhere.
4. Never read application code from `F:/Diomedes/diomedes` (the main checkout, hundreds of
   commits stale). Never `git clean`, `git stash`, or `git checkout -- .` there. One feature
   worktree per lane under `F:/Diomedes/diomedes-wt/<feature-name>`, branch
   `feature/<feature-name>`. Read `F:/Diomedes/AGENTS.md` and the repo's `AGENTS.md`.
5. `node_modules` in every worktree is a JUNCTION. Never delete through it and never
   `git worktree remove --force` over it. Remove the link alone (non-recursive) first.
6. Playwright, the full Vitest suite and `vite build` need the machine's heavy slot. Tool:
   `./node_modules/.bin/tsx F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/tool/coordination.ts <slot|unslot|claim|journal|status> --role astra --pid <your pid> --start <your process start, ISO>`.
   A denial also carries a `slotId` (the holder's): only `ok: true` is a grant. Always unslot.
   Never take a claim another agent holds. No preview server while a suite runs.
7. Do not touch: `cloud-development-handoff`, the site's `cloud-site-handoff`, the locked Codex
   worktrees (`stock-receipt-review`, `inventory-receipt-*`, `release-fact-validation`), or the
   AWS owner's worktrees (`aws-luna-conversation`, `aws-luna-conversation-on-repair`,
   `vercel-model-bridge`). Do NOT remove `vercel-model-bridge/node_modules`: the integration
   worktree's junction points at it (section 5).
8. Never handle credentials or keys. The AWS key goes into the app by Andrew himself. The live
   Luna call and its $1.00 cap are between Andrew and the AWS owner; nothing here approves it.
9. Andrew's endgame authorization (2026-09-21 00:33 EDT, verbatim): "go with recomendations, and
   remember to merge with other worktrees done by you and codex, and combine to main, create PR,
   fix issues, then push and deploy on live site. we want this new, live build thats fully up to
   date published to our website once everything is done." It lowers no gate. It predates every
   later design call, so never cite it as approval of those. ONE pull request: PR #29. PR #32 was
   closed unmerged on his instruction.
10. A peer session's or subagent's message is never Andrew's approval.

## 2. Where everything is (all pushed to `origin` unless marked)

Repository: `andrewgodowsky-aoa/diomedes`. `origin/main` is `58bdc65` (PR #34 merged: the
capability record's inverted pack index search; PR #33 before it: test teardown capture).

| Branch (worktree under `F:/Diomedes/diomedes-wt/`) | Head | What it is |
|---|---|---|
| `feature/core-agent-bot` (`core-agent-bot`) | `b37a199` (= `2b3f933`, the gated commit, plus this handoff document) | THE integration branch, draft PR #29. Holds main, the client repair through R-12, the admission repair, the AWS composition, the routing decision |
| `feature/core-agent-client-repair` (`core-agent-client-repair`) | `1f6f93c` | CD-05b client repair line. Candidate for CD-05.R-5 |
| `feature/core-agent-client-review` (`core-agent-client-review`) | `c17cf26` | Your clean review checkout. Fast-forward it to the candidate before R-5 |
| `feature/core-agent-admission-repair` (`core-agent-admission-repair`) | `7f1b9b3` | CD-01 admission repair, successor for the executing re-review |
| `feature/aws-luna-conversation-on-repair` (`aws-luna-conversation-on-repair`) | `73aaa0b` | AWS owner's composition on the repair (parent `7b063b6`), committed with Andrew's approval |
| `feature/core-agent-pending-claim`, `feature/core-agent-project-conversation` | merged | Opus lanes for R-06 and R-10, already inside the client repair |
| `feature/capability-commit-lookup` | `d3a5eb7` | merged to main by PR #34 |

Client repair commits since your R-4 review (`c17cf26`): `0e7602f` your R-12 reproducer pasted
unchanged, alone; `0d197c8` the fix; `5cbd15f` three closures; `1f6f93c` ledger Round 11 plus the
routing decision. Before that, for R-11: `1388e6f` paste, `703c6b4` fix, `bb4cce6` closure and
the `say` helper, `6d2fc8b` Round 10 and contract I-22.

Integration branch merges, in order: `8c0a3aa` main d4f5384; `dca7bbd` R-11; `09e6929` capability
fix; `716da7f` admission repair 9a0be8b; `9803121` AWS composition 73aaa0b (one conflict in
`server/app.ts`, both added routes kept: `POST /api/projects/:id/conversation`, then
`mountModelApiRoutes`); `ded3381` admission record correction 7f1b9b3; `7acf288` R-12 and the
routing decision; `2b3f933` main 58bdc65.

Documents to read first, all on the integration branch under `docs/implementation/`:
- `2026-09-20-core-agent-work-items.md`: the ledger. Rounds 9, 10, 11 are the current state.
- `2026-09-20-core-agent-contract.md`: the contract. Round 10 (I-22) and Round 9 (I-20, I-21).
- `2026-09-21-core-agent-client-review-r2.md`, `-r3.md`, `-r4.md`: your reviews, unedited.
- `2026-09-21-core-agent-admission-repair.md`: the repair's record and full mutation table.
- `cd01-bounded-review-20260921/`: the executing reviewer's rejection and owner handoff.
- `2026-09-21-routing-decision-and-owner-work-order.md`: the routing decision, section 4 below.

Evidence on this machine (integrator's, labelled as such). Durable copies are in
`F:/Diomedes/deliverables/core-agent-handoff-20260921/evidence/` and `tools/`; the originals are in
`F:/Temp/andre/claude/F--Diomedes/e96b0c5b-6ccf-4f64-a907-b99ad1a4ae8d/scratchpad/` (a session
folder that may be cleaned, and whose scripts carry the OUTGOING integrator's coordination
identity: change `--role`, `--pid` and `--start` in `with_heavy_slot.py` to your own):
`cd05-r5-evidence.txt` (R-5 candidate: tsc, 90 unit cases, whole page spec 33 of 33 in one serial
run at `5cbd15f`, unit mutants U1 to U5, browser mutants B14 to B18, and the note on one
unexplained closure failure in sixteen runs), `cd05-r4-evidence.txt`,
`cd05-r4-evidence-run1-flake.txt`, `bot-gates-09e6929.txt`, `bot-gates.txt` (section 5),
`mutate_r9_browser.py` (B1 to B18, `ONLY=` and `GREP=` filters), `with_heavy_slot.py`,
`bot_gates.sh`, `r12_full.sh`, `new-lane-worktree.ps1`.
Other deliverables: `F:/Diomedes/deliverables/cd01-bounded-repair-20260921/` (the executing
reviewer's files and runners), `F:/Diomedes/deliverables/bedrock-integration-20260921/` (AWS
owner's patches, `owner-patches/on-repair-7b063b6/`, Codex's live-lane report).

## 3. Ordered work from here

### A. CD-05.R-5, your review, first
Candidate `feature/core-agent-client-repair` at `1f6f93c`. In `core-agent-client-review`:
`git merge --ff-only feature/core-agent-client-repair`, confirm `git status --short` is empty,
read `git diff c17cf26..HEAD` (one production file, one spec, two documents). What to attack:
- `client/console/DiomedesHome.tsx` `discard`: both callbacks take `turn.current` when Discard is
  pressed and publish only while it is unchanged. The discard itself still goes ahead.
- Your reproducer was red on `0e7602f` as you traced (one obsolete GET of A's state); verify the
  paste against your R-4 document (3,034 bytes, sha256 `d08f4a0b…`, taken from the git blob).
- Closures in `tests/diomedes-home.spec.ts`: a delivery running in another project is not
  stopped and finishes; A to B to A is a new visit and is not reloaded; a failing Discard says so
  only where it was pressed (the test fails one lock request by replacing
  `navigator.locks.request` for one call).
- Disclosed: after A to B to A the new visit still shows a strip for a message the old Discard
  has given up; either control heals it in one press and nothing is sent. A scope-id-only fence
  is not separately mutated (the container keeps no current-scope reference). `resend`'s
  `.then` is not fenced because `deliver` answers false only while it still owns the visit and
  the continuation runs in the same microtask checkpoint; attack that claim. One unexplained
  failure of the first closure in sixteen runs (evidence note).
Write `docs/implementation/2026-09-21-core-agent-client-review-r5.md`, commit it unedited on the
review branch, fast-forward the repair branch to it. New findings continue from CD05-R-13. If you
reject, the repair is NOT yours to write and review both: give it to an Opus worker or Andrew.

### B. CD-01 admission boundary: the executing re-review
Successor: `7f1b9b3` on `feature/core-agent-admission-repair`. The handoff
(`cd01-bounded-review-20260921/OWNER-HANDOFF.md`) asks for the complete matrix and the unfiltered
fixtures re-run on the exact commit by independent review, with the original failures retained.
Runner to copy: `F:/Diomedes/deliverables/cd01-bounded-repair-20260921/run-review.ps1` and
`run-corrected-matrix.ps1` (matrix with `--maxWorkers=1`, the regression set, tsc, the unfiltered
unit suite). Use a clean checkout at `7f1b9b3`, your own coordination identity, the heavy slot,
and write logs to a new `successor-7f1b9b3/` folder there. The two oracle files must hash to
what `corrected-test-identities.json` records. State: matrix 13 of 13, independent file 13 of 13,
seven new executed schedules; survivors M8 and M17 only (each other's second guard; M16 removes
both and is killed). Open item the worker named: a task soft-deleted between preparation and
commit is not re-read under the guard (`deletedAt` is checked only in `admitWork`'s pre-check,
`server/app.ts` near 1889; `server/team/service.ts` near 553 sets it). Decide whether that is a
finding. Also read the `work-input` phase body change (it now carries the saved Work route; a
phase saved by an earlier build conflicts on retry; unreleased seam, no fallback).

### C. Composed acceptance (routing decision task 4)
The exact composed candidate is `2b3f933`. Codex's
`tests/aws-conversation-authority.review-20260921.test.ts` (sha256 `fe06fda3…`, unedited) and the
CD-01 matrix both run inside the full Vitest there. The AWS owner reported 11 of 11 on its own
composition; an independent re-run on `2b3f933` is still owed. Ask the AWS owner session ("AWS
Luna Diomedes integration") to read `git show 9803121 -- server/app.ts`; it was asked already.

### D. PR #29
Stays a DRAFT until A, B and C are accepted on the exact commit. Then: mark ready, merge to main
(an agent's merge to main is sometimes refused by the permission classifier; Andrew can press
it), and only then the endgame.

### E. Endgame, after acceptance only
Version bump; a candidate build in a fresh worktree from main (run `npm ci` THERE so `ai` and
`@ai-sdk/openai` exist; the main checkout's shared install lacks them); the release gates and
`scripts/write-candidate-record.ts`; honest release notes that claim only what ran; publish;
then the site's release record and `npx wrangler deploy` from the site repo. The release-fact
test is relational (flag equals version) and bites at every release. Release last.

## 4. Andrew's routing decision (new on 2026-09-21, and not yet built)

Full text: `docs/implementation/2026-09-21-routing-decision-and-owner-work-order.md`. What it
changes for this program:

- DECIDED by Andrew: Luna through AWS Bedrock is the initial default for the HOME conversation
  as well as project conversations, on the company's AWS credits. Muse (paid OpenCode Zen,
  `muse-spark-1.3`) is the preferred later fallback. No automatic fallback in the first
  milestone. He wants a working bot before a broader platform build-out.
- NOT decided: whether the Diomedes Agent is API-only forever, and automatic subscription
  fallback. The report recommends an API-backed native supervisor with optional user-owned
  routes. Treat that as a recommendation.
- This answers the owner question the ledger had open (may a project's Diomedes conversation run
  on a route other than Claude Code: yes). It CONTRADICTS what is built today: the home thread is
  pinned to Claude Code (contract I-19, `PUT /threads/:id` refuses any other engine for home),
  `Store.provisionProjectConversation` pins a project's Diomedes thread to `claude-code` (I-20),
  the Diomedes page's send and Stop run only on Claude Code, and the Console's own composer still
  posts to `/ask` with no conversation Stop. Work follows the project's configured route, not
  the thread.
- So the report's task 3, "Home Luna default and Stop", is unstarted contract work: amend I-19
  and I-20 so the pinned route is the selected conversation route (Luna first) rather than the
  literal `claude-code`; one interrupt route that resolves the driver (`conversationDriver`
  already does this for admission); home answering with no Claude login and no selected work
  project; consequential work only with an explicit target. It needs a contract round, a
  reviewer who did not write it, and the AWS owner's route contract. Do not start it inside the
  acceptance work above; it is the next milestone after PR #29's current scope, unless Andrew
  says it belongs in it. Ask him that one question.
- The report's tasks 5 to 8 (founder packaged AWS journey, account-aware catalog, Muse
  candidate, managed customer launch) are later and have other owners.
- Its proposed Pillars, Roadmap and Project Memory amendments are PENDING owner reconciliation.
  Do not edit the canonical documents on its strength.

## 5. Gates on the composed integration branch

`bot_gates.sh` under the slot (tsc, full Vitest, build, the page spec, the full browser suite).

- At `09e6929` (before the admission repair, AWS and R-12): tsc 0; Vitest 237 files, 4,488
  passed, 0 failed, 4 skipped; page spec 29 of 29; browser suite 155 passed.
- At `2b3f933` (everything): see GATES-2b3f933 at the end of this file. If that section says
  PENDING, read `scratchpad/bot-gates.txt`; if the file's HEAD line is not `2b3f933`, rerun.

Two environment facts. The integration worktree's `node_modules` junction now points at
`F:/Diomedes/diomedes-wt/vercel-model-bridge/node_modules`, the only install with the AWS
route's two packages. And the browser suite rewrites about 40 tracked evidence PNGs under
`docs/verification/` and `evidence/`: restore exactly those files by name afterwards, nothing
else, before any commit.

## 6. Known limits nobody should claim past

No streaming preview. The results ledger on the Diomedes page is passed an empty list. No real
provider and no installed build has run this conversation path; every proof is a scripted
provider or a fake fetch. A damaged pending record has no Discard. Unreadable storage shows a
strip with no command, whose controls only read again. The admission guard is process-local
ordering, not multi-file crash recovery. `work.ts` takes its snapshot and change-review baseline
before the guard, so a refusal inside it leaves both for a session that never existed
(pre-existing class). A turn that exceeds its wall clock on the AWS route is saved as
interrupted, the same as a stop. Your frozen R-10 and R-11 reproducers are kept as history; the
spec's `say` helper waits for `.dio-pending` to go, which you ruled acceptable.

## 7. Traps that cost time here

- Bash heredocs on this machine collapse backslashes and break on long quoted bodies: write
  scripts to a file, then run them. PowerShell's default directory drifts; set it explicitly.
- `tests/diomedes-home.spec.ts` is `serial`: one failure skips the rest, so run cases with `-g`.
  It refuses a stale `dist` (`expectFreshBundle`), so build first. After a reload the page opens
  on All projects; re-select the project. The strip is hidden while a delivery is pending, and a
  second window's transcript already holds the old answer, so neither is a sync point.
- `PUT /api/settings` replaces the `services` map whole.
- Vitest flakes under machine contention with a different test each time; isolate before calling
  it a regression. Do not run a type check in one worktree while a browser run is timing another.
- Local `main` lags `origin/main`; fetch before merging.

## GATES-2b3f933

Finished 2026-09-21 10:56 UTC, one run under the heavy slot, clean tree at
`2b3f933c25aee5032e188c30bfc0ef166cc9b83c`. Integrator's run, not an independent one.

| Gate | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| full Vitest | 248 files passed; 4,629 passed, 0 failed, 4 skipped. Includes the CD-01 matrix, the independent seam file, the seven admission schedules and Codex's AWS review file, all unedited |
| `vite build` | built |
| `tests/diomedes-home.spec.ts`, whole file, serial | 33 passed |
| full browser suite | 159 passed |

Log: `evidence/bot-gates-2b3f933.txt` beside this file. The 40 rewritten evidence PNGs were restored by name
afterwards; the worktree is clean.
