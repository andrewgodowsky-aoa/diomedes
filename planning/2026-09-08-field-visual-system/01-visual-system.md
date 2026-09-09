# Diomedes visual system: the Field (2026-09-08)

Status 06:36 EDT: Andrew calls this the best design yet and is "a huge, huge fan" of the wake.
The direction is approved; the five decisions at the end still stand before build.

Andrew's brief, 06:25 EDT: keep the flattened productivity-tool architecture (no pervasive cards,
bubbles, glass, gradients or pills), but the de-AI pass lost identity. Build a coherent system
around "the Field": Diomedes is the central intelligence and executor; threads reach into projects,
workers, machines, documents and business systems. Conceptual inspiration only from Diomedes and
Athena, action guided by perception and strategy; no Greek imagery. A unique mark (abstract D or
spear-line with a very small guiding point); the point and the thread as motifs with meaning. A
wake sequence with the restraint of Hermes Desktop. Two operational models: an execution board whose
states are executable, and a multi-worker view that feels like one coordinated system. Calm and
readable; mysterious for a few seconds when it wakes, extremely clear once work begins.

Status 07:00 EDT: the visual language is approved. No further shell redesign and no global aesthetic
passes. Work moves to information architecture and interaction (section 6c). The canon prototype is
`04-canon-ia-pass-prototype.html` (artifact "Diomedes Living Thread"); the experimental set that pushes
the same notes further is `05-instrumented-density-prototype.html` (artifact "Diomedes Instrumented
Density"). Earlier states: `02` the pre-motion working target, `03` the Living Thread before the IA pass.
This note is the system; the prototypes are the evidence.

## 1. Premise

- **Diomedes is the point.** One small point stands for the intelligence at the centre. It is the
  only element in the interface allowed a soft glow, and only when it is live.
- **Work is a thread.** A thread is a line from the point to an endpoint: a project, a worker, a
  document, a machine. Threads are drawn as hairlines; they carry state by how they are drawn.
- **Perception precedes action** (the Athena relation). In the mark, the guiding point sits ahead of
  the spear tip. In the interface, the point always marks where attention is before anything moves:
  the selected thread, the next step, the row about to start, the worker about to receive a handoff.

Nothing in the system is decoration. Each element answers: whose attention, which thread, what state.

## 2. The mark

An open D drawn as a spear-line, with the guiding point ahead of its tip.

- A 24-unit box. Shaft: a straight stroke from (5,3) to (5,21). Blade: a single curve leaving the
  top of the shaft, reaching x = 18 at mid height, and returning toward (9,21) without closing;
  stroke 1.6, round caps, so the return tapers like a tip.
- Guiding point: radius 1.6 at (20.5, 12), just beyond the blade's furthest reach.
- Colour: strokes in text colour; the point takes the state colour (see 4). At rest the point is
  ice; while Diomedes works it is cyan; when something needs the person it is amber.
- Wordmark: DIOMEDES in Schibsted Grotesk 400, tracked 0.32em, 12.5 px in chrome, 22 px in the wake.
  Big Shoulders Display retires.
- The mark alone (no wordmark) is the app icon, the tab favicon, and the gutter marker of a Diomedes
  turn at 10 px.

## 3. Motifs and their meaning

**The point.** Filled cyan: live, running now. Hollow: ready, not started. Filled ice: done or at
rest. Amber: waiting on the person. Red: failed. Size is fixed (8 px in lists, 6 px in text, 1.6
units in the mark); the point never grows to shout.

**The thread.** Hairline (1 px, `--hair`): a relation that exists. Solid text-colour: work is
travelling along it now. Dashed: planned, not yet run. Broken with a gap: blocked. The point may move
along a thread while work runs (a 1.6 s loop, low contrast); that is the one continuous motion in
the working state.

Where they appear: the thread rail's spine (a vertical hairline with the point at the selected
thread; the point slides when the selection changes); the transcript (a point in the gutter beside
each Diomedes turn; exchange dividers are threads that start 24 px into the gutter, reaching in);
the mode strip (a point under the active mode with a trailing line whose form says how much the mode
may change: Ask, point only; Plan, point and dashed line; Build, point and solid line; Fix, point
and a short solid line); the board (a thread under a Working row that lengthens); the team view (a
spine from the Diomedes point to each worker lane; handoffs travel along it).

## 4. Tokens

Colour, cool graphite neutrals, one light, two semantics:

