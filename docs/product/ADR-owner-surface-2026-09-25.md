# ADR: Owner Surface vs. Operator Console

**Status:** Proposed. D7 is settled for its first delivery (OS01); everything else stays proposed until its lane's owner questions are answered.
**Date:** 2026-09-25
**Revised:** 2026-09-25 (rev 5).
- Rev 5 writes in:
  - Andrew's OS01 decisions of 2026-09-25 (D7);
  - the corrections from the OS-DISC-01 discovery report, section 8 (`docs/implementation/owner-surface-discovery-2026-09-25.md`), summarised in section 7 below.
- Rev 4 was re-based on `origin/main` `90f23fa` (v0.2.0), SHA-256 `8590d6e2…5733`.
- Revs 1–3 were written against a stale local checkout (v0.1.4, 1,156 commits behind). Several things they called "new" already exist on main and are folded in.
**Origin:** Aaron's whiteboard (hub → Projects / Data / Integrations / Settings, chat on every screen) and his job-priority feature request. Owner direction 2026-09-25: Aaron's perspective (a normal employee who rarely uses AI) is the reference; architectural edits are acceptable; staff sign-ins, private messaging and per-account access control are required; task completion reporting is configurable by the boss.
**Next step:** `PROMPT_owner-surface-discovery-2026-09-25.md` (same folder) investigates real main against every decision here and reports what to edit, add and remove. Nothing is implemented from this document alone.

---

## 1. Decision in one paragraph

Nectovia has two audiences and two surfaces. The **Operator Console** is what exists today: the Electron app with `Thread | Board | Team | Discovery | Readiness | Automations`, where Diomedes staff and technical owners configure, approve and watch AI seats. The **Owner Surface** is the authenticated responsive web/PWA the MI-DEMO milestone committed to and whose inventory slice has landed on main, widened from "inventory on an iPad" to "the business on a phone": projects, assignments, people, inventory, messages and the bot, for owners, managers and employees with their own sign-ins. Aaron's sketch is the Owner Surface. It is not a redesign of the console, the two are not merged, and it adds no second agent loop, membership authority, permission system or Files authority (MI-DEMO product boundary). Where main already has the piece — access profiles, workforce, the ready queue, the automation scheduler, the inventory ledger — this ADR builds on it rather than beside it.

## 2. Context — what main actually has (`90f23fa`)

