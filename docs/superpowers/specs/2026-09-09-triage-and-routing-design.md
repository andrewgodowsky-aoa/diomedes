# Automatic triage and runtime routing: design specification

Date: 2026-09-09
Status: design, approved for implementation in a fresh thread. Not implemented here.
Repos: `F:/Achilles/diomedes` (desktop app), `F:/Achilles/diomedes-site` (marketing site)
Reference: `F:/Achilles/diomedes-site/docs/reference/instrumented-density-prototype.html`

This is written for an implementer who has not worked on this feature. Every claim about existing
code cites `file:line` and was read from the working tree on 2026-09-09. Three labels are used
throughout and nothing is left ambiguous between them:

- **EXISTS** — already in the tree, cited, works today.
- **THIS SLICE** — built by the work this spec authorises.
- **DEFERRED** — belongs to the future native Diomedes agent and is explicitly not built now.

Ignore `output/main-integration-20260908-084506/source-before/**` entirely. It is a captured
snapshot, not live code, and it shadows several of the greps below with stale line numbers.

---

## 0. Orientation: the shape of the thing today

A **task** is the durable unit of work. `shared/types.ts:83-106` defines it. It carries a name, a
description, an owner, a state, an optional `assignedTo` slot, and a `moves[]` audit trail. It
carries **no engine, model, effort, or route field of any kind**. That absence is the single most
load-bearing fact in this document.

A **thread** (`Conversation`) is where a person talks to a runtime. `shared/types.ts:293` gives it
`requested?: { model: string | null; effort: string | null } | null`. Note what is and is not there:
a model and an effort, and **no engine**. The engine is inferred at render time from whichever
catalogue contains the chosen slug (`client/console/Picker.tsx:87-92`). That works because a thread
has exactly one live runtime at a time. It will not survive being reused for tasks.

The **board** is a view over tasks. `client/console/BoardView.tsx:26-31`:

```ts
function columnOf(task: Task): Column {
  if (task.state === 'todo') return 'Ready';
  if (task.state === 'working') return 'Working';
  if (task.state === 'done') return 'Done';
  if (task.reason === 'needs-ok' || task.reason === 'changes-ready') return 'Review';
  return 'Blocked';
}
```

Five columns derived from four states, because `waiting` splits on `task.reason`. The board moves
work with **verb buttons, not drag and drop** — worth knowing before designing any interaction for
it.

There is **no router, no scheduler, no dispatcher, and no state-change hook** anywhere in the
server. Nothing observes a task entering a state. `Route` is a two-value union
(`shared/types.ts:10`, `export type Route = 'sample' | 'codex';`) and it disagrees with the wider
engine identifiers used on `TeamMember` and in `client/console/Picker.tsx:13`
(`['codex', 'claude-code', 'opencode']`). Two vocabularies for the same concept already exist.

The picker the owner asked to keep **already exists in the app**. `client/console/Picker.tsx` is 214
lines and is a faithful port of the prototype's picker: the same three-span mono trigger, the same
340px right-anchored menu, the same per-model reasoning ladder with struck-through capped rungs. It
reads live catalogues from `GET /engines/:id/models`. This slice **adapts** it. It does not build a
picker from nothing, and it must not restart from the HTML.

Finally, only one engine reports a catalogue. `server/models.ts:112-118`:

```ts
export function engineCatalog(engine: string): EngineCatalog {
  if (engine === 'codex') return codexCatalog();
  if (engine === 'sample')
    return { engine, models: [], detail: 'Sample work is deterministic and has no choices.' };
  return { engine, models: [], detail: 'This engine does not report its choices to Diomedes yet.' };
}
```

Claude Code and OpenCode return empty lists with an honest sentence. Any design that assumes three
populated catalogues will ship an empty menu on two engines out of three.

---

## 1. What is being built, in one paragraph

A sixth board column named **Triage**, leftmost, where a person can write a task and leave it. When
that task is moved to **Ready**, Diomedes picks it up: it records a durable pickup request, decides
which runtime and reasoning level suit the work, starts it, and moves it through the stages on its
own. Tasks that arrive from a thread or from the team view keep today's behaviour exactly — they are
created already running and never sit in Triage. The routing decision is surfaced everywhere through
one shared runtime-selection contract, rendered natively per frontend, with automatic routing shown
as the default and manual override available from the same control. The capability is called
**Automatic triage**.

