# Questions

What is still undecided about Diomedes, and what the answers to the earlier questions
turned out to be. Anything settled here is settled in the code as well; if you overturn
one, the change is named beside it.

## Open

### O1. There is no pre-execution veto over the Codex tool host

<<<<<<< HEAD
- Options: (a) assert absence only on observe-only entries (localai, aioncore); (b) also hide the button on Sample work.
- Pick: (a). Sample work has `adapter === 'ready'`, and the button rule is adapter-based, so Sample work keeps its button. The UI test asserts switch/button absence on LocalAI supervisor and AionCore under Standard.

## 5. What does `available` mean on the Desk helpers list?

- Options: (a) the integration's `available` flag gated by the Settings switch (`settings.services[id]`), sample ungated; (b) the raw integration flag.
- Pick: (a). This preserves the old Start-button behaviour (no "Start with Codex" while its switch is off) and generalises it: any future ready engine becomes startable only after its switch is on.

## 6. Task Start buttons and the thread Helper picker for non-Route engines?

- Options: (a) restrict both to the `Route` union (sample, codex); (b) offer every ready/planned engine.
- Pick: (a). `shared/types.ts` fixes `Route` to sample/codex, and sending any other route would fail server-side. The "Helpers available" display still lists every ready/planned engine.

## 7. Add-a-helper picker availability: switch-gated or integration flag?

- Options: (a) the integration's `available` flag, per the task wording; (b) switch-gated like the helpers list.
- Pick: (a). Unavailable options are disabled with the server's `status` in parentheses, e.g. "Claude Code (Installed)".

## 8. `engineNames` extension?

- No change needed: it already names every id in the `TeamMember['engine']` union (codex, claude-code, opencode, oh-my-pi, sample, probe).

## 9. styles.css?

- No new rules were needed; the roster reuses existing `.service`, `.switch`, `.mark`, `.helper-line` and `.text-button` styles.

## 10. Engine ids outside the `TeamMember['engine']` union?

- None added. Discovery-only ids (cursor, hermes, ollama, and any future ones) appear in Settings and the Desk helpers display, but cannot be picked for team membership. If one needs to run work, that is a contract change to `shared/types.ts`, not a client guess.


# Team wake — open questions (muse/team-wake, 2026-09-06)

Unsettled points from the wake task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. Where is the recipient thread's permission read from?

- Options: (a) `Conversation.permission` on the member's `threadId`; (b) a new field on
  `TeamMember`; (c) the member's Session.
- Pick: (a). `Conversation.permission` already exists, `migrateConversation` defaults it to
  `'show-first'`, and the wake spec names "Conversation.permission". Missing conversation or
  missing field both fall back to `'show-first'`.

## 2. Exact wake text?

- Options: (a) `"From <sender name>: <content>"` joined by blank lines, oldest first;
  (b) include timestamps/message ids; (c) raw contents only.
- Pick: (a), exactly as the task states. Sender name is the sending member's `name`
  (`'Owner'` for `from: 'owner'`, raw slot id if the sender row is gone). Same renderer is
  used for auto-wake and the owner wake route.

## 3. What counts toward `unread` and the wake text?

- Options: (a) every unread message addressed to the slot; (b) only `type: 'message'`.
- Pick: (a). `shutdown_request` / `idle_notification` addressed to the slot are rare and the
  owner should see them when waking the helper. `TeamMember.unread` is filled by `teamState()`
  on the live objects, so it is also persisted into `state.json` (recomputed on every read).

## 4. Wake route error precedence (400 vs 503)?

- Options: (a) 400 `'Nothing is waiting for this helper.'` first, then 503
  `'Runs are not available here.'`; (b) the reverse.
- Pick: (a). Nothing-to-do beats service-unavailable, and it matches the order in the task.

## 5. Over-budget History entry — which helper is "cheap to call"?

- Options: (a) `store.addEntry` (pure in-memory push onto `state.history`, persisted with the
  state we already persist); (b) skip History.