- **Console views:** `ShellView = 'Thread' | 'Board' | 'Team' | 'Discovery' | 'Readiness' | 'Automations'` (`client/console/types.ts`). Connections moved out of the shell.
- **Hierarchy:** `Workspace` (organization, `shared/workspaces.ts`) → `Project` → `Task`. `Mode` now includes `'auto'`.
- **`Task`** (`shared/types.ts`): `state: 'todo' | 'working' | 'waiting' | 'done'`, `owner`, `assignedTo?: Slot | null` (AI seat only), `moves[]`, `acceptance?` (H17). **No priority, no due, no person assignee, no completion report.**
- **Ready queue** (`shared/ready-queue.ts`, `server/ready-scheduler.ts`): decides which Ready tasks Diomedes starts on its own and in what order. Fair across projects (least recently served), and within a project `readyAt → createdAt → taskId`. Board's `policy: 'first' | 'go'` is the on/off for auto-start. **No priority key.**
- **Automations** (`shared/automation-schedule.ts`, `shared/automations.ts`, `server/automation-scheduler.ts`, `server/automations.ts`, `Automations` view): a separate scheduler with `DuePlan` / `ScheduleSlot`. Already its own run system.
- **Access control** (`shared/business-access.ts`, `server/business/`): contract v1. `BUSINESS_PERMISSIONS` is a fixed list (`project:view/create/edit/share/delete`, `inventory:*`, `schedule:*`, `labor:view_own/record_own/view_team/approve`, `membership:*`, `authorization:*`, `finance:*`, …). `AccessProfile` (`systemKind: 'owner' | 'custom'`, immutable revisions) carries permissions; `AccessAssignment` pins a profile revision to a `personId` on `ResourceScope`s; `WorkerProfile` is a ceiling over AI work and never a grant. "Job titles are presentation." **People already have `personId`; there are no `task:*` or `message:*` permissions.**
- **Workforce** (`shared/workforce.ts`, `server/workforce/constraints.ts`): human `WorkforceWorker` with `roles[]`, `availability`, `absences`, `priorWeekMinutes`; `WorkforceDemand` (shifts); `DraftAssignment`. Used for shift scheduling only. **Hours and availability for people exist; nothing links a worker to `personId` or to tasks.**
- **Inventory** (`shared/inventory.ts`, `shared/inventory-workflow.ts`, `server/inventory/`, `client/inventory/`): MI-DEMO landed. `inventorySourceSchema.kind: 'synthetic' | 'approved-file' | 'connected' | 'recorded-ledger'`; bounded pilot snapshot with `authority: 'recorded-ledger'`; "a connected source is provenance, not a second writable master."
- **Team mail** (`MailboxMessage`): `to: Slot`, `from: Slot`, `type: 'message' | 'idle_notification' | 'shutdown_request'`. AI-to-AI only. **No people-to-people messaging anywhere.**
- **Files:** `server/file-drops.ts`, `server/file-imports.ts`, `shared/file-identity.ts`, `FileRecord`.
- **Control plane** (`services/control-plane/`): a Cloudflare Worker (`wrangler.jsonc`) with `migrations/`, `contract/`, `src/`, `tests/`. `server/managed-gateway.ts` resolves membership, tenant and `OrganizationPolicy`.
- **Packs** (`shared/capability-packs.ts`, `shared/pack-contributions.ts`, `server/pack-contributions.ts`, `server/pack-catalogue.ts`): `PackContributionKind` includes `'ui'`; `PackUiAffordance` exists.

What the execution package commits to (MI-DEMO, owner decision 2026-09-19): authenticated responsive web/PWA first; same organization identity, Trust rules, History; no second membership authority; inventory is a reusable capability, remodeling is the first proof; B01–B03 supply shared cloud/auth/tenancy; a control-plane database does not become a second Tasks/Runs/History owner.

What Aaron drew: hub → Projects (Jobs, Production Timeline, Inventory, Employees), Data, Integrations, Settings; chat on every window; cross-navigation without returning home; a per-person priority list.

## 3. Decisions

### D1. Two surfaces, one harness

| | Operator Console (exists) | Owner Surface (MI-DEMO client, widened) |
|---|---|---|
| Who | Diomedes staff, technical owners | Owner, managers, employees — each signed in |
| Where | Electron desktop, loopback server | Hosted, browser/PWA on phone, tablet, desktop |
| Nouns | Project, Task, Need, Session, Change, AI seat | Projects, assignments, people, inventory, messages |
| Primary action | Approve, route, review, configure | See what's mine, do it, report it, ask the bot |
| Data | Local project state | The narrow authenticated operational API MI-DEMO defined; `client/inventory/` is its first screen |

Same harness, same `Task` / `Need` machinery, same organization identity, same `business-access` authorization. The bot's dispatch from the Owner Surface lands on the console's Board.

### D2. Tiles are pack contributions, not hardcoded screens

Jobs / Timeline / Inventory / Employees are a remodel shop's nouns. An industry pack declares its tiles through the existing `'ui'` contribution; the Owner Surface shell renders whatever the organization's active packs contribute. **Core** tiles every organization gets: Projects, Assignments, People, Messages. **Pack** tiles: Inventory (already built), Timeline, Data, and whatever the vertical needs.

```ts
interface PackTile {
  id: string;
  title: string;                       // pack- or org-overridable label
  source: { kind: 'core'; view: string } | { kind: 'connection'; connection: string; view: string };
  layout: 'list' | 'bars' | 'calendar' | 'cards' | 'kpis';
  askContext: string;                  // what the bot is told when chat opens here
  requires?: BusinessPermission[];     // who sees it; checked server-side
}
```

Discovery decides whether `PackUiAffordance` can carry a view or whether `PackTile` is a new contribution kind.

### D3. Read-through by default; one authority always

