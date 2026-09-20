# Rail destinations, overlaps, and where pin state lives

Implementation contract for the Console rail reduction: **New chat**, the thread
list, and one **Everything** entry that opens a flyout holding every destination.
A pin control on each flyout row adds or removes that destination as a permanent
rail entry.

**Owner decision, 2026-09-19, applied throughout:** a destination with no working
view behind it is **a present-but-unavailable row carrying a short reason**, not
something to design or build. §3 is the strict audit of which rows those are, and
the sentence each one carries.

No production code was written for this document. Every claim below was read out
of source in this worktree and carries a `file:line`.

---

## 0. What the rail carries today

`client/console/Rail.tsx` is 120 lines and carries eight destinations in two
groups.

| Group | Entries | Line |
|---|---|---|
| View switch | Thread, Board, Team, Connections | `Rail.tsx:91` |
| Foot | Files, Workbook, History, Engines | `Rail.tsx:105`, `:108`, `:111`, `:114` |

Only the first group is a view switch. The foot is four unrelated things wearing
one shape:

- **Files** (`Rail.tsx:105`) toggles a pane, not a view — `Rail.tsx:22-24`
  says so, and `Shell.tsx:1322` renders it as the stage's third grid column.
- **Workbook** (`Rail.tsx:108`) calls `onHome` → `openInBook('home')`
  (`Shell.tsx:1096`) → `App.tsx:711-718`, which writes `surface: 'workbook'`
  **and demotes `detail` from `technical` to `standard`**. It leaves the Console.
- **History** (`Rail.tsx:111`) calls `openInBook('history')` (`Shell.tsx:1097`).
  Same surface switch, same detail demotion. It also leaves the Console.
- **Engines** (`Rail.tsx:114`) calls `openEngineSettings` (`Shell.tsx:1098`) →
  `App.tsx:719-722`, which opens the Settings page and raises a signal that
  selects the helpers section.

So of the four foot buttons, **one opens a pane, two exit the surface, and one
opens Settings**. None of them is a peer of Thread/Board/Team. That is the
clutter the Everything flyout replaces.

---

## 1. Every real destination in the app

I walked all 53 files in `client/console/`, plus `client/`, `client/connections/`
and `client/workbench/`. Below is what a person can actually land on.

The brief listed sixteen candidates. **Six of them are destinations. Eleven are
panels inside another destination.** The verified split is in §1.3.

### 1.1 Console destinations

The **Available** column is the strict yes/no from §3.1: does a real view, over
real data, exist behind this row right now.

| # | Label a business owner understands | Component | Reached today | Available | What a person does there |
|---|---|---|---|---|---|
| 1 | **Chats** (today "Thread") | `client/console/ThreadView.tsx` | Rail view switch `Rail.tsx:91`; mounted `Shell.tsx:1107` | **Yes** | Talk to Diomedes about one job and approve or refuse each change it proposes. |
| 2 | **Tasks** (today "Board") | `client/console/BoardView.tsx` | Rail view switch `Rail.tsx:91`; mounted `Shell.tsx:1242` | **Yes** | See every job as a card — to do, working, waiting, done — and start, pause or reassign one. |
| 3 | **Helpers** (today "Team") | `client/console/TeamView.tsx` | Rail view switch `Rail.tsx:91`; mounted `Shell.tsx:1284` | **Yes** | See which assistants are working, message one, stop one, wake one. |
| 4 | **Connected apps** (today "Connections") | `client/connections/Connections.tsx` | Rail view switch `Rail.tsx:91`; mounted `Shell.tsx:1102` | **No** — §3.1 | Describe an outside service to watch and get a rule that alerts someone. Runs on invented restaurants. |
| 5 | **Files** | `client/console/FilesPane.tsx` | Rail foot toggle `Rail.tsx:105`; mounted `Shell.tsx:1322` | **Yes** | Browse the project's documents as a folder tree, preview one, bring outside files in. |
| 6 | **Your business** (today "Workspaces") | `client/console/Workspaces.tsx` (`WorkspacePanel`) | The mark above the thread list, `Shell.tsx:1082` → `Workspaces.tsx:44`; opened at `Shell.tsx:1346` | **Yes**, with a caveat — §3.1 | Switch between Personal and a business, invite people, set what the business is set up to do. |
| 7 | **Projects** | `client/App.tsx:748` (`projects-page`) | Console header crumb, `Shell.tsx:983` → `onShowProjects` → `App.tsx:725-728` | **Yes** | Pick which folder to work in, or start a new one. |
| 8 | **Settings** | `client/Settings.tsx` | Console header, `Shell.tsx:1034` → `App.tsx:728` | **Yes** | Change how the app behaves: detail, permissions, appearance, AI helpers. |
| 9 | **AI helpers** (today "Engines") | A **section inside Settings**, `Settings.tsx:204-211` | Rail foot `Rail.tsx:114` → `App.tsx:719-722` | **Yes** | Switch an AI service on and choose the default model and effort. |
| 10 | **Look and feel** (today "Design Center") | `client/console/DesignCenter.tsx` | Settings → Design Center → button at `Settings.tsx:517` → `App.tsx:694-701`, rendered `App.tsx:946` | **Yes** | Author a theme for the app and preview it. Authoring tool, gated to the Console (`Settings.tsx:212`). |
| 11 | **Find anything** (Ctrl+K) | `client/console/Palette.tsx` | Header chip `Shell.tsx:1023-1033`; mounted `Shell.tsx:1336` | **Yes** | Type a few letters and jump to a task, file, worker, model or project. |
| 12 | **Automations** | *none* | *not reachable* | **No** — §3.1 | — |
| 13 | **Notes** | *none* | *not reachable* | **No** — §3.1 | — |

### 1.2 Workbook pages — the other surface

The Workbook is the second surface (`shared/types.ts:15`,
`client/components.tsx:46-51`). Its rail is built from the `pages` array
(`components.tsx:19-27`, consumed at `Workspace.tsx:1147`): **Home, Ask, Plan,
Work, Review, Tasks, Documents, History**.

