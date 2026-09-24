# Automations Milestone B: implementation record

Version 2026-09-24.1. Lane `automations-b`, branch `feature/automations-milestone-b`, based on
`origin/integration/overnight-batch-1` (Milestone A and the H07 Ready scheduler), with `origin/main`
merged before the final push. Linear DIO-91 (OPS-08), DIO-92 (OPS-09), DIO-93 (OPS-10, in-app part
only), parent DIO-89.

- **Specification:** `docs/product/2026-09-19-automations.md` 2026-09-19.1, sections 5–10, the A
  matrix in section 9 and Milestone B in section 12.
- **Binding decisions:** Milestone A work order 2026-09-24.2, D1–D5 (Andrew's). Nothing here
  reopens them: the scheduled run is the same deterministic `weekly-brief` procedure (D1), saves with
  today's authority and asks for no approval (D2), stops before writing when a source is missing (D3),
  and lives on the same Nectovia-group screen (D4). No step here asks for an approval, so D5 has
  nothing to build.
- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project
  Memory 2026-09-23.1. None is edited by this lane; the exact patch is in section 8.

## 1. What shipped

The Milestone B acceptance test, from the specification:

> The job starts at its interpreted time without a person pressing Run, or visibly records why it
> could not. Restart, sleep, DST, duplicate dispatch, pause races, stale source, expired grant and
> exhausted budget tests behave as specified.

An owner or admin opens **Automations**, saves a schedule ("Every Monday at 8:00 a.m.
America/New_York"), sees the next three runs the host computed, and presses **Turn on schedule** — a
separate, recorded act. The row then reads **Scheduled** with its next run. At the slot, with nobody
pressing anything, the host admits the brief through the same admission Run once uses, and the run,
Task and saved draft appear exactly as a manual run's do. A missed, skipped or blocked slot is
recorded as an occurrence with its reason and raises one attention item, shown on the row and in the
output project's **Needs you**. **Pause** stops future slots (and says so in the runs list as
"Skipped — paused"), **Resume** re-grants with fresh authority, **Turn off** returns it to
**Manual — not scheduled**. All of it survives a restart and none of it is revived by one.

| Slice | Result | Files |
|---|---|---|
| B1 | Pure calendar-time slots: IANA timezone, daily/weekly, DST gap and overlap rules, next-run preview, the missed-run plan, words. No clock. | `shared/automation-schedule.ts`, `tests/automation-schedule.test.ts` (43) |
| B2 | Contract: `ScheduleTrigger`, occurrence file v2, `AutomationDefinition` (revisions, control, acts, attention), `HostRecord`, schedule labels and facts, the `scheduled` count, `ScheduleView`, `AttentionView`. | `shared/automations.ts`, `tests/automations-projection.test.ts` |
| B3 | Stored definition and host heartbeat, versioned, unknown versions refused, never pruned. | `server/automation-definitions.ts` |
| B4 | One admission for a press and a slot; the schedule gate; recorded skips; the pass; attention; schedule controls; History entries. | `server/automations.ts`, `server/automation-routes.ts` |
| B5 | The scheduler: a clock and nothing else. Wired into the app with an injectable clock and interval. | `server/automation-scheduler.ts`, `server/app.ts` (12 lines) |
| B6 | Console: schedule section and editor, next runs, this computer, Enable/Pause/Resume/Turn off, missed and skipped runs, attention with Mark as seen, Needs you rows. | `client/console/AutomationSchedule.tsx`, `client/console/automation-schedule-api.ts`, `client/console/automation-attention.ts`, `client/console/AutomationsPage.tsx`, `client/console/automations.css`, `client/console/activity.ts`, `client/console/Shell.tsx` (9 lines) |
| B7 | Integration and browser proof. | `tests/automation-scheduler.test.ts` (23), `tests/console-activity.test.ts` (+1), `tests/automations.spec.ts` (+1), updates to `tests/automation-occurrences.test.ts` and `tests/automation-routes.test.ts` |

## 2. How it works

### Records

**`AutomationDefinition`** (contract version 1), stored at
`<data>/workspaces/automations/definitions/<organizationId>.json` in `{ v: 1, organizationId,
definitions[] }`. Milestone A derived the definition; B stores one because the schedule needs
somewhere to live.

- `revisions[]`: `{ revision, at, by, schedule: { cadence, weekday, time, timezone }, catchUpMinutes }`.
  An edit appends one and never rewrites another (A13, A35).
- `control`: `off`, or `enabled { since, grant }`, or `paused { since, by, reason, grant }`. The
  `grant` is the recorded authority of the act that turned it on: `{ personId, at, configuration:
  { revision, digest }, hostId }`.
- `acts[]`: every edit, enable, pause (with its in-flight receipt), resume and turn-off.
- `attention[]`: the deduplicated items (section 2, Attention).
- `generation`: bumped on every change; a change sent against an older generation is a 409
  `automation_definition_conflict` (A24).

A file from another contract version is refused for that organization and left untouched, exactly as
the occurrence file is; its schedules never run.

**`TriggerOccurrence`** gains a second trigger kind, and the occurrence file's envelope moves to
**version 2**:

```ts
interface ScheduleTrigger {
  kind: 'schedule';
  commandId: string;          // 'schedule:<revision>:<slot, compact UTC>', e.g. schedule:1:20260928T120000Z
  payloadDigest: string;      // payloadDigest({ automationId, slot, definitionRevision })
  slot: string;               // the slot's instant, UTC ISO: its identity
  local: string;              // intended local date and time, 'YYYY-MM-DD HH:MM'
  timezone: string;
  shifted: 'gap' | null;      // that local time did not exist, so it ran when the clocks jumped
  definitionRevision: number;
  enabledBy: string;          // whose recorded enable it runs under
  hostId: string;
  late: boolean;              // a catch-up after the computer was off
}
```

A v1 file (Milestone A) is read as it is and written back as v2. A Milestone A build refuses a v2
file and leaves it alone, so a rollback never misreads a scheduled occurrence as a manual one and
never revives anything (A12, A30).

**Host record**, `<data>/workspaces/automation-host.json`: a stable `hostId` minted once per data
folder, the computer's name, and `lastSeenAt`, the scheduler's heartbeat. It is what "last checked"
means on the screen, and nothing more.

### One scheduler, one admission

`AutomationScheduler` (`server/automation-scheduler.ts`) owns a clock and nothing else. Every 30
seconds it takes the store lock, writes the heartbeat, and calls `AutomationService.schedulePass()`.
The first pass runs at startup, before the first request, so missed slots are recorded as soon as
the computer is back.

**Why not the H07 Ready queue.** H07's only admission is the Work start path (`admitWork`), which
starts a Task on its selected engine route. The brief is a deterministic harness procedure that the
bridge starts only with the pinned input its occurrence carries (`bridge.start(…, pinned)`), which
the Work start path cannot carry; feeding a Ready task would start the wrong route or need a second
path into the procedure. The Ready queue also has no clock: it is driven by store changes. So this
module owns only the clock, and admission stays single: `AutomationService.admission()` is the one
function both a Run once press and a due slot go through. A slot differs only in the trigger it
records and a `gate` that runs first.

**The pass**, per enabled definition: take the slots after
`max(control.since, revision.at, newest covered slot)` up to now that have no occurrence of any
revision (`planDue`); record every slot that passed unseen as missed; admit at most the most recent
one, when it is on time or within the catch-up window; for a paused definition, record every such
slot as "Skipped — paused". Then follow the scheduled runs: a run that failed, is waiting for data or
needs a check raises one attention item; the newest completed scheduled run clears the items before
it (except missed runs, see Attention).

**The gate** at fire time, in order, each a recorded refusal with its own words:

1. `assigned_to_another_computer` — the grant's host is not this computer. No takeover (A08).
2. `schedule_authority_lost` — whoever turned it on is no longer an active owner or admin. Diomedes
   never runs it under a removed member's name (A15).
3. `schedule_owner_not_signed_in` — this computer is signed in as someone else.
4. `configuration_changed` — the active setup is not the revision and digest it was turned on for
   (A13).
5. `schedule_budget_unbounded` — the procedure's budget has model calls or no finite bound (A22).

Then the same admission as Run once: setup and output binding (A14), the one-active-run-per-project
overlap rule (A09, "Skipped — previous run still active"), the occurrence written `admitting`, the
run started with its deterministic id, and the occurrence settled. A missing source stops the run as
**Waiting for data** before anything is written (D3, A17).

**Identity.** The command id is derived from the definition revision and the slot, inside the
organization's occurrence file keyed by automation, so a duplicate dispatch — two passes, a retried
pass, a restart mid-pass — replays to the same occurrence and returns a duplicate receipt (A05). A
slot instant that already has an occurrence under *any* revision is never admitted again, so an
innocuous edit cannot manufacture a second occurrence for the same intended slot (A35).

**Atomic boundary (A10).** Every schedule change and every pass holds the store lock. A pause that
lands first makes the pass record "Skipped — paused"; a pass that lands first admits the slot, and the
pause's recorded act follows it with an `inFlight` receipt naming the run it did not stop.

### Time (A04)

- Calendar time in a named IANA zone, never a fixed offset or an interval (`+05:00` and
  `every: '24h'` are refused).
- **A local time that does not exist** (clocks go forward through it) runs at the next valid
  instant, the moment the clocks jump, and the occurrence says so (`shifted: 'gap'`, "moved by the
  clock change").
- **A repeated local time** (clocks go back) runs once, at its first occurrence: there is one slot
  per local date.
- The clock is injected (`createApp({ automationClock, automationTickMs })`); every schedule record
  uses it, and the pure functions take their instants as arguments.

### Missed work and this computer (A02, A03)

- Every slot that passed while Diomedes was not running is recorded as **Missed — computer was
  off**, naming the slot and when the computer was last seen.
- Only the most recent missed slot may still run, and only within the catch-up window (default 2
  hours; choices never, 1, 2 or 4 hours). A backlog never runs. Slots older than 400 days are not
  listed one by one.
- The row shows **Scheduled** only while the schedule is on, assigned here, and the heartbeat is
  under 5 minutes old. Otherwise it reads **Waiting for computer** with the last-known time. Nothing
  claims a live outage alert: the screen says nobody is alerted while this computer is off.

### Attention (A31, OPS-10 in-app)

One item per underlying issue: an open item of the same kind and code absorbs new occurrences (a
week of missed days is one item with a count, not seven), and a repeated pass adds nothing. Kinds:
`missed`, `skipped`, `blocked`, `failed`. A new item writes one History entry in the output project.
Items are shown on the Automations row with **Mark as seen** (any active member; it changes no
authority) and in the output project's **Needs you** (`GET /api/projects/:id/automation-attention`,
merged into the activity projection as rows that open Automations). A clean scheduled run clears
failed, skipped and blocked items before it; turning the schedule on, resuming or turning it off
addresses blocked items; **missed items stay until someone has seen them**. No push, email or phone
channel exists, and the screen says so ("Nothing is sent by push, email or phone").

### Console

The row: the label (Scheduled / Paused / Waiting for computer / Manual — not scheduled, and A's
attention labels, which outrank them), the trigger text, the **Next run**, attention items, and the
runs list with "Scheduled · Mon 28 Sep 2026, 8:00 a.m." and each missed or skipped slot's outcome.
The detail's **Schedule** section: the schedule, its state and who set it, the next three runs (or
"Would run" while off), the missed-run policy in one sentence, this computer and its last check,
Edit / Turn on schedule / Pause (with an optional reason) / Resume / Turn off for owners and admins,
and a Changes disclosure. The editor previews the next three slots with the same shared functions the
host uses and says "Saving does not turn it on." Settings > Engines language: flat rows on hairlines,
compact bordered controls; every machine string has `min-width: 0` and wraps or truncates; the column
is `.col`'s alone.

