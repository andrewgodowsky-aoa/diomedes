# Questions

What is still undecided about Diomedes, and what the answers to the earlier questions
turned out to be. Anything settled here is settled in the code as well; if you overturn
one, the change is named beside it.

## Open

### O1. There is no pre-execution veto over the Codex tool host

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
next, driven through its CLI rather than the Agent SDK, as slices E2 and E3.

**The first half is decided.** Andrew, 2026-09-10: adapters are the next big piece, named
as "acp, -p for claude". So the second adapter target is Claude Code through its own
command interface, confirming the brief's CLI recommendation over the Agent SDK, and ACP
is a peer target rather than a later one.

**The second half is still open.** Nobody has said what the equivalent isolation proof
looks like for a CLI that was not built to be fenced, and that proof is what the Codex
adapter's cost actually was: a Windows write-denial probe, an inherited-MCP
disable-and-verify step and a pinned protocol schema. Until one lands, "team" means
"Codex talking to Codex", and D5 in the two-views brief — which engine leads by default —
has nothing to decide.

### O4. What a member should be able to do to a run in flight

There is no steering a run, no branching a thread, and no handing a thread from one
helper to another. A leader can interrupt or shut down a member, and that is all. Each
of these is a design question before it is an implementation one.

## Resolved

### R7. History retention was configured and not enforced (raised as O5)

**Settled 2026-09-10 by Andrew: preserve the evidence, remove the controls.**
`Settings.history.keepDays` (30) and `maxBytesPerProject` (2 GB) were stored, validated
and read by nothing. The choice was to implement pruning or stop offering the settings,
and pruning was the wrong half to reach for first: History is evidence, and Pillars 06
and 09 both name evidence and audit as enforced concepts, so what may be aged out is a
policy question before it is an implementation one.

Both keys are gone from `Settings`, from the defaults and from the settings validator.
`migrateSettings` deletes a stored block, because settings load with no merge against the
defaults and a retired key would otherwise be read back and rewritten forever. History
now keeps everything, and the README and the website say so rather than describing a
control that does not work.

This is not a ruling that data can never be deleted. Diomedes relies on durable
attribution, receipts, authorization history, verification and evidence as part of its
trust model, so what it will not do is expose a blunt setting that destroys that record
before the archival, deletion, organization-policy and legal data-lifecycle model exists.
Designing those semantics deliberately is future work, not a closed door.

Still open, when someone wants it: what a real retention and archive policy allows. It
has to answer whether ageing out may remove the record of an authorized effect, and if
not, what an archive keeps instead.

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

# Appendix: picks recorded by the 2026-09-06 evening builds (sizing, landing)

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

# Verified helper (muse/verified-model, 2026-09-07)

The Astra finding: a saved conversation showed the helper answering "GPT-5.2 Codex"
when asked its name. The runtime is Codex CLI 0.153.4 over app-server with a ChatGPT
account, default `gpt-6-astra`, and no GPT-5.2 among its models. The claim came from the
helper's prose. The app kept only `askCodex()`'s `.text`, so nothing recorded which
engine actually answered.

## Which schema field the runtime engine came from

The `thread/start` response's `model` field on the started thread — the value the
existing adapter already read (`started.model`) and the protocol fakes mirror
(`model: 'native-model'`, `model: 'fake-model'`). When `turn/completed` carries
`turn.model` it overrides, since that is the turn that produced the text. `version`
comes from `initialize` (the `userAgent` check against `CODEX_PROTOCOL_VERSION`).
The pinned schema dir (`evidence/codex-app-server-0.153.4/`) holds only
`ListMcpServerStatusResponse.json` plus the README, so there is no pinned
`ThreadStart`/`TurnCompleted` schema to cite beyond the live binary's behaviour;
`verified` is true only for these runtime fields, never for anything parsed from text.

## Picks

- Every run passes an explicit selection: `askCodex({ model })` rides in the
  `thread/start` config (never in prompt text, so the answer cannot rename its own
  engine), defaulted from `settings.services.codexModel` when present, else the
  runtime default. The setting is a name, not a switch, so `validateSettings`
  accepts a ≤120-character string for that one key.
- Every turn stores `helper: { engine, model, version, verified }`; every session
  engine carries `version`/`verified` beside its existing fields. Sample work is
  deterministic, so its helper is `{ engine: 'sample', model: null, verified: true }`.
