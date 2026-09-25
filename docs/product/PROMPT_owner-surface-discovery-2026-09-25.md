# Prompt: Owner Surface discovery — investigate real main against the ADR and report what changes

Prompt ID: OS-DISC-01
Date: 2026-09-25 (rev 2 — targets `origin/main`, not the local checkout)
Kind: discovery and gap analysis. **No implementation. No file edits outside the report.**
Owner: Andrew (Diomedes Systems LLC)
Model: any reviewer-capable model; Opus reviewers are fine. This prompt does not build.

## Where to read from — this matters

The local checkout at `F:/Diomedes/diomedes` is **not main**. On 2026-09-25 it was on branch `docs/fractional-ai-ops-agreement-20260919`, five WIP commits ahead of nothing and 1,156 commits behind `origin/main`, with 700 line-ending-dirty files. Do not read it as the current state of the product. The local `main` ref was fast-forwarded to `origin/main` (`90f23fa`, v0.2.0) that day, but the working tree was left alone.

Work in a fresh worktree from main, named per `F:/Diomedes/AGENTS.md`:

```
cd F:/Diomedes/diomedes
git fetch origin main:main
git worktree add F:/Diomedes/diomedes-wt/owner-surface-discovery main
```

Record the commit you inspected in the report. If `origin/main` has moved past `90f23fa`, use the newer commit and say so. Read from that worktree only. Do not `git checkout` in `F:/Diomedes/diomedes` itself.

## What you are doing

Read `docs/product/ADR-owner-surface-2026-09-25.md` (rev 4) in that worktree. It records eleven decisions (D1–D11) about a second surface for Nectovia — projects, assignments, people, permissions, messaging, task priority and configurable completion on the MI-DEMO phone/tablet PWA — and it names the modules on main it intends to build on. Check every decision against the code and the execution package, and produce one report that says, file by file, what must be **edited, added and removed**, what the ADR got wrong, and how to split the work into feature worktrees.

You are not being asked whether the decisions are good. Where one is impossible or conflicts with something committed, say so with the file and line that proves it and propose the nearest thing that works.

## Read first, in this order

1. `F:/Diomedes/AGENTS.md`; the repo's `CLAUDE.md` and `AGENTS.md`.
2. `docs/product/ADR-owner-surface-2026-09-25.md` — the subject.
3. `docs/DIOMEDES_CORE_PILLARS.md`, `docs/DIOMEDES_LIVE_ROADMAP.md`, `docs/DIOMEDES_PROJECT_MEMORY.md`, and every `docs/product/2026-09-*.md` dated on or after 2026-09-19 (automations, core agent, artifacts, home/history sharing, lineage, visual convergence) — several were written after the ADR's author last saw the tree.
4. `docs/product/personal-business/` — identity, onboarding, harness rules and the PB prompts; this is where access profiles came from.
5. The execution package at `F:/Diomedes/planning/Roadmap and prompts/Diomedes_Unified_Execution_Package_2026-09-13/diomedes-unified-execution-2026-09-13/`: `RUN_ORDER.md`, `RUN_ORDER.json`, `coordination/completion-status.json`, `shared/CHARTER.md`, all of `milestones/mobile-inventory-demo/`, and the prompts for MI00–MI09, B01–B03, PB01–PB04, H17, and any H-, P- or CD-series prompt touching identity, membership, tenancy, Files, tasks, mail or the control plane (`MODEL_PROMPT_INDEX.md`).
6. `git log --oneline -60 origin/main` and the merged PR titles since #100, so you know what landed after the package's last refresh (2026-09-23).

Then the code. At minimum, on main:

- **Shared contracts:** `shared/types.ts` (all), `shared/workspaces.ts`, `shared/business-access.ts`, `shared/business-setup.ts`, `shared/workforce.ts`, `shared/ready-queue.ts`, `shared/automations.ts`, `shared/automation-schedule.ts`, `shared/inventory.ts`, `shared/inventory-workflow.ts`, `shared/capability-packs.ts`, `shared/pack-contributions.ts`, `shared/pack-manifest.ts`, `shared/permissions.ts`, `shared/verification.ts` (H17 `AcceptanceDeclaration`), `shared/file-identity.ts`, `shared/attribution.ts`, `shared/task-sources.ts`, `shared/conversation.ts`, `shared/interaction.ts`, `shared/team-delegation.ts`, `shared/team-routes.ts`.
- **Server:** `server/business/`, `server/workforce/`, `server/inventory/`, `server/ready-scheduler.ts`, `server/automation-scheduler.ts`, `server/automations.ts`, `server/task-admission.ts`, `server/work-admission.ts`, `server/work.ts`, `server/work-control.ts`, `server/execution.ts`, `server/agents.ts`, `server/team/`, `server/trust/`, `server/managed-gateway.ts`, `server/app.ts`, `server/store.ts`, `server/migrations/`, `server/file-drops.ts`, `server/file-imports.ts`, `server/pack-contributions.ts`, `server/pack-catalogue.ts`, `server/workspace-routes.ts`, `server/workspaces.ts`, `server/permission-routes.ts`.
- **Client:** `client/console/Shell.tsx`, `BoardView.tsx`, `TeamView.tsx`, `ThreadView.tsx`, `Composer.tsx`, `FollowUpQueue.tsx`, `Need.tsx`, `Wake.tsx`, `useWake.ts`, `Workspaces.tsx`, `Palette.tsx`, `paletteEntries.ts`, `PermissionPanel.tsx`, `types.ts`, and whichever files render the `Automations` and `Readiness` views; all of `client/inventory/`; `client/App.tsx`, `client/Settings.tsx`, `client/task-create.ts`, `client/work-start.ts`, `client/ready-queue.ts`, `client/approval-decisions.ts`.
- **Control plane:** all of `services/control-plane/` — `contract/`, `migrations/`, `src/`, `wrangler.jsonc`, `README.md`.
- **Tests:** `tests/`, `server/**/*.test.ts`, the four Playwright configs, `scripts/gates.ts`, so you can say which tests break under each change.