## 3. Proposed defaults (conservative; Andrew's to confirm or change)

1. **DST gap**: a local time that does not exist runs at the moment the clocks jump (the work order
   for this lane). **This differs from the specification's section 6 proposed default ("skip and
   record the omission").** Skipping is one line in `resolveLocal`'s caller; Andrew should pick one.
2. **DST overlap**: runs once, at the first occurrence (matches the specification).
3. **Missed runs**: every missed slot is recorded; only the most recent may catch up, within **2
   hours** of its time; a backlog never runs. Per-schedule choices: never, 1, 2 or 4 hours.
4. **On time** means within 2 minutes of the slot; later is a catch-up and says so.
5. **Pass interval** 30 seconds; the heartbeat reads **unknown** after 5 minutes.
6. **Enabling** is a separate act from saving, by an owner or admin, and records a grant (person,
   setup revision and digest, this computer). A setup answer, a pack activation, a configuration
   change, a restart or a rollback never turns a schedule on.
7. **Who controls a schedule**: owners and admins edit, turn on, pause, resume and turn off. The
   specification lists pause as its own permission; letting any member pause (safe: it only stops
   future runs) is the obvious alternative.
8. **Resume** is a fresh grant by whoever resumes, checked now; slots during the pause never run.
9. **Editing a schedule that is on** keeps it on under the original enable grant, from the next slot.
10. **A changed setup blocks the schedule** until an owner or admin turns it on again
    (`configuration_changed`). The alternative — follow the newly active setup — would let a setup
    change silently redirect an unattended job.
