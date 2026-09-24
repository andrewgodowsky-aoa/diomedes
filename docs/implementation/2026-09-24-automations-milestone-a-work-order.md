# Automations Milestone A: work order

Version 2026-09-24.2, written 2026-09-24 at Andrew's request ("write the Milestone A work order").
Version .1 records Andrew's answers to D1–D4 and his direction on remembered approvals (section 3).
Version .2 records his choice of a one-click learned offer for remembered approvals (D5).

- **Base:** `main` `a49f027` ("Merge pull request #66 … retired-settings-removal").
- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
  2026-09-23.1, Automations specification 2026-09-19.1, delivery mapping
  `docs/implementation/2026-09-19-automations-work-items.md` 2026-09-19.1.
- **State:** planning only. No product code is written or changed by this order. D1–D4 are decided
  (section 3). The order authorizes no publication on its own: each slice still needs Andrew's
  approval to commit and publish.
- **Traceability:** BUS-10 foundation (roadmap section 2, Milestone A; specification section 12).

## 1. What Milestone A delivers

The specification states the acceptance test, and this order does not change it:

> From the normal Console, a person finds the configured job, sees that it is manual, runs it
> through existing authorized admission, follows its real work/evidence, sees a missing-input
> failure, and returns after restart to the same saved records. No competing RunService or
> fabricated automation record is introduced for unrelated tasks.

In practice:

1. The reserved **Automations** destination opens a real Console screen.
2. That screen lists the active workspace's weekly brief as **Manual — not scheduled**, with a detail
   view of what it reads, where it writes, who owns it and what it does not do.
3. **Run once** admits the brief through the existing Task, Session and Harness `RunService` path,
   with a command identity, so a double-click cannot make two runs.
4. Every run links to the real Task and thread, the saved draft in Files and its review record.
5. A missing configured source shows as **Waiting for data** and names the file. It never shows as a
   clean result.
6. After a restart, the screen rebuilds from the same durable records.

Out of scope for A: any scheduler, timer, trigger other than a person pressing Run once, event
ingestion, notifications, multi-host, templates and value reporting. Those belong to Milestones B–D.

## 2. What the source says today

These findings are from `a49f027`. File references are exact at that commit.

**The brief runs as a direct write, outside admission.**
- `POST /api/workspace/organizations/:organizationId/brief` (`server/workspace-routes.ts:286-324`)
  calls `WeeklyBriefService.run` (`server/weekly-brief.ts:275-385`), which calls
  `store.writeRecorded(... kind: 'weekly-brief', review: true)`.
- It creates no Task, Session, HarnessRun or Need.
- It carries no `commandId`, so two presses make two History entries
  (`tests/file-imports-ui.spec.ts:227` expects 2).
- The History entry has `taskId: null`, so the Console activity projection
  (`client/console/activity.ts:131-190`) never sees it.

**A missing configured source does not stop the brief.**
- `gather()` skips an unreadable path (`weekly-brief.ts:246-272`).
- The draft is still written, with a "Sources that could not be read" section. This is pinned by
  `tests/weekly-brief.test.ts:291-299`.
- `missing` is not returned over HTTP and is not stored anywhere machine-readable.
- The bundled variants' source selections are placeholder names (`resources/industry-variants/*.json`),
  so a fresh setup usually produces missing sources.

**Configuration is per organization, not per project.**
- There is one active `ConfigurationManifest` per organization
  (`shared/configuration.ts:320-365`), stored at `<data>/workspaces/configuration/<org>.json`
  (`server/configuration.ts:117-129`).
- The project that receives the draft comes from a separate output binding
  (`shared/workspaces.ts:240-259`, `server/workspaces.ts:1447-1519`).
- The manifest has no schedule field. A non-manual `first-run` answer becomes a non-blocking
  `unsupported-schedule` issue, "recorded but stays inactive" (`shared/packs.ts:586-595`).

**Authority to run is active membership only.**
- Running with the configured sources needs only active membership
  (`workspaces.ts:930-936`, `1500-1519`).
- Choosing per-run sources needs owner or admin (`workspace-routes.ts:296`,
  `configuration.ts:313-328`).