| Token | Value | Use |
|---|---|---|
| `--chrome` | `#121417` | rail, ledger, top strip, wake |
| `--surface` | `#16191d` | work surface |
| `--raised` | `#1c2025` | composer, palette, hover |
| `--hair` / `--hair-2` | `rgba(255,255,255,.07)` / `.12` | threads, dividers, control edges |
| `--t1` / `--t2` / `--t3` | `#e6e9ed` / `#a4acb6` / `#6d7681` | text, secondary, system |
| `--light` | `#3fd6df` | the point when live; the mode indicator; nothing else |
| `--attn` | `#e0a94a` | waiting on the person |
| `--fail` | `#e06c6c` | failed, blocked |

Type: Schibsted Grotesk for everything read and operated (UI 13 px, transcript 15.5 px / 1.6,
thread title 18 px medium, metadata 12 to 13 px). IBM Plex Mono for system facts only: uppercase 11 px
tracked 0.08em for labels (`ASK · CODEX`, `3 OPEN`, `61% LEFT`), lowercase 11.5 px for logs and
the wake lines. IBM Plex Serif leaves the Console; whether the Workbook keeps it for long reading is
a separate decision.

Shape: panels 6 px, controls 5 px, segmented controls 5 px with hairline dividers. No pills. Depth by
hairline and tone only; no shadows except the palette.

Motion: in the app, 140 to 220 ms ease-out, transform and opacity only, hover states are a tone
shift, nothing animates on keyboard-repeated actions. The wake is the exception (section 5).
Reduced motion: the wake resolves at once; the travelling point stands still.

Density: thinking is sparse, working is dense. Ask shows the least; Plan, Build and Fix add rows to
the composer and the ledger; the board and the team view are the densest surfaces and earn it.

## 5. The wake

The connection experience when Diomedes starts or reconnects to its service.

1. Chrome-black field, nothing else. The guiding point appears at centre (scale from 0, 400 ms).
2. A thread draws leftward from the point along the baseline where the wordmark will sit (600 ms).
3. The letters of DIOMEDES resolve one at a time, 60 ms apart, from tracking 0.9em to 0.32em over
   900 ms, so the word assembles rather than fades.
4. Beneath, in lowercase mono at `--t3`, one line at a time, each replacing the last:
   `recovering the field`, then `restoring context  3 projects  2 workers` (real counts), then
   `field established`. If the service is not reachable the last line reads `field not reached` and
   a plain "Try again" appears; the wake never spins.
5. The field fades to the workspace (300 ms). Total about 3.2 s. Any key or click skips to the end.

The wake also plays, shorter, when a project reconnects after sleep or a service restart; the copy
then is `restoring context` alone.

## 6. Surfaces

**Workspace (a thread).** Rail 232 px with the thread spine; work surface with a 720 px reading
column offset 56 px from the rail; ledger 296 px. Transcript as an editorial record: name line
(Andrew, Diomedes) with time and Copy / Make a task on hover, text native to the canvas, exchanges
divided by threads. Composer: a 6 px panel on `--raised`, the mode strip (mono uppercase, point and
line indicator), the caption for the mode, Send in `--light` when ready.

**The picker.** Top right, in every mode: engine, the full model id, and the reasoning level, as one
mono control (`CODEX  gpt-5.2-codex  medium`). Ask never hides it; the mode changes what Diomedes
may do, not what is running, and the person should always be able to read the model name, as in
Cursor. Clicking opens a flat menu grouped by engine (each with where it comes from: ChatGPT account,
installed version, OpenCode Go), the model's own reasoning ladder underneath, and one line of
consequence. Fix caps the level at medium; the control shows `high, runs medium` in amber and the
menu says "Fix runs at medium. Your choice still governs Ask, Plan and Build." The thread head
repeats the mode and the model id in mono. The choice is per thread; the default lives in Settings.

**Ledger.** Project name in mono uppercase, one line of counts, then sections divided by hairlines:
Work (rows with the point glyph, owner in mono, due note), Needs you, Activity (mono log, lit while
running), Recent. The ledger is domain content, never navigation.