- Pick: (a). One entry, `kind: 'team-wake'`, actor `'diomedes'`, e.g.
  `"Helper (Probe) has waiting messages; automatic wake paused for 10 minutes (budget reached)"`.
  No History entry is written for normal wakes.

## 6. Starter failures?

- Options: (a) auto-wake swallows the error and parks the member as `'waiting'` (a send must
  never fail because of the wake); the explicit wake route lets the error propagate (500 via
  the normal error handler). (b) fail the send too.
- Pick: (a).

## 7. Which deliveries can wake?

- Options: (a) only `sendAsMember` (team_send_message) and `ownerSendMessage`
  (POST /team/messages); (b) also lead interrupt / shutdown deliveries.
- Pick: (a), per the task. `team_interrupt_agent` / `team_shutdown_agent` deliveries do not
  wake, and `mcp.ts` needed no change (the sender already flows through `sendAsMember`).

## 8. Explicit wake of a `stopped` member?

- The task only says auto-wake skips `stopped` recipients. The owner wake route (`POST
  .../wake`) works regardless of status: the owner asked explicitly, so it starts the run
  (status becomes `'working'` via `acceptRun`) as long as there is unread mail and a starter.

## 9. Locking note for whoever wires the real starter (not this task)

- `maybeWake` calls the starter from inside the service methods, which the routes/MCP tools
  run under `store.locked`. A real starter that needs the store must not synchronously
  re-enter `store.locked` (it is a queue — re-entering from inside deadlocks). Do the
  store-dependent run setup asynchronously outside the lock, or restructure the call.


# Engine discovery — open questions (muse/discovery-server, 2026-09-06)

Every judgment call below lists the options and the pick I implemented.
`shared/types.ts` needed no change: every new entry fills the existing
`IntegrationStatus` contract (`available: false` whenever the adapter is not
`ready`), setting both `version` and `installedVersion` when a version is read
(the Desk still renders the deprecated `version` line).

## 1. Banned-word test scope vs the pre-existing LocalAI detail

- Options: (a) assert no banned word on every roster entry, which fails today
  because the untouched `localai` detail says "A resident model is ready";
  (b) scope the banned-word assertion to the six discovered entries plus the
  appended Codex drift sentence.
- Pick: (b). `server/integrations.ts` edits were limited to
  `getIntegrationStatuses` and its cache, so the existing `localai`/`codex`
  sentences stay as they are. (The UI banned-word test only visits Home, Ask,
  Plan, Work, Review, Tasks, Documents and History — not the Services page —
  so the existing wording does not trip it either.)

## 2. Version-unreadable tail for adapter `none` engines (Cursor, Ollama)

- The brief gives one unreadable sentence ending "...Diomedes cannot run it
  yet." Options: (a) use it verbatim for every engine; (b) keep the tail
  adapter-specific — `planned` keeps "cannot run it yet", `none` uses
  "does not use it", matching the versioned sentences.
- Pick: (b). Cursor unreadable reads "Cursor is installed. Its version could
  not be read. Diomedes does not use it." Ollama unreadable omits the version
  but keeps the running distinction ("Ollama is installed but not running..."
  / "Ollama is running...").

## 3. Ollama port open but no binary

- Options: (a) `found: false` because the binary is the find rule; (b)
  `found: true` + Running without a version, since a 200 from
  `/api/tags` is direct evidence the engine is there.
- Pick: (b). `found` is binary-found OR tags-200; `location` falls back to the
  tags URL when no binary resolved.

## 4. `--version` exits non-zero but prints something parseable

- Options: (a) treat any non-zero exit as unreadable; (b) accept the parsed
  version whenever stdout/stderr parses, and only treat timeout, spawn failure
  or unparseable output as unreadable.
- Pick: (b). Some CLIs exit non-zero on `--version`; the version string itself
  is the evidence. Timeouts always yield unreadable (no partial output is
  trusted).

## 5. Known-folder lookup details

- Options: (a) platform-specific suffix sets; (b) the same `.exe` / `.cmd` /
  bare order on every platform, base dir `USERPROFILE ?? HOME`.