Connection-backed tiles are projections. The inventory module already states the rule — a connected source is provenance, not a second writable master — and allows a `recorded-ledger` authority for a bounded pilot. That rule generalizes to every pack tile.

Projects, tasks, assignments, people and messages are **native**: Diomedes's own records, same as `Project` and `Task` today. That is the existing system of record, not a second one.

### D4. Home is "what's mine right now", not a button grid

Home = the signed-in person's assignments by priority, unread messages, the needs waiting on them, up to three pinned tiles. The rail carries the rest. Reuses `FollowUpQueue`, `Need`, `ActivityOverview`, `Rail`.

### D5. Chat is context-aware

`Conversation.attachedTo` gains view kinds:

```ts
attachedTo:
  | { kind: 'document' | 'plan' | 'project'; ref: string }   // existing
  | { kind: 'tile'; ref: string }                             // 'inventory'
  | { kind: 'record'; ref: string }                           // 'task:1042', 'person:…'
```

The thread is seeded with the tile's `askContext` or the record. What the bot may do from it is bounded by the asking person's `AccessDecision` (D9), never wider.

### D6. Vocabulary: the customer's words win; `Project` is the customer's project

- **Project.** A remodel job *is* a folder with plans, photos, documents and tasks, which is what `Project` is. So a Diomedes Project **is** the customer's project. No rename; the pack labels it ("Projects", "Jobs"); a standing project holds work that belongs to no single job. `project:*` permissions already exist and apply unchanged.
- **Worker.** Aaron's worker is a human. Internally `Slot` / `TeamMember` / `WorkerProfile` are AI and stay so. To owners and staff, humans are **people** and AI seats are never called workers. `WorkforceWorker` is confusingly named for a human record; discovery decides whether to alias it or leave it.
- **Assignments vs. Board.** Two views over one `Task` table, split by who holds the task:
  - **Assignments** — tasks assigned to a person. "My assignments" is the signed-in person's filter; managers see everyone's. This is the Employees tile's substance and Aaron's priority list.
  - **Board** — tasks assigned to AI seats. Stays in the console; on the Owner Surface it is a read-only "Nectovia is working on…" tile for those with the permission.

```ts
assignedTo?: { kind: 'person'; personId: string } | { kind: 'ai'; slot: Slot } | null;
```

`personId` is the one `AccessAssignment` already uses. Discovery must find the person record that `personId` points to (control-plane membership? `server/business/`?) and whether `WorkforceWorker.id` can be the same id.

### D7. Priority is a prominent 1–5 a person picks; it orders every work list; the ready queue uses it inside each project's fair turn

Settled for the first delivery (OS01, `docs/product/PROMPT_OS01-task-priority-2026-09-25.md`, rev 2) by Andrew on 2026-09-25:

```ts
type Priority = 1 | 2 | 3 | 4 | 5;   // 1 = do first

interface Task {
  // ...existing
  priority: Priority;               // required on every task, AI- and automation-created too; default 3
  due?: string;                     // plain calendar date YYYY-MM-DD as entered; no timezone conversion
  planningRevision: number;         // bumped only by priority and due edits
  priorityMoves?: { at: string; by: Owner; from: Priority; to: Priority; dueFrom?: string; dueTo?: string }[];
}
```

**Levels and labels**
- One number, five levels. Not an importance × urgency matrix. `due` carries urgency when there is a real date.
- Foreman words: **1 Do first · 2 Today · 3 This week · 4 When you can · 5 Backlog.** Default 3.
- Labels are words only; they never auto-decay when a period passes. Packs and organizations may override the words later (not in OS01).

**Migration**
- Legacy tasks migrate to priority 3 and planning revision 1.
- A malformed stored value refuses migration with a backup and a plain message.
- Older builds then refuse the migrated project state, which the release notes must say.

**Ordering**
- One comparator orders every actionable work list: `priority → due (dated first, ascending) → readyAt(task) → scoped stable id`.
- Undated tasks sort after dated ones at the same priority.
- Plan-step order, History, conversation turns and message order are not priority-sorted.