- Identity is a labelled development fixture (`server/workspaces.ts:8-13`,
  `shared/release-gates.ts:66-86`). There are no verified tenant controls.

**The harness already has a deterministic precedent.**
- `server/harness/capabilities/format-report.ts` runs pure tools, then an idempotent
  `write-project-file` tool, through `RunService`. It produces a Task, a Session, a durable run file,
  an exact write receipt keyed by the step's idempotency key, and restart recovery.
- `server/harness/bridge.ts` accepts only `format-report` and `codex-report`:
  - capability selection at `:102-105`
  - the Task label at `:122-128`
  - the recovery allow-list at `:506-512`
- `RunService` gates approval per tool declaration (`server/harness/run-service.ts:689-710`). A tool
  with `approval: false` still needs the principal to hold its permission (`:430`).

**Nothing is built behind the Console destination.**
- `ShellView` is `Thread | Board | Team | Discovery | Readiness` (`client/console/types.ts:23-28`).
- Automations is a reserved, unavailable row in Shell (`client/console/Shell.tsx:1559-1566`, `1593`).
- It is also a reserved row on the Diomedes home (`client/App.tsx:108-116`, `573-580`, `599`,
  `789-792`).
- `goTo` (`Shell.tsx:1606-1624`) and `currentDestination` (`:1598-1604`) have no branch for it.
- The only client caller of the brief is the workspace panel's `BriefFiles.tsx:115-134`. It shows a
  sentence and never links to the saved draft.

**A copy defect is waiting in the approval text.**
- `needFromWaitingStep` promises undo for every non-idempotent action (`server/harness/present.ts:139-140`).
- The specification (section 5.3) asks for this to be fixed during implementation.

## 3. Decisions