- Pick: (b), exactly the order in the brief. `LOCALAPPDATA\Programs\OpenAI\Codex\bin`
  is skipped when `LOCALAPPDATA` is unset; the two home folders are skipped
  when neither `USERPROFILE` nor `HOME` is set.

## 6. PATH lookup timeout or spawn failure

- Options: (a) fail the whole engine probe; (b) treat as "no PATH hit" and
  fall through to the known folders.
- Pick: (b). A broken PATH lookup must not hide a folder install; every probe
  still resolves independently via `Promise.allSettled`-style per-engine
  catches.

## 7. `createIntegrations` override shape and `getIntegrationStatuses` signature

- Options: (a) inject raw `DiscoveryDeps`; (b) inject a `discovery: () =>
  Promise<DiscoveryResult>` function, mirroring how `fetch` is injected.
- Pick: (b). `getIntegrationStatuses(options: { refresh?: boolean } = {})`.
  The default `discovery` is built from the merged `fetch`, so test fetch
  mocks also govern the Hermes/Ollama loopback probes.

## 8. What `?refresh=1` refreshes

- Options: (a) only the discovery cache; (b) discovery plus the 30-second
  codex/localai cache.
- Pick: (b). A refresh is a user asking for fresh answers, so it bypasses both
  caches; plain calls reuse discovery indefinitely and codex/localai for
  30 seconds.

## 9. Hermes body handling

- Options: (a) ignore the body entirely; (b) read and discard it capped at
  100 KB like `localAiStatus`.
- Pick: (b). Any HTTP status (even 500) counts as running; an over-cap or
  unreadable body does not change that — the headers already answered.

 ## 10. Version source order

- Options: (a) stdout only; (b) stdout then stderr combined, first
  `\d+\.\d+(\.\d+)?`, sliced to the 4 KB cap before matching.
- Pick: (b). The slice mirrors the spawn-layer cap, so a version past 4 KB is
  unreadable rather than trusted.


# Interface scale as root zoom — open questions (muse/sizing, 2026-09-07)

Unsettled points from the sizing task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. What `100vh`/`100dvh`/`100vw` do under `html { zoom: var(--dm-ui-scale) }`

- Observed empirically with headless Chromium (standalone probe page, viewport
  1280x800, scales 0.9 / 1.0 / 1.3; the full app suite could not run — see 8):
  viewport units resolve against the *unzoomed* viewport and then get zoomed
  with the layout. With `.app { height: 100dvh }`, the app box measured
  720 / 800 / 1040 device px at scales 0.9 / 1.0 / 1.3, so at 1.3 the document
  was 1040px tall in an 800px viewport — a page-level vertical scrollbar.
  With `.app { height: calc(100dvh / var(--dm-ui-scale)) }` the app box stayed
  exactly 800 at all three scales (document scrollHeight == innerHeight, no
  page scrollbar), while the top bar measured 41.39 / 46 / 59.8px — i.e. boxes
  grow with the scale (59.8/46 = 1.3). Computed `font-size` does not change
  under zoom, which is why the smoke test now measures box heights.
- Pick: keep `html { zoom: var(--dm-ui-scale) }` and divide exactly the rules
  that size against the viewport: `.app` height, `.dialog` max-width/max-height
  (plus its 600px responsive max-width), `.error-bar`/`.feedback` max-width
  (plus their responsive max-width). Native `<dialog>` modals still covered
  the viewport in the probe at all three scales in both variants. The top bar
  stays at the top (flex column, `flex: none`).

## 2. When nothing is saved and the person is both Guided and on the Desk

- Options: (a) Desk wins (0.95); (b) Guided wins (1.1).
- Pick: (a). `App.tsx` computes `interfaceScale ?? (surface === 'desk' ? 0.95
  : detail === 'guided' ? 1.1 : 1)`. Rationale: on the Desk the binding
  constraint is fitting threads/helpers/changes on one screen; a Guided person
  on the Desk still gets the reading/code text multipliers untouched. The
  `Settings.tsx` slider uses the same formula for its displayed value.

## 3. Settings slider option labels for the new effective values

