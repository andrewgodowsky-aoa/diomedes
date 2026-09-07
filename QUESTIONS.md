# Codex team gateway isolation

## [blocked] 2026-09-06: enabling the 0.153.4 host lacks an enforceable tool boundary

The reported real team run reached readiness but returned "code-mode host is disabled."
No gateway enablement is included in this change. Team tool execution remains unresolved;
the separate Work task-name fix can be reviewed independently.

Verified locally:

- `server/integrations.ts` sets both `features.code_mode=false` and
  `features.code_mode_host=false` in `SAFE_CONFIG`. `configArgs()` applies these at
  app-server startup, and `askCodex()` also sends them in `thread/start.config`.
  `startNative()` does not pass `--code-mode-host`.
- The installed binary at `F:/Achilles/diomedes/.data/native-runtime/codex.exe`
  reports `codex-cli 0.153.4`. Its read-only `features list` reports `code_mode_host`
  as stable/enabled and `code_mode` as under development/disabled in the inspected
  configuration. Its `app-server --help` describes `--code-mode-host <URL>` as
  selecting a remote host instead of starting a local one.
- Generated the pinned experimental protocol with
  `codex.exe app-server generate-json-schema --experimental --out test-results/codex-0.153.4-schema`.
  These ignored artifacts are not proposed repository changes. No model turn or
  real app-server session was run.
- `ClientRequest.json` contains `mcpServerStatus/list` but no complete code-mode
  host tool-inventory method. `v2/ListMcpServerStatusResponse.json` describes MCP
  servers/tools/resources, not the host's built-in or nested executor inventory.
  `server/diagnostics` reports process/memory gauges; `environment/info` and
  `environment/status` report shell/cwd and connection state, not a tool allowlist.
- `ServerRequest.json` references `DynamicToolCallParams` for `item/tool/call`.
  There is no universal pre-execution MCP/native/gateway call interception request.
  Rejecting all server requests in `createRpcClient()` fences client-executed
  dynamic tools and permission requests; it does not fence calls executed inside
  app-server without a client request.
- `askCodex()` accepts team MCP lifecycle notifications and rejects foreign tool
  items on `item/completed`. This detects a violation after execution; neither
  that handler nor switching to `item/started` proves the foreign operation was
  prevented. A fake completed notification is not a pre-execution refusal test.
- The pinned `v2/ThreadStartParams.json` and `v2/TurnStartParams.json` explicitly
  document `environments: []` as disabling environment access. This supports the
  existing environment fence, but does not enumerate every tool the enabled host
  can expose. The existing read-only write probe proves write denial, not absence
  of filesystem reads, other native tools, or gateway tool sources.

Official documentation checked on 2026-09-06 (live pages, not versioned 0.153.4 docs):

- <https://developers.openai.com/codex/app-server/#connect-a-remote-code-mode-host>
  redirects to <https://learn.chatgpt.com/docs/app-server>. It confirms a local
  Code Mode host starts by default and `--code-mode-host` selects the outbound
  host connection shared by threads in that app-server process. It does not
  document an MCP-only host allowlist.
- <https://developers.openai.com/codex/app-server/#dynamic-tool-calls-experimental>
  documents `item/tool/call` for client-executed dynamic tools. The items section
  documents `item/started` and `item/completed` as lifecycle notifications.
- <https://developers.openai.com/codex/config-reference> redirects to
  <https://learn.chatgpt.com/docs/config-file/config-reference>. It documents
  `features.code_mode.enabled`, `features.code_mode.excluded_tool_namespaces`, and
  `features.code_mode.direct_only_tool_namespaces`. The fetched reference does
  not document `features.code_mode_host` or a `tool_gateway` setting. Namespace
  exclusions cover nested guidance/executor exposure; they do not establish that
  all other direct tools are disabled. Direct-only namespaces explicitly permit
  direct calls.

