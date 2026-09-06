# Codex team adapter protocol questions

## 1. MCP runtime readiness (answered)

Question: What are the enabled and healthy `runtimeStatus` values in the pinned
0.153.4 `mcpServerStatus/list` response?

Options: supply the generated 0.153.4 protocol schema from the original proof;
authorize a separate schema export/probe; or guess the enum.

Answer: use the pinned runtime's exported schema in
[evidence/codex-app-server-0.153.4](evidence/codex-app-server-0.153.4/README.md).
Inherited servers must remain disabled. The team server requires
`runtimeStatus === 'connected'` and `team_members` in its tools. On `starting`,
re-list up to five times at 200 ms. Absent or disabled means TEAM_SERVER_MISSING;
all other states, including null and unknown strings, mean MCP_NOT_ISOLATED.
Implemented and tested with the fake app-server. No real Codex run was made.

## 2. Instruction field (answered)

Question: Is `baseInstructions` documented for thread/start in 0.153.4? It is
already used by this adapter, but the current App Server page omits its schema.

Options: append role text to the existing but undocumented baseInstructions
field; or use the documented developer_instructions thread config setting.

Answer: the chosen thread/start.config.developer_instructions is accepted,
documented as additional
developer instructions injected into the session in the
[configuration reference](https://developers.openai.com/codex/config-reference/#developer_instructions).
Role text never enters turn/start user input. Both HTTP work routes now exercise
this config through the fake app-server. End-to-end behavior on the real pinned
runtime remains unverified by instruction.

## Integration contract (accepted)

The adapter caller supplies an already-populated process.env[tokenEnv]. No secret
is accepted in the request object, stored in a Session, or written into config.
tokenEnv must use the `DIOMEDES_TEAM_` namespace so the opt-in cannot reintroduce
provider keys, proxy variables, or native process controls. The URL must use a
literal loopback address and the spec's /mcp/team/:projectId route. HTTP headers
are [documented](https://developers.openai.com/codex/mcp/), so no query/token-path
authentication fallback is used.

An inherited diomedes_team name fails closed rather than merging untrusted
transport/header/helper settings into the trusted entry. The optional team
argument is exposed on NativeWorkService.start and askCodex. The /ask work and
/work/start routes supply it only for a Codex member matching the request's
threadId. The endpoint uses req.socket.localPort, the actual listening port;
no extra createApp/index/desktop port plumbing is needed.

NativeWorkService reads registered members' tokens from the store, leases
`DIOMEDES_TEAM_<SLOTID_UPPERCASED_ALNUM>` while their Session is live (including an
open approval), and clears it on completion, failure, decline, stop, or close.
Standalone adapter callers retain their existing environment ownership contract.

## Verification environment (waiting)

`npm run check` and `npm run probe:team` pass. Bare `npm test` cannot load its
config: Vite reports EPERM writing node_modules/.vite-temp through the shared
junction to F:/Achilles/diomedes/node_modules, outside the writable worktree.
The supported session-only invocation
`npm.cmd test -- --configLoader runner --no-cache` runs the suite: 132 passed,
2 failed (134 total). Two existing
owned-process transport tests still report CLEANUP_FAILED from taskkill; their
underlying cause is not established. Readiness and glue tests pass, including
authenticating team_members against the real local MCP endpoint using the fake
app-server's supplied config and environment. No real Codex configuration changed.

Question: Can final verification be run in a session that permits the shared
Vite temp directory and owned-subprocess cleanup? Options: rerun in that
environment, or weaken/skip the transport tests. Pick: rerun; preserve the tests
and production cleanup behavior. The exact required npm test pass is still
outstanding. This is the existing verification question, not a new behavior
question; no other questions remain open.