### 1.1 Two funnels, and the rule that separates them

This is the owner's distinction, in their own words on 2026-09-09, and it decides the default value
of exactly one function argument:

> if its tasks from a team view (e.g. fable leading subagents), it should just begin as per a normal
> model thread, with tasks posted automatically but already began and not by the user. a user created
> task is different. […] one is automated and from regular threads/team view, another is manual and
> could be entirely unrelated.

| Origin | Created in | Who starts it |
|---|---|---|
| A thread, a plan, or a team member over MCP | `todo` (Ready) — **unchanged** | Already running when it appears |
| A person typing into the board's new-task control | `triage` | Nobody, until the person moves it to Ready |

The whole rule reduces to giving `createTask` an optional `state` that **defaults to `'todo'`**. Every
existing caller keeps its behaviour without being touched. Only the new board control passes
`'triage'`. Resist any temptation to make Triage the default because it is leftmost; that would
silently stop the team funnel.

### 1.2 Out of scope

Anything that requires a model to read a task description and reason about it. See section 9.

---

## 2. The `triage` state, and the six enumerations it touches

`shared/types.ts:8` today:

```ts
export type TaskState = 'todo' | 'working' | 'waiting' | 'done';
```

**THIS SLICE** adds `'triage'`, first in the union so the type order matches board order:

```ts
export type TaskState = 'triage' | 'todo' | 'working' | 'waiting' | 'done';
```

That one-word change reaches six places. Three the compiler catches, three it does not. The three it
does not are the reason this section exists — each fails silently and produces a wrong answer rather
than an error.

### 2.1 Caught by the compiler (exhaustive `Record<TaskState, …>`)

| Site | What it is | Value to add |
|---|---|---|
| `server/store.ts:1226` | History label map inside `moveTask` | `triage: 'Triage'` |
| `client/components.tsx:27` | `stateNames`, the Workbook's state labels | `triage: 'Triage'` |
| `client/console/BoardView.tsx:10-24` | `ORDER`, `WHY`, `EMPTY` — keyed by `Column`, so not strictly exhaustive over the new state, but extended in the same edit | see 2.5 |

Do not silence these with `Partial<>` or a cast. They are the design working as intended.

### 2.2 Silent failure one — the manual-move whitelist

`server/app.ts:42`:

```ts
const states: TaskState[] = ['todo', 'working', 'waiting', 'done'];
```

Used at `server/app.ts:755` as `choice(b.state, states, 'task state')`. Until `'triage'` is added
here, `PUT /tasks/:id` rejects every move into or out of Triage with a 400. This one hard-fails
rather than mis-mapping, but it fails at the exact moment the feature is first demonstrated, so it
is listed first.

### 2.3 Silent failure two — the team status map reports Triage as done

`server/team/board.ts:47-54`:

```ts
export function taskStateToTeamStatus(task: Task): { status: TeamTaskStatus; waiting_for?: string } {
  if (task.deletedAt) return { status: 'deleted' };
  if (task.state === 'todo') return { status: 'pending' };
  if (task.state === 'working') return { status: 'in_progress' };
  if (task.state === 'waiting') return { status: 'in_progress', waiting_for: 'owner' };
  return { status: 'completed' };          // <- a triage task falls through to HERE
}
```

An if/else chain with a bare final `return`. A task sitting in Triage would be reported to every team
member over MCP as **completed**. This is the worst defect in the change set: no error, no test
failure, and a member could reasonably act on it.

**THIS SLICE** adds `if (task.state === 'triage') return { status: 'pending' };` before the `todo`
line, and converts the trailing `return` into an explicit `if (task.state === 'done')` followed by a
`never`-typed exhaustiveness throw, so the next state added to the union cannot repeat this.

The reverse map, `server/team/board.ts:42-46`, is deliberately **left alone**. A member setting a
task to `pending` means "not started"; sending it to `todo` keeps it inside the automated funnel,
which is correct. The mapping becomes lossy in one direction — both `triage` and `todo` present as
`pending` — and that is accepted and documented rather than fixed. Triage is a human staging area;
team members have no business putting work into it.

