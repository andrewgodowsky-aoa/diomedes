# Andrew's decisions, 2026-09-24 (overnight lanes P06, H13, H15)

Andrew answered the open defaults from the overnight sprint's implementation records on
2026-09-24. His direction: take the options that give broad functionality and safety without
disabling or hampering agents while they work, especially in team mode, and dispatch sub-agents
into sandboxes wherever that is possible.

Source-of-truth rank 1 (Andrew's newest explicit decision). The canonical documents, their cloud
copies and `QUESTIONS.md` still have to carry these. That sync is pending, and this file is the
patch to apply. The overnight canonical-sync branch is editing those documents now, so this record
does not edit them.

## P06 — readable diffs belong to Core

Readable diffs of recorded versions, per-change keep and review comments are **Core**, as the P06
lane built them. The rule is decision 12 (Projects stay general-purpose) and decision 13 (one
Files surface): a restaurant's spreadsheet export and a contract draft need a readable diff as much
as source code does. The Software Engineering pack still owns the IDE-grade layer on the same
surface: Git, syntax highlighting, unified and split code views, and LSP. This replaces the
2026-09-10 product note's placement of "unified and split diffs" in the pack, for recorded
versions only.

## H13 — the Diomedes loop

1. **Accepted.** A finish that is not Verified leaves the task in Review (`waiting ·
   changes-ready`), including when no checks are declared. The agent is not stopped. It finishes,
   and a person or a verifier moves the task to done.
2. **Changed: delegates work in sandboxes instead of being read-only.** The lane's proposal (a
   read-only delegate, one level deep, at most 2 per run, 4 model and 4 tool calls) is safe, but
   it keeps delegates from doing work. The decision:
   - **Every delegate runs in its own sandbox.** The sandbox is an isolated working copy of the
     delegate's scope, held in the parent run's own area. Every write and spawn goes through H12's
     containment funnel (`containedPath`, `containedWrite`, `containedSpawn`) rooted at that copy.
     A delegate never writes the project directly.
   - **Its changes come back as a change set, not as effects.** When a delegate finishes, its
     sandbox diff returns to the parent as a recorded change set with P06's readable diff and
     per-change keep. The parent may apply changes that fall inside the parent's own granted
     scope, through the one recorded write path and attributed truthfully (decision 8). Anything
     else waits for a person as ordinary review. Delegation never widens authority (decision 7):
     a delegate's grant is the intersection of the parent's grant and the handoff's declared
     scope.
   - **Limits that allow a team.** Depth at most 2, at most 4 delegates per run, and delegates may
     run in parallel. The budget is carved from the parent's remaining budget, never added on top
     of it, so a team costs no more than the run it serves. Stop still cancels the whole tree.
   - **Routes.** Delegate routes come from the project's H09 Agent profiles. The person, or the
     profile's default, fixes which routes are allowed at start. The model picks among those
     routes and decides what each sub-task says, but never who pays.
   - **Until the sandbox exists**, delegates stay read-only as built. The sandbox is H13's next
     slice, after integration batch 4 lands.
3. **Accepted.** The loop's own steps are attributed to Diomedes as native supervisor, model steps
   to the runtime-reported model, and a fixture route names no model.

## H15 — supervision

1. **Accepted: the thresholds.**
   - Identical calls in a row: 3 / 4 / 6 (note / correct / pause).
   - Same observation for different inputs: 4 / 5 / 8.
   - Budget: noted at 80 % used; critical at ≥ 90 % used with a projected overrun.

   A project may tighten these thresholds but never loosen them.
2. **Accepted: correction bounds.** Scope 1, no-progress 2, budget 1, instruction 1, verification
   1, all capped at `CORRECTION_LIMITS.maxAttempts` (3).
3. **Accepted.** Scope is folder-level, as proposed.
4. **Accepted.** An unapproved recorded write outside scope, or into a forbidden path, pauses at
   once. Reads and proposals are noted only.
5. **Answered: a queued correction may start the next run on a route that cannot steer, without a
   person.** It keeps agents moving, and it is safe for these reasons:
   - It shares the origin run's correction bound.
   - It runs through ordinary admission, with a permission never wider than the origin run's.
   - It is labelled as a supervision correction in the thread and in History.
   - A pause or a Stop cancels it.

   Once the bound is spent, the next drift escalates to a person as a Need.
6. **Accepted.** An escalation is raised once per task and issue.
7. **Accepted.** Supervision is on for every project, with no setting that turns it off or widens
   it.
8. **Accepted.** Instruction drift reads only backticked paths after an explicit prohibition.

## Team mode, in general

Decisions for any Diomedes-dispatched helper or sub-agent, not only H13 delegates:

- **Sandbox by default.** Delegated work runs in an isolated working copy under H12 containment
  and hands back a recorded change set. Direct writes to the project are the parent's, or a
  person's, never the helper's.
- **No authority widening.** A helper's authority is the intersection of its parent's grant and
  its declared scope (decision 7). A helper's action is attributed to its own engine and model
  (decision 8).
- **Do not hamper.** Sandboxing replaces "read-only" as the safety mechanism. The system prefers
  letting a helper do the work somewhere safe over refusing the work.

## Pending

- Apply these decisions to `QUESTIONS.md` (resolve the H13, H15 and P06 questions the records
  propose), the roadmap, project memory, and their cloud copies (cloud sync pending).
- H13 next slice: the delegate sandbox and the change-set return.