- A Plan History sentence names the verified helper when present —
  `Diomedes, with Codex gpt-6-astra, wrote <plan>` — and falls back to
  `Diomedes wrote <plan>` when the runtime reported nothing.
- Captions show the verified value only: `Codex, gpt-6-astra` when verified. The
  Book never uses the word "model" (a UI test bans it), so an unreported Book
  helper reads `Codex, name not reported`; the Desk header from a live session
  reads `Codex, model not reported`. Turns written before this change have no
  `helper` and show no caption rather than a guessed one.
- Work turns are created unverified and marked verified by the native worker once
  the runtime reports; the session engine is set in the same locked step.

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

# Usage bar — open questions (muse/usage, 2026-09-07)

Unsettled points from slice U1, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. The pinned evidence has no rate-limit schema

- The spec says to read `evidence/codex-app-server-0.153.4/` for the exact
  field names (`GetAccountRateLimitsResponse`, `RateLimitSnapshot`,
  `RateLimitWindow`, `ThreadTokenUsageUpdatedNotification`,
  `TokenUsageBreakdown`). That folder holds only `README.md` and
  `ListMcpServerStatusResponse.json` — none of those five types appear
  anywhere in the tree.
- Options: (a) block U1 on a fresh schema dump from the pinned binary;
  (b) map defensively from the spec's field names (`primary`/`secondary`
  with `usedPercent`, `windowDurationMins`, `resetsAt`; `planType`;
  `credits`; `last`/`total` breakdowns with `inputTokens`,
  `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`,
  `totalTokens`; `modelContextWindow`), accepting both a bare snapshot and
  a `{ rateLimits }`-wrapped one, and mapping unknown shapes to empty
  windows rather than guessed numbers.
- Pick: (b). The mappers live in `server/usage.ts`
  (`windowsFromRateLimits`, `meterFromTokenUsage`) with unit tests over
  spec-shaped fakes. If the real `account/rateLimits/read` shape differs,
  only those two functions change.

## 2. What "tightest window" means

- Options: (a) highest percent used; (b) soonest reset.
- Pick: (a). The chip, the Desk pane bar and the roster chips all show the
  window with the highest `usedPercent`. The spec's chip example names one
  window, so either reading fits it; highest-used is the one closest to
  empty, which is what the bar warns about.

## 3. Window labels and reset times from raw fields

- Options: (a) label from `windowDurationMins` (300 → "5 hours",
  10080 → "week", with generic minute/hour/day fallbacks) and `resetsAt`
  normalised from unix seconds or ISO strings to ISO; (b) show raw values.
- Pick: (a), in `server/usage.ts`. An explicit `label` string from the
  engine wins when present. Unknown durations fall back to
  "Primary window" / "Secondary window", never a guessed quota.

## 4. A failed allowance read must not fail the status check

- Options: (a) let `account/rateLimits/read` errors flow into
  `codexStatus()` like any other check; (b) fence the read in its own
  try/catch so the last snapshot stands and the check outcome is unchanged.
- Pick: (b). The allowance is advisory. This also keeps the existing
  integration tests green: their fake native client rejects the unknown
  method, which is swallowed exactly like a real read failure.

## 5. How the filler reaches the usage service

- Options: (a) `createApp` builds the service and passes it into a fresh
  `createIntegrations`; (b) a shared `usageService` singleton in
  `server/usage.ts` is the default `usage` dependency, replaceable through
  `createIntegrations` overrides like `fetch` and `discovery`.
- Pick: (b). `server/app.ts` stays within its allowance (route plus SSE
  broadcast) because it imports the same singleton; tests inject fakes
  through overrides.

## 6. Test-mode fake: seeded snapshot plus `GET /api/usage?fake=1`

- Options: (a) `?fake=1` only; (b) preseed the shared service when
  `DIOMEDES_TEST_MODE=1` *and* offer `?fake=1` to reseed deterministically.
- Pick: (b). The client fetches plain `/api/usage`, so preseeding at
  `server/usage.ts` import time is what makes the chip and Settings bars
  appear with no client test hooks. `?fake=1` reseeds and returns the fixed
  Codex snapshot (62 and 91 percent); outside test mode it is 404.
  Test-mode seeding lives in `server/usage.ts`, not `server/app.ts`, to
  keep the app edit to route plus broadcast.