### 2.4 Silent failure three — the member wake captures triaged tasks

`server/app.ts:352`:

```ts
(item) => item.assignedTo === member.slotId && !item.deletedAt && item.state !== 'done',
```

An open-ended negative. Any new state passes it. A task sitting untouched in Triage, if it carries an
`assignedTo`, would be handed to a waking member as its open task — breaking the "it sits there until
I move it" promise that is the entire point of the column.

**THIS SLICE** replaces the negative with a positive list:

```ts
['todo', 'working', 'waiting'].includes(item.state)
```

This is the general lesson for the whole change: **every `!== 'done'` and every trailing `else` over
`TaskState` is a bug waiting for the next state.** Grep for both before starting.

### 2.5 The board column

In `client/console/BoardView.tsx`, `Column` gains `'Triage'` and `ORDER` becomes:

```ts
const ORDER: Column[] = ['Triage', 'Ready', 'Working', 'Review', 'Blocked', 'Done'];
```

`columnOf` gains `if (task.state === 'triage') return 'Triage';` as its first line, plus:

- `WHY.Triage` — `'waits for you to send it'`
- `EMPTY.Triage` — `'Write a task here and move it to Ready when it should start.'`
- `pointClass('Triage')` — `''`. Triage is inert by definition and takes no state colour.

Six columns is a real horizontal cost and the board is already dense. Verify the six-column layout at
1280px and 1440px before calling the column work done. If it does not hold, the answer is to narrow
the gutters, not to drop a column or hide Triage behind a toggle.

### 2.6 Board-side task creation

`EMPTY.Ready` currently reads `'Add a task in the Workbook, or make tasks from a plan.'`
(`client/console/BoardView.tsx:18`) — an admission that the board cannot create work. **THIS SLICE**
adds a `New task` control at the head of the Triage column: name, description, and the routing
control from section 5 defaulted to Automatic. It posts to the existing `POST /tasks` with the new
`state: 'triage'`, and `EMPTY.Ready` is rewritten accordingly.

`server/store.ts:1190-1196` becomes:

```ts
createTask(
  state: StoredState,
  input: {
    name: string;
    description?: string;
    owner?: Owner;
    from?: Task['from'];
    state?: TaskState;      // THIS SLICE. Defaults to 'todo': every existing caller is unchanged.
    route?: Task['route'];  // THIS SLICE. A person may pre-set a runtime while writing the task.
  },
): Task
```

and the hard-coded `state: 'todo'` inside becomes `input.state ?? 'todo'`.

---

## 3. Two new durable records on `Task`

### 3.1 Why `Conversation.requested` cannot be reused

It has no engine (section 0), it lives on the wrong object, and it carries no provenance — nothing in
it can express *who* chose, *when*, or *why*. Automatic routing needs all three, because the whole
product promise is that the choice is visible and overridable rather than hidden. Reusing
`requested` would force the engine to be re-derived from the catalogue on every read, which already
fails today for Claude Code and OpenCode whose catalogues are empty.

### 3.2 `Task.route` — the runtime decision

```ts
/**
 * The runtime this task runs on. Distinct from Conversation.requested: it names its engine
 * explicitly rather than inferring it from a catalogue, and it records who decided and why,
 * because automatic routing is only honest if the person can see the choice and change it.
 * Null means nothing has decided yet.
 */
route?: {
  engine: string;          // integration id: 'codex' | 'claude-code' | 'opencode' | 'sample'
  model: string | null;    // catalogue slug; null follows the engine's own default
  effort: string | null;   // a rung of EFFORT_ORDER; null follows the model's defaultEffort
  by: 'auto' | 'you';      // 'auto' is the default state, not a fallback
  at: string;              // ISO
  why: string;             // one plain sentence, shown in the picker and in History
} | null;
```

`by: 'you'` is **sticky**. Once a person has overridden the route, the dispatcher must not silently
re-decide it on a later pickup. It may only propose, through the mechanism in section 6.3.

### 3.3 `Task.pickup` — the durable request

This is the seam the owner chose: *record a durable pickup request, show it waiting*. It exists so
that a Ready task whose runtime is unavailable is visibly parked rather than silently ignored.