11. **The person who turned it on must be the one signed in** on this computer
    (`schedule_owner_not_signed_in`); a removed or demoted enabler blocks it (`schedule_authority_lost`).
12. **Budget at a schedule's admission**: a procedure with any model call or no finite bound never
    starts on a schedule. The brief has 0 model calls and 9 units, so no payer is involved.
13. **Overlap**: one active run per output project (A's rule); a due slot while it is busy is
    skipped and recorded, never queued.
14. **Paused slots** are recorded as "Skipped — paused" and raise no attention (the person chose it).
15. **Run once stays available while the schedule is paused**: pause is about automatic starts.
16. **Attention resolution**: missed items stay until seen; others clear on the next clean run or
    when the schedule is turned on again.
17. **Only daily and weekly** calendar schedules, one time per day; no intervals, no cron text.
18. **The occurrence file is version 2**; a Milestone A build refuses it rather than misreading it.

## 4. Acceptance-matrix coverage (Milestone B)

| Case | Proof |
|---|---|
| A01 | `automation-scheduler` "a recorded weekly answer never runs…" (answer, saved-but-off schedule, summary 0 scheduled); `automations.spec` "Saving does not turn it on". |
| A02 | "slots missed while the computer was off…" (2 missed, latest caught up late, one item); "back after the window…" (4 missed, no run, one item absorbs a second outage). |
| A03 | "the last-known heartbeat is shown; a stale one reads as unknown…". No live alert is claimed. |
| A04 | `automation-schedule` DST table (New York and London, gap and overlap, 2026 dates); `automation-scheduler` "a nonexistent local time runs when the clocks jump; a repeated one runs once". |
| A05 | "a duplicate dispatch of one slot is one run and a receipt"; A's Run once double press still passes. |
| A06 | "a crash between recording a slot and starting its run": settled once, never re-admitted, attention raised. |
| A08 (part) | "a schedule assigned to another computer never runs here". One host only; takeover is not built or claimed. |
| A09 | "a slot while the previous run is still active is skipped and recorded". |
| A10 | "a pause that lands before the slot suppresses it…"; "a slot admitted before the pause keeps its run…". |
| A12 | "pause and turn-off survive restarts and are never revived by one"; occurrence v2 refused by a v1 build. |
| A13 | "a setup activated after the schedule was turned on blocks it…"; each occurrence keeps its `definitionRevision`. |
| A14 | Unchanged from A, through the same admission (no substitute project). |
| A15 | "a removed member is never impersonated"; "someone else signed in on this computer…". |
| A17 (part) | "a missing source stops a scheduled run as Waiting for data, raised once…". |
| A22 (part) | "without a hard spending bound nothing starts on a schedule; an exhausted budget stops before writing". |
| A24 (part) | "a change sent against an older read is refused". |
| A31 (in-app) | Missed-outage dedup, waiting-for-data raised once across passes, `console-activity` Needs you row. |
| A35 | "an edit after a slot ran never runs that slot again…"; "an edit before the slot moves it…". |

**Deferred:** A07, A11, A19–A21, A27 (no external effect exists: the brief sends nothing); A08
beyond "never take over" (multi-host, Milestone D); A16, A18 beyond D3's stop; A23 (no approval
step); A25, A26 unchanged from A; A28–A30, A32–A34 as their milestones require. Push, email and
phone notifications (A32, spec section 10) are not built and not claimed.

