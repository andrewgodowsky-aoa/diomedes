# Agents replace the modes, 2026-10-07

Andrew decided on 2026-10-07 that the ask box's Ask, Plan, Build and Fix modes go: "we can use
agents instead ... each of those roles have abilities or tools stripped instead." DIO-292 is that
change. A person picks who answers in the Agent box, with Auto first, and each agent carries the
limits a mode used to carry. Permissions stay authoritative: picking an agent never grants anything.

## Change

- **The roster** (`shared/agents.ts`). Eight agents a person can pick, in menu order, each with one
  line in the app's voice, plus one internal agent. The built-ins are version 2.0.0. Their ids are
  the ones records already hold, so Planner is still `diomedes.architect` and Fixer is still
  `diomedes.debugger`.

  | Agent | Id | Kind of run | Read tools | Permission ceiling |
  |---|---|---|---|---|
  | Researcher | `diomedes.researcher` | ask | files, `fetch_page`, `connector_read` | `review` |
  | Planner | `diomedes.architect` | plan | files, `fetch_page`, `connector_read` | `review` |
  | Builder | `diomedes.builder` | build | its kind's own | `auto-review` |
  | Fixer | `diomedes.debugger` | fix | its kind's own | `auto-review` |
  | Reviewer | `diomedes.reviewer` | ask | files | `review` |
  | Explorer | `diomedes.explorer` | ask | files | `review` |
  | Analyst | `diomedes.analyst` | ask | files, `connector_read` | `review` |
  | Writer | `diomedes.writer` | build | its kind's own | `auto-review` |
  | General Assistant, internal | `diomedes.general` | every kind | its kind's own | `auto-review` |

  "Files" is `list_files`, `read_file` and `search_files`. A ceiling is a maximum, never a grant.
  The kind's default agents (Researcher, Planner, Builder, Fixer) run on exactly their kind's text.
- **The Agent box** (`shared/agent-choice.ts`, `client/console/AgentPicker.tsx`). The thread's
  `requested.agent` holds `auto` or an agent id. Saving an agent sets the thread's stored kind to
  that agent's. Saving Auto keeps the stored kind, since Auto decides the kind per message, and a
  new thread is stored as Ask with Auto in its box. A send leaves the stored kind of a thread with a
  box, Auto included: on Auto each turn records the kind it ran as (`recordRunKind`). An Automatic
  kind is how a project's own Diomedes conversation is found (`shared/diomedes-thread.ts`), so no
  Console thread becomes one by its kind. A thread saved before agents with no agent reads as its
  stored mode's default agent and behaves as it did, following the kind of each send, as does a
  thread an API caller sets by mode. One whose saved agent no longer fits is set right when the project loads
  (`migrateConversation` in `server/store.ts`): General Assistant, picked before it left the menu,
  reads as Auto, and a built-in whose kind isn't the thread's becomes that kind's default agent
  (Auto on an Automatic thread). So an old Ask thread that saved Builder or Fixer opens as
  Researcher, never as an agent that changes files. A profile thread reads as Auto in the box; the
  host resolves the profile's own agent when it picks.
- **Auto's pick** (`server/agent-pick.ts`, `POST /api/projects/:id/threads/:threadId/agent-pick`).
  Before anything is sent, Auto picks one agent for the message. A rule reads the message's own
  words: a request for a plan, a fix with a file attached, a letter or email to write, a review, a
  question about where something is, numbers or a spreadsheet. Where the words don't say, Jev
  chooses from the same shortlist when an advisor is configured. Otherwise Auto answers the message
  itself where the route has an Auto conversation, and Researcher answers where it doesn't. No
  default changes files. Auto picks Builder or Fixer only when a file comes with the message, never
  an agent that changes files where the conversation is the only path (Home, the Agent page,
  Nectovia) or when an image comes with the message, and never an internal or added agent. A chosen
  box answers `chosen`. The pick route sends nothing and changes nothing on the thread. It reads a
  message of up to 32,000 characters, as the send does, and a profile that names General Assistant
  as Auto.
- **Auto's own lane.** Where Auto answers in the conversation, a reading agent it picks
  (Researcher, Planner, Reviewer, Explorer or Analyst) rides Auto's lane: the pick answers mode
  `auto` with that agent, and the send carries it (`rides` in `interactionHost.resolve`). The agent
  narrows that message to its kind's limit (answer-only or plan-only), its role and, on a model-API
  route, its own read tools, so a thread on Auto keeps one history and one session as Auto moves
  between agents. A chosen agent keeps its own kind's lane. Where Auto can't answer in the
  conversation (Claude Code in the Work view goes direct), the picked agent's kind is sent.