```ts
/**
 * Set when the task enters Ready. The dispatcher consumes it. It is durable so that a
 * pickup surviving a restart is still owed, and so that a task nobody can serve shows as
 * waiting on the board instead of looking started.
 */
pickup?: {
  at: string;                                        // ISO, when Ready was entered
  by: Owner;                                         // who moved it
  state: 'requested' | 'claimed' | 'unserved';
  reason?: string;                                   // required when 'unserved'
  sessionId?: string;                                // set on 'claimed'
} | null;
```

The board renders `requested` as a mono `WAITING FOR PICKUP` line on the card, and `unserved` as an
`attn`-coloured line carrying `reason` verbatim. Neither invents an explanation.

Both fields are optional, so every state file written before this change loads unchanged. No
migration is required; `server/store.ts` already tolerates absent optional task fields (the same
pattern as `assignedTo` and `deletedAt`).

---

## 4. The dispatcher, and the one place a move happens

### 4.1 Fixing the two move paths first

Today a task's state changes in two different places and only one of them is the funnel.

`server/store.ts:1215` — `moveTask(state, task, target, by = 'you')` — writes the state, pushes the
`moves[]` entry with its undo window (60s for `'you'`, 3600s otherwise), and adds a History entry
from a hard-coded label map.

`server/team/service.ts:487` — `taskUpdateAsMember(…)` — assigns `task.state` **directly**, and
writes its own member-attributed History sentence via `progressSentence`
(`server/team/board.ts:34-40`).

Hanging pickup off state changes while two paths exist guarantees that one of them forgets. **THIS
SLICE** extracts a private `transition()` in `server/store.ts` that owns the state write, the
`moves[]` entry, and the `pickup` record. `moveTask` calls it and then adds its standard History
sentence; `taskUpdateAsMember` calls it and keeps its own member-attributed sentence. History output
is byte-identical in both paths afterwards — this is a refactor with a new side effect, not a change
in what either path says.

`transition()` is where the entire feature attaches:

```
transition(state, task, target, by):
  if task.state === target: return
  write task.state, push moves[]
  if target === 'todo':                    // entering Ready is the trigger, from ANY path
    task.pickup = { at: now(), by, state: 'requested' }
    queue a dispatch for this task         // never awaited on the request path
  if target !== 'todo' && task.pickup?.state === 'requested':
    task.pickup = null                     // moved out of Ready before pickup; the request lapses
```

The dispatch is **queued, never awaited**. `server/store.ts` already establishes this discipline for
the document walk (`server/store.ts:1241`, "Never walk on the request path"). A `PUT /tasks/:id` that
blocks until a model starts would make the board feel broken.

### 4.2 The dispatcher

New file, `server/dispatch.ts`. Single-flight per project, driven by a queue, with one public entry
point:

```ts
export interface Dispatcher {
  /** Called by store.transition when a task enters Ready. Never throws to the caller. */
  request(projectId: string, taskId: string): void;
  /** Re-queue every task whose pickup is still 'requested'. Called once on project load. */
  resume(projectId: string): void;
}
```

For each queued task, in order:

1. **Skip if already running.** `server/app.ts:750-754` already guards manual moves with
   `state.sessions.some(s => s.taskId === task.id && ['working','waiting','queued'].includes(s.state))`.
   Reuse that predicate; do not re-implement it.
2. **Resolve the route.** If `task.route?.by === 'you'`, use it verbatim. Otherwise call
   `decideRoute()` (section 4.3) and store the result with `by: 'auto'`.
3. **Check the runtime is actually available.** Same predicate the picker uses,
   `client/console/Picker.tsx:26-31` — the integration exists, is available, and
   `settings.services[id] === true`. Move this into `shared/` so server and client cannot drift.
4. **Start the work.** Reuse the existing run starter. `startCodexWork(…)` is already called with a
   `taskId` at `server/app.ts:354-369`; the dispatcher calls the same function with
   `wake: true` and the task's own description as `text`.
5. **On success** — `pickup.state = 'claimed'`, `pickup.sessionId = …`, and `transition(task,
   'working')`. The task moves itself into the Working column. This is the automatic stage movement.