- Options: (a) add 0.95/1.1 options; (b) keep only 1/1.12/1.24 so an effective
  1.1/0.95 shows blank until touched.
- Pick: (a). Interface size now offers Smaller (0.95, marked default on Desk),
  Default (1), Guided (1.1, marked default when Guided), Larger (1.12),
  Largest (1.24). Reading/Code keep Default/Larger/Largest. Once the person
  picks anything, the saved number wins everywhere (even picking Default (1)
  on Guided pins 1 instead of the 1.1 default).

## 4. 13px Desk labels vs the never-below-14 floor

- Options: (a) raise `.desk-side-header h2` / `.desk-side-sub` 13px to 14px;
  (b) leave at 13px without the multiplier.
- Pick: (b). They are Desk-only eyebrow labels, not covered by the Book layout
  check, and raising them would change the Desk's visual character beyond the
  brief. Everything that was 15px ui-scale is now a flat 14px.

## 5. Responsive sizes that mirrored a changed desktop value

- Options: (a) leave every media-query fixed size alone; (b) move the ones
  that are clearly the same part (top-bar 52->46 incl. brand-button/top-right
  heights, project-tabs 44->40, project-tab 42->38, rail/rail-link 44->40,
  task header 44->40, task-card 130->120, dialog/error-bar viewport calcs).
- Pick: (b). Page-header mobile padding, setup margins and other
  context-specific values were left alone. The 21px responsive headings
  (page-header h1, dialog-heading h2) became 19px and the 24px responsive
  setup h1 became 22px, following their desktop 22->20 / 28->24 moves.

## 6. Reading-face rules that moved with prose

- Options: (a) only the table rows (prose 16/1.6, prose.small 15);
  (b) also the rules that are the same reading rhythm.
- Pick: (b). `.turn.you` 17->16, composer textarea 17->16 (68px box, tighter
  padding), `.notice .prose` and `.capability` 15.5->15. Markdown document
  headings (24/28/17 read-scale), desk turn text (16) and the home
  section-title (19) were left alone as document/desk-specific.

## 7. Desktop smoke evidence key

- The `sizes()` helper now records `getBoundingClientRect().height` for body,
  `.task-title`, `.task-card .button`, `.caption`, and the 1.24 ratio assertion
  is unchanged. The old exact assertions (`body 16`, `task-title 18`) became
  computed-font checks for the new defaults (`body 15`, `task-title 17`).
  The `fontSizes: { before, after }` evidence field was left named as-is to
  stay inside the allowed edit area; its values are now box heights, not font
  sizes.

## 8. Verification status (blocker, not a code question)

- `tsc --noEmit` is clean (exit 0). The UI suite could not run in this
  worktree: vite fails to transform `client/main.tsx` with
  `Cannot find package '@babel/core' imported from
  .../node_modules/@vitejs/plugin-react/dist/index.js`. Installed
  `@vitejs/plugin-react` is 5.2.0, which requires `@babel/core ^7.29.0`, but
  `node_modules/@babel` does not exist in the shared tree (junction target
  `F:/Achilles/diomedes/node_modules`); installed Playwright browsers are
  1228 (matching @playwright/test 1.55) while node_modules now holds
  playwright 1.63.0 (which wants headless_shell-1243). Both pre-date this
  change — the failure happens before any app code loads (no Continue button
  renders) — and `npm install` is forbidden in this worktree, so the full
  Home/Tasks/Settings/Desk scrollbar sweep, modal coverage check and the two
  new assertions have not been executed here. The zoom/viewport behaviour in
  (1) was verified with a standalone Chromium probe instead.
# Projects landing — open questions (muse/landing, 2026-09-07)

Unsettled points from the landing task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. One-column width: reuse Home rules or add a landing class?

- Options: (a) give the wrapper `book-layout home` so the existing Home column
  rules apply; (b) add a `landing` class with duplicated caps.
- Pick: (a). The wrapper is `book-layout home`, so the 760px cap (880px at
  ≥1550px) and the hidden margin come from the existing Home rules. The appended
  Landing CSS only styles the ask box row.