- **Guards on the send** (`server/app.ts`). Both send paths hold a message to the thread's Agent
  box. A message that names no agent runs as the box's agent. One meant for another agent than the
  box holds now, or of a kind the box's agent doesn't do, is refused with 409 `agent_changed`
  ("This thread's agent changed. Nothing was sent. Send again."). A message whose kind doesn't match
  the agent it names is 400 `agent_mode_mismatch`. The Console sends on the route the person
  confirmed, and Send this task? names the agent ("Agent: Reviewer", or "Agent: Fixer, picked by
  Auto"). A profile thread's reply isn't captioned as Auto's pick.
- **Where an agent's role goes** (`server/agent-framing.ts`). A non-default agent's role travels in
  the message, behind a host marker line, never in the lane's instructions: a lane's instructions
  are part of its saved scope, so changing them per message would retire the lane. A Build or Fix
  proposal prompt carries a "{name}: {role}" line. A kind's default agent sends no framing, since
  the kind's own instructions are its job.
- **Read tools per agent** (`server/agent-tools.ts`). An agent's tools are the most its turn gets.
  Without the web tool it neither searches nor fetches, and without the connector tool it calls no
  connector. File reads stay as the turn chose them. It narrows and never widens. The host applies
  it wherever a turn has no kept session: every model-API route and every direct request. An engine
  that keeps its own session pins the scope it opened with, so there agents of one kind share that
  kind's scope. Each agent's own tools on those engines is DIO-296. There, a reading agent Auto
  picks rides Auto's lane, which opens with Automatic's scope (no folder listing, web or
  connectors), so it answers from the files sent with the message, as an Auto message did before.
  An agent the person chooses keeps its kind's scope.
- **A message that moves lanes** (`server/lane-recap.ts`). Lanes are per kind of run. When a
  thread moves between kinds, for example from Researcher to Planner, or from Auto to a chosen
  Researcher, the new lane hasn't seen the last answer, so the message brings the other lane's last
  exchange, at most 2,000 characters, read from the durable run. It comes only from an open lane,
  and only when the last answer came on the route this message uses, so nothing one route read
  reaches another. Markers and earlier recaps are taken out of what it quotes, so they never pile
  up.
- **History** (`server/harness/conversation-history.ts`). The history a lane is sent gives each
  earlier message as the person wrote it, without an agent's role line, so a later message never
  reads the role line as the person's words.
- **Fix** keeps its limits as Fixer's: three tries a thread, a fourth refused with "Three tries
  haven't fixed this. Start a new thread, or ask Planner for a plan first.", and its effort ceiling,
  now named for the agent ("Fixer runs at Medium."). The fields that asked what was failing are
  gone; the person says it in the message. `failing` stays optional on the API for callers that
  send it.
- **The Console** (`Composer.tsx`, `AskRow.tsx`, `ThreadView.tsx`, `Shell.tsx`). There is no mode
  strip in either view. The Agent box sits where the strip was, in the conversation view too, where
  it leaves out profiles. Each agent's placeholder says what it needs ("What's broken?"). A reply
  Auto's pick made is captioned "{name}, picked by Auto". The Projects page sends its draft with no
  mode. A queued message (`NativeSessionControls.tsx`) carries the page's agent.
- **The Agent page** (`Diomedes.tsx`, `DiomedesHome.tsx`, `diomedes-view.ts`). Its Mode select is
  an Agent select with Auto and the agents that answer in a conversation: Researcher, Planner,
  Reviewer, Explorer and Analyst. The pick runs inside the delivery, after the conversation exists.
  A project's conversation that hasn't spoken is found by its Auto kind, so an agent picked before
  the first message is held until that message is admitted (`canSaveAgent`). If that message isn't
  admitted, or its send fails or is stopped after the agent was saved, the page puts Auto back with
  the Automatic kind and keeps the pick for the next try, so the page never loses its own
  conversation. The page's local model controls lost their own Agent picker, so the page has one
  Agent control.
- **The phone relay** (`server/relay/`) sends a reading agent the thread chose with a phone
  message, and an Auto thread's message as Auto itself. A box that changes files (Builder, Fixer,
  Writer) has no conversation message of its own, so its message goes as Automatic, and the host
  holds it to the box's own control: it's answered, it never starts work, and the thread keeps its
  agent.
- **Copy.** Three older lines that still named the modes changed with it: a new thread's empty state
  ("Ask, or pick an agent below. Nothing changes until you say so."), the Codex setup caption and the
  Codex engine's Ready detail.

