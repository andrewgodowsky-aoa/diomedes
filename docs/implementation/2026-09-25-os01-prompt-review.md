# OS01 prompt review: what to fix before dispatch

**Status: all 22 findings are resolved in OS01 prompt rev 2 (2026-09-25).** Andrew asked for every fix to be written in and for the recommendations under "Andrew decides" to be adopted as decisions. Where each one landed:

| Findings | Resolved in |
|---|---|
| 1 inputs unreachable | All four documents committed to main with this review, so repository-relative paths work from any worktree cut from `origin/main`. |
| 2 ADR rev 5 missing | `docs/product/ADR-owner-surface-2026-09-25.md` rev 5. D7 is rewritten to the OS01 decisions, and section 7 records the discovery corrections. The prompt also says it wins over the ADR for OS01. |
| 3 test commands | Prompt steps 3-5: the four gates verbatim, `vite build` before Playwright, the full suite, per-spec counts and the evidence restore. |
| 4 claims and slot | Prompt section "Hot files, claims and the test slot": the pinned tool path, `--role opus`, `--pid`/`--start`, slot and unslot, and the worktree lock. |
| 5 hot files | The same section: Andrew assigns the four hot files to this lane for OS01 only. |
| 6 attribution trailer | Prompt step 8. |
| 7 revision scope | `planningRevision`, bumped only by priority and due edits (prompt decisions; ADR D7; QUESTIONS.md R14). |
| 8 `by` mapping | Console and a person-requested conversational edit record `'you'`; team tools and anything Diomedes initiates record `'diomedes'`. |
| 9 click saves | Choosing a level saves at once, with "Saving…" then the result or a conflict message, and no confirmation. |
| 10 due-date editing | In the same control, with a clear-date action. |
| 11 timezone | A plain calendar date stored as entered; no conversion; no overdue logic in OS01. |
| 12-18 text fixes | The main SHA is now `df28d5c` or later; `Store.createTask`; the state-sentence table is OS09's; `readyAt(task)` is derived; test :76 is amended deliberately; no permission until OS04; 8.10-8.12 are marked context. |
| 19 report sections | Prompt step 9: PILLAR IMPACT, ROADMAP IMPACT, build/publication/deployment status, and implemented versus recorded. |
| 20 decisions recorded | ADR rev 5 D7, QUESTIONS.md R14, Project Memory 2026-09-25.2, and Live Roadmap 2026-09-25.2 section 6 H. Cloud synchronisation of the canonical documents is pending, as for the earlier 2026-09-24.2 and 2026-09-25.1 patches. |
| 21 package node | `OS01.I` (23c, `OPUS_5/OWNER_SURFACE/`) and `OS01.R` (24c, `ASTRA/OWNER_SURFACE/`) added to the unified execution package, with dependencies C00, H07 and H21 as the discovery report lists them. |
| 22 downgrade | Prompt "Downgrade" decision and acceptance; the contract doc and release notes must name the refusal and the backup. |

One consequence to know before dispatch: `OS01.I` depends on `H07.R` and `H21.R`. Both are still OPEN in the package ledger, although their code is on main. Dispatching OS01 before those nodes are DONE needs Andrew's recorded override.

Since this review was written, the discovery report grew to lanes OS01-OS20 and 27 section 8 corrections (OS18-OS20 cover internal and customer builds, company-only design creation and AI-service entitlements). The committed snapshot is SHA-256 `31e6020e6b5256e927661bcc55162adf1b24cd5bc8f6eaf546de14c90961d262`. Codex's discovery worktree may still revise it.

The original review follows unchanged.

---