## 5. Known gaps and follow-ups

- **Not run here**: the packaged Windows journey on named build bytes, and an independent review.
  Both are required for acceptance, as for Milestone A.
- The home screen's "Needs you" ledger counts projects from `status.needsYou`, which does not include
  automation attention; only the project's own Needs you does.
- **Stop current run** stays where it is today (the run's thread). The Automations screen offers
  Pause future runs, not Stop.
- The schedule runs only while Diomedes is running on this computer. No background service,
  auto-start, wake or remote status exists, and nothing claims one.
- Identity is still the labelled local development fixture; the owner/admin checks are real over it.
- Times of acts are shown in the viewer's own zone; slot times are shown in the schedule's zone
  (named in the schedule line).

## 6. Tests

- `tests/automation-schedule.test.ts` (43): DST table, slots, preview, the missed-run plan, words,
  validation.
- `tests/automation-scheduler.test.ts` (23): the host with an injected clock, section 4's cases.
- `tests/automations-projection.test.ts`: 11 schedule label rows and the Milestone B summary.
- `tests/automation-occurrences.test.ts`: envelope v2, v1 read and rewritten, v3 refused.
- `tests/automation-routes.test.ts`, `tests/console-activity.test.ts`: additive.
- `tests/automations.spec.ts` (Playwright, own host, injected clock): save → still manual → turn on →
  Scheduled with the next run → the due slot runs with nobody pressing Run once → pause → the next
  slot is "Skipped — paused" and no Task is added.

## 7. PILLAR IMPACT

- Advances P06 (bounded unattended ownership: a draft-only job starts on its own, records every slot
  it did not run and why), P05 (inspectable setup: schedule, revisions, grant, host, next runs), P04
  (point-of-work visibility: missed and skipped slots in the runs list and Needs you), P09 (scoped
  authority: an explicit, recorded, revalidated grant; no model spend on a schedule) and P08
  (meaningful human decisions: one item per issue, no approval spam).
- Risks guarded: a second execution path (one admission), autonomy inflation ("Scheduled" only while
  on and checked; "Waiting for computer" otherwise), stale health claims (last-known time only),
  impersonation (a removed enabler blocks), silent redirection (a changed setup blocks).
- One conflict to settle: proposed default 1 (DST gap) differs from the specification's proposed
  default. No pillar conflict.

## 8. Proposed canonical-doc patch (for the integrator; not applied here)

**Live Roadmap** (`docs/DIOMEDES_LIVE_ROADMAP.md`, next version), section 2:

- Heading: "## 2. Automations — Milestones A and B implemented; C–D planned".
- Replace the Milestone B bullet with: "Milestone B / OPS-08 + OPS-09 (+ OPS-10 in-app) —
  implemented 2026-09-24 on `feature/automations-milestone-b` (record
  `docs/implementation/2026-09-24-automations-b.md`): a stored, versioned AutomationDefinition holds a
  daily/weekly local-time schedule in a named IANA timezone; an owner or admin turns it on as a
  recorded act; one small scheduler admits each due slot through the same admission as Run once, with
  a slot identity derived from the automation, revision and slot; DST, missed-slot (record all, catch
  up only the latest within 2 hours), pause/resume, overlap, fire-time revalidation (host, enabler
  authority, signed-in person, setup revision, spending bound) and restart recovery are proved by
  tests; missed, skipped, blocked and failed slots raise one in-app attention item per issue, also in
  the project's Needs you. One assigned host; no background service, multi-host, push, email or phone.
  The packaged Windows journey and independent review are still required for acceptance."
- Milestone C bullet: replace "scoped notifications" with "scoped notifications beyond in-app
  attention".
- Open decisions paragraph, append: "Automations B proposed defaults awaiting confirmation (record
  section 3), notably a nonexistent local time runs when the clocks jump (the specification proposed
  skip), and who may pause a schedule."