| Label | Renders at | What a person does there |
|---|---|---|
| Home | `Workspace.tsx:1234` | Land, see what needs them, pick one of four intents. |
| Ask | `Workspace.tsx:1425` | Ask a question without starting work. |
| Plan | `Workspace.tsx:1517` | Turn a plan document into tasks. |
| Work | `Workspace.tsx:1608` | Watch the run that is going and answer what it asks. |
| Review | `Workspace.tsx:1659` | Look at proposed changes and keep or discard them. |
| Tasks | `Workspace.tsx:1188` | The same board as the Console's, in Workbook clothing. |
| Documents | `Workspace.tsx:1552` | A flat list of the project folder's documents; open one to edit it. |
| **History** | `Workspace.tsx:1696` | **Every recorded change, grouped by day, with Restore.** |

Two notes that matter for the flyout:

- `Page` (`shared/types.ts:18-27`) includes `'connections'`, but the `pages`
  array the Workbook rail renders (`components.tsx:19-27`) **omits it**. There is
  no Workbook Connections page. `connections` is a `Page` value nothing navigates
  to. Dead enum member.
- `History` is the only Workbook page with no Console equivalent (see §2.1). Its
  rail button therefore is not redundant — it is the *only* way to reach the
  restore log from the Console, and it costs you the Console to use it.

### 1.3 Panels, not destinations — verified

Each of these mounts inside another screen. None has a route, a rail entry or a
URL of its own. Putting any of them in the Everything flyout would produce a row
that cannot be navigated to.

| Candidate | Verdict | Where it actually mounts |
|---|---|---|
| `ActivityOverview` | Panel | `Shell.tsx:1208` — the Thread view's **empty state only**. Vanishes the moment a thread exists. |
| `Allowance` | Panel | `Workspaces.tsx:354` — a section of the Workspaces modal, business workspaces only. |
| `BriefFiles` | Form control | `Workspaces.tsx:332` — a file picker beside the "output project" select, business workspaces only. |
| `BusinessSetup` | Panel | `Workspaces.tsx:127` — an early `return` that **replaces** the Workspaces body with a questionnaire. |
| `ChangeReview` | Panel | `ThreadView.tsx:417` and `:424` — inline in the thread transcript. |
| `Configuration` | Panel | `Workspaces.tsx:144` — an early `return` that replaces the Workspaces body. |
| `FollowUpQueue` | Panel | `ThreadView.tsx:496` — inline in the thread. |
| `ImportFiles` | Modal | `FilesPane.tsx:518` — a dialog opened from inside Files. |
| `Ledger` | `<aside>` | `Shell.tsx:1177` and `:1217` — the permanent right column beside Thread. `Ledger.tsx:96` is literally `<aside className="ledger">`. |
| `PackSettings` | Panel | `PermissionPanel.tsx:387` — inside the task-permissions modal. |
| `ProjectInstructions` | Panel | `ThreadView.tsx:358` — in the thread head, and only when `instructionFiles.length > 0`. |
| `PermissionPanel` | Modal | `Shell.tsx:1395`. |
| `RunInspector` | Panel | `ThreadView.tsx:409` — inline in the thread transcript. |
| `AgentPicker`, `Picker` | Header controls | `Shell.tsx:999`, `:1009`. |
| `Wake` | Splash | `App.tsx:518` — the startup animation (`Wake.tsx:20-24`). Not a place. |
| `Setup` | First-run flow | `App.tsx` via `Setup.tsx:17`; returns `null` once `resumeAt === 'done'` (`Setup.tsx:22`). Not a place. |
| `AISetup` / `AIConnections` | Panel | Inside `Setup.tsx:49` and Settings (`Settings.tsx:14`). |
| `AppUpdates` | Panel | `Settings.tsx:548` — a Settings section. |
| Website Studio | Panel | `client/console/design-center/WebsiteTarget.tsx:38` — a probe inside the Design Center. |

**Count check against the brief's sixteen:** ActivityOverview (panel), Allowance
(panel), BoardView (**destination**), BriefFiles (control), BusinessSetup
(panel), ChangeReview (panel), Configuration (panel), DesignCenter
(**destination**), FilesPane (**destination**), FollowUpQueue (panel),
ImportFiles (modal), Ledger (aside), PackSettings (panel), ProjectInstructions
(panel), TeamView (**destination**), ThreadView (**destination**), Workspaces
(**destination**). Six of seventeen. The list was a file inventory, not a
destination inventory.

### 1.4 The flyout is not a duplicate of Ctrl+K

`buildEntries` (`paletteEntries.ts:374`) offers six groups (`console/types.ts:25`):
Recent, Tasks, Files, Workers, Models, Projects, Views. Its `Views` group
(`paletteEntries.ts:363-371`) offers **only Thread, Board and Team** — not
Connections, not Files, not Settings, not Workspaces.

So Ctrl+K searches *content* and can reach three views; the Everything flyout
lists *places*. They do not overlap today and should not be merged.

**Contract point:** both should read one list. Put the destination registry in a
new `shared/destinations.ts` and have `viewEntries` (`paletteEntries.ts:363`) and
the flyout both map over it, so the palette and the flyout cannot disagree about
what exists.

---

## 2. The overlaps — which pairs are one destination wearing two names

### 2.1 Ledger, ActivityOverview and History are THREE different things

This was the specific question. The answer is three, not one, and not two.

| | Data it reads | Shape | Answers |
|---|---|---|---|
| **Ledger** | `state.tasks`, `state.needs`, `state.sessions`, and `state.history.slice(-3)` (`Ledger.tsx:64-87`) | `<aside>`, always on beside Thread (`Ledger.tsx:96`) | "What is open in this project right now, and what is this run doing this second." |
| **ActivityOverview** | `projectActivity(...)` — a projection over tasks, runs, Needs, changes and History (`activity.ts:1-18`) | Block in the Thread **empty state only** (`Shell.tsx:1208`) | "Working / Needs you / Ready for review / Finished recently" (`ActivityOverview.tsx:23-27`). |
| **History** (Workbook page) | `state.history`, grouped by day, with `restoreEntry` (`Workspace.tsx:1696-1760`) | Full page | "What was changed, when, by whom — and put it back." |