## 7. The chip shows last-reported windows for an unreachable engine

- Options: (a) require the engine to be `available` as well as switched on;
  (b) show whenever the switch is on and windows were reported.
- Pick: (b). The spec hides the chip "when no engine is on or no window is
  reported" — availability is not in that sentence, and the helpers list
  already carries the live status. In the UI suite Codex is switched on but
  its binary is absent, so (a) would make the chip untestable there.

## 8. Workspace carries a `usage` prop after all

- The spec allows Workspace to stay untouched unless the chip needs a
  prop passed through. The chip lives in `App.tsx`, but `App.tsx` is told
  to pass `usage` to Workspace, Desk and Settings alike.
- Pick: pass it everywhere, and put it to real use in Workspace: the
  composer route line shows the selected service's tightest bar and percent
  (nothing renders for sample work, which reports no allowance). Copy was
  checked against the banned-words list.

## 9. Clicking the chip opens Settings at the helpers section

- Options: (a) just open Settings wherever it was; (b) raise a signal that
  moves Settings to "Helpers on this computer" (Book) or "Engines" (Desk).
- Pick: (b) via an `openHelpersSignal` counter prop. No existing Settings
  behaviour changed.

## 10. Cost stays null on turn notifications

- The turn notification carries no cost field in the spec; per-thread cost
  comes from `account/usage/read`, which U1 does not call.
- Pick: `meterFromTokenUsage` records `costUsd: null` unless the payload
  states a cost outright. The Settings meter line omits the price when it
  is null.

# Modes (muse/modes)

Unsettled points from slice 1, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. The `work` alias

- Options: (a) reject `work` outright; (b) accept `work` as an alias for `build`.
- Pick: (b). `modeOf()` maps `work` to `build` on `POST /ask`, `POST /threads`
  and `PUT /threads/:threadId`, and `migrateConversation` maps stored
  `turn.mode === 'work'` to `'build'`. The alias goes after one release.

## 2. Thread mode default

- Options: (a) leave new threads without a mode; (b) default to `ask`.
- Pick: (b). `POST /threads` defaults to `ask`; migration fills a missing
  `Conversation.mode` from the last turn's mode, else `ask`. Every `/ask`
  sets the thread's mode to the mode actually used.

## 3. Per-mode harness values

- The spec fixes effort, output, writes, consent and `maxAttempts`; no
  alternative was considered. Ask is low/text/none/sending-setting, Plan is
  medium/plan/plan/sending-setting, Build is medium/proposal/proposal/always,
  Fix is Build plus `maxAttempts` 3.

## 4. Instruction wording

- Options: (a) copy Codex-facing sentences from existing prompts; (b) write
  short plain-English instructions under 900 characters.
- Pick: (b). Ask answers only from supplied documents, names the document
  each fact came from and proposes no changes. Plan carries today's
  "practical Markdown plan, numbered actionable steps" prefix so the
  person's text is sent unchanged. Build limits proposals to the selected
  documents, at most eight files, each explained. Fix adds: something
  specific is failing, change as little as possible, improve nothing else,
  say what changed and why it fixes the failure. The STRICT JSON contract
  stays in `native-work.ts` untouched.

## 5. `askCodex` defaults

- Options: (a) require instructions/effort on every call; (b) keep today's
  values as defaults.
- Pick: (b). `instructions` replaces `baseInstructions` only on non-team
  runs when non-empty; team runs keep their team text. `effort` defaults
  to `low` on `turn/start`, including team runs.

## 6. Native work mode

- Options: (a) separate Build/Fix services; (b) one service with a mode.
- Pick: (b). `start()` accepts `mode: 'build' | 'fix'` defaulting to
  `build`; `prepare()` looks up `MODES[mode]` for instructions and effort.

## 7. Fix binding shape

- Options: (a) free-form failing text; (b) bound document and/or text.
- Pick: (b). `failing: { document?, text? }` needs at least one field;
  `document` must be one of the request's sources, `text` at most 4000
  characters, else 400 "Say what is failing: pick the document or paste
  what went wrong." The run instruction is the person's text plus a
  `Failing:` block naming the document and/or quoting the pasted text as
  untrusted material; the failing text never enters `baseInstructions`.