## 2. Where does the landing ask state and send handler live?

- Options: (a) `useState` hooks at the top of `App` plus a small `sendLandingAsk`
  handler in the component body, kept out of the scale effect; (b) everything
  inline in the JSX.
- Pick: (a). `landingText` / `landingProjectId` sit with the other `useState`
  hooks, and `sendLandingAsk(text, project)` sits just above `const current`,
  with a comment noting it belongs to the projects-page block below. Hooks cannot
  live inside the JSX ternary, and the scale effect is untouched.

## 3. What orders the picker and the rows?

- Options: (a) picker by last opened (`lastOpenedAt || createdAt`, newest first),
  rows by `needsYou` first then last opened; (b) picker and rows both follow
  `settings.openProjects` order.
- Pick: (a), per the task. The select defaults to the newest by that key via
  `landingProjectId ?? sorted[0]?.id`; rows use the needs-first comparator and
  keep the existing row markup, status text and marks.

## 4. How is "none is the sample" detected?

- Options: (a) a flag on `Project`; (b) a name match, since the server creates
  the sample as "Harbor Street restaurants" and `shared/types.ts` is frozen.
- Pick: (b). The caption button hides when any project name includes
  "harbor street" (case-insensitive). If the sample is ever renamed or flagged,
  this one line changes.

## 5. Landing placeholder variants?

- Options: (a) one fixed placeholder; (b) vary by `settings.onboarding.work`.
- Pick: (b), exactly as specified: business "Ask about a supplier, plan a
  schedule, or say what to do"; school "Ask about a reading, plan the week, or
  say what to do"; software "Ask about the code, plan a change, or say what to
  do"; personal "Ask a question, plan something, or say what to do"; mix and
  undefined fall back to "Ask, plan, or say what to do". The textarea keeps a
  constant `aria-label` so tests do not depend on the variant.

## 6. Closing caption in the empty state?

- Options: (a) caption only when projects exist; (b) caption in both states.
- Pick: (b). Both states end with "Projects are ordinary folders on this
  computer." The "Try the sample project." text-button is appended on the same
  line only when projects exist and none matches the sample.

## 7. Carried draft: key format and who clears it?

- Options: (a) a new `askDraftKey(projectId)` helper returning
  `diomedes.ask-draft.${projectId}`, read once by the composer initializer which
  removes it; (b) reuse the document-draft keys.
- Pick: (a) in `components.tsx`. `Workspace` initialises `prompt` from
  `localStorage.getItem(askDraftKey(projectId)) ?? ''` inside try/catch and
  removes the key right after reading. `mode` initialises to `ask` with an
  explicit check for a carried draft (it runs before the prompt initializer
  consumes the key), so a carried draft always lands in Ask.

## 8. `HelperLine` props and matching Home behaviour?

- Options: (a) `(integrations, settings, saveSettings)` with the exact Home
  markup, classes and three sentences; (b) a slimmer landing-only line.
- Pick: (a) in `components.tsx`. Same `caption helper-line` / `text-button`
  classes, same "is on" / "signed in but turned off" / "Sample work, on this
  computer" sentences, first ready non-sample engine in roster order. Both Home
  (via `Workspace`) and the landing page render this component, so the Home test
  looking for `.helper-line` containing "Sample work" stays green.

## 9. Empty-state test without a fresh data dir?

- Options: (a) spin up a fresh data dir; (b) skip with a reason, since this spec
  has no fresh-dir helper and projects cannot be deleted via the API.