**Ready queue**
- The comparator applies inside each project's line.
- Least-recently-served project fairness, consent holds and limits stay exactly as they are. A priority-1 task in another project still waits its turn.
- This is the one place priority does not override fairness. There is no cross-project override.

**Editing**
- The control appears wherever a task is listed. Choosing a level saves at once and shows "Saving…" and then the result or a conflict message; there is no confirmation step. The due date is edited in the same control.
- Edits carry an expected planning revision and fail with a typed conflict on mismatch.
- Edits never start AI work, change `owner`, rewrite an admitted Work or Approval digest, or reorder a claim the scheduler already made.
- The bot uses the same edit path.

**Attribution**
- `by` uses the existing `Owner` type until OS02 introduces actors.
- The Console control and a conversational edit the person asked for record `'you'`; the latter's receipt names the conversation turn.
- A team tool or anything Diomedes initiates records `'diomedes'`.

**Permission**
- None until OS04 adds `task:prioritize`. Until then the local Console user may edit.

**Deferred to later lanes**
- Syncing priority with a customer's PM tool (OS13) needs a named authority per linked task. "Both ways" alone does not settle conflicts.
- Board's `policy: 'first' | 'go'` stays the start-gate.

**Automations** already have their own scheduler (`automation-scheduler.ts`, `DuePlan`).
- Automation-created tasks carry the default priority 3, like every task, and do not appear in Assignments.
- Automation admission checks only the target project's active sessions. It does not use the ready queue's global limiter.
- Shared capacity and preemption are OS12's decision, not an assumption here. That includes whether a priority-1 human task can interrupt an automation, and only on routes with a proven resumable checkpoint.

### D8. The Owner Surface is hosted, per MI-DEMO's architecture

The narrow authenticated operational API that `client/inventory/` already uses is the boundary; this ADR adds named capabilities to it (tasks, assignments, people, messages, completion reports) and does not widen it. The desktop loopback service stays restricted. An organization with `processing: 'local-only'` gets only what its policy lets leave the machine, and a local bot route.

Where the new native records live — control-plane D1 (which the package says must not become a second Tasks/Runs/History owner), the operational store MI00 defined, or desktop project state synced up — is the first thing discovery must settle, because everything in D9–D11 depends on it.

### D9. Every person signs in; access is the existing `business-access` contract with task and message permissions added

Staff have real identities — the same organization membership MI-DEMO and B01–B03 require. No inventory- or surface-specific auth. Identities exist so that priority changes, completions, messages and stock moves are attributed to a person, and so private messages are private.

**Do not build a role system.** `AccessProfile` + `AccessAssignment` + `BusinessPermission` already are one, and the contract says job titles are presentation. This ADR adds permissions to `BUSINESS_PERMISSIONS` (a new contract revision):

```
task:view_own      task:view_team     task:create       task:assign
task:prioritize    task:complete_own  task:accept       task:edit
message:send_managers   message:send_peers   message:read_own   message:configure
tile:view_board    completion:configure
```

and seeds two **default custom profiles** per organization that packs may rename: **Manager** (everything above) and **Employee** (`task:view_own`, `task:complete_own`, `message:send_managers`, `message:send_peers`, `message:read_own`, plus `project:view`, `inventory:view/record`, `labor:view_own/record_own` as the pack sees fit). The owner profile is the existing `systemKind: 'owner'`. The boss edits profiles from Settings — that is the "very configurable" control, and it already has immutable revisions and audit.

- Each permission is checked server-side by the existing `AccessDecision` path. The client hides what a person can't do; the API refuses it regardless.
- The bot inherits the asking person's decision. An employee asking to reprioritize someone else's task gets "you'd need a manager for that" and, if the org allows, a `Need` to one.
- Devices, users, sites and bins stay separate identities (MI-DEMO). A shared warehouse tablet is a device; the person still signs in on it.

### D10. Messaging between people is core, and is not `MailboxMessage`

Private messages — manager↔manager, manager↔employee, and employee↔employee where `message:send_peers` is granted — are a core tile.