Unchanged: Permissions and Trust decide what any run may do, and changing the agent never grants
authority. Run kinds stay internal: `server/modes.ts` owns each kind's instructions, its effort
ceiling and Fix's tries. No Workbook screen changed.

## Tests

- New unit files: `agent-roster`, `agent-choice`, `agent-thread-choice`, `agent-pick`,
  `agent-pick-route`, `agent-send-guards`, `agent-framing`, `agent-tools`, `lane-recap` and
  `agent-ui`.
- Changed unit files mostly swap fixtures that passed a mode for ones that pass the Agent box's
  choice or a run kind.
- Browser specs: the Console's Agent box and Fixer (`ui.spec.ts`), the Projects page draft
  (`ui.spec.ts`, `field.spec.ts`), the Agent page's Agent select (`diomedes-home.spec.ts`), the
  agent menu (`agent-ui.spec.ts`, `agent-profiles-ui.spec.ts`) and the ask row's motion and contrast
  sweeps (`cd05-zoom-motion.spec.ts`). `tests/fixtures/agent-menu.ts` picks an agent the way a person
  does. The contrast sweep's colour helper no longer divides `getImageData`'s straight values by
  alpha a second time, which read a hovered 6% tint as near white, and the sweep measures with
  nothing hovered.
- After the final review: `auto-mode-migration` (old threads' saved agents set right at load);
  the conversation path's box checks, riding agents and the phone relay
  (`model-read-tools-routes`); the direct path's box checks (`agent-send-guards`); riding picks,
  long messages and a General Assistant profile (`agent-pick-route`); a Console thread never taken
  for a project's conversation (`project-conversation`); the recap's route and open-lane limits
  (`thread-conversation-model-api`); and the history without the role line
  (`conversation-history`).
- The scripted test engines answer what the person said (`spokenPrompt` in `server/lane-recap.ts`),
  so a role line or a recap doesn't move their match.

## Verification

On the committed tree, from origin/main 24fe1e5, on 2026-10-08, one command at a time under the
coordination heavy slot:

- `npx tsc --noEmit`: passed, and again after the spec change below.
- `npx vitest run --maxWorkers=2`: 618 files, 10,422 passed and 5 skipped of 10,427.
- `npx vite build`: passed.
- `playwright test`, the main config: 354 tests. The full run passed 336. In
  `ai-engines-ui.spec.ts`, the standalone Ask check failed when it found the saved answer and its
  live text on screen together, a race older than this change (DIO-301), and the 17 tests after it
  in that serial file didn't run. The other 334 tests passed. With the check waiting for the saved
  answer, `ai-engines-ui.spec.ts` passed 20 of 20, twice.
- `playwright test -c playwright.bonsai.config.ts`: 2 passed. `playwright test -c
  playwright.responsive.config.ts`: 20 passed.

The Agent pictures in `evidence/agents/` come from the final run. The other pictures a full run
rewrites were put back.

Two earlier runs, for the record. The first, before the final review's fixes, failed 2 vitest tests
of 10,411 and 5 browser tests of 354, with 6 not run. The second, after them, failed 4 vitest tests
of 10,427, all in `tests/backend.test.ts`, which pinned that a send moves the stored kind of a
thread on Auto; it was stopped before the build, and those tests now say that the turns carry each
kind while the thread keeps its own.

## Follow-ups

- DIO-295: Jev chooses the model and effort for Auto's pick.
- DIO-296: each agent's own read tools on engines that keep their own session.
- DIO-297: the task inspector, the workbench run inspector and the evidence rows still call the
  agent "Worker".
- DIO-293 and DIO-294: the Tester and Organizer agents, which come later.
- `client/console/Picker.tsx` is rendered nowhere; its props type is all that's imported.
- DIO-298: the completion journey spec stops at the sign-in wall (a fresh service answers 401 on
  `/api/settings`).
- DIO-301: a streamed reply shows twice for a moment, its live text beside the saved answer, until
  the send's own request returns.
- DIO-299: a project's own conversation is still found by a guess (a thread that has spoken
  qualifies, and a Console choice can drop the unspoken one); it needs a marker of its own.
- DIO-300: four small Agent box gaps: a queued message keeps the agent it was queued with, a retry
  checks its agent before reading back its answer, the per-engine session routes take Ask or Plan
  with no box check, and the phone relay reads a profile thread as Auto.
- Auto doesn't pick for a phone message: an Auto thread's phone message is answered by Auto itself.
- A read with no message (Jev's preflight, a work-style read without `?mode=`) takes its effort from
  the thread's stored kind, so an Auto thread saved before agents (Automatic) and a new one (Ask)
  read differently there. Jev reading the message's own kind belongs with DIO-295.