These decisions were Andrew's to make under `AGENTS.md`: two touch permission meaning and all four
touch product behaviour. **Andrew took all four recommendations on 2026-09-24** ("go with your
recommendations on D1 through D4"). The alternatives are kept below so the reasoning stays
inspectable; they are not open.

### D1. How Run once executes

- **Decided: a deterministic `weekly-brief` harness capability run by `RunService`.**
  - It follows the `format-report` pattern: read sources, compose, save the draft.
  - No model is called, and attribution names a Diomedes procedure started by the person (decision 8).
  - This is the path Milestone B's scheduler will feed, so B adds a trigger and not a second execution
    path.
- Not taken: wrap the existing direct write in a command receipt and a mirror Task.
  - This is smaller now.
  - It leaves the brief outside `RunService`, which the roadmap names as the durable execution spine,
    and B would have to move it anyway.
- **Affects:** A3, A4.

### D2. Whether saving the draft needs an approval each time

- **Decided: keep today's authority.**
  - The save tool declares `approval: false` and needs `write-project-file`.
  - It may write only to the destination named by the admitted configuration revision.
  - The draft is saved with `review: true`, so it appears as a waiting Change the person keeps or
    undoes, exactly as now.
  - This neither widens nor narrows who may do what today.
- Not taken: `approval: true`. Each run would stop at an exact write approval, like `format-report`.
  That is a click on every manual run, and approval spam once B schedules the brief (decision 7).
- **Affects:** A3. In A the "Needs approval" label has no brief fact behind it. It stays in the A1
  label set for any later step that declares approval.
- Andrew's direction on approvals generally, given with this answer, is recorded in D5.

### D3. What a missing configured source does

- **Decided: stop before writing.**
  - The run ends as **Waiting for data** and names each missing file.
  - Nothing is written.
  - This satisfies specification sections 4.3 and A16/A17: missing coverage must not produce a
    reassuring result.
- Not taken: keep writing a draft, but label the result **Partial — N sources missing** and never
  **Draft saved**.
- This changes behaviour only on the new admission path. `composeBrief`, and the rehearsal service's
  direct call (`server/rehearsal/service.ts:147`, `:205`), keep their current, tested behaviour.
- **Affects:** A3, and A1's labels.

### D4. Where the destination lives and what the Diomedes home row does

- **Decided placement:** automations belong to the workspace, not the open project, so the Console
  row moves from "Not ready yet" into the **Nectovia** group beside AI engines, Settings and Projects.
- **Decided home row:** it becomes available.
  - It opens the active organization's output project on the Automations screen.
  - It uses a new `viewRequest` prop on `Shell`, mirroring the existing `sectionRequest` pattern
    (`App.tsx:85`, `561`, `707`).
  - Without an output project it states why and opens nothing.
- Not taken: the Console row becomes live and the home row stays held, with new reason text.
- **Affects:** A5.

### D5. Remembered approvals: learned, offered, accepted once (Andrew, 2026-09-24)

Andrew, answering D2: "We want to reduce unnecessary clicking for approvals, usually one click per
project is enough for an item to be remembered as safe." And later: "one key point we advertise is
'learns your approvals', as in if you constantly click 'yes, send email', then we shouldnt have to
keep doing that for months over and over." Asked to choose between silent learning and a one-click
offer, he chose **the one-click offer**.

**Decided:** Diomedes may learn which approvals a person keeps giving, but learning only *offers*.
Authority is remembered only when the person accepts, and one acceptance per item per project is
enough. There are two routes to a remembered approval, and both are an explicit act by the person:

1. **Remember when approving.** An approval prompt may offer **Approve and remember in this
   project** beside the exact **Approve**. One click then covers that item in that project from then
   on.
2. **The learned offer.** When a person keeps giving the same exact approval in a project, Diomedes
   notices and asks once, for example: "You've approved *send the weekly brief to ops@yourco.com* 4
   times in this project. Stop asking?" Accepting creates the remembered approval. Declining is
   remembered too, so the offer does not come back for that item unless the person asks for it.

**What a remembered approval is:**
- It is a scoped grant: decision 7 made concrete ("a user-approved task or project grant may cover
  routine work inside an explicit scope"). The grant is itself the exact approval of a bounded
  pattern, so each later action inside it is still evidenced against a recorded, exact decision.
- It records who accepted it, when, from which route, and exactly what it covers.
- It can be revoked from one place, and the automation's **Rules and access** section shows what is
  remembered for it.
- It is shown truthfully: a later action taken under it says it ran under a remembered approval,
  naming whose and since when. It never looks like a fresh human click.

**What it covers.** Proposed default, to confirm when the first such step is built: the same
automation or procedure, the same action, the same destination or recipients, in the same project.

**It asks again** when anything falls outside that pattern:
- a new recipient or destination
- a wider or different action
- the person revokes the grant, or loses membership or the authority it rested on
- the credential or connection it acts through changes

**What learning and configuration can never do** (Project Memory: "repeated approvals … and learning
cannot expand authority"; `AGENTS.md`, standing decision 7):
- A remembered approval never exists without the person's click. Repeated approvals alone never
  create one.
- A grant never widens itself.
- A configuration change, rollback, pack activation, restart or model change never creates a
  remembered approval or revives a revoked one.

**Always asks.** Proposed default, to confirm with Andrew when the first effectful connector is
built: moving money or making a payment, deleting or irreversibly destroying data, and changing
credentials, members or permissions keep an exact approval each time, and are never offered for
remembering. Sending an email or a report *is* rememberable, which is the case Andrew named.

**Offer threshold.** Proposed default: offered after 3 identical exact approvals in a project. It is
a product setting to tune with evidence, and never a silent grant.

**Effect on Milestone A: none to build.** Under D2 the brief asks for no approval at all. No A slice
adds an approval prompt or an offer. The first step that uses D5 is expected in Milestone B or C,
for example a delivery step.

**What is built today.** Remembered project grants exist only for Codex writes
(`server/trust/scope-grants.ts`, which pins `engine: 'codex'`). The general form (both routes, the
learned offer, the decline memory and the one revocation place) is Trust work, with its own owner and
review.

**Website.** "Learns your approvals" is accurate for this design only if the copy says it *offers* to
remember them. For example: "Notices the approvals you keep giving and offers to stop asking." The
site is a separate repository (`diomedes-site`). Its wording is checked there, and no copy may
describe the feature as shipped until it is built and proved.

**Canonical documents.** This is a permission default, so it belongs in the canonical documents, not
only in this order. Proposed Project Memory addition, pending cloud synchronisation and A8:

> **Remembered approval.** Diomedes learns which approvals a person keeps giving, and learning only
> offers. A person may approve and remember an item in a project, or accept a learned offer to stop
> asking; one acceptance per item per project is enough. The result is a scoped, revocable, attributed
> grant for that exact pattern. It never widens, never survives revocation or loss of authority, and
> is never created by repeated approvals, learning or configuration without the person's click.
> Payments, destructive actions and permission or credential changes always ask.

The roadmap's section 6 B "exact consequential approvals" should gain one clause at the same time:
a remembered approval accepted by the person is an exact approval of a bounded pattern, so it
satisfies that rule.

Not a decision, but recorded here so nobody makes one by accident: **who may press Run once** stays
the current rule.
- Any active member may run with the configured sources.
- Only an owner or admin may choose per-run sources.
- The specification's distinct trigger permission (section 8) waits for verified identity, because a
  permission check over fixture identity would prove nothing.

## 4. Records

Following specification section 5.1: add only what does not exist.

**AutomationDefinition: not stored in A.**
- The definition is **derived**, read-only, from four existing records:
  - the active `ConfigurationManifest` (revision, digest, template, owner, sources, destination,
    reviewer, budget, unresolved issues, including a recorded `unsupported-schedule`)
  - the output binding (project)
  - the organization's owner
  - the pack's fixed trigger, `manual`
- Its id is stable: `brief:<organizationId>`.
- A stored, versioned definition arrives in B, when a schedule needs somewhere to live. Storing one now
  would record nothing the manifest does not already hold.

**TriggerOccurrence: stored, new in A.** A0 fixes the exact field names. The shape:

```ts
interface TriggerOccurrence {
  v: 1;
  id: string;                    // 'O-' + digest(organizationId, commandId)
  automationId: string;          // 'brief:<organizationId>'
  organizationId: string;
  tenantId: string;
  trigger: { kind: 'manual'; commandId: string; payloadDigest: string; requestedBy: string };
  configuration: { revision: number; digest: string };   // pinned at admission (A13)
  target: { projectId: string };                         // pinned at admission (A14)
  observedAt: string;
  admission:
    | { state: 'admitting' }
    | { state: 'admitted'; runId: string; taskId: string; sessionId: string; at: string }
    | { state: 'refused'; code: string; reason: string; at: string };
}
```

- It holds references to the run, never the run's state. Run, step and Need state are always read
  from `RunService` and `ProjectState`.
- **Storage:**
  - Path: `<data>/workspaces/automations/<organizationId>.json`.
  - Envelope: `{ v: 1, organizationId, occurrences[] }`.
  - Written with `jsonWrite`.
  - An unknown `v` is refused and left alone, as `server/configuration.ts:131-161` and
    `server/job-caps.ts:199-209` do.
  - Occurrences are retained, never pruned (decision 10).
- **Replay:**
  - The same `commandId` with the same `payloadDigest` returns the existing occurrence as a duplicate
    receipt.
  - The same `commandId` with a different digest is refused with 409, matching `assertReplay` in
    `server/command-admission.ts:34-64`.

**AutomationOverview: a projection, never stored.**
- Built on request from the derived definition, the occurrences, `RunService.get`, and the output
  project's Tasks, Sessions, Needs, Changes and History.
- It carries `observedAt`.
- It feeds a pure label function in `shared/`, so the same facts always give the same label.

## 5. Slices

Each slice is independently reviewable. The order is the dependency order.

| Slice | Result | Files (new unless marked) | Proposed owner |
|---|---|---|---|
| **A0** | D1–D4 answered 2026-09-24 and recorded here (section 3). Remaining: freeze the field names. The answers go into `QUESTIONS.md` with A8, once code carries them, because that file records only what the code settles. | this file | Integrator |
| **A1** | Types and pure projection: `TriggerOccurrence`, `AutomationView`, `automationLabel(facts)`, summary counts. No I/O. | `shared/automations.ts`, `tests/automations-projection.test.ts` | Opus (bounded worker) |
| **A2** | Occurrence store: load, validate, refuse unknown `v`, replay by command identity, restart. | `server/automations.ts`, `tests/automation-occurrences.test.ts` | Opus |
| **A3** | `weekly-brief` capability and bridge generalisation | see below | Fable (hot); Opus drafts the capability file |
| **A4** | Admission and routes | see below | Fable (hot); Opus drafts the routes file |
| **A5** | Console screen | see below | Fable (hot); Opus drafts the page |
| **A6** | Fix the undo promise in `needFromWaitingStep` (`present.ts:139-140`) so reversibility depends on the destination. | `server/harness/present.ts` (shared harness), its test | Fable |
| **A7** | Browser proof and test migrations | see below | Astra writes the independent matrix tests; the owner of each slice fixes its own tests |
| **A8** | Implementation record, roadmap section 2 status, memory wording, `QUESTIONS.md`, cloud sync or an exact pending patch. | `docs/…` | Integrator |

### A1: projection and labels

- The labels are the specification's own (section 4.1), used only when their facts exist. Each is a
  projection, never a stored state:
  - **Manual — not scheduled:** the trigger is manual and nothing is running or waiting. This is the
    resting label in A.
  - **Running:** the latest admitted run is `queued` or `running`.
  - **Needs approval:** the run is `waiting` on an approval. Under D2 the brief never produces this;
    it is kept for a later step that declares approval (D5).
  - **Waiting for data:** the latest run stopped at source gathering with missing sources (D3). The
    detail names the files.
  - **Setup incomplete:** there is no active configuration, the configuration is not ready, there is
    no output binding, or the output project is missing or unresolved. The detail uses the server's
    own refusal codes (`shared/workspaces.ts:266-270`, `weekly-brief.ts:287-305`).
  - **Needs investigation:** the run is `reconcile_required` or `failed`, or the admission was left
    `admitting` with no run after recovery.
- **Last result** is kept separate from the label (specification section 5.2):
  - **Draft saved for review**, **Kept**, **Undone** or **Not written**.
  - **Sent** never appears, because nothing is sent.
- A recorded `unsupported-schedule` is shown as its own sentence ("A weekly start is recorded but stays
  inactive"). It never counts as active (A01).
- **Summary counts** are Configured, Running, Needs attention and Not ready, each defined in a caption.
  A manual job is Configured and never Active.
- **Usefulness figures are not shown in A.** Where a row would carry them it says **Not measured**
  (A34).

### A2: occurrence store

- It uses the `configuration.ts` pattern: a per-organization file, an in-memory map, and a `store.locked()`
  caller.
- **Recovery on start:** an occurrence left `admitting` is completed or refused.
  - If its deterministic run id exists in the output project, it becomes `admitted` with that run.
  - Otherwise it becomes `refused` with code `interrupted_before_start`. No effect can have happened,
    because the write is a later step of a run that does not exist. The occurrence is not re-admitted
    silently. The person presses Run once again (A06).

### A3: the `weekly-brief` capability

- **New file** `server/harness/capabilities/weekly-brief.ts`, with manifest
  `{ id: 'weekly-brief', version: 'v1', requestedPermissions: ['write-project-file'], maxTurns: 4 }`.
- **Tools:**
  - `read_brief_sources` (pure)
    - Reads the pinned selection through `store.current`, the side-effect-free read.
    - Returns each source with its SHA-256 and returns `missing[]`, so missing coverage becomes durable
      step evidence and not only markdown.
    - Per D3, a non-empty `missing[]` ends the run as failed with reason `waiting_for_data`, before any
      write.
  - `compose_brief` (pure): wraps the existing `composeBrief` unchanged.
  - `save_brief_draft`
    - Declared `effect: 'idempotent'`, `permission: 'write-project-file'`, and `approval: false` (D2).
    - Before writing it rechecks, under `store.locked()`:
      - live membership, output binding and project ownership through `resolveBriefTarget`
        (A14, A15)
      - that the destination is still the pinned one
      - the `expected` hash of the previous draft, which is the existing base check.
    - It writes through `store.writeRecorded` with `review: true`, `kind: 'weekly-brief'`, the run's
      Task and Session, and `label` = the step idempotency key. The recovery comparison is copied from
      `format-report.ts:108-123`.
- **Driver:** the steps are fixed, so the driver is a scripted procedure, not a model. Engine
  attribution reads as a Diomedes procedure with `model: null`. No model call or provider route is
  involved, and no model is named (decision 8).
- **Bridge generalisation** (`server/harness/bridge.ts`, `server/harness/host.ts`; shared harness
  files, Fable):
  - Replace the two-capability fallback at `:102-105` with a registry lookup.
  - Name the Task from the capability's label, not `FORMAT_REPORT.label` (`:122-128`).
  - Add `weekly-brief` to the recovery allow-list (`:506-512`).
  - Register it in `host.ts` next to `registerFormatReport` (`:394`).
  - The existing one-active-Session-per-project rule (`bridge.ts:116-117`) stands. A refusal becomes a
    refused occurrence reading "The output project already has work in progress". This is the declared
    overlap rule for A (A09, first part).
- **Run input pins** organization, tenant, configuration revision and digest, destination, and the
  source selection with SHAs when the sources were chosen per run (A13, A36 first part). The run
  tenant stays `local`, as in `bridge.ts:169-172`. The organization binding is carried in the input
  and rechecked at the write.

### A4: admission and routes

- **New file** `server/automation-routes.ts`, mounted in `server/app.ts` (hot) beside the workspace
  routes (`app.ts:1022`). The global loopback, origin and client-header gates (`app.ts:927-982`) apply
  unchanged.
- **Endpoints:**
  - `GET /api/workspace/organizations/:organizationId/automations`
    - Returns the overview for an active member.
    - For anyone else it returns 404 `organization_not_found`, the existing `mine()` behaviour. No
      title, count or existence leaks (A25).
  - `GET /api/workspace/organizations/:organizationId/automations/:automationId`
    - Returns the detail and its occurrences, newest first, paged.
  - `POST /api/workspace/organizations/:organizationId/automations/:automationId/run`
    - Body: `{ commandId, sources? }`. `sources` follows today's rule: owner or admin only, pinned by
      SHA.
    - Under `store.locked()` it does five things in order:
      1. Replays by command identity.
      2. Writes the occurrence as `admitting`.
      3. Resolves the target.
      4. Calls `bridge.start` (the caller owns the lock, per `bridge.ts:92`) with the deterministic run
         id.
      5. Marks the occurrence `admitted` or `refused`, with the server's own code.
    - Returns the occurrence and a presented run.
- **The legacy brief route converges.**
  - `POST …/brief` becomes a thin caller of the same admission, generating a `commandId` when the old
    client sends none. There is then one path to a brief draft, not two.
  - The workspace panel's **Prepare the weekly brief** button (`BriefFiles.tsx`) keeps working, and
    gains a link to its occurrence.
  - The rehearsal service keeps its direct, trusted call, because it writes synthetic drafts and is not
    a user-admitted automation.
- **Client helpers** in `client/api.ts` (hot): `listAutomations`, `automationDetail`,
  `runAutomation`. `runAutomation` generates the `commandId` once per press and reuses it on retry.

### A5: the Console screen

- **Page:** new `client/console/AutomationsPage.tsx` and `automations.css`.
  - The template is `ReadinessPage.tsx` and `readiness.css`: an abort-and-epoch loader, the
    `loading`, `error` and `role="status"` states, and cards with `<details>` for evidence.
  - Screen primitives come from `console.css`, and the Nectovia treatment comes from
    `nectovia.css:877-930`.
- **List:**
  - One row per automation: name, purpose sentence, project, owner, label and reason, last result and
    time, "Manual — not scheduled" as the trigger, and source freshness (the last run's SHAs and
    time).
  - Rows are ordered by attention first (specification section 4.1).
  - The empty authorized list, a loading failure and a stale list read differently.
  - The Personal workspace, which has no organization, says that automations are set up per business
    workspace and that this one has none. It shows nothing invented.
  - The organization's identity is labelled a local development fixture wherever ownership is shown.
    No production multi-user claim is made.
- **Detail** (specification section 4.2):
  - What it reads, where it writes, who reviews it, and what it does not do: it sends nothing and
    changes nothing but its one draft.
  - What remains manual.
  - The pinned configuration revision.
  - The list of occurrences.
  - Each admitted occurrence links to:
    - its Task on the Board (`focusTaskId`) and its thread
    - the saved draft (`openDocument`, `Shell.tsx:1460-1464`)
    - its waiting Change for keep or undo, using the existing review action
  - Refused occurrences show their reason and the next step.
- **Run once:**
  - Shown when the person may run the brief.
  - Disabled with a stated reason while the output project is busy.
  - While running, the row follows the run through the existing state and SSE mirror. The label is
    never inferred from elapsed time.
- **Wiring** (`Shell.tsx`, hot):
  - `'Automations'` in `ShellView`
  - a render block beside Readiness (`:1933-1937`)
  - a branch in `goTo` and in `currentDestination`
  - drop `unavailableReason` and `reserved` from the row
  - the D4 group
  - a palette view entry (`client/console/paletteEntries.ts:409-420`)
  - D4's `viewRequest` prop in `ShellProps` and `App.tsx`
- **Standing UI decisions:**
  - Every name, path and project title cell gets `min-width: 0` and truncation (decision 5).
  - The page column follows the one `.col` rule (decision 6).
  - No sentence repeats a caption (decision 4).
  - Status is never shown by colour alone, and focus is restored after the run and dialogs.

### A7: tests that must change or be added

- **Vitest:**
  - A1 labels, table-driven over the facts.
  - A2 replay, conflict and restart.
  - A3 capability:
    - missing source means no write
    - the pinned revision is kept after a mid-run activation
    - an unbound output project means no write
    - write replay after a crash returns the same entry
  - A4 routes:
    - a non-member sees nothing
    - a double press gives one run and a duplicate receipt
    - a busy project gives a refused occurrence
    - a restart keeps every occurrence and link
  - The legacy `POST …/brief` still passes `tests/business-output-routes.test.ts`, with added
    assertions for the occurrence and run it now creates.
- **Update:** `tests/weekly-brief.test.ts:291-299` stays as it is. It tests `composeBrief`, which D3
  does not change. The new-path behaviour is tested in the A3 file.
- **Update:** `tests/everything-hover.test.ts:27-60` uses Automations as its reserved-row fixture.
  - Re-point it at Connections (unavailable, not reserved), or keep an invented id.
  - The reserved behaviour itself still needs a test, because the `reserved` flag stays in
    `Everything.tsx`.
- **Update:** `tests/diomedes-home.spec.ts:156-158` asserts the home Automations button is
  `aria-disabled`. Under D4, assert instead that it opens the Automations screen, or
  states why when there is no output project.
- **Update:** `tests/file-imports-ui.spec.ts:128-227` keeps its two-briefs History count. The two
  presses carry different `commandId`s, so it still expects two entries. It additionally expects two
  Tasks.
- **New:** `tests/automations.spec.ts` (Playwright), added to `playwright.config.ts` `testMatch`
  (`:82-114`). It seeds over the API the way `configuration-ui.spec.ts:47-127` does. The ordinary path
  is the acceptance test in section 1:
  1. Open the Automations screen from Everything (the `openDestination` helper,
     `tests/fd03-readiness.spec.ts:21-24`).
  2. See **Manual — not scheduled**.
  3. Press Run once, and a double press yields one run.
  4. Follow to the Task and the draft.
  5. Remove a source, run again, and see **Waiting for data** naming it.
  6. Restart and see the same occurrences.
  7. Check keyboard-only operation and 200% zoom.

## 6. Acceptance-matrix coverage

The specification's cases are proof obligations, not passed tests. Milestone A takes these and no
others:

| Case | What A proves |
|---|---|
| A01 | Manual label. A recorded weekly answer is shown as inactive and never counted as active. |
| A05 | One command identity gives one run. A duplicate gets a receipt. |
| A06 | A crash between the occurrence and the run is resolved on restart, with no duplicate and no silent loss. |
| A09 (part) | Declared overlap rule for A: one active run per output project, and the refusal is recorded. |
| A12 (part) | A restart does not revive a cancelled or refused occurrence. |
| A13 | The admitted configuration revision is pinned. A later activation affects only later runs. |
| A14 | An unbound or missing output project blocks. No substitute project. |
| A15 (part) | Membership is rechecked at admission and at the write. |
| A16, A17 (part) | A missing or unreadable source is named, and no clean result is shown. |
| A25 | Non-members get no existence, title, count or result, in the list, the detail or a deep link. |
| A26 | The screen rebuilds from records after a restart, with no ghost "Running". |
| A34 | Usefulness reads **Not measured**. Nothing is invented. |
| A36 (part) | Per-run sources are bound by SHA and rechecked before the write (already true, kept). |

Explicitly deferred:
- A02–A04, A07, A08, A10, A11, A35: timing, schedules, hosts and uncertain external effects. B, or C
  for a real external send.
- A18–A21, A31, A32: data shapes, delivery, events and notifications. C.
- A22–A24, A27–A30, A33: budgets across children, approvals across people, rehearsal effects,
  external harnesses, migrations and offboarding. As their milestones require.

The brief has no external effect, so A07 and A27 have nothing to prove in A. The implementation record
must say that plainly, not mark them passed.

## 7. Ownership, claims and gates

- **Hot files** (`AGENTS.md`, unified execution program):
  - `server/app.ts`, `client/api.ts`, `client/console/Shell.tsx`, and the shared harness contracts
    (`server/harness/bridge.ts`, `host.ts`, `present.ts`) are Fable's.
  - Other workers draft the new files and return patches for these.
  - `shared/types.ts` should not need a change. If it does, it is Fable's too.
- **Claims:**
  - Paths are claimed atomically through the pinned coordination tool before editing, and released
    when the patch returns.
  - This cloud checkout has no coordination root (`.git/diomedes-coordination` is absent), so no claim
    was read or taken while writing this order. Claims must be taken on the machine that holds the
    root.
- **Review:** Astra reviews each exact base-plus-patch candidate and owns the independent matrix
  tests in section 6.
- **Gates:** before any merge to `main`, run all four with the heavy-test slot held, and report the
  real counts from that run:

  ```
  npx tsc --noEmit
  npx vitest run
  npx vite build
  npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts
  ```

  Also run the new and updated specs from section 5, A7.
- **Packaged Windows journey:** the section 1 path on named build bytes. The specification requires it
  for implementation acceptance, and it is separate from the gates.
- **Publication:** each slice needs Andrew's approval to commit, push or release. Approving this order
  approves none of them.

## 8. What this order does not claim

- Nothing in it is implemented.
- Milestone A is not started. D1–D4 are answered; implementation starts when the field names are
  frozen and the first slice is claimed.
- No site copy, release note or roadmap status may call Automations available until A7 and A8 exist
  with proof.
- A manual brief with a Run once button is not an automation that runs on its own. The screen, the
  records and every report must keep saying **Manual — not scheduled** until Milestone B ships a
  scheduler.

PILLAR IMPACT:
- Plans P04 (point-of-work visibility), P05 (inspectable setup), P06 (bounded ownership: here, bounded
  honesty about none), P07 (truthful attribution of a model-free procedure) and P12 (the same records
  for Personal and Business).
- Risks guarded: a second execution path (D1), approval spam (D2), and a reassuring result over
  missing data (D3).
- No pillar conflict found.

ROADMAP IMPACT: none yet. D5's proposed Project Memory wording and its section 6 B clause wait for the
canonical-document update and cloud synchronisation. On landing, A8 moves roadmap section 2 Milestone A from "approved plan,
implementation pending" to the status its evidence supports.

BUILD / PUBLICATION / DEPLOYMENT STATUS: documentation only. No build, test run, commit to `main`,
release or deployment.