They read overlapping records but answer different questions. `activity.ts:9-11`
states the distinction itself: *"It is a projection, not a lifecycle."* And
`Ledger.tsx:86` takes only the last three history entries — it is a glance, not a
log.

**Contract:**

- **History is one destination**, and it is the Workbook page (`Workspace.tsx:1696`).
  It is the only one of the three with a restore action, which is the product's
  trust claim — Settings calls that section "A way back" (`Settings.tsx:584`).
- **Ledger is not a destination.** It stays where it is, as the aside.
- **ActivityOverview is not a destination.** It is an empty state. If anything,
  it is the natural body of a future **Today** destination, but do not ship it as
  one in this change.
- The rail's History button (`Rail.tsx:111`) must stop exiting the Console. Today
  it is the only way to the restore log and it costs you the surface
  (`App.tsx:711-718`). This is why History is held back as a default pin — see
  §5, and §8 Q1 for the decision it waits on.

### 2.2 BriefFiles, ImportFiles and FilesPane are ONE Files, plus two unrelated things

- **FilesPane** (`FilesPane.tsx:15-24`) is *"the Core file and artifact surface,
  bound to the current Project"*. It builds a tree client-side from the flat
  listing (`FilesPane.tsx:38-41`) and is explicitly **not an editor**
  (`FilesPane.tsx:21-22`). This is **Files**.
- **ImportFiles** is a modal *inside* Files (`FilesPane.tsx:518`) for bringing
  outside files in (`ImportFiles.tsx:14-22`). Part of Files, never its own row.
- **BriefFiles** is **not a Files anything.** It takes `organizationId` and
  `projectId` (`BriefFiles.tsx:13-19`), filters the listing to importable files
  under the size cap (`BriefFiles.tsx:34-37`), and its errors read *"The brief
  could not be prepared"* (`BriefFiles.tsx:54`). It is a source picker for a
  business's weekly brief, living inside the Workspaces modal
  (`Workspaces.tsx:332`). Different concept, similar name.

**So: one Files. Not three.**

There is a fourth thing worth naming: the Workbook's **Documents** page
(`Workspace.tsx:1552-1604`) is a flat list of the same documents, and it *does*
edit (`Workspace.tsx:1570`, `editor`). Files (tree, read-only preview) and
Documents (flat, editable) are the same data in two surfaces. **When the Workbook
goes, Files must absorb the edit affordance or the product loses document
editing.** Flag this as a dependency, not a detail.

### 2.3 Connections and Engines are NOT the same thing

- **Connections** (`Connections.tsx:8`) is outside services: it posts to
  `/projects/:id/connections`, compiles a plan from a sentence like *"Watch Toast
  menu availability across my three Raleigh restaurants and alert a manager"*
  (`Connections.tsx:12`), and produces a rule proposal a person approves.
- **Engines** is AI helpers — a Settings section
  (`Settings.tsx:204-211`) wired to `/api/ai/enabled` (`api.ts:207`).

Two destinations. But note that **Settings already renames "Engines" by surface**:
`const helpersSection = isDesk ? 'Engines' : 'Helpers on this computer'`
(`Settings.tsx:199`). The product has already conceded that "Engines" fails the
label test. See §6.

### 2.4 Board appears twice, in two surfaces

`BoardView` (Console, `Shell.tsx:1242`) and the Workbook `tasks` page
(`Workspace.tsx:1188`) are the same concept over `state.tasks`. Both read
`settings.tasksView[projectId]` for board-vs-list (`Workspace.tsx:823-838`). One
destination, two renderings. When the Workbook goes, one remains.

---

## 3. Availability — which rows are present but unavailable

**Owner decision, 2026-09-19:** a destination without a working view behind it is
**a row that is present and visibly unavailable, carrying a short reason** — not
something to design or build. His words on Automations: *"automations can just not
exist right now, i mean the button exists but isn't functional until its wired to
a real built item."* That rule is applied across the whole inventory below, not
only to Automations.

**This reverses two recommendations an earlier draft of this document made.**
Notes and Automations are **not** omitted, and Connected apps is **not** held
back. All three are rows in the flyout. They are simply unavailable.

### 3.0 Two names for this field exist right now — pick one before building

The concept is already spelled two ways in this worktree, which is the same
failure this document flags for "Engines" in §6.

| Name | Where | Status |
|---|---|---|
| `disabledReason?: string` | `client/console/Everything.tsx:14`, consumed at `:79-80`, `:218-222`, `:274`, `:302-303` | The **new** flyout component, written in this session. |
| `unavailableReason: string` | `shared/permissions.ts:252`, `shared/managed-usage.ts:601` | The **shipped** contract. Rendered as prose beneath a refused control at `PermissionPanel.tsx:186` and `Allowance.tsx:112`; server-filled at `server/managed-usage-routes.ts:112`; decided at `permissions.ts:308` and `:323`. |

**Recommendation: `unavailableReason`**, and rename the new field to match. It is
the older name, it is in `shared/` where the flyout's registry will also live, it
is already on the wire, and "disabled" is a developer's word for a greyed-out
control while "unavailable" is a statement about the world. The flyout's own
own rendering already avoids "disabled": unavailable rows collect under
*"Not ready yet"* (`Everything.tsx:30`) and each reason prints as
`Not ready · {reason}` (`Everything.tsx:303`).

**That prefix is part of the sentence the owner reads.** The §3.2 wordings are
written to sit after it, so Automations renders as *"Not ready · Nothing runs on
a schedule yet. This opens once a standing job is wired to something real."* If
the prefix is ever changed, re-read §3.2 against the new one — a reason that
duplicates its own prefix ("Not ready · Not connected yet…") reads as a stutter.