**Execution board.** Five columns, Ready, Working, Review, Blocked, Done, as hairline-topped lists
with mono counts; no cards. A row is: state point, title, worker in mono, age. States are executable:
hovering a row reveals the one verb its state allows under the project policy. Ready: Start (hands
the task to its worker; under "Show me first" an inline confirm appears in the row, under "Go ahead
for tasks" it starts at once). Working: Pause. Review: Review (opens the proposal). Blocked: Route
to (choose another worker; the thread redraws to the new lane). Done: Reopen. Moving a row between
columns is the same action as the verb, not a relabel. A Working row grows a thread under its title.
The policy sits at the top right as a two-way segmented control and applies to the whole board.

**Team (multi-worker).** One task at the top with the Diomedes point; a spine runs from it and
branches to each worker lane. Lanes stand side by side: header (worker name, role, engine and model
in mono, state point), a condensed mono log, the last message in prose, and hover controls Pause,
Take over, Message. A handoff is drawn as the point travelling along the spine from one lane to the
next, with a one-line mono record in both logs. One composer at the bottom addresses Diomedes, who
routes; a "to" control can pin a message to one lane. It reads as one system because the spine,
the point and the log grammar are shared, and because nothing in a lane looks like a chat window.

## 6b. The living thread (motion language, approved 06:45 EDT)

Andrew chose this over "light follows Diomedes" (rejected as ambient atmosphere; at most a
luminance step on a modified board row, later) and "instrumented density" (queued as the next
pass: Ctrl+K as a command surface that starts, pauses and routes; per-worker context as a filling
thread; virtualised logs). His conditions are rules:

- **Nothing waits on motion.** The destination is live the instant it is asked for; the travelling
  point only explains continuity. 150 to 300 ms for navigation and state changes; 350 to 500 ms
  only for a real handoff between workers; every animation interruptible; no chained sequences in
  daily work; reduced motion keeps the fade and the state change and drops the travel.
- **Repeated actions get plainer.** The fifth trip of a kind runs at 160 ms without the landing
  pulse; after the eighth, only the 160 ms arrival fade remains. Enter never animates.
- **The startup is the one ceremony.** The wake's guiding point ends by travelling into the mark's
  point in the top left and taking its place.

What travels, and where, in the prototype "Diomedes Field System, pushed":
- Thread to Board: the point leaves the thread's gutter and lands on that thread's task row.
- Board to Team: it leaves the row and lands on the task's point above the lanes.
- Back to Thread: it lands on the latest Diomedes turn.
- Board actions: Start moves the point from the Ready row to the new Working row (280 ms);
  Route to crosses to the other worker's row (420 ms, a handoff); Review to Done, 220 ms.
- Team: the handoff point runs the spine from Codex into the Claude Code lane and decelerates
  (480 ms); the log line lands at once.
- The mode strip's point moves on a small spring (stiffness 210, damping 22, settles under 300 ms,
  interruptible); its line scales rather than resizes.

Mechanics: Web Animations API for travel and the spring, CSS for arrival fades and the landing
scale, no library, no View Transitions (they block input for their duration). One travelling point at
a time; a new trip cancels the last.

## 6c. Information architecture and interaction (Andrew's notes, 07:00 EDT)

The shell is settled: Thread architecture, graphite surfaces, cyan as the semantic accent, the type
philosophy, left project navigation, right contextual inspector, the DIOMEDES identity, the Living
Thread, Ask/Plan/Build/Fix, the model picker (approved as it stands: provider grouping, readable names,
technical ids, one line of purpose, effort inside; no benchmarks) and the Ctrl+K direction. The next
milestone is legible, operational and unmistakably Diomedes, not prettier. What the canon prototype
now does, and what the density set pushes further:

**Thread.** Reading column 760 px, transcript 16 px / 1.65, turns 68ch. Conversation and instrumentation
are two registers: prose is Schibsted at 16 px; everything measured is mono at 11 to 11.5 px, and lives
in two places only: the instrument line under the title (`ASK gpt-5.2-codex medium · context 14% · last
run 06:42 4.2 s · task Permit renewal WORKING Codex`) and the run record beside a Diomedes turn (a
hairline-left mono block that lists what the run read and folds to `2 documents read 3.1 s` when it
ends). Debug text is gone or formalised: the top bar's unlabelled `61% left` became `context 14%` on
the instrument line; the ledger's dump became structured events; `idle` became `quiet`; the prototype
controls are labelled as such. Density set: the record keeps per-step timings and a `show run` toggle,
the instrument line counts runs, the ledger groups events by run with `2 earlier runs` loading in place.

**Inspector.** Hierarchy by type and hairline weight, no new surface: the project name, then a
"this thread's work" block on a stronger hairline (the task, its state and owner in mono, Board and Team
as plain links), then Work (two-line rows: title, then owner and status in 12 px), Needs you, Activity
(structured mono events with a run header), Recent (quiet 12 px). Section labels are mono uppercase and
recede; items are 13 px `--t1` and advance.

