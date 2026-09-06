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