This is a one-line rename in an uncommitted file, and it is much cheaper now than
after a third caller exists. Whichever name is chosen, **choose once** — the rule
throughout this document is that a non-empty reason string is the single source of
"this row is unavailable".

### 3.1 The strict audit

A component in `client/console/` is **not** evidence of a working destination. A
view that renders only against a fixture, a demonstration or synthetic data
counts as **not built**.

| Destination | Real view behind it? | The `file:line` that decides it |
|---|---|---|
| Chats, Tasks, Helpers, Files, History, Projects, Settings, AI helpers | **Yes** | Real project records: `state.conversations`, `state.tasks`, `state.team`, `/projects/:id/documents`, `state.history`. No fixture gate on any of them. |
| Look and feel (Design Center) | **Yes** | Fixtures exist *only* in the preview harness (`DesignCenter.tsx:6`). The authoring, autosave, package import and Apply are real and change the running app (`DesignCenter.tsx:11-19`). |
| Your business (Workspaces) | **Yes, with a caveat** | Personal is real and switching works. **Business organizations are local development fixtures** — `Workspaces.tsx:34-38` tests `identitySource === 'development-fixture'` and `:50` labels it *"Development identity — not verified"*. `release-gates.ts:70-76` records `met: false` with *"this build issues only local development fixtures and says so (hosted.available is false)"*. The row is available; the business half already carries its own reason at `Workspaces.tsx:401`. |
| **Connected apps** | **No** | `Connections.tsx:38` renders the literal banner **"Experimental / synthetic data"**. `:42-43`: *"This local demonstration uses three fictional restaurants. Live Toast access is unavailable."* The connector layer is fixtures end to end — `server/connections/fixture.ts`, `fixture-model.ts`, `compiled-fixture.ts`, `compiler-demo.ts` — and `server/connections/toast.ts:12-16` hardcodes three invented location UUIDs named Downtown, North Hills and Cary. |
| **Automations** | **No** | No component, no route, no type. `grep -rni "automation"` across `shared/`, `server/`, `client/` returns only change-review fixtures (`server/change-review/fixtures.ts:79-85`, `rules.ts:561`) and one option label (`ChangeReview.tsx:41`). |
| **Notes** | **No** | `grep -rn "notebook"` across `shared/`, `server/`, `client/` and `docs/` returns **nothing**. No capability, type, route or component. If `notebook` is registered anywhere it is in the site's `status.json` registry, not in this app. |

**The one that would be easiest to get wrong in the other direction is Your
business.** It shows a fixture warning, so it looks like it belongs with
Connections. It does not: Personal is a real workspace with real settings,
projects and history, and it is the workspace every owner is in by default
(`store.ts:198`). Marking that row unavailable would hide a working screen.

### 3.2 The reason sentence for each unavailable row

Read by a restaurant or auto-shop owner. "Not implemented" and "Coming soon" are
both wrong — the first is a developer's word, the second is a promise. The
codebase's own voice states the fact and its consequence, e.g.
`HOSTED_BUSINESS_UNAVAILABLE_REASON` (`shared/workspaces.ts:127-128`).

| Row | Proposed `unavailableReason` |
|---|---|
| **Automations** | `Nothing runs on a schedule yet. This opens once a standing job is wired to something real.` |
| **Connected apps** | `Not connected to anything yet. This screen works against sample restaurant data, so nothing here reaches your own accounts.` |
| **Notes** | `There is nowhere to keep notes yet. Anything you write lives in Files until this has a home of its own.` |

Each names what is true now and what has to happen first, and none of them
promises a date.

### 3.3 What already exists behind each one — how close it is to being wired

Kept from the original brief, because it tells the implementer the distance.

**Automations — closest.** Two thirds of the mechanism is built, in the wrong
place:

1. **Connections** already takes a sentence, compiles a `ConnectionPlan`,
   produces a `RuleProposal` a person approves, and polls on a timer
   (`Connections.tsx:8-28`). Its own copy says *"Monitoring runs while this app
   is open"* (`Connections.tsx:43`). That is an automation in everything but the
   name and the data.
2. **Configuration** (`shared/configuration.ts:1-30`) is the governed setup a
   business's answers produce — agents, rules, routes, computed readiness —
   explicitly *"a reference document, never executable setup"*
   (`configuration.ts:12-14`), parked in a business-only modal
   (`Workspaces.tsx:144`).
3. `BUSINESS_JOBS` already names **`recurring-report`** (`business-setup.ts:148`),
   covered by `COVERED_JOBS` (`shared/packs.ts:180`).

What is missing is a real connector and a scheduler that runs when the app is
closed. **Automations and Connected apps are one destination in waiting**, and
wiring either one wires the other.

**Notes — furthest, and the data is thin.**

- `ContextKind` includes `'pasted-notes'`, labelled *"Notes typed when it runs"*
  (`shared/configuration.ts:178`, `:184`).
- `BUSINESS_JOBS` includes `organise-notes` — *"Turn rough notes into a usable
  written record"* (`business-setup.ts:149`) — deliberately the one job with **no
  source question**, because *"asking where notes live has no useful answer"*
  (`business-setup.ts:153-156`, `packs.ts:353-362`). That comment is the honest
  statement that notes have no home.
- The guarded document routes (`FilesPane.tsx:17-20`) and the Workbook's editor
  (`Workspace.tsx:1570`) would carry the storage.

**Connected apps — the plumbing is real, the other end is not.** The rule engine,
the observation schema (`shared/connections.ts`), the plan compiler and the
approval flow all exist and are exercised. Only the connector is invented
(`server/connections/toast.ts:12-16`).

### 3.4 Unavailable rows are not clickable and not pinnable

A row with a non-empty reason string:

- renders in the flyout with its reason beneath it — `Everything.tsx:302-303`
  already does this, under its own heading for waiting rows (`:79-80`, `:29`)
- does **not** navigate on click, and announces why — `Everything.tsx:218-222`
- cannot be **newly** pinned, but can be **un**pinned if it already is —
  `Everything.tsx:283`, and see §4.4 for why that asymmetry is deliberate