6. **On no available runtime** — `pickup.state = 'unserved'`, `reason` set to the plain sentence from
   the integration or catalogue (`server/models.ts:117` already supplies one). **The task stays in
   Ready.** It is not moved back to Triage and it is not moved to Blocked: it was legitimately sent,
   and the board says so.

Every non-Codex engine currently lands on step 6, because `server/app.ts:349` reads
`if (member.engine !== 'codex') throw new ApiError(409, 'This helper cannot run here yet.')`. That is
correct and honest behaviour on day one, not a stub — the pickup is recorded, shown, and served the
moment that engine can run.

Later stage movement — Working to Review or Done — already happens through the existing session
lifecycle and needs no new machinery here.

### 4.3 The routing decision

`decideRoute(task, catalogues, integrations, settings): Task['route']`. Pure, synchronous,
deterministic, in `shared/` so both the server and the picker's preview can call it.

**THIS SLICE** ships it as a scored rule set over the task's own text and the live catalogues:

- Prefer an engine that is available and enabled; among those, prefer the one with a populated
  catalogue, since a runtime that cannot report its choices cannot be routed intelligently.
- Choose the model whose catalogue `priority` is best (`server/models.ts:104-110` already reads a
  `priority` from the Codex cache).
- Choose the effort from the task's shape, held to the mode ceiling by the existing
  `effortFor()` (`shared/effort.ts:32-44`), so Fix work still cannot be handed a deeper budget than
  `MODE_CEILING.fix = 'medium'` (`shared/effort.ts:16`).
- Always write `why` as one sentence naming the actual reason, e.g. `Codex is the only runtime that
  reports its models; gpt-5.5-codex at high is its default for build work.`

It is deliberately not clever. Its value is that **the seam is real and load-bearing**: the
dispatcher, the persistence, the movement, the display and the override all work against this
signature today. Section 9 replaces the body of this one function and nothing else.

---

## 5. The shared runtime-selection contract

The owner's decision, verbatim:

> Use a shared runtime-selection contract with native renderers for each frontend. The Electron app
> gets a React picker; the Astro site keeps its own renderer. Do not use the browser/native
> `<select>` for runtime/model selection in the app.

### 5.1 What is shared, and what is not

New file, `shared/runtime-selection.ts`. **Pure data and pure functions. No React, no DOM, no CSS.**

```ts
export interface RuntimeChoice { engine: string; model: string | null; effort: string | null }

export interface RuntimeRung {
  id: string;            // a rung of this model's own ladder, NOT a normalised scale
  description: string;
  capped: boolean;       // effortFor() would lower it under the active mode ceiling
}

export interface RuntimeOption {
  engine: string;
  slug: string | null;   // null is the engine's "Default" row
  name: string;
  description: string;
  rungs: RuntimeRung[];  // empty when this engine reports no ladder
}

export interface RuntimeGroup {
  engine: string;
  name: string;
  where: string;         // provenance, right-aligned: 'ChatGPT account', 'installed 2.1.252'
  detail: string;        // EngineCatalog.detail, shown verbatim when options is empty
  options: RuntimeOption[];
}

export interface RuntimeSelection {
  groups: RuntimeGroup[];
  chosen: RuntimeChoice | null;   // null means automatic
  resolved: RuntimeChoice;        // what will actually run, automatic or not
  auto: boolean;
  why: string | null;             // route.why when automatic
  ceiling: string | null;         // MODE_CEILING[mode]
  lowered: boolean;               // effortLowered(): the ceiling is reducing the choice
}

export function buildSelection(input: {
  catalogues: EngineCatalog[];
  integrations: IntegrationStatus[];
  settings: Settings;
  mode: Mode;
  chosen: RuntimeChoice | null;
  auto: RuntimeChoice | null;
  why?: string | null;
}): RuntimeSelection;
```

`buildSelection` is the entire contract. Both frontends call it and render the result their own way.
It is where the existing derivations at `client/console/Picker.tsx:84-98` move to, unchanged in
behaviour — `capped`, `lowered` and the ceiling note keep using `effortFor` and `effortLowered` from
`shared/effort.ts:32-53`.

**Not shared:** markup, CSS, animation, focus handling, keyboard interaction. Those are per-frontend
and always were.

### 5.2 Provider-specific ladders are preserved, not normalised

The owner was explicit: *"Preserve provider-specific controls instead of pretending every runtime
exposes the same effort scale."*