- `MailboxMessage` is `Slot → Slot` AI team mail with `idle_notification` / `shutdown_request` types. It is the wrong shape for people. A people `Message` is a new record: `from: personId`, `to: personId[] | thread`, `attachedTo` (same shape as D5), `readBy`, delivery time. Discovery confirms it should not share a store with team mail.
- Managers cannot read employees' private threads they are not in. Retention follows organization policy.
- The bot can be a participant when invited, under the inviting person's permissions.

### D11. Task completion is a configurable report, not a checkbox

```ts
interface CompletionRule {
  requires: ('note' | 'photo' | 'checklist' | 'quantity' | 'signature')[];
  minPhotos?: number;
  checklist?: string[];
  managerSignOff: boolean;        // true → 'submitted' before 'done'
}

interface CompletionReport {
  by: { personId: string };
  at: string;
  note?: string;
  attachments: FileRecord[];      // via file-drops / file-imports, no second upload path
  checklist?: { item: string; done: boolean }[];
  quantity?: number;
}
```

- `TaskState` gains `'submitted'`. With `managerSignOff: false` the report moves the task straight to `done`.
- Accepting or bouncing is `task:accept`, logged in `moves`; a bounced task returns to `working` with the manager's note.
- The rule is an organization setting (`completion:configure`), overridable per project and per task; packs supply defaults (remodeling: note + one photo; restaurant: checklist); the boss's Settings win.
- H17's `acceptance?: AcceptanceDeclaration` on `Task` is the AI-side "what a finished run must satisfy." Discovery decides whether `CompletionRule` is a person-side sibling of it or the same thing with a `kind`.

## 4. Consequences

**Good**

- Aaron's sketch ships as the widening of a milestone the package already prioritizes and that has begun landing.
- Access control, workforce hours, the ready queue, the automation scheduler and the inventory authority rule are reused, not rebuilt. The new code is: priority on `Task`, person assignment, people messages, completion reports, tiles.
- Sign-ins, roles, DMs and completion reports are what every prospect asks about in the first meeting, and they are org-level.

**Costs**

- `Task` changes ripple: `assignedTo` widening from `Slot`, `Priority` required, `'submitted'` in `TaskState`, `moves.by` from `Owner` to an actor that can be a person. Every `Task` consumer in `client/`, `server/`, `shared/` and the tests is touched. Discovery lists them.
- `BUSINESS_PERMISSIONS` is a versioned contract; adding permissions is a contract revision with migration of existing profiles.
- Where native records live under MI00 decides the size of D9–D11. Unknown until discovery.
- Two shells means `shared/theme-pack` feeds both.

**Rejected**

- *A new role system.* One exists; extend its permission list.
- *Roster without sign-in.* Fails the first time attribution, privacy or access matters.
- *People messages inside `MailboxMessage`.* Wrong recipients, wrong types.
- *Importance and urgency as two fields.* Nobody fills in a matrix on a floor.
- *Store connection-backed business data natively for speed.* The inventory module's own rule says no.

## 5. Implementation order

0. **Discovery** — `PROMPT_owner-surface-discovery-2026-09-25.md`, run against `origin/main` in a fresh worktree. Produces the file-level edit/add/remove report and the worktree split. Nothing below starts until it is read.
1. `Task.priority`, `due`, `planningRevision`, `priorityMoves`; one work-list order; ready-queue sort inside each project's fair turn; priority control everywhere a task is listed in the Console. Delivered as OS01; package nodes `OS01.I` (23c) and `OS01.R` (24c).
2. `Task.assignedTo` widened to person-or-AI; the person record `personId` resolves to; link `WorkforceWorker` to it; **Assignments** and **Board** as the two views.
3. `BUSINESS_PERMISSIONS` revision with `task:*`, `message:*`, `tile:*`, `completion:*`; default Manager / Employee profiles; Settings UI for profiles (if not already present in `server/business/`).
4. `'submitted'`, `CompletionRule`, `CompletionReport`; accept/bounce; attachments through file-drops.
5. People `Message` with `attachedTo` and read state.
6. `attachedTo` view kinds and `askContext` in `Composer`; bot inherits `AccessDecision`.
7. `PackTile`; core tiles; remodeling pack (Inventory as-is, Timeline over `due`, Data).
8. Owner Surface shell on the MI-DEMO device client: home, rail, chat.
9. Demo for Aaron's boss.