The pin rule is a contract requirement, not a nicety: a freshly pinned
unavailable row would put a dead entry in the permanent rail, which is precisely
the clutter this change removes. §4.4 encodes it in the server validator so it
cannot be reached by a hand-written settings file either.

**Consequence for the rail today:** Connected apps is currently a *view switch
entry* (`Rail.tsx:91`, mounted `Shell.tsx:1102`). Under this rule it stops being
a view and becomes an unavailable flyout row. That removes one of the four view
switch buttons as a side effect of the availability rule, independently of the
rail reduction.

### 3.5 Projects — it exists

Confirmed. `App.tsx:748` renders `<main className="main projects-page">` with
`<h1>Projects</h1>` when no project is selected, reached from the Console header
crumb (`Shell.tsx:983` → `onShowProjects`, declared `Shell.tsx:82`, wired
`App.tsx:725-728`). Ctrl+K also offers every project
(`paletteEntries.ts:352-361`).

Include it in the flyout, available. Do **not** make it pinnable — it is already
permanent in the header crumb (`Shell.tsx:983-996`), and a second copy in the
rail would be the same clutter in a new place.

---

## 4. Where pin state persists

This is the load-bearing section.

### 4.1 The two patterns already in the codebase

The app stores per-person UI preferences in **two** places, and the rail already
uses both.

**Pattern A — `localStorage`, for rail chrome.** The Files pane's own state:

```
Shell.tsx:144-149   const [filesOpen, setFilesOpen] = useState(() => stored('console.files.open') === 'true');
                    const [filesWidth, setFilesWidth] = useState(() => { ... stored('console.files.width') ... });
Shell.tsx:402-408   useEffect(() => { remember('console.files.open', ...) }, [filesOpen]);
Shell.tsx:1509-1525 stored()/remember() — try/catch wrapped, documented as
                    "Per-person interface memory. A browser that refuses storage
                    still gets the pane; it simply does not remember it."
```

The comment at `Shell.tsx:144` is exact about the scope: *"off by default and
remembered per person, never per project."* That is the same sentence the pin
feature needs.

**Pattern B — `Settings`, for everything about the shape of the interface.**
`detail`, `surface`, `appearance`, `explanations`, `openProjects`, `lastPage`,
`tasksView` (`shared/types.ts:33-105`).

### 4.2 The precise answers

**What record would hold "which destinations are pinned to my rail"?**

`Settings` (`shared/types.ts:33`), as a new flat field. Not `localStorage`, and
not keyed per project.

Reasoning:

- Pins are the same class of decision as `detail` and `surface` — they are what
  the interface *is*, not a transient pane toggle. `Settings` already owns that
  class.
- `localStorage` is documented to fail open (`Shell.tsx:1509-1525`): storage
  refused means the preference is silently lost. A Files pane that reopens closed
  is a shrug. **A rail whose entries silently vanish is a broken product.**
- Pins must be flat, not per-project like `lastPage`/`tasksView`
  (`types.ts:99-100`, validated `app.ts:389-402`). A rail that changed shape when
  you opened a different folder would be a different rail. Destinations are
  app-level.

**Is it per person or per workspace?**

**Per install.** Neither, strictly.

- `settings.json` is a single file at `<dataDir>/settings.json`, read at
  `store.ts:349` and `:426`, written at `store.ts:751`. `dataDir` is
  `DIOMEDES_DATA_DIR` or `<root>/.data` (`server/index.ts:10`).
- It is **not** per workspace: `activeWorkspace` lives *inside* settings
  (`types.ts:98`), so switching Personal ↔ Business does not swap settings files.
- It is per person only to the extent that one install is one person, which is
  today's reality — there is no auth in this repo.

State this plainly in the code comment. Do not write "per person" where the truth
is "per install", or the first multi-user build inherits a wrong claim.

**Does it sync?**

**No.** `grep -rn "settings.json"` across `server/`, `client/`, `desktop/` and
`scripts/` returns **three hits, all in `server/store.ts`** (`:349`, `:426`,
`:751`). Nothing else reads or writes it. There is no sync path, no cloud copy,
no export. Pins live on the machine and move only if the data folder moves.

**What happens on first run before anybody has chosen?**

Two different first runs, and they need two different answers:

1. **Fresh install — settings.json absent.** `readJson` calls `initial()`, which
   is `defaults()` (`store.ts:279-286`, `:349`). A default written into
   `defaults()` (`store.ts:171`) is picked up.
2. **Existing install — settings.json present but with no `rail` key.**
   `readJson` *parses the file as-is and does not merge*
   (`store.ts:280-282`). **`defaults()` is never consulted.** An existing
   install would get `rail: undefined` forever.

The hook for case 2 is `migrateSettings` (`store.ts:130-152`), called at load
(`:350`) and at reload (`:427`). It is exactly where `surface` is backfilled for
old files (`store.ts:151-152`) — which is what the *"the server fills it"* comment
on `Settings.surface` (`types.ts:37`) refers to.

**So the field must be optional, defaulted in `defaults()` for case 1 and filled
in `migrateSettings` for case 2, and the client must still render correctly when
it reads `undefined`** — because a client can hold a settings object read before
a server restart.

### 4.3 Does it need a server change?

**Yes. Unavoidably, if it lives in Settings.**

`validateSettings` rejects any key not already present in `defaults()`:

```
server/app.ts:207-209
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(defaults(), key)) throw new ApiError(400, `Unknown setting: ${key}`);
```

A client calling `patchSettings({ rail: ... })` against today's server gets a
**400**. There is no client-only route into `Settings`.

### 4.4 Proposed concrete shape

**New file — `shared/destinations.ts`.** One registry, imported by the flyout, the
palette and the server validator, so none of them can disagree.