**Project Memory** (`docs/DIOMEDES_PROJECT_MEMORY.md`, next version), "Automations — stable meanings
and truthful state":

- Replace the status sentence with: "Milestones A and B are implemented (2026-09-24): the weekly brief
  is manual until an owner or admin turns a schedule on; a scheduled slot is a TriggerOccurrence
  admitted into RunService by the same admission as Run once. C–D remain planned."
- Add: "**Scheduled** means a schedule is turned on, assigned to this computer, and this computer has
  checked it within the last few minutes. Otherwise the label says **Paused**, **Waiting for
  computer** or **Manual — not scheduled**. A slot that did not start is recorded with its reason —
  **Missed — computer was off**, **Skipped — paused**, **Skipped — previous run still active** or a
  **Blocked** reason — and never runs later except the one bounded catch-up."
- Add: "**Turning a schedule on** is an explicit, recorded act by an owner or admin that grants
  authority for that schedule on that computer against that setup revision. A setup answer, pack
  activation, configuration change, restart or rollback never turns one on or revives one."

**QUESTIONS.md**, open: "Automations B — confirm the DST-gap default (run at the jump vs. skip and
record), who may pause a schedule (owners/admins vs. any member), and whether a changed setup should
block a schedule until it is turned on again. Proposed defaults in
`docs/implementation/2026-09-24-automations-b.md` section 3."

Cloud synchronisation of the canonical documents is pending with this patch.

## ROADMAP IMPACT

Section 2 Milestone B moves from "planned" to "implemented; packaged Windows journey and independent
review pending" once this branch merges (patch in section 8). OPS-10 is implemented for in-app
attention only; its push/email/phone part stays planned under Milestone C.

## BUILD STATUS

See the lane's final report for the exact counts of its own final run (tsc, full vitest, vite build,
the three Playwright gate specs, and `tests/automations.spec.ts`), on the Linux sprint container.
Publication: branch pushed; no pull request, merge, release or deployment by this lane.