- Pick: (b). The new UI test covers the sample-present path end to end (ask box
  visible, select defaults to last opened, Send carries "Which suppliers are
  late?" into the Workspace Ask box with the rail Ask entry active) and states
  in a comment why the no-projects cards are not asserted in this run.
=======
Team runs enable `features.code_mode_host` for the team server only. With that on, the
model reported an inventory of the thirteen Diomedes team tools plus the host's own
internals (`exec`, `wait`, `request_user_input`, `clock`, the MCP resource readers,
`skills__list`, `skills__read`) and no shell or file tool, and it could not read a
project file or run a shell command. That is the model's own report, not a protocol
guarantee.

What is missing is a universal pre-execution interception point. `ClientRequest.json`
in the pinned 0.153.4 protocol has `mcpServerStatus/list` but no complete host
tool-inventory method; `ServerRequest.json` has `DynamicToolCallParams` for
`item/tool/call`, which covers client-executed dynamic tools only. Rejecting every
server request in `createRpcClient()` fences those; it does not fence a call the
app-server executes without asking the client. Diomedes rejects a foreign tool item on
`item/completed`, which detects a violation *after* it happened.

Three ways out, none taken yet:

1. Version-matched runtime or source evidence of the complete host inventory, or of a
   universal pre-execution allowlist, then implement and test a team-only boundary.
2. A separately constrained host or a client-executed tool bridge that checks the
   allowlist before forwarding. `--code-mode-host` is routing, not enforcement.
3. Accept the residual risk with the current fences, and say so plainly. This is where
   the project stands today: the enabled surface is documented, the gap is named, and
   nothing claims the boundary is proven.

Owner decision D8 in `../planning/2026-09-06-v6-two-views/00-two-views-brief.md`.

### O2. Discovered engines cannot be team members

`shared/types.ts` fixes `TeamMember['engine']` to `codex | claude-code | opencode |
oh-my-pi | sample | probe`, and `Route` to `sample | codex`. Discovery also finds
Cursor, Hermes and Ollama, and any future engine it learns about lands outside both
unions: it appears in the helper roster but cannot be picked for a team or given work.
Widening either union is a contract change, not a client guess. Nothing needs it yet.

### O3. Which engine gets the second adapter, and what it costs

Claude Code, OpenCode and oh-my-pi are found, reported and unrunnable. Each needs its
own adapter with its own isolation proof — the Codex one took a Windows write-denial
probe, an inherited-MCP disable-and-verify step and a pinned protocol schema.

`../planning/2026-09-06-v6-two-views/07-engine-discovery-brief.md` recommends Claude Code
next, driven through its CLI rather than the Agent SDK, as slices E2 and E3. Nobody has
confirmed that, and nobody has said what the equivalent isolation proof looks like for a
CLI that was not built to be fenced. Until one lands, "team" means "Codex talking to
Codex", and D5 in the two-views brief — which engine leads by default — has nothing to
decide.

### O4. What a member should be able to do to a run in flight

There is no steering a run, no branching a thread, and no handing a thread from one
helper to another. A leader can interrupt or shut down a member, and that is all. Each
of these is a design question before it is an implementation one.

### O5. History retention is configured but not enforced

`Settings.history.keepDays` (30) and `maxBytesPerProject` (2 GB) are stored and settable
and nothing reads them. Either implement pruning or stop offering the settings.

## Resolved

### R1. Could Codex call the Diomedes team tools at all?

**Yes, with two changes.** This was the blocker of 2026-09-06: a real team run reached
readiness and returned "code-mode host is disabled", and the analysis at the time
concluded that enabling the host could not be justified without an enforceable tool
boundary.

It was settled empirically instead, and the runs are recorded in
`evidence/codex-team-real-binary-2026-09-06.md`:

- **Run 1** — `features.code_mode_host = true` for the team run only, everything else
  unchanged. Every team tool call returned `MCP tool call requires approval, but
  approval policy is never`. The tools were reachable but uncallable.
- **Run 2** — plus `default_tools_approval_mode: 'approve'` on the `diomedes_team`
  server entry. `team_members`, `team_task_list` and `team_task_create` all returned
  real results.
- **Run 3** — a member woken by the owner's message read its mail, created and updated a
  board task, and reported to the leader.

`features.code_mode` stays `false`. The host flag is set for the team process and team
thread config only; a non-team run still sees both flags false. What this does *not*
settle is O1 above, which is the proof gap the original analysis named.

### R2. Where does a helper's work show up?

The board is the Diomedes task list — a task a member creates is a task on Tasks and on
the Desk's Board, attributed to the member. The model's own report goes into that run's
session log, not into the thread as a turn; the thread turn says a team message was
picked up. Team tool calls are logged as technical lines in the session log.

### R3. How a member wakes

- The recipient thread's permission comes from `Conversation.permission` on the member's
  `threadId`; a missing conversation or missing field means `show-first`.
- The wake text is `From <sender name>: <content>`, oldest first, joined by blank lines.
  The sender is `Owner` for the owner, the member's name otherwise, the raw slot id if
  the sender row is gone. The same renderer serves the automatic wake and the explicit
  one.
- Every unread message addressed to the slot counts toward `unread` and the wake text,
  including `shutdown_request` and `idle_notification`.
- Only `team_send_message` and the owner's `POST /team/messages` wake a member. A
  leader's interrupt or shutdown does not.
- Automatic wakes are capped at five per slot per ten minutes. Going over writes one
  History entry (`kind: 'team-wake'`, actor `diomedes`) and parks the member as waiting.
  Normal wakes write no History entry.
- A starter failure never fails the send: the automatic wake swallows it and parks the
  member as waiting. The explicit wake route lets the error through.
- The explicit wake route works on a `stopped` member — the owner asked for it — as long
  as there is unread mail and a starter. Automatic wake skips stopped members.
- The starter is wired in `server/app.ts`. It calls `startCodexWork(..., held = true)`,
  so it does not re-enter `store.locked` from inside a locked route. The store lock is a
  queue and re-entering it deadlocks; anything else wiring a starter has to respect that.

### R4. What the helper roster shows

- The Settings rail entry is **Helpers on this computer** in the Book; the Desk keeps
  **Engines**. Both render the same block. The old Desk-only "Connections" entry is gone.
- Guided detail hides engines whose adapter is not ready, in the Book only. Standard and
  the Desk show everything.
- An engine counts as usable when the integration reports it available *and* its
  Settings switch is on. Sample work is ungated. This is what keeps "Start with Codex"
  from appearing while Codex is switched off.
- Task Start buttons and the thread helper picker offer only the `Route` union — sample
  and Codex. The roster still lists every engine that was found.
- The add-a-helper picker offers every engine the integration reports; unavailable ones
  are disabled and carry the server's status in parentheses, e.g. "Claude Code
  (Installed)".

### R5. How discovery decides what it found

- Discovery runs only when asked: opening the helpers section, or pressing **Check
  connections**. Never at application start, and one probe at a time.
- On Windows, `where` lists an extension-less shim before its `.cmd` twin, so candidates
  are ranked `.exe`, then `.cmd`/`.bat`, then bare. A `.cmd` or `.bat` is run through
  `cmd.exe` with a fixed argument list, and a path carrying shell metacharacters is
  refused outright.
- PATH first, then `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`, `~/.local/bin` and
  `~/.bun/bin`, each tried as `.exe`, `.cmd`, then bare. A failed or slow PATH lookup
  falls through to the folders instead of failing the engine.
- A non-zero exit from `--version` is fine if the output parses; the version string is
  the evidence. A timeout is always "version could not be read" — no partial output is
  trusted. Version text is stdout and stderr combined, sliced to 4 KB before matching, so
  a version past the cap is unreadable rather than guessed.
- Ollama counts as found when either the binary resolves or `/api/tags` answers 200; the
  location falls back to the tags URL when no binary resolved.
- `?refresh=1` bypasses both the discovery cache and the 30-second Codex/LocalAI cache.
  A plain call reuses discovery indefinitely.
- Loopback probe bodies are never read. The response body is cancelled and released —
  the headers already answered. (This overturns an earlier decision to read and discard
  a capped body.)
- Cursor is reported as installed without being run: its launcher starts an interpreter.

### R6. What "Technical" became

There is no Technical detail level. There are two surfaces, the Book and the Desk, and
two detail levels inside the Book. Settings written before 2026-09-06 with
`detail: 'technical'` are read as "open the Desk"; the `Detail` type still carries the
value so old state loads.
>>>>>>> opus/docs