`EngineModel.efforts` is already per-model (`shared/types.ts:305`), and `EFFORT_ORDER`
(`shared/effort.ts:8`) documents that engines offer a *contiguous run* of it — GPT-5.5 stops at
`xhigh`, Astra reaches `ultra`. Therefore:

- `rungs` is built from that model's own `efforts`, ordered by `EFFORT_ORDER` where the id is known
  and appended in catalogue order where it is not. A vendor rung that is not on the ladder is shown,
  not dropped.
- An engine with an empty catalogue renders **its `detail` sentence and no rail at all**. It does not
  get a fabricated low/medium/high. Today that is Claude Code and OpenCode
  (`server/models.ts:117`), and showing them an invented ladder would be the exact dishonesty this
  clause forbids.
- The ceiling is a per-mode fact, not a per-engine one, and it renders as a struck rung plus the
  existing sentence (`client/console/Picker.tsx:197-200`).

### 5.3 The Astro renderer

The site cannot reach a live catalogue. It renders `buildSelection` against a committed snapshot
checked in at `src/data/runtimes.snapshot.json`, generated from a real `engineCatalog()` read and
dated in the file. The site's own Astro renderer stays; only the data shape becomes shared. This
keeps the marketing page from claiming capabilities the product does not have — the same discipline
already enforced by `src/data/engines.ts` and its `rosterStatus()` single source of truth.

---

## 6. The picker itself

### 6.1 What is kept

`client/console/Picker.tsx` is the starting point and its structure survives intact: the three-span
mono trigger (`.eng` / `.mdl` / `.eff`), the 340px right-anchored `.pmenu`, engine `<h4>` headers
with right-aligned provenance, the two-column model rows with slug and note, and
`.eff.capped` for a lowered effort. Selection remains **one signal only** — the prototype's
`.m.on .id { color: var(--light) }` — not a checkmark, not a filled row.

Its internals change in three ways: it calls `buildSelection` instead of deriving inline; it accepts
a route rather than requiring a `Conversation`, so it can mount on a task (today it only mounts when
a thread is selected, `client/console/Shell.tsx:540`); and it gains the automatic state.

`ENGINE_IDS` at `client/console/Picker.tsx:13` is hardcoded. It becomes derived from
`integrations`, which is what "have it update per provider" requires — a new provider appearing in
the integration list must appear in the picker without a code change.

### 6.2 Bringing it into the Diomedes language

The owner asked for the website picker as the visual starting point, brought fully into the approved
graphite/cyan language. Two corrections carry over from
`F:/Achilles/diomedes-site/docs/reference/app-handoff-2026-09-09.md`, and they belong in this work
because the picker is the surface that shows them:

- `client/styles.css:399` — `.button` has **no `border-radius`**, so every button in the app renders
  as a hard square. `var(--rb)` (5px, `client/styles.css:22`) is used exactly once in the whole
  stylesheet. The picker's trigger and rows must carry `--rb`, and the bare `border:` rules nearby
  should be checked for the same omission.
- Cyan stays semantic. In the picker it means exactly one thing: **this is what will run.** It is not
  used for hover, for the menu border, or for the group headers.

### 6.3 The stepped, animated reasoning rail

Replacing the flat row of buttons at `client/console/Picker.tsx:184-195`.

**Structure.** A single horizontal track with one stop per rung, `role="radiogroup"
aria-label="Reasoning level"`, each stop a `role="radio"` button carrying the rung id in mono
uppercase and the rung description as its accessible name. Full arrow-key operation, matching the
mode rail already shipped on the site.

**Motion.** The track fills in cyan from the left to the selected stop; the selected indicator
*travels* to its new stop rather than disappearing and reappearing. This is the Living Thread rule
and the app already has the mechanism: `client/console/motion.ts` implements travel on the Web
Animations API with `EASE_ARRIVE` (`client/console/motion.ts:21`), one travelling point at a time,
and progressive plainness on repeats. **Use `travel()`. Do not add a library and do not hand-roll a
second animation path.**

**Capped rungs.** Rungs above the mode ceiling render struck through in `--attn` — the prototype's
`.capped` treatment — and remain focusable and readable. A capped rung is still selectable; the
existing note then explains what will actually run
(`client/console/Picker.tsx:197-200`).