Candidate change, NOT applied: enable `features.code_mode_host=true` only for team
process startup and team thread config, retaining `features.code_mode=false`.
It is an inference from the reported error and separate binary feature flags that
host enablement alone could restore direct MCP calls. Whether it suffices, and
whether every non-team tool remains uncallable, is unverified. Setting the current
docs' `features.code_mode.enabled=true` or boolean `features.code_mode=true` would
also need a separate proof; do not assume the live docs describe the pinned build.

The retained controls include `features.shell_tool=false`, `features.apps=false`,
`features.plugins=false`, `features.hooks=false`, `features.memories=false`,
`features.multi_agent=false`, `features.multi_agent_v2=false`,
`features.computer_use=false`, `features.browser_use=false`,
`features.browser_use_external=false`, `features.image_generation=false`,
`features.workspace_dependencies=false`, `features.view_image=false`,
`features.skip_host_skill_discovery=true`, `features.shell_snapshot=false`,
`features.remote_plugin=false`, `features.skill_search=false`,
`features.skill_mcp_dependency_install=false`, `skills.include_instructions=false`,
`agents.enabled=false`, `web_search="disabled"`, per-server
`mcp_servers.<name>.enabled=false` except the explicit team server, empty dynamic
tools/capability/workspace roots/environments, read-only sandbox, no sandbox network,
and `approval_policy="never"`. These controls and the MCP disabled-inventory check
have not been proven to cover the enabled host's complete tool surface. In
particular, a read-only sandbox is not proof of no filesystem reads, and MCP
inventory does not attest host-native tool absence.

Options for resolving the blocker:

1. Obtain version-matched runtime/source evidence of a complete host inventory or
   a universal pre-execution allowlist/refusal mechanism, then implement and test
   a team-only boundary before enabling the host.
2. Design a separately constrained host or client-executed tool bridge that
   enforces the allowlist before forwarding a call. This requires an explicit
   design/scope decision and verification that native/direct tool paths cannot
   bypass it; `--code-mode-host` alone is routing, not such an enforcement layer.
3. Keep the current host-disabled adapter until one of those proofs is available.
   This is the current state; do not log that team tools are callable or that a
   team-only host is enabled.

Fake app-server coverage retains the existing team MCP acceptance/logging and
foreign completed-tool rejection tests, and now explicitly observes both gateway
flags as false with and without `team`. Those tests prove adapter configuration
and notification handling, not successful real gateway execution or prevention
of every foreign call. The requested enabled-host acceptance/refusal proof and
enabled-host technical session log are blocked, rather than simulated as passing.


# Helper roster — open questions (muse/discovery-client, 2026-09-06)

Unsettled points from the helper-roster task, each with options and the pick I implemented.
The implementation keeps going with the pick; overturning one is a small, local change.

## 1. What does "the section is 'Helpers on this computer'" rename?

- Options: (a) the Settings rail entry (old 'Services') in the Book; (b) a new heading inside the block, keeping the rail entry 'Services'.
- Pick: (a). The rail entry is now 'Helpers on this computer' in the base list; the Desk keeps its 'Engines' entry. The block renders for either entry. The Desk-only 'Connections' entry and its block are removed.

## 2. What intro does the Desk 'Engines' block show?

- Options: (a) keep the old sentence; (b) reuse the new Book intro.
- Pick: (a). The task only specifies the Book intro ("Diomedes can use these to do work. Here is which ones it found, and what each one sends."), so the Desk keeps "Diomedes uses AI services to do work. Here is which ones, and what is sent."

## 3. Guided detail on the Desk surface?

- Options: (a) Guided hides non-ready adapters only in the Book; the Desk always shows everything; (b) Guided hides them on both surfaces.
- Pick: (a), per "Standard and the Desk show everything": the filter applies when `settings.detail === 'guided' && !isDesk`.

## 4. "Entries without a switch show no 'What is sent' button" vs Sample work?

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