**Ids are component-derived and label-independent.** `EverythingItem` already
draws that line — `id` is *"Stable id, e.g. 'board'"* (`Everything.tsx:5`) while
`label` is *"What a business owner reads, e.g. 'Tasks'"* (`:7`). Follow it. The
labels in §6 are proposals Andrew may reject; a stored id is forever. If ids
tracked labels, keeping "Team" over "Helpers" would mean a rename branch in
`migrateSettings` for a decision that has nothing to do with storage.

```ts
export const DESTINATIONS = [
  'thread', 'board', 'team', 'files', 'history',
  'workspaces', 'projects', 'settings', 'design-center',
  // Present in the flyout, unavailable. See §3.
  'connections', 'automations', 'notes',
] as const;
export type DestinationId = (typeof DESTINATIONS)[number];

/** Id → the label a person reads. The only place §6's wording lands. */
export const DESTINATION_LABEL: Record<DestinationId, string> = {
  thread: 'Chats',
  board: 'Tasks',
  team: 'Helpers',
  files: 'Files',
  history: 'History',
  workspaces: 'Your business',
  projects: 'Projects',
  settings: 'Settings',
  'design-center': 'Look and feel',
  connections: 'Connected apps',
  automations: 'Jobs that run on their own',
  notes: 'Notes',
};

/**
 * Why a destination cannot be opened, in the owner's words, or '' when it can.
 *
 * Same name and same meaning as `unavailableReason` in shared/permissions.ts:252
 * and shared/managed-usage.ts:601, so a reader of one is a reader of all three.
 * A non-empty string is the single source of "this row is unavailable": it does
 * not navigate, and it cannot be pinned.
 */
export const UNAVAILABLE: Partial<Record<DestinationId, string>> = {
  connections:
    'Not connected to anything yet. This screen works against sample restaurant data, so nothing here reaches your own accounts.',
  automations:
    'Nothing runs on a schedule yet. This opens once a standing job is wired to something real.',
  notes:
    'There is nowhere to keep notes yet. Anything you write lives in Files until this has a home of its own.',
};

export const isAvailable = (id: DestinationId): boolean => !UNAVAILABLE[id];

/**
 * Pinned for an install that has never chosen. See RAIL_DESTINATIONS.md §5.
 *
 * 'history' is deliberately absent: it has no Console view yet, and the only
 * route to it leaves the surface (§5). Add it here in the same change that
 * gives it one, and not before.
 */
export const RAIL_DEFAULT_PINS: readonly DestinationId[] = ['board', 'files'];

/** The rail runs out of room past this, and a rail of ten is the thing we are removing. */
export const MAX_PINS = 6;

/** Always in the flyout, never pinnable: they already have a permanent home. */
export const UNPINNABLE: readonly DestinationId[] = ['thread', 'projects', 'settings'];
```

Note that `RAIL_DEFAULT_PINS` contains no unavailable id, and the validator below
enforces that it never can — so the defaults cannot drift into a dead rail as
destinations come and go.

**`shared/types.ts`, inside `Settings`** (beside `tasksView`, `types.ts:100`):

```ts
/**
 * Which destinations are pinned to the Console rail, in the order they show.
 *
 * Absent means this install has never chosen, which renders RAIL_DEFAULT_PINS.
 * Missing on settings written before 2026-09-19; `migrateSettings` fills it, on
 * the same footing as `surface`.
 *
 * Flat, not keyed per project like `lastPage` and `tasksView`: a rail that
 * changed shape when you opened a different folder would be a different rail.
 */
rail?: { pinned: DestinationId[] };
```

**`server/store.ts`** — two edits:

```ts
// defaults(), beside tasksView at store.ts:194
rail: { pinned: [...RAIL_DEFAULT_PINS] },

// migrateSettings(), beside the surface backfill at store.ts:150-152
settings.rail ??= { pinned: [...RAIL_DEFAULT_PINS] };
settings.rail.pinned ??= [...RAIL_DEFAULT_PINS];
```

**`server/app.ts`** — one validation branch, modelled on `tasksView`
(`app.ts:397-402`), using the existing `choice` helper (`app.ts:144`):

```ts
if (supplied.rail) {
  const value = plain(supplied.rail);
  if (value.pinned !== undefined) {
    if (!Array.isArray(value.pinned) || value.pinned.length > MAX_PINS)
      throw new ApiError(400, `Pin at most ${MAX_PINS} destinations.`);
    const seen = new Set<string>();
    result.rail = {
      pinned: value.pinned.map((id) => {
        const known = choice(id, DESTINATIONS, 'destination');
        if (!isAvailable(known)) throw new ApiError(400, 'That one is not available yet.');
        if (UNPINNABLE.includes(known)) throw new ApiError(400, 'That one is always there.');
        if (seen.has(known)) throw new ApiError(400, 'A destination can be pinned once.');
        seen.add(known);
        return known;
      }),
    };
  }
}
```

A **closed enum, not free strings**, for one reason: a stored id that no longer
maps to a destination would render a dead rail row. With `choice`, a removed
destination is refused at the boundary, and the array is re-validated on every
write.

The `isAvailable` check is on the **server**, not only in the flyout's pin
control. The flyout hiding the pin button is presentation; this is the boundary.

**A destination that was available when it was pinned and is not any more must
NOT be silently stripped.** `Everything.tsx:283` already has the right rule:

```ts
const pinnable = !unavailable || isPinned;
```

An unavailable destination cannot be newly pinned, but one that is *already*
pinned stays pinnable — meaning the person can take it off. Keep that. The rail
renders it in its unavailable state and they remove it when they choose.

So `migrateSettings` prunes **only ids that no longer exist at all**, never ids
that merely went unavailable:

```ts
// migrateSettings(), after the default fill
settings.rail.pinned = settings.rail.pinned.filter(
  (id) => DESTINATIONS.includes(id) && !UNPINNABLE.includes(id),
);
```

An earlier draft of this section filtered on `isAvailable` too. That was wrong:
it would discard a person's choice silently and lose it for good if the
destination came back, and they would never see the row to unpin it. Stripping an
unknown id is unavoidable — nothing can render it. Stripping a known-but-waiting
one is a decision made on their behalf, which this product does not do.