Do not stop at `grep`. Read how a `Task` flows from `task-create.ts` through admission, the ready queue, execution, review and history. The ADR's biggest cost is "every consumer of `Task` is touched"; your report must list them.

## Investigate, decision by decision

For each of D1–D11, with file paths and line references:

**What exists.** Types, stores, routes, components and tests that already implement part of it, on main and in open prompts. Name prompt IDs. Where MI01–MI09, B01–B03 or PB01–PB04 already cover a piece, say which prompt owns it and whether the ADR adds scope to it or should wait behind it.

**What must change.** Per file: edit / add / remove, one line each, grouped by proposed worktree. Call out ripples: `Task.assignedTo` widening from `Slot`; `Priority` becoming required; `TaskState` gaining `'submitted'`; `moves.by` moving from `Owner` to an actor that can be a person; `BUSINESS_PERMISSIONS` becoming contract v2 and what that does to stored `AccessProfile` revisions.

**What conflicts.** Known suspects:

- **Data owner (D8, D9, D10, D11).** Where do people, messages, completion rules and reports live? MI-DEMO says a control-plane database does not become a second Tasks/Runs/History owner; MI00 fixes the contract. Read `services/control-plane/migrations/` and `server/store.ts` / `server/migrations/` and say what each owns today. What does `AccessAssignment.personId` resolve to — a control-plane member, a `server/business/` record, both? If MI00 has not fixed the contract, give the options and their consequences.
- **Ready queue vs. automations (D7).** Read `planReadyQueue` and the automation scheduler. Do they share `READY_QUEUE_LIMITS.global`? Can a person-priority task preempt an automation at a safe point today, and what is a safe point in `server/execution.ts`? Is there one run object to carry a class on?
- **Acceptance vs. completion (D11).** H17's `Task.acceptance?: AcceptanceDeclaration` — is `CompletionRule` a sibling for people or the same thing with a `kind`? Read `shared/verification.ts` and its consumers before answering.
- **Team mail vs. people messages (D10).** Confirm from `server/team/` that `MailboxMessage` cannot reasonably hold person-to-person mail, or show how it could.
- **Files from a phone (D11).** Can the MI-DEMO operational API accept an attachment through `file-drops` / `file-imports` without widening the remote boundary? Where do `client/inventory/` photos go today, if anywhere?
- **`Project` from a phone (D6).** What is `Project` bound to — a filesystem folder, a worktree? Can a customer project created on the Owner Surface exist without a folder on the founder's desktop?
- **Pack tiles (D2).** Can `PackUiAffordance` carry a view today or only an affordance? Read `server/pack-contributions.ts` and where `'ui'` contributions are rendered.
- **`WorkforceWorker` (D6, D9).** Its `id` and `roles[]` — can they be the same `personId` and the same profiles as `business-access`, or is workforce a separate roster today?
- **Shell (D1).** `client/inventory/` — does it already contain a responsive shell (sign-in, rail, layouts) or only inventory screens?

**What tests break.** Existing unit, gate and Playwright tests failing under each change, and the new tests each worktree needs before review.

## Deliverable

One file in the discovery worktree: `docs/implementation/owner-surface-discovery-2026-09-25.md`. Structure:

1. **Versions inspected** — main commit, package version, ADR revision, PRs merged since the package's last refresh.
2. **Verdict per decision** — a table: D#, status (`stands` / `stands with changes` / `already exists — reuse` / `conflicts` / `blocked by <prompt>`), one line why.
3. **Edit / add / remove list** — grouped by proposed feature worktree; every entry `path — edit|add|remove — what`. Complete on `Task` consumers and on `BUSINESS_PERMISSIONS` consumers.
4. **Proposed worktrees** — name (plain lowercase hyphenated), branch `feature/<name>`, scope, prerequisites (prompt IDs and other worktrees), size (files, rough lines), and the charter's safe-prerequisite subset if one exists.
5. **Conflicts and escalations** — each with evidence and the nearest workable alternative. Anything needing Andrew's decision is a question, not a recommendation dressed as one.
6. **Answers to the ADR's section 6** — from the code, or marked as an owner decision with the options laid out.
7. **Package impact** — which existing prompts gain scope, which new prompts are needed, where they sit in `RUN_ORDER`. Do not edit the package; propose the edit.
8. **What the ADR got wrong** — plainly. Corrections for rev 5.

Plain sentences. No "leverage", no "robust", no restating this prompt. A reader who has not seen this prompt should be able to act on the report.

## Boundaries

- Read-only on the application, the site, other worktrees and the package. The only file you create is the report. If you must draft a type change to reason about its ripple, do it in scratch space and paste the relevant lines into the report; leave no edited source anywhere.
- No commits, pushes, branch creation beyond the one discovery worktree, package edits, `RUN_ORDER` or checksum changes, DONE markings, dependency installs, running the app against real credentials, or contacting Aaron or any customer.
- Running existing tests read-only to confirm current state is fine. Do not modify tests.
- If a file this prompt names is missing on main, say so and continue; do not fabricate its contents.
- Stop when the report is complete. If context runs short, write what you have with a clear "incomplete after section N" marker and a resume note.

## What Andrew wants from this

A report he can hand to a builder model per worktree, in his priority order (task priority and assignments first), with the confidence that the builder will not discover a conflict with MI-DEMO, `business-access` or the control plane halfway through. Aaron's perspective — a normal employee who rarely uses AI — is the reference for what the surface has to feel like; where the code makes that hard, say so rather than bending the requirement.