## 8. Attempt counting

- Options: (a) server-side retry loop; (b) count and stop, the person is
  the check.
- Pick: (b). Attempt is the thread's prior helper Fix turns plus one; over
  3 answers 409 "Three tries have not fixed this. Start a new thread, or
  make a plan first." Both turns carry `attempt: { n, of }`. Nothing
  re-runs automatically. A named-check registry comes with Fix v1.

## 9. Sample Fix text

- Options: (a) reuse the sample work sentence; (b) label the fix.
- Pick: (b). Sample Build keeps "Started clearly labelled sample work. No
  AI service is involved." Sample Fix returns "Started a clearly labelled
  sample fix. No AI service is involved."

## 10. Composer placeholders and captions

- The four Book captions are the spec sentences verbatim. Placeholders:
  Book Ask "Ask a question about this project...", Plan "What should the
  plan cover?...", Build "What should be done?...", Fix "What should be
  fixed?..."; Desk Ask "Ask or think out loud...", Plan "What should the
  plan cover?", Build "What should be done?", Fix "What should be fixed?"
- Pick: these exact strings; all avoid the banned-words list and use
  sentence case.

## 11. Fix row sources

- Options: (a) pick from every project document; (b) pick from the
  request's sources.
- Pick: (b). The Book select lists the attached document plus "Not a
  document"; the Desk lists the thread's prior turn sources plus "Not a
  document" and sends the chosen document as its source. Send stays
  disabled until a document or pasted text is present, with "Pick the
  document or paste what went wrong to send."

## 12. Chip text and placement

- Options: (a) mode only; (b) mode plus try count for Fix.
- Pick: (b). `ModeChip({ mode, attempt })` renders "Ask"/"Plan"/"Build"/
  "Fix" and "Fix, try 2 of 3" when an attempt is present. Shown on every
  turn in the Book thread and Desk pane, on the Desk pane header next to
  the helper name, and on the Book's thread rows (recent and page lists).

## 13. Work page and Home intent

- The Book's Work page keeps its name and hosts Build and Fix results.
  Home "Get something done" sets mode `build` and opens the Work page.
  The empty Ask thread says "switch the box below to Build." No new words
  were added to the top bar.

## 14. Two efforts met in the merge, and which one wins

- The modes slice and the engine-choice work each added `effort` to the
  Codex adapter, meaning different things: a mode's turn effort (Ask low,
  the rest medium, sent as `turn/start` effort) and the reasoning level a
  person picks for a thread from the model's own ladder (sent as
  `model_reasoning_effort` in the thread config). Both call sites read the
  same `input.effort`, so leaving two fields would have let the two
  channels disagree, and a mode's medium would have silently overruled a
  deliberate Astra "ultra" on every run.
- Options: (a) keep both fields and let each write its own channel;
  (b) one resolved value, the mode supplying the default and the person's
  explicit choice outranking it.
- Pick: (b). The adapter takes one `effort` string, so both channels
  always carry the same value. Callers resolve it as
  `thread choice ?? mode default` in `server/app.ts` (Ask and Plan) and
  `server/native-work.ts` (Build and Fix). The type is a string rather
  than the mode's `'low' | 'medium'`, because a ladder can reach past
  'high' and Astra reaches 'ultra'. A team run still keeps the low effort
  it was proven with.
- Not settled: whether a mode should be able to cap a choice (a person on
  "ultra" still gets "ultra" for a Fix). Owner's call.

## 15. The two surfaces are the Workbook and the Console

- The Book and the Desk were renamed on the owner's decision. Notebook was
  considered and set aside so the word stays free for the scratch surface
  that is not a project; Notes was the runner-up.
- Stored values change with them, so `Settings.surface` is now
  `'workbook' | 'console'`. Old settings are read forever: `migrateSettings`
  maps `book`, `desk` and the long-retired `technical` onto the new pair,
  and the settings route accepts the old spellings from an older client
  while only ever writing the new one. Without that, anyone already running
  Diomedes would open on a surface they did not choose.
- The rename went all the way through - component, file, CSS classes and
  copy - rather than stopping at the visible strings, so the code does not
  say Desk while the product says Console.
- This log keeps its older entries as they were written. They describe what
  was decided at the time, under the names in use then.