Date: 2026-09-25. Reviewed: `PROMPT_OS01-task-priority-2026-09-25.md` (SHA-256 `5716234a…f760`), against `origin/main` at `d27230b` (PR #144), the Owner Surface ADR (rev 4, SHA-256 `8590d6e2…5733`), the OS-DISC-01 discovery report, `F:/Diomedes/AGENTS.md`, and the repository `AGENTS.md` on main.

**Verdict: don't dispatch OS01 yet.** The design decisions are sound and most of the code claims check out. But the builder can't reach its inputs, one input doesn't exist, and the test instructions would fail or skip required gates. Fixes are listed below in priority order. Items marked **Andrew decides** are choices the prompt made quietly or didn't make; each one has a recommendation.

## Checked and correct

- Ready-queue order is `readyAt → createdAt → taskId` inside a project (`shared/ready-queue.ts:177-181`), with least-recently-served project fairness (`:192-194`).
- The task PUT route (`server/app.ts:2217`) changes only name, description, owner and state. It ignores `assignedTo`, as the prompt says.
- Every file the prompt says to add is absent on main. Every file it says to edit exists.
- The test lines it pins still say what it expects: `tests/ready-queue.test.ts:76,90,142`, `tests/ready-scheduler.test.ts:131,333,350,386`, `tests/migrations.test.ts:70,286,303`.
- `playwright.config.ts` lists spec files by name, so a new spec does need adding there.
- The priority labels match ADR D7. The worktree name and branch follow `F:/Diomedes/AGENTS.md`.

## Blockers: fix before dispatch

1. **The builder can't read any of its inputs.** The ADR, this prompt and the discovery prompt are untracked files in `F:/Diomedes/diomedes`. That checkout is parked on `docs/fractional-ai-ops-agreement-20260919`, far behind main, and agents are told never to read code from it. The discovery report is an untracked file in the `owner-surface-discovery` worktree. A `task-priority` worktree cut from `origin/main` contains none of these, and the prompt cites them by repository-relative path. **Fix:** land the four documents on main through a docs-only PR, then dispatch. As a stopgap, give absolute paths.

2. **"ADR rev 5" doesn't exist.** The ADR on disk is rev 4. The discovery report's section 8 is titled "corrections for rev 5", and nobody has applied them. Rev 4 contradicts the prompt in four places:
   - D7 has `due?: string // ISO`; the prompt says a plain calendar date.
   - D7 has `by: Actor`; the prompt says `by: Owner`.
   - D7 makes priority required on human-created tasks; the prompt makes it required on every task.
   - D7 says automation-created tasks "carry no person priority"; under the prompt they carry 3.

   The builder is told to read the ADR in full and not to re-decide anything, so it will hit these contradictions with no rule for which source wins. **Fix:** write rev 5, folding in the prompt's decisions and the discovery section 8 corrections. Or cite rev 4 and add one sentence: "where this prompt and rev 4 differ, this prompt wins."

3. **The browser-test instructions are wrong.**
   - `npm run test:ui` is `playwright test`, which runs the whole suite, not "the spec you add".
   - There's no `npx vite build` step. `tests/native-ui.spec.ts` fails with "dist is older than …" whenever `shared/types.ts` changed after the last build, and OS01 edits `shared/types.ts`.
   - The repository requires four gates (`tsc`, `vitest`, `vite build`, and the named Playwright gate). This change touches Board, palette, Ledger and Thread flows, so the full browser suite is needed too.
   - A full run rewrites committed `evidence/**.png` files; restore them with `git restore -- evidence/`.

   **Fix:** give the exact command list and require per-spec counts, including skipped tests.

4. **Path claims and the heavy-test slot aren't covered.** The repository `AGENTS.md` requires claiming exact paths through the pinned coordination tool before editing. It also requires taking the shared heavy-test slot before any Playwright run. The tool lives at `F:/Diomedes/diomedes/.git/diomedes-coordination/unified-20260913/tool/coordination.ts`. The prompt only says not to run heavy gates "unless the coordination system shows it free". **Fix:** name the tool, `--role opus`, and a long-lived `--pid`. Say "take the slot, run, release". Also tell the lane to `git worktree lock` itself so the weekly sweep leaves it alone.

5. **Hot-file ownership isn't addressed.** The repository `AGENTS.md` gives the integrator ownership of `shared/types.ts`, `server/app.ts`, `server/store.ts` and `client/console/Shell.tsx`. Other lanes are expected to return patches. OS01 edits all four directly. **Fix:** Andrew's prompt can override that, but it should say so explicitly and require claims on those paths.

6. **No commit-attribution rule.** Andrew's standing rule is no `Co-Authored-By` trailer and no "Generated with Claude Code" line in a Diomedes repository; the repositories are public. A Claude Code builder adds both by default. **Fix:** add one line to step 5.

## Andrew decides (the prompt settled these quietly, or left them open)

7. **What does `revision` count?** The prompt adds `revision` to `Task` and checks `expectedRevision` on priority and due edits. But the PUT route also changes name, description, owner and state, and the Store and scheduler move state automatically. If every change bumps `revision`, every Store writer needs editing, and that isn't in scope. It would also make a manager's priority edit fail whenever the scheduler happened to move the task. If only priority and due edits bump it, the name should say so.
   **Recommendation:** only priority and due edits bump it. Name it plainly, for example `planningRevision`, and say state moves and name edits don't touch it.

8. **Who does `priorityMoves.by` record?** `Owner` is `'you' | 'diomedes' | 'diomedes-with-ok'`, which is an execution mode, not an actor. Standing decision 8 says attribution must be truthful. `undo-move` already treats `by === 'you'` specially, so the value matters.
   **Recommendation:** Console control → `'you'`. A team tool or any AI-initiated change → `'diomedes'`. A conversational edit asked for in the person's own words → `'you'`, with the command receipt pointing at the conversation turn. Write this mapping into the prompt.

9. **Does picking a level save immediately?** "Whether a click runs an action or selects it" is on the repository's "not yours to decide" list, and the priority control is exactly that choice.
   **Recommendation:** choosing a level saves at once, shows "Saving…", then either the new label or a conflict message. The change is recorded and reversible, so no confirmation step.

10. **Where does the due date get edited?** The Outcome says priority and due date can be set "anywhere a task is listed", but `TaskPriority.tsx` is described only as a five-level control.
    **Recommendation:** put the due-date field in the same control, with a clear-date action. Check at least one list for keyboard access.

11. **The "organization's timezone" has no source.** There's no timezone on Workspace, Project, Task or business access on main. Only automation schedules carry an IANA zone (`shared/automation-schedule.ts:44`). Sorting isn't affected, because the prompt compares strings, and OS01 computes no "overdue" or "today".
    **Recommendation:** say the due date is a plain calendar date stored as typed, with no timezone conversion. A later lane that shows overdue work picks the zone.

## Stale or wrong details (fix in text)

12. **The main SHA is stale.** It says main is `2a44687`, but `origin/main` is `d27230b`. PR #144 changed `client/console/BoardView.tsx` (+64 lines) and `client/console/ThreadView.tsx` (+18), both on OS01's edit list. Discovery section 3.16's line numbers are pinned to `90f23fa`. Say "branch from current `origin/main`; line numbers in the report are pinned to `90f23fa`".

13. **"Store constructor" is a misreading.** The failing site is the `Task` object literal inside `Store.createTask` (`server/store.ts:1951-1961`), not the Store class constructor.

14. **"Exhaustive label table" in `server/store.ts` belongs to OS09.** That table is the task-state sentence table the discovery probe flagged for adding `'submitted'`. Priority labels belong in `shared/task-priority.ts`. Remove it from OS01's store.ts list.

15. **`readyAt` isn't a Task field.** It's worked out by `readyAt()` in `shared/ready-queue.ts:86`, which falls back to `createdAt`. The comparator should call that function, so work lists and the scheduler agree.

16. **"Preserve `tests/ready-queue.test.ts:76`" means the opposite.** That test asserts "only its oldest Ready task". OS01 changes that rule on purpose. Reword to "amend deliberately and record the change in the contract doc". Lines 90 and 142 stay as they are.

17. **"Manager" implies a permission that doesn't exist yet.** OS01 has no permission check. `task:prioritize` arrives with OS04. Say the local Console user can edit, and name `task:prioritize` as deferred to OS04.

18. **Sections 8.10-8.12 are context, not scope.** Those cited discovery sections cover automation capacity, run class and allowance, which are OS12 concerns. Label them that way.

## Process gaps

19. **The PR report misses required sections.** It should also carry PILLAR IMPACT, ROADMAP IMPACT, build/publication status, and "implemented versus only recorded", as the repository `AGENTS.md` requires.

20. **Decisions live only in the prompt.** The prompt answers the owner questions in discovery section 5 ("One sort"): fairness scope, due semantics, undated order, and labels without auto-decay. Record them in ADR rev 5 and `QUESTIONS.md`. Put the label words in Project Memory, since they're terminology. The builder shouldn't be the one to edit the canonical documents.

21. **OS01 has no node in the execution package.** `RUN_ORDER` has no OS nodes, and discovery section 7 proposes adding OS01-OS17 as paired implementation and review nodes. Under `F:/Diomedes/AGENTS.md`, DONE means moving the prompt into `completed/` and updating the package. Without a node, OS01 can never be marked DONE. Add the nodes before or alongside dispatch; that's Andrew's authorization.

22. **Downgrades will be refused.** The migration registry refuses project state written by a newer schema (`tests/migrations.test.ts:303`). After OS01 ships, an older build can't open migrated projects. The contract doc and release notes should say so, and name the backup.

## The ADR and the discovery report

- The ADR's own drift is catalogued in discovery section 8 (22 items). The four D7 contradictions in item 2 above are the ones that affect OS01.
- The discovery report looks sound as a work-order source. Its PR table and SHAs match GitHub. It correctly calls all OS IDs proposals, not package nodes, and it claims no tests beyond a compiler probe. Its worktree inventory is a historical snapshot; recheck it before assigning lanes.
- The discovery prompt (OS-DISC-01 rev 2) is finished; its report exists. But the report is uncommitted in Codex's worktree.