**Client write path — `patchSettings`, never `writeSettings`.**

`patchSettings` (`client/api.ts:202`) sends no `If-Match` because it *"owns
exactly one field and names only that field"* (`api.ts:195-201`). A pin toggle is
precisely that. `writeSettings` (`api.ts:192`) is guarded and would 409 against a
concurrent write from elsewhere in the app. Follow the `openProjects` /
`lastPage` precedent (`App.tsx:377`, `:393`).

### 4.5 Fallback if the server change cannot land this cycle

`localStorage` under `console.rail.pinned`, reusing `stored`/`remember`
(`Shell.tsx:1513-1525`), is a working alternative with real precedent and **zero**
server change. Its costs, stated honestly:

- Pins do not survive a data-folder move, while every other preference does.
- Nothing server-side can read them — no support action, no "reset my rail", no
  export.
- `stored()` returns `null` on refused storage (`Shell.tsx:1515-1517`), so the
  rail silently reverts to defaults with no notice.

Recommend Settings. Offer localStorage only as a stopgap, and say in the code
comment that it is one.

---

## 5. Recommended default pins for a brand-new user

The reader is a restaurant or auto-shop owner with no AI knowledge. The
discriminating question is not "what is important" but **"what do they touch in
week one."**

**Two now, three once History has a Console view.**

| Pin | One-sentence reason |
|---|---|
| **Tasks** — id `board` (`BoardView`, `Shell.tsx:1242`) | It is the only screen that answers "what is being worked on and what is stuck", which is the question an owner asks every single day. |
| **Files** — id `files` (`FilesPane`, `Shell.tsx:1322`) | Their own documents, in the one shape every other program on the machine has taught them — and it is where the work lands. |
| **History** — id `history` — **held back, see below** | It is the undo, and the product's promise is that nothing happens you cannot take back; it belongs on the rail the moment it can be opened without leaving the Console. |

#### Why History is not a default pin yet — read this before wiring it

**A pinned rail entry must never route through `openInBook`.**

History has no Console view. The only route to it is
`Rail.tsx:111` → `onHistory` → `Shell.tsx:1097` → `openInBook('history')` →
`App.tsx:711-718`, which writes `surface: 'workbook'` **and demotes `detail`
from `technical` to `standard`**. An implementer who wires a History pin to the
existing handler ships a default rail entry whose click changes what the entire
app is — from the Console to the Workbook — for a person who never asked.

That is a worse first-run experience than not having the pin.

So, explicitly, one of two things:

- **(a)** A Console History view is in scope for this change. Then
  `RAIL_DEFAULT_PINS` is `['board', 'files', 'history']` and the pin routes to
  that view.
- **(b)** It is not in scope. Then `RAIL_DEFAULT_PINS` is `['board', 'files']`,
  History stays an available flyout row that still uses `openInBook`, and it is
  promoted in the same change that gives it a Console view.

**This document recommends (b)**, because it keeps the rail change independent of
a view that does not exist yet, and because §8 Q1 is genuinely Andrew's call.
The registry in §4.4 is written for (b).

Note the dependency in §3.1: History's "Yes" is true *today* only because the
Workbook still exists. This worktree is named for the Workbook's removal. When
that lands, History has no renderer at all unless (a) is done — so (a) is not
optional forever, only for now.

**Two is a smaller starting rail than the brief's four, deliberately.** A rail
with two entries and visible room invites the person to open Everything and put
their own thing there. A rail that arrives full teaches them that the rail is not
theirs — which is the habit this change exists to break.

**Explicitly not default-pinned:**

- **Helpers / Team** — setup-time. An owner configures assistants once and then
  cares about the work, not the workers. Ctrl+K reaches it (`paletteEntries.ts:306`).
- **Connected apps, Automations, Notes** — unavailable, so not pinnable at all
  (§3.1, §3.4). The validator refuses them (§4.4).
- **AI helpers / Engines** — setup-time, and it is a Settings section
  (`Settings.tsx:204-211`), not a destination.
- **Your business / Workspaces** — the mark above the thread list already opens it
  (`Shell.tsx:1082`), and it is meaningless for a single-location owner on
  Personal (`store.ts:198`, `activeWorkspace: { kind: 'personal' }`).
- **Projects, Chats, Settings** — already permanent elsewhere (`Shell.tsx:983`,
  the thread list itself, `Shell.tsx:1034`). Listed in `UNPINNABLE`.

---

## 6. Naming

The product rule: **if someone has to ask what a label means, the label has
failed.**

| Today | Where | Verdict | Proposed label |
|---|---|---|---|
| Thread | `Rail.tsx:91` | **Fails.** A thread is a developer's word for a conversation. The rail head already says "Threads" (`Rail.tsx:62`) while the decided action is **New chat**. | **Chats** |
| Board | `Rail.tsx:91` | **Fails.** "Board" describes the layout, not the content — and the layout is a *setting* (`tasksView`, board or list, `Workspace.tsx:823-838`). The Workbook already calls it **Tasks** (`components.tsx:25`). | **Tasks** |
| Team | `Rail.tsx:91` | **Fails.** It implies human colleagues. Diomedes' own Settings calls these *"Helpers on this computer"* (`Settings.tsx:199`). | **Helpers** |
| Connections | `Rail.tsx:91` | **Fails.** Connections to what — people, apps, the internet? The screen is about outside services (`Connections.tsx:12`). | **Connected apps** |
| Files | `Rail.tsx:105` | **Passes.** | Files |
| **Workbook** | `Rail.tsx:108` | **Fails hardest.** It names an internal surface (`types.ts:15`) that no owner has a concept for, and the button does not go to a place — it changes what the whole app is (`App.tsx:711-718`). | *Delete. See §7.* |
| History | `Rail.tsx:111` | **Passes**, and Settings' own copy for it is better still: *"A way back"* (`Settings.tsx:584`). Keep **History**; use that sentence as the flyout row's description. | History |
| **Engines** | `Rail.tsx:114` | **Fails**, and the codebase has already admitted it: `const helpersSection = isDesk ? 'Engines' : 'Helpers on this computer'` (`Settings.tsx:199`). Two names for one thing, chosen by surface, is the definition of a failed label. | **AI helpers** |
| Workspaces | `Workspaces.tsx:155` | **Fails.** SaaS jargon. An owner has a business, not a workspace. | **Your business** |
| Design Center | `Settings.tsx:212`, `App.tsx:946` | **Fails.** "Center" is a brochure word and "Design" could mean anything. | **Look and feel** |
| Projects | `App.tsx:749` | **Passes.** | Projects |
| Settings | `Shell.tsx:1034` | **Passes.** | Settings |
| Ledger | `Ledger.tsx:96` | Not a destination, so it needs no rail label — and its `aria-label` is already the plain *"This project"* (`Ledger.tsx:96`). Leave it. | — |
| *(none yet)* | §3.1 | An unavailable row still needs a label an owner reads without asking. **Automations** fails on its own — it is a software word. | **Jobs that run on their own** |
| *(none yet)* | §3.1 | **Notes** passes, and is the rare case where the obvious word is the right one. | **Notes** |