**Team, the primary task.** Three lanes on one grid, regions aligned across lanes with subgrid: header
(name, role, engine and model in mono, state word), current action (proportional 13.5 px with elapsed
in mono; Waiting shows a letterspaced `WAITING` and dashed spine; Blocked shows an amber `blocked`, a
broken spine and its two verbs always visible), event stream (mono, the flexible row, min 160 px, scrolls
inside), communication (proportional, attributed `to Claude Code` / `from Codex` in mono; quiet lanes say
`No messages yet.`), then hover controls. Structural dividers are hairlines between lanes; each lane has
a vertical spine at its left with the worker's point on it at the header and a live point at the current
event. A handoff is a polyline: along the giver's record, across the divider, into the receiver's record;
the point travels it in 480 ms and the line stays as a solid thread. The records land in both streams
at once, and the task row above counts handoffs. Density set: a context meter (a filling hairline with
`context 38% · 3 files open`) under each header, the stream as aligned columns (time, kind, detail, with
per-step ms) and an `N earlier events` row that loads in place instead of shipping the whole log.

**Board.** Each column names what its state does to a worker under its title (`Start hands it to its
worker`, `a worker holds it now`, `waits on you`, `needs an answer or a route`, `kept; Reopen to change
it`). Blocked rows carry their reason in amber, Review rows their proposal size, and the row that
belongs to the open thread says `this thread` in cyan. Rows are 6 px tighter. Density set: compact rows
(title, worker, age on one line; a toggle in the head), `Working 1 of 2 slots`, amber counts on Review
and Blocked.

**Ctrl+K.** An operational surface, not search. Groups: Tasks, Workers, Models, Projects, Views. Each
row shows its state point, a mono state line and only the verbs valid now: Ready has Start; Working has
Pause, Handoff, Team; Review has Review; Blocked has Route to; Done has Reopen; workers have Message,
Pause, Take over, Lane; models have Use here. Tab moves between the row's verbs, Enter runs the
highlighted one, and a typed verb filters to what can do it (`pause` lists only running work and live
workers). The verbs call the same functions the board's row verbs call. Density set: a Recent group
with the last three things acted on, Start under "Show me first" confirms inside the palette (`Start now`
/ `Not now`), and a task's `Model` verb pivots the palette to the model list without closing.

**Motion.** Unchanged rules (6b). Thread, Board and Team are one piece of work seen from three sides:
the instrument line, the inspector's focus block and the board's `this thread` row all read the same
task record, and the travelling point connects the same task across the three.

## 7. Do not

Cards for everything; bubbles; glass; gradients; pills; a second accent; icons beside every label;
glow anywhere but the live point; a spinner; Greek imagery of any kind; centring the reading column;
animating on Enter.

## 9. Brand layers and ritual moments (Andrew's Hermes notes, 07:00 EDT)

Three layers. **Core product UI**: crisp, readable, calm, practical; this is sections 4 and 6. **Ritual
moments**: startup, reconnecting, agent handoff, waiting on a remote host, entering a workspace, a major
completion, a special empty state; the Hermes-like restraint belongs here and nowhere else. **Marketing
imagery**: hero and section art may be more atmospheric than the app.

The mood is mythic minimalism: ancient in tone, modern in execution. Fields (dark spatial surfaces,
faint grain), signals (points, traces, threads), constellations (structured clusters, never literal
stars), fragments becoming order, thresholds. No helmets, statues, runes or swords. Once the person is
working the interface is clearer, more grounded and more human than at the threshold.

In the prototypes: the wake is the full ceremony (section 5) and keeps its copy set, `recovering the
field`, `restoring context 3 projects 2 workers`, `field established`, with `field not reached` on
failure. Reconnect plays the short form: the name already resolved, only `restoring context` then
`field established`, about 1.4 s, skippable (prototype control "reconnect"). A waiting lane carries the
one letterspaced word `WAITING` in mono at `--t3`. Alternative wordmark treatments Andrew named for
later: signal assembly (letters sharpen from noise) or line emergence (points briefly map the word, then
collapse to type); the current tracking resolve stays until one of those is prototyped for the
marketing hero.

## 8. Decisions for Andrew

1. Approve the system and the prototype as the target, or name what to change.
2. Big Shoulders Display and IBM Plex Serif retire from the Console; does the Workbook keep the serif?
3. The wake plays on every start (about 3 s, skippable). Also on reconnect, or only on start?
4. Board policy is per project. Should a Ready row be startable at all under "Show me first", or
   only queued for the person?
5. Build order once approved: tokens and type, the mark and wake, transcript and ledger, board,
   team. Each is one Muse pass in its own worktree; the board and team lanes need service work that
   overlaps Astra's M1 foundation and will be sequenced behind it.
