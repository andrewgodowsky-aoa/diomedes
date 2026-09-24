# Automations Milestone A: implementation record

Version 2026-09-24.1. Lane `automations-a`, branch `feature/automations-milestone-a`, based on `main`
`559a1ab`. Linear DIO-89 (parent) and DIO-90 (BUS-10).

- **Work order:** `docs/implementation/2026-09-24-automations-milestone-a-work-order.md` 2026-09-24.2.
  Decisions D1–D5 are Andrew's and are implemented as written; nothing here re-opens them.
- **Specification:** `docs/product/2026-09-19-automations.md` 2026-09-19.1; mapping
  `docs/implementation/2026-09-19-automations-work-items.md` 2026-09-19.1.
- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
  2026-09-23.1. None is edited by this lane; the exact patch is in section 8.
- **State:** slices A0–A7 implemented with tests; A8 is this record. The work order's file:line
  references were re-located against `559a1ab`.

## 1. What shipped

From the normal Console a person opens **Automations** (Everything, the Nectovia group, or Ctrl K),
sees the active business's weekly brief as **Manual — not scheduled**, presses **Run once**, follows
the run to its Task, its saved draft and its keep-or-undo review, sees a missing source read **Waiting
for data** with the file named and nothing written, and after a restart finds the same occurrences,
runs and links rebuilt from the same records. `tests/automations.spec.ts` walks exactly that path in
the built app.

| Slice | Result | Files |
|---|---|---|
| A0 | Field names frozen (section 2). | this record, `shared/automations.ts` |
| A1 | Contract types, the pure `automationLabel`, `occurrenceResult`, `automationSummary`, `byAttention`. No I/O, no clock. | `shared/automations.ts`, `tests/automations-projection.test.ts` |
| A2 | Occurrence store: one versioned file per organization, replay by command id with 409 on a changed request, restart recovery of `admitting`, never pruned. | `server/automations.ts` (`AutomationOccurrences`), `tests/automation-occurrences.test.ts` |
| A3 | Deterministic `weekly-brief` harness capability run by `RunService`; bridge capability registry; recovery allow-list; host registration. | `server/harness/capabilities/weekly-brief.ts`, `server/harness/bridge.ts`, `server/harness/host.ts`, `server/weekly-brief.ts` (four helpers exported), `tests/automation-weekly-brief.test.ts` |
| A4 | Admission and routes; the legacy brief route converges on the same admission; client helpers. | `server/automations.ts` (`AutomationService`), `server/automation-routes.ts`, `server/workspace-routes.ts`, `server/app.ts`, `client/api.ts`, `tests/automation-routes.test.ts`, `tests/business-output-routes.test.ts` |
| A5 | Console screen and wiring; the D4 home row. | `client/console/AutomationsPage.tsx`, `client/console/automations.css`, `client/console/Shell.tsx`, `client/console/types.ts`, `client/console/paletteEntries.ts`, `client/App.tsx`, `client/console/Workspaces.tsx`, `client/console/workspace.css` |
| A6 | `needFromWaitingStep` promises undo only for a recorded change to project files; a run stopped for missing data says so. | `server/harness/present.ts`, `tests/harness-present.test.ts` |
| A7 | New and migrated tests (section 6). | `tests/automations.spec.ts` (+ `playwright.config.ts`), `tests/diomedes-home.spec.ts`, `tests/everything-hover.test.ts`, `tests/file-imports-ui.spec.ts` |

## 2. A0: frozen field names

`TriggerOccurrence` (contract version 1), stored at `<data>/workspaces/automations/<organizationId>.json`
in the envelope `{ v: 1, organizationId, occurrences[] }`:

```ts
interface TriggerOccurrence {
  v: 1;
  id: string;                    // 'O-' + sha256(organizationId + '\n' + commandId), first 32 hex
  automationId: string;          // 'brief:<organizationId>'
  organizationId: string;
  tenantId: string;
  trigger: { kind: 'manual'; commandId: string; payloadDigest: string; requestedBy: string };
  configuration: { revision: number; digest: string } | null;   // pinned at admission (A13)
  target: { projectId: string; projectName: string } | null;    // pinned at admission (A14)
  sources: { path: string; sha: string }[] | null;              // per-run choice, by SHA (A36)
  observedAt: string;
  admission:
    | { state: 'admitting'; runId: string }
    | { state: 'admitted'; runId: string; taskId: string; sessionId: string; at: string }
    | { state: 'refused'; code: string; reason: string; at: string; runId?: string };
}
```