Each step is a feature worktree under `F:/Diomedes/diomedes-wt/` with a `feature/<name>` branch per `F:/Diomedes/AGENTS.md`. Steps 1–2: `task-priority`, `people-assignments`.

## 6. Open questions (for discovery to answer or escalate)

- Where do people, messages, completion rules and reports live under MI00's data-owner contract? What does `personId` resolve to today?
- Does `client/inventory/` already contain the responsive shell (rail, sign-in, layout) the Owner Surface needs, or only the inventory screens?
- Do the ready queue and the automation scheduler share `READY_QUEUE_LIMITS.global`? If so, preemption is a scheduler change; if not, it is a policy question.
- Is `CompletionRule` a sibling of H17's `AcceptanceDeclaration` or the same concept?
- Which of the open prompts (MI01–MI09, B01–B03, H-, P-, CD-series) already own parts of D9–D11?
- Which connector is first for the remodeling pack? Aaron's boss's shop decides.
- Product name for the Owner Surface. "Nectovia" alone is probably right.

Rev 5 note:
- Discovery section 6 answers these from the code. D7's priority questions (fairness scope, due semantics, undated order, labels) are settled above.
- The owner questions still open are in discovery section 5. They cover:
  - who operates the governed host;
  - employee file scope;
  - shared capacity and preemption;
  - completion-rule versioning and what "signature" and "quantity" mean;
  - message visibility and bot disclosure;
  - photo format and metadata;
  - the paid-hours source;
  - pack navigation across projects;
  - local-only metadata egress;
  - the first connector;
  - priority authority for a linked PM tool.
- They stay open until Andrew answers them. Each lane's prompt must name the ones it depends on.

## 7. Rev 5 corrections from discovery

The OS-DISC-01 report (section 8, 27 items) corrected rev 4. Rev 5 adopts them as constraints on the lanes that implement each decision; the numbers below are that section's.

- **Decision text changed in this revision:** D7, as above (items 8 and 9).
- **Facts corrected** (items 2–7):
  - Workbook is removed; Ledger is work, Needs and recent evidence.
  - Business-access v2 is a catalogue migration with row predicates and an editor, not new strings. The Console has no profile editor yet.
  - `WorkforceWorker` is a scheduling source record, not an employee directory or login.
  - D3's one-authority rule stands.
  - MI-DEMO is not wholly landed; only MI00 is DONE.
  - A local fixture Person is not verified identity; B03 must bind it.
- **Constraints on later lanes** (items 10–19):
  - Automation capacity and preemption need a shared capacity owner and proven resumable checkpoints (OS12).
  - Run class stays independent of Wake and `createdBy`.
  - Displayed allowance is not queue or spend admission.
  - H17's AI verification survives; human completion is a sibling contract behind one finish gate (OS09). `signature` and `quantity` need definitions.
  - `FileRecord` is not an upload reference. Phone uploads need a named authenticated ingress (OS10).
  - A private message linked to a project must not publish its body there (OS11).
  - Pack `ui` affordances cannot render tiles yet. A versioned declarative tile contract is needed, and Core owns the device shell (OS06, OS08).
  - Not every `Task` consumer changes; discovery section 3.16 separates them.
  - Reuse the fictional sample businesses from PR #140 as fixtures.
  - Hosted and local-only organizations need an explicit disclosure policy for titles, counts, bodies and photos.
- **Customer repairs and product boundaries added after rev 4** (items 20–27, lanes OS15–OS20):
  - Customer AI settings are not a machine inventory.
  - A default AI setting is not a conversation switch.
  - Choosing a project folder must not need a typed path.
  - The Projects page lacks a work-style choice.
  - An adapter registry is not a customer service catalogue.
  - Design authoring is not a paid-plan right.
  - A fork label is not a product boundary.
  - Provider sign-in, product access and funding are separate.

Item 1 (the revision mismatch) was already resolved in rev 4.