One more label, the one the whole change turns on: **Everything**. It passes —
nobody asks what "everything" means — and it is better than *More*, *All*, or
*Browse*, each of which invites the question "more than what?". Keep it.

**One contradiction the naming pass must not paper over.** `App.tsx:284` forces
`root.dataset.detail = 'technical'` on the Console surface unconditionally, with
the comment *"The Console shows the machinery."* Plain-English rail labels on a
surface that renders every component in its technical mode is a half-measure. If
the Console is now the only surface (§7), that line is a decision to revisit, not
a constant to route around.

---

## 7. What should NOT be in the flyout

> **Corrected against the owner's 2026-09-19 decision.** An earlier draft
> recommended holding Connected apps back and omitting Notes and Automations.
> That is wrong under the present-but-unavailable rule. All three are **in** the
> flyout, as unavailable rows with the reasons in §3.2. Only one thing is
> genuinely removed, and two are placed elsewhere.

### Workbook — remove it entirely

It is not a destination. `onHome` (`Rail.tsx:108` → `Shell.tsx:1096` →
`App.tsx:711-718`) writes `surface: 'workbook'` and demotes `detail` from
`technical` to `standard`. It is a surface switch dressed as a nav item, and the
console header's `···` menu already offers **The Workbook / The Console**
explicitly (`Shell.tsx:1040-1070`) — so it is also a duplicate.

This worktree is named for its removal. When the Workbook goes, four of its eight
pages have no Console home: **Ask, Plan, Work, Review** (`components.tsx:19-27`).
Ask and Plan are already `Mode` values on the thread composer
(`shared/types.ts:28`, `ThreadView` `mode`), Work is the Thread's live run, and
Review is `ChangeReview` inline in the transcript (`ThreadView.tsx:417`). **All
four are already absorbed.** Only **Documents** and **History** need Console homes
— Documents into Files (§2.2, including its edit affordance), History as its own
destination (§2.1).

### Connected apps (Connections) — in the flyout, unavailable, and out of the view switch

It stays listed. The worry that a list titled **Everything** makes a capability
claim is answered by the reason text, not by hiding the row: `Connections.tsx:38`
already says **"Experimental / synthetic data"** on the screen itself, and the row
now says the same thing in the owner's words before he opens it (§3.2). That is
the product stating the capability's state once, in the place he reads first.

What *does* change: it must come **out of the rail view switch**
(`Rail.tsx:91`), and `Shell.tsx:1102` stops mounting it as a view. An unavailable
destination cannot be one of four permanent buttons.

### Look and feel (Design Center) — leave it in Settings

`Settings.tsx:212` already gates it to the Console, and it is reached from a
button inside Settings (`Settings.tsx:517`). It is a theme-authoring tool. An
auto-shop owner will not author a theme. One entry point is correct.

### AI helpers (Engines) — not its own row

It is a Settings section (`Settings.tsx:204-211`), and the current rail button
only opens Settings with a signal (`App.tsx:719-722`). The flyout should offer
**Settings** once, not eleven deep-links into its sections. If AI helpers deserve
a top-level row later, promote the section first.

### Projects, Chats, Settings — in the flyout, never pinnable

Each already has a permanent home: the header crumb (`Shell.tsx:983`), the thread
list itself, and the header (`Shell.tsx:1034`). List them so Everything is honest
about being everything; block the pin control so a person cannot create a second
copy of something that is always on screen. `UNPINNABLE` in §4.4 encodes this.

---

## 8. Open questions for Andrew

1. **History's surface.** It is a Workbook page today (`Workspace.tsx:1696`) and
   the rail reaches it by leaving the Console (`App.tsx:711-718`). With the
   Workbook going, does History become a Console view, or does the restore log
   move into Files beside each document?
2. **Document editing.** Files is explicitly not an editor
   (`FilesPane.tsx:21-22`); the Workbook's Documents page is
   (`Workspace.tsx:1570`). Removing the Workbook removes editing unless Files
   absorbs it. Is that in this change's scope or a follow-on?
3. **`data-detail="technical"` on the Console** (`App.tsx:284`). If the Console
   becomes the only surface, that line makes every component render in its
   technical mode for an owner who chose `guided`. Revisit, or leave and treat it
   as a separate defect?
4. **`Page = 'connections'`** (`types.ts:27`) is in the type and absent from the
   `pages` array (`components.tsx:19-27`). Dead member — delete with the Workbook?
5. **Connected apps leaving the view switch** (§3.4). The availability rule
   demotes it from one of four permanent buttons (`Rail.tsx:91`,
   `Shell.tsx:1102`) to an unavailable flyout row. That is a real capability
   coming off the screen, so confirm it is intended rather than a side effect.
6. **Automations and Connected apps are one destination in waiting** (§3.3).
   Wiring a real connector wires both. Should they be two rows now and merge
   later, or one row from the start?
