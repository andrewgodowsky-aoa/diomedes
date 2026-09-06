# Codex team adapter protocol questions

## 1. MCP runtime readiness (waiting)

Question: What are the enabled and healthy `runtimeStatus` values in the pinned
0.153.4 `mcpServerStatus/list` response? The existing adapter proves `disabled`,
but the current [official App Server documentation](https://developers.openai.com/codex/app-server/)
does not describe this field or its enum. No saved generated schema was found.

Options: supply the generated 0.153.4 protocol schema from the original proof;
authorize a separate schema export/probe; or guess the enum.

Pick: use the saved schema. Do not guess. The implementation rejects unknown
runtimeStatus values with MCP_NOT_ISOLATED. For a status inventory without that
undocumented field, required:true establishes successful initialization at
thread/start and a nonempty team tool inventory establishes tool availability.
The real pinned runtime remains blocked if it reports an undocumented state.
No real Codex command or probe was run.

## 2. Instruction field (documented alternative implemented)

Question: Is `baseInstructions` documented for thread/start in 0.153.4? It is
already used by this adapter, but the current App Server page omits its schema.

Options: append role text to the existing but undocumented baseInstructions
field; or use the documented developer_instructions thread config setting.

Pick: thread/start.config.developer_instructions, documented as additional
developer instructions injected into the session in the
[configuration reference](https://developers.openai.com/codex/config-reference/#developer_instructions).
Role text never enters turn/start user input. Per-thread config uses the existing
adapter path; end-to-end behavior on the pinned runtime is unverified.

## Integration contract

The caller supplies an already-populated process.env[tokenEnv]. No secret is
accepted in the request object, stored in a Session, or written into config.
tokenEnv must use the DIOMEDES_TEAM_ namespace so the opt-in cannot reintroduce
provider keys, proxy variables, or native process controls. The URL must use a
literal loopback address and the spec's /mcp/team/:projectId route. HTTP headers
are [documented](https://developers.openai.com/codex/mcp/), so no query/token-path
authentication fallback is used.

An inherited diomedes_team name fails closed rather than merging untrusted
transport/header/helper settings into the trusted entry. The optional team
argument is exposed on NativeWorkService.start and askCodex; client HTTP route
wiring remains outside this task's allowed files.

## Verification environment (waiting)

`npm run check` passes. Bare `npm test` cannot load its config because Vite writes
to node_modules/.vite-temp through the shared junction, whose target is outside
this session's writable root. The supported session-only invocation
`npm.cmd test -- --configLoader runner --no-cache` avoids that write and runs
all tests: 105 passed, 2 failed. Both failures are unchanged owned-process
transport tests reporting CLEANUP_FAILED from taskkill; their underlying cause
is not established. The new team tests pass. No Codex configuration was changed.

Question: Can final verification be run in a session that permits the shared
Vite temp directory and owned-subprocess cleanup? Options: rerun in that
environment, or weaken/skip the transport tests. Pick: rerun; preserve the tests
and production cleanup behavior. The exact required npm test pass is still
outstanding.