Differences from the work order's sketch, each additive:

- `admitting` carries its `runId`. The run id is deterministic (`'R-brief-'` + the first 24 hex of
  sha256(occurrence id)), so recovery could derive it; storing it makes the record self-describing.
- `configuration` and `target` are `null` only on a refusal recorded before either resolved (no active
  setup, no output project). An admitted occurrence always has both.
- `target.projectName` is kept so a refusal, or a project that later disappears, still names it.
- `sources` records a per-run selection, bound by SHA-256, when an owner or admin chose one.
- `refused.runId` names a run the bridge created and then stopped, when one exists.
- `payloadDigest` is `payloadDigest({ automationId, sources, projectId })` (`projectId` only with
  sources), from `server/command-admission.ts`.

The harness run input (`weeklyBriefInputSchema`) pins `occurrenceId`, `organizationId`, `tenantId`,
`projectId`, `configuration { revision, digest }`, `destination`, `selection`, `chosen` and `at`. The run
tenant stays `local`, as every bridge run's does; the organization binding travels in the input and is
rechecked at the write.

Labels (`AutomationLabel`): `manual` "Manual — not scheduled", `running`, `needs-approval`,
`waiting-for-data`, `setup-incomplete`, `needs-investigation`. Results (`AutomationResult`):
`draft-saved` "Draft saved for review", `kept`, `undone`, `not-written`. There is no "Sent".

Routes: `GET /api/workspace/organizations/:organizationId/automations`,
`GET …/automations/:automationId?page=N` (20 per page, newest first) and
`POST …/automations/:automationId/run` with `{ commandId, sources?, projectId? }`.

## 3. How it works