**Reduced motion.** `client/console/motion.ts:29` already reads both `html[data-motion='reduced']`
and the media query, and drops travel while keeping the state change. Inherit it; add nothing.

### 6.4 Automatic as the visible default

> Automatic routing must be visible as the default, with manual override from the same picker.

- **Automatic, nothing chosen.** The trigger's engine span reads `AUTO` in cyan; the model and effort
  spans show the *resolved* choice in the dim `--t3` tone, e.g. `AUTO · gpt-5.5-codex · high`. A
  person can always see what will run, and that it was not their decision.
- **The menu** opens with an `Automatic` row above the first engine group, selected by the same
  single `.on` signal. Under it, one line: `route.why`, verbatim.
- **Overriding** is choosing any model row or any rung. That writes `route.by = 'you'` and the trigger
  drops `AUTO` for the engine's real name.
- **Reverting** is choosing `Automatic` again, which sets `route` back to `by: 'auto'` and re-runs
  `decideRoute()`.
- A route the dispatcher would now choose differently is **never** silently changed under a person.
  The `Automatic` row shows what it would pick, and choosing it applies that.

---

## 7. Retiring the native selects

The owner: *"I want a stepped, animated reasoning rail rather than the current white OS dropdown."*
Four native `<select>` elements select a runtime today. All four are replaced by the picker.

| Site | What it is now | Becomes |
|---|---|---|
| `client/console/TeamView.tsx:430-435` | `<select aria-label="Recipient">` whose first option is literally `Diomedes routes it` | The routing control. `Automatic` replaces that option and carries `route.why`; the member rows follow, styled as picker rows |
| `client/Workspace.tsx:729` | `<select value={route}>` labelled "Service" (sample \| codex) | Picker, thread scope |
| `client/Workspace.tsx:2320` | second instance of the same | Picker, thread scope |
| `client/Settings.tsx:301, 319` | "Default choice" and "Default reasoning level" | Picker in **default mode** — no thread, no task; writes `settings.services.codexModel` / `codexEffort`, which `client/console/Picker.tsx:84-85` already reads |

`TeamView.tsx:430` is the one the owner pointed at, and it is more than a styling change: `Diomedes
routes it` is a promise the product could not keep until this slice, because no router existed. After
this work that option is the automatic route, and it is real.

`client/Workspace.tsx` is the Workbook surface. Two related decisions are already recorded against it
in `app-handoff-2026-09-09.md` sections 3 and 4 and are **not** part of this slice; do not fold them
in.

---

## 8. Test obligations

### 8.1 The floor test will reject the rail — amend it in the same commit

`tests/ui.spec.ts:405-418` walks every visible element on Home and fails the run on any text under
**14px**, any `<button>` shorter than **35.5px**, and any live animation or non-zero transition. The
matching comment sits at `client/styles.css:214`.

The rail is mono ~11px with wide tracking, its stops are small, and it animates. **The rail and this
test cannot both be true.** The fix is the one already prescribed in `app-handoff-2026-09-09.md`
section 5: hold the 14px floor for proportional text a person reads, and exempt the mono
machine-state class — the same counter-rule the website uses in `src/styles/surface.css`. Do not
delete the test, and do not ship the rail without amending it, or CI will report the approved design
as a defect.

### 8.2 New coverage

Each of these asserts a property that would otherwise fail silently:

1. A task created from the board lands in `triage`; a task created from a plan or over MCP lands in
   `todo`. **The default argument is the whole funnel rule.**
2. `taskStateToTeamStatus` on a `triage` task returns `pending`, never `completed` (§2.3).
3. A member wake does not select a task that is sitting in `triage` (§2.4).
4. Moving a task to Ready writes `pickup.state === 'requested'`, from **both** `moveTask` and
   `taskUpdateAsMember` (§4.1) — the test that proves the two paths were actually unified.
5. Moving a task out of Ready before pickup clears the request.
6. With no available runtime, the task stays in Ready with `pickup.state === 'unserved'` and a
   non-empty `reason`.
