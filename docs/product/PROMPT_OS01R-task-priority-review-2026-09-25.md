# OS01.R — Task priority: independent review prompt

**Node:** `OS01.R` (independent review of `OS01.I`)
Revision: rev 1, 2026-09-25
Owner: Andrew (Diomedes Systems LLC)
Model: an independent reviewer; Astra by default. Never the model or session that built `OS01.I`.
Package node: `OS01.R` (number 24c), reviewing `OS01.I` (23c). Linear DIO-110.
Subject: the exact head commit of the `OS01.I` draft PR, `OS01: task priority, due date and work-list ordering`, on `feature/task-priority`. You review only that commit's tree, never the builder's summary of it.
Inputs, on main in this repository:
- `docs/product/PROMPT_OS01-task-priority-2026-09-25.md` (rev 2). Its "Decisions" and "Required acceptance" sections are the contract you check.
- `docs/product/ADR-owner-surface-2026-09-25.md` (rev 5, D7).
- `docs/implementation/owner-surface-discovery-2026-09-25.md` (sections 3.1, 3.16, 5 "One sort", 8.8 and 8.9).
- `docs/implementation/2026-09-25-os01-prompt-review.md`.

## What you are doing

Decide whether the candidate meets OS01's contract, from the code and from tests you run yourself.

- The verdict is `accepted`, `accepted with fixes` or `rejected`.
- Each finding has a file, a line and a failing case. If you fix something, the fix is a separate commit on a review branch, and the verdict names the exact commit it judged.
- Do not re-decide the prompt's settled decisions. If one is wrong, report it as a finding for Andrew, not a change.

## How to work

1. **Set up.**
   - Create `F:/Diomedes/diomedes-wt/task-priority-review` from the candidate commit, on branch `review/task-priority`.
   - Lock the worktree.
   - Never read code from `F:/Diomedes/diomedes`.
2. **Read** `F:/Diomedes/AGENTS.md`, this repository's `AGENTS.md` and `CLAUDE.md`, and the inputs above.
3. **Reconstruct the diff** against the candidate's merge base with `origin/main`. Walk every path in the prompt's scope. Confirm nothing outside scope changed, especially:
   - `assignedTo`;
   - `Owner`;
   - the task-state sentence table;
   - permissions;
   - new dependencies.
4. **Take the heavy-test slot** through the pinned coordination tool (`F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/tool/coordination.ts`, `--role astra`) before any Playwright run, and release it afterwards.
5. **Run the four gates yourself** on the candidate:
   ```
   npx tsc --noEmit
   npx vitest run
   npx vite build
   npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
   ```
   Then run the full browser suite, `npx playwright test`. Report per-spec counts, including skipped tests, and restore `evidence/` afterwards.
6. **Write adversarial tests** where the builder's tests are thin. At minimum:
   - concurrent edits with one expected planning revision;
   - a state move between two priority edits;
   - a same-command retry after a crash between write and receipt;
   - a reorder between plan and claim;
   - a corrupt stored priority;
   - an invalid due date such as `2026-02-30`;
   - a conversational edit's `by` value and receipt;
   - no AI session started by any edit.

## Required acceptance

The candidate is accepted only if every item below holds on the exact commit.

**The prompt's acceptance**
- Every item in the "Required acceptance" section of `docs/product/PROMPT_OS01-task-priority-2026-09-25.md` (rev 2) is met and shown by a test you ran or wrote.

**One comparator**
- `shared/task-priority.ts` is the only priority comparator. It is pure and does not mutate its input.
- Every work list listed in the prompt uses it.
- The ready queue uses it only inside a project's line, with least-recently-served fairness, consent holds and limits byte-for-byte unchanged in behaviour.

**One writer**
- `server/task-commands.ts` is the only writer of priority, due and `priorityMoves`.
- The PUT route, the conversational seam and team tools all call it. A search finds no second writer.

**Planning revision**
- `planningRevision` changes only on priority and due edits.
- A state move, a name edit and scheduler activity leave it unchanged.

**Attribution**
- `by` follows the mapping in the prompt: `'you'` for the Console control and person-requested conversational edits; `'diomedes'` for team tools and anything Diomedes initiates.
- `'diomedes-with-ok'` is never recorded for a priority move.

**Migration**
- A migrated fixture loads with priority 3 and planning revision 1.
- A corrupt value refuses with a backup and a plain message.
- The contract doc names the backup and the downgrade refusal.

**Tests**
- `tests/ready-queue.test.ts:76` was amended deliberately, and the contract doc records it.
- Lines 90 and 142, `tests/ready-scheduler.test.ts:131,333,350,386`, and `tests/migrations.test.ts:70,286,303` still pass unchanged or are re-anchored to the same assertion.
- Old v1 admission receipts stay readable.
- No assertion was weakened and no live test became a mock pass.

**The control**
- Choosing a level saves at once, with "Saving…" and then the result or a conflict message, and no optimistic success before the receipt.
- It works keyboard-only, with visible focus.
- Touch targets are at least 44 px.
- Labels are visible; the due date can be set and cleared in the same control.

**Gates and commits**
- All four gates and the full browser suite pass on the candidate, with real counts.
- No commit or PR text carries a `Co-Authored-By` trailer or AI-attribution line.
- Nothing was merged to main.

## Execution and return

Write your verdict to `docs/implementation/2026-09-25-os01-review.md` on `review/task-priority`. It contains:
- the verdict;
- the exact candidate commit;
- the commands and real counts;
- every finding, with file, line and failing case;
- any fix commits;
- what remains unproven: live-provider, packaged, installer and device behaviour are out of OS01's scope and stay unclaimed.

Commit it with no AI-attribution trailer. Push only the review branch. Do not merge, do not edit the execution package, and do not mark anything DONE; Andrew records DONE after the exact accepted commit is merged. Release the slot and any claims before you stop.