**Admission** (`AutomationService.admit`, caller holds `store.locked()`): membership (`assertMine`, a
404 for anyone else), the automation id, a valid command id (400 otherwise), the owner-or-admin check
when `sources` are sent (403), then replay by command id (a duplicate receipt, or 409
`automation_command_conflict` for a changed request). It then resolves the target and the active
configuration in the legacy route's order, checks per-run sources by SHA, and applies the declared
overlap rule for A — one active Session per output project (A09, first part). Any refusal from here on
is **recorded** as a refused occurrence with the server's own code and words. Otherwise it writes the
occurrence `admitting`, calls `bridge.start` with the deterministic run id and the pinned input, and
settles the occurrence `admitted` (with the Task and Session) or `refused` (with the error's code).

**The capability** (`server/harness/capabilities/weekly-brief.ts`, D1): three registry tools run
through `RunService.step` by a fixed procedure — no `NativeAgent`, no model adapter, and a budget of
zero model calls, so a model call is impossible rather than merely unused.

1. `read_brief_sources` (pure) reads the pinned selection, or the per-run choice by SHA, through the
   side-effect-free `store.current`, and the previous draft; it returns each source's SHA-256 and a
   `missing[]` list as durable step evidence. A non-empty `missing[]` fails the run as
   `waiting_for_data` before any write (D3).
2. `compose_brief` (pure) wraps the unchanged `composeBrief`, reading the sources from the recorded
   read step (checked by its output hash) and the **pinned** configuration revision (A13).
3. `save_brief_draft` (`idempotent`, `write-project-file`, `approval: false`, D2) rechecks under the
   store lock: membership, output binding and project ownership through `briefTarget` (A14, A15), that
   the project is the pinned one, that the destination is the pinned revision's, the per-run SHAs
   (A36), and the previous draft's hash through `writeRecorded`'s own base check. It writes with
   `review: true`, `kind: 'weekly-brief'`, the run's Task and Session, and `label` = the step's
   idempotency key; a crash between the write and the step's commit replays against that History
   receipt (the comparison copied from `format-report.ts`).

Every step, and the Session from its first moment, carries an application origin with executor
`diomedes:weekly-brief`; the Session engine is `diomedes-procedure` with `model: null`. The Console
reads it as "Nectovia application action" and names no model (decision 8). The person who pressed Run
once is the occurrence's `requestedBy`.

**Bridge generalisation** (`server/harness/bridge.ts`): a `HarnessProcedure` registry replaces the
two-capability fallback; the Task is named from the capability's label; recovery accepts registered
procedures; the Session-engine lists used by recovery and notes include procedure engines; `start`
takes an optional `pinned { runId, input }`, and a procedure starts **only** with it (a bare request
naming `weekly-brief`, for example through the generic work route, is a 400 and creates nothing).
`host.ts` registers the procedure next to `registerFormatReport` when the app passes
`weeklyBrief: AutomationService.host(workspaces, configuration)`.

**Recovery** (A06, A12): `AutomationService.init()` runs after `harness.init()`. An occurrence left
`admitting` becomes `admitted` if its deterministic run exists in the pinned project, otherwise
`refused` with `interrupted_before_start`; nothing is re-admitted silently, and settled occurrences are
never revisited. The harness's own recovery resumes an interrupted brief run, whose save replays
against its receipt.

**The legacy route** (`POST …/brief`) is now a thin caller of the same admission. It generates a
`commandId` when the workspace panel sends none, keeps its old refusal words and statuses (409, 413,
415, and 403/404 before admission), waits outside the lock for the run to settle (30 s), and answers
with the old fields plus `occurrenceId`, `runId` and `taskId`. A missing source is now a 409
`waiting_for_data` naming the file. The rehearsal service keeps its direct, trusted call.

**The screen** (`AutomationsPage.tsx`) follows `ReadinessPage.tsx`: an abort-and-epoch loader;
distinct loading, error, stale ("Could not refresh… Showing what was read at …"), empty ("Nothing is
set up to run yet") and Personal ("Personal has no automations") states; four summary counts, each
with its caption; one row per automation ordered by attention, with the label as a mark plus a word,
its reason, project, last result and time, and source freshness. The trigger is shown on the row when
the label is not already "Manual — not scheduled", so it is said once (decision 4). The detail is a
disclosure (open by default when there is one row) with What it does, What stays manual, Rules and
access (owner labelled a local development identity, no remembered approvals, pinned setup version,
**Usefulness: Not measured**), and Runs, each with its four stages (real denominators: "N of M read"),
its missing files, links to the Task's thread (where its Change is kept or undone), the Board and the
draft, and a Record disclosure with the occurrence id, run id, revision and source SHAs. Run once uses
`aria-disabled` rather than `disabled`, so focus stays on it through the run; the outcome is said once
in a polite status line when the run settles. The run is followed through the host's own SSE `session`,
`review` and `history` events for the output project, never a timer. Machine strings use `.mono.lc`
and every text cell has `min-width: 0` with wrapping or truncation; the column is `.col`'s alone.
Nectovia draws the label as the Readiness result does (glyph and mono label).

**Wiring**: `'Automations'` in `ShellView`; the render block after Readiness; `goTo` and
`currentDestination` branches; the Everything row loses `unavailableReason`/`reserved` and joins the
Nectovia group (D4); a palette view entry; `viewRequest` / `onViewRequestTaken` props on `Shell`,
mirroring `sectionRequest` and `firstTask`. The Diomedes home row is available: it opens the active
organization's output project on the Automations screen, or states why in a status bar and opens
nothing (Personal, no output project, or a bound project that is gone). The workspace panel's brief
result gains "See its run in Automations".

## 4. Proposed defaults recorded here (conservative, for Andrew to confirm or change)

1. **An occurrence file from another version** is refused for that organization only (409
   `automation_record_unreadable`) and left untouched; every other organization and the app keep
   working. `configuration.ts` and `job-caps.ts` stop the app instead; a record the Console only reads
   did not seem worth refusing to start over.
2. **Source size**: the 4 MB total cap the per-run path already had now applies to the configured
   sources too.
3. **History attribution of the draft** changes from `actor: 'you'` with the sentence "Diomedes drafted
   … for your review" to `actor: 'diomedes'` with the procedure's application origin, linked to the run's
   Task and Session. `Store.writeRecorded` rewrites a session-linked entry's sentence to "Diomedes
   changed 1 file"; the richer sentence is not kept (changing that rule in `store.ts` would touch every
   session-linked write). The kind stays `weekly-brief`.
4. **A setup that asks for a reviewer first** (`person-after-reviewer`) is shown truthfully: the brief
   procedure runs no reviewer in this build, and the detail says so.
5. **Listing**: the brief is listed once its organization has any configuration revision or any
   occurrence; before that the list is empty rather than an invented row.
6. **Label precedence**: Running, Needs approval and Needs investigation from the latest run come first;
   then Setup incomplete; then Waiting for data; then Manual. A cleanly stopped run rests as Manual with
   the result "Not written". A refusal for a busy project rests as Manual; `interrupted_before_start`
   reads Needs investigation.
7. **Budget**: 9 units and 9 tool calls (three steps, three attempts each) so a crash-replayed save is
   affordable; model calls 0.
8. **Reads take the store lock**, so an `admitting` occurrence is never seen half-way.
9. **Placement**: first in the Console's Nectovia group, and first in the home's Nectovia group (the
   home's "Not ready yet" group is gone because nothing is left in it).

Who may press Run once stays the current rule, as the work order records: any active member with the
configured sources; owner or admin for per-run sources.

## 5. D5: remembered approvals

Nothing to build in Milestone A, and nothing was built. The brief asks for no approval (D2), so no
slice adds an approval prompt, a "remember" choice or a learned offer. The screen's Rules and access
section says "Saving the draft asks for none: it waits for review instead. Nothing is remembered." The
Project Memory wording and the roadmap clause are in section 8, as the order asks.

## 6. Acceptance-matrix coverage (Milestone A cases only)

| Case | Proof |
|---|---|
| A01 | `automations-projection` resting label; `automation-routes` "shows the brief as manual…" (a recorded weekly answer is `scheduleRecorded`, counts as configured, never running); `automations.spec` step 2. |
| A05 | `automation-routes` "a double press is one run and a duplicate receipt"; `automations.spec` double click → one occurrence, one Task; `automation-occurrences` replay and 409. |
| A06 | `automation-occurrences` restart recovery; `automation-routes` "an admission a crash left behind is settled once". |
| A09 (part) | `automation-routes` "a busy output project gives a refused occurrence". |
| A12 (part) | `automation-occurrences` "a refusal is not revived"; `automation-routes` second restart changes nothing. |
| A13 | `automation-weekly-brief` "the pinned revision is kept after a later activation". |
| A14 | `automation-weekly-brief` "an output project that is no longer bound gets no write", "a different project is never substituted". |
| A15 (part) | `automation-weekly-brief` "membership is rechecked at the write"; admission checks membership first. |
| A16, A17 (part) | `automation-weekly-brief` "a missing source stops the run before anything is written"; `automation-routes` Waiting for data; `automations.spec` step 5. |
| A25 | `automation-routes` "a non-member gets no existence, title, count or result" (list, detail, run, unknown id). |
| A26 | `automation-routes` restart rebuild; `automations.spec` step 6 (no ghost Running). |
| A34 | Usefulness is `not-measured` in the contract; the detail reads "Not measured". |
| A36 (part) | Per-run SHAs checked at admission, at the read step and again before the write (`save_brief_draft`); `business-output-routes` keeps its stale-selection refusal. |

**A07 and A27 have nothing to prove in A**: the brief has no external effect and sends nothing. They
are not marked passed. All other cases stay deferred as the order lists.

Tests updated: `tests/weekly-brief.test.ts` unchanged (it tests `composeBrief`, which D3 does not
change). `tests/everything-hover.test.ts` keeps the reserved-row test on an invented `reports` id.
`tests/diomedes-home.spec.ts` asserts the home row now states why it opens nothing in Personal.
`tests/file-imports-ui.spec.ts` keeps two brief History entries and adds two Tasks; its button locator
is now exact, because the brief's Task, named "Prepare the weekly brief", is now visible in the
Console. `tests/business-output-routes.test.ts` adds the occurrence, run, Task, Session and History
assertions for the legacy route.

## 7. Known gaps and follow-ups

- **Not run here**: the packaged Windows journey on named build bytes, and Astra's independent review
  and matrix tests. Both are required for implementation acceptance and remain open.
- The screen's links open records in the project that is showing. When the output project is another
  one, the run offers "Open <project>", which works for a project in the open-projects bar; otherwise it
  says to open it from Projects.
- "Show on Board" focuses the Task only when it already has a thread.
- `WeeklyBriefService.run` is now called only by the rehearsal service.
- A stored, versioned `AutomationDefinition` is Milestone B's, with the schedule.
- Production Business aggregation still requires verified tenant controls; identity here is the
  labelled local development fixture, and the screen says so.

## 8. Proposed canonical-doc patch (for the integrator; not applied here)

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`, next version):

- Section 2 heading: "## 2. Automations — Milestone A implemented; B–D planned".
- Replace the Milestone A bullet with: "Milestone A / BUS-10 foundation — implemented 2026-09-24 on
  `feature/automations-milestone-a` (record `docs/implementation/2026-09-24-automations-a.md`): the
  Console Automations screen lists the active business's weekly brief as **Manual — not scheduled**;
  Run once admits it through a durable TriggerOccurrence into the `weekly-brief` RunService capability
  (no model call); missing sources stop before writing as Waiting for data; non-members see nothing; a
  restart rebuilds the same records. The packaged Windows journey and independent review are still
  required for acceptance. Production organization aggregation still requires verified tenant controls."
- Section 2, source-audit paragraph: add "At `559a1ab` plus this branch, `ShellView` includes
  Automations and the weekly brief runs through RunService; schedules stay inactive."
- Section 6 B, after "exact consequential approvals": "; a remembered approval the person accepted is an
  exact approval of a bounded pattern and satisfies this rule (D5, 2026-09-24)".

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`, next version):

- In the permissions paragraph ("Settings, remembered preferences, repeated approvals, effort and
  learning cannot expand authority."), append: "A remembered approval is not a remembered preference:
  it exists only when the person accepts it (see Remembered approval)."
- Add, under the permissions definitions:

  > **Remembered approval.** Diomedes learns which approvals a person keeps giving, and learning only
  > offers. A person may approve and remember an item in a project, or accept a learned offer to stop
  > asking; one acceptance per item per project is enough. The result is a scoped, revocable, attributed
  > grant for that exact pattern. It never widens, never survives revocation or loss of authority, and
  > is never created by repeated approvals, learning or configuration without the person's click.
  > Payments, destructive actions and permission or credential changes always ask.

- In "Automations — stable meanings and truthful state", replace the source-audit sentence's status
  with: "Milestone A is implemented (2026-09-24): the weekly brief is a manual automation whose Run once
  is a durable TriggerOccurrence admitted into RunService; its label is a pure projection of records
  (`shared/automations.ts`). B–D remain planned."

**QUESTIONS.md**, under Resolved:

> ### R9. How Run once executes, what it may save, what a missing source does, and where Automations lives
>
> Andrew, 2026-09-24 (work order D1–D4), now settled in code on `feature/automations-milestone-a`:
> Run once is a deterministic `weekly-brief` harness capability run by RunService with no model call
> (D1); saving the draft keeps today's authority — `approval: false`, `write-project-file`, the pinned
> destination only, saved for review (D2); a missing configured source stops the run before writing as
> Waiting for data (D3); Automations sits in the Console's Nectovia group and the home row opens the
> output project on it, or says why (D4). `server/harness/capabilities/weekly-brief.ts`,
> `server/automations.ts`, `client/console/AutomationsPage.tsx`.

Cloud synchronisation of the three canonical documents is pending with this patch.

## PILLAR IMPACT

- Advances P04 (point-of-work visibility: runs, stages and links from the same records), P05
  (inspectable setup: pinned revision, what it reads and writes, what stays manual), P06 (bounded
  honesty: "Manual — not scheduled" everywhere, no scheduler implied), P07 (truthful attribution: a
  Diomedes application procedure, no model named) and P12 (one Project, Task, Session and History
  contract for the brief).
- Risks guarded: a second execution path (the legacy route now converges; the capability is
  RunService's), approval spam (none added), a reassuring result over missing data (stops before
  writing), existence leaks (404 for non-members).
- No pillar conflict found.

## ROADMAP IMPACT

Section 2 Milestone A moves from "approved plan, implementation pending" to "implemented; packaged
Windows journey and independent review pending" once this branch merges (patch in section 8). B–D
unchanged.

## BUILD STATUS

Filled in from the final run before the last push; see the lane's final report for the exact counts.