7. `route.by === 'you'` survives a later pickup unchanged (§3.2).
8. An engine with an empty catalogue renders its `detail` sentence and **no** rail (§5.2).
9. `buildSelection` produces the same `resolved` choice as `effortFor` for a capped mode.
10. `PUT /tasks/:id` accepts `triage` as a target (§2.2).

---

## 9. DEFERRED — the native Diomedes agent

Everything above ships without it. What is deferred is exactly one function body.

`decideRoute()` in section 4.3 is a deterministic rule set. The native Diomedes agent replaces it
with a real reading of the task: understanding what the work actually is, which runtime suits it, how
much reasoning it deserves, and — later — when a task should move stage without a session lifecycle
event saying so. It implements the same signature. Nothing else in the dispatcher, the persistence,
the board, the picker or the override changes when it arrives.

To be explicit, because this boundary was drawn the wrong way once already: **the dispatcher, the
routing decision and the automatic stage movement are all built now.** There is no null
implementation, no stub, and no "wire it up later". A task moved to Ready in the shipped slice is
picked up, routed, started and moved by code that exists. The missing piece is the quality of the
judgement, not the machinery that carries it out.

Also deferred, and not to be smuggled in:

- Catalogue reporting for Claude Code and OpenCode. Until those engines report their models, they
  correctly show their `detail` sentence (`server/models.ts:117`).
- Running non-Codex engines from a wake (`server/app.ts:349`).
- Reconciling `Route` (`shared/types.ts:10`) with the wider engine identifier used everywhere else.
  This slice introduces no third vocabulary — `route.engine` uses integration ids, the same strings
  the picker and the integration list already use — but the old two-value union survives alongside it
  and should be retired in its own change.

---

## 10. Build order and isolation

Isolation is a hard constraint: **do not touch Astra's live thread, `astra/codex-team-mcp`.** Work in
a dedicated worktree under `F:/Achilles/diomedes-wt/` on a branch of its own, following the existing
worktree-per-agent convention.

Sequence, each step leaving the tree green:

1. `TaskState` gains `triage`; fix all six sites in §2. Compile, run the suite, no behaviour change
   yet beyond a column that is always empty.
2. `Task.route` and `Task.pickup` types; `createTask` gains `state` and `route`. No reader yet.
3. Extract `transition()` and route both move paths through it (§4.1). Prove History output is
   unchanged — this is the riskiest refactor in the slice and it is not visible if it breaks.
4. Board: Triage column, new-task control, pickup states on cards.
5. `shared/runtime-selection.ts` and `buildSelection`; move the picker's derivations into it with no
   visual change. This step should be provably a no-op on screen.
6. `decideRoute()` and `server/dispatch.ts`; wire the queue into `transition()`.
7. The rail, the automatic state, and the `client/styles.css:399` radius fix — with the
   `tests/ui.spec.ts:412` amendment in the same commit (§8.1).
8. Retire the four native selects (§7).
9. The site's snapshot renderer (§5.3), in the website repo, separately.

Steps 1–3 are the ones that break things quietly. Steps 4–8 are visible and will be caught by eye.

---

## 11. Decisions already made — do not relitigate

| Decision | Made by | Where |
|---|---|---|
| Triage is a 6th board column, leftmost | owner, 2026-09-09 | §2.5 |
| Team/thread tasks start already running; only user-authored tasks sit in Triage | owner, 2026-09-09 | §1.1 |
| The pickup seam is a durable request shown as waiting | owner, 2026-09-09 | §3.3 |
| Shared contract, native renderers per frontend | owner, 2026-09-09 | §5 |
| No native `<select>` for runtime or model selection in the app | owner, 2026-09-09 | §7 |
| Provider-specific ladders preserved, not normalised | owner, 2026-09-09 | §5.2 |
| Automatic routing visible as the default, overridable from the same control | owner, 2026-09-09 | §6.4 |
| Dispatcher, routing decision and stage movement are built now | owner, 2026-09-09 | §9 |
| The capability is named **Automatic triage** | owner, 2026-09-09 | title |

---

Related: `docs/superpowers/specs/2026-09-09-accounts-and-remote-pairing-design.md`,
`F:/Achilles/diomedes-site/docs/reference/app-handoff-2026-09-09.md`, and the prototype at
`F:/Achilles/diomedes-site/docs/reference/instrumented-density-prototype.html`.
