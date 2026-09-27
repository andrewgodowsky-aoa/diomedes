# Codex app-server 0.153.4 protocol schema (excerpt)

Generated on 2026-09-06 from the pinned runtime with a read-only command:

```powershell
.\.data\native-runtime\codex.exe app-server generate-json-schema --out <dir>
```

`ListMcpServerStatusResponse.json` is the v2 response of `mcpServerStatus/list`. The facts the team adapter relies on:

- `data[].runtimeStatus` is `McpServerConnectionStatus | null`, enum
  `notStarted | starting | connected | authenticationRequired | failed | cancelled | disabled`;
  null means "unavailable or the configuration changed".
- `data[].authStatus` enum `unknown | unsupported | notLoggedIn | bearerToken | oAuth`.
- `data[].tools` lists the server's tools; `nextCursor` pages.

So: an inherited server is isolated when `runtimeStatus === 'disabled'`; the Diomedes team server is ready when `runtimeStatus === 'connected'` (retry briefly on `starting`; every other value, including null, is not ready).

## The kept ChatGPT conversation (2026-09-27)

Generated again on 2026-09-27 from the same pinned runtime (0.153.4) for the engine conversations
plan (`docs/superpowers/plans/2026-09-27-engine-conversations.md`). The facts the kept
conversation relies on, each pinned by `tests/codex-protocol-evidence.test.ts`:

- `turn/interrupt` takes `{ threadId, turnId }` and answers `{}`. The turn then completes with
  `turn.status` `interrupted` (`TurnStatus`: `completed | interrupted | failed | inProgress`).
- `turn/start` answers `{ turn }` with the turn's `id`, which Stop needs.
- `turn/start` takes `summary` (`ReasoningSummary`: `auto | concise | detailed | none`), which
  "overrides the reasoning summary for this turn and subsequent turns". A turn that has no
  thinking sink sends `none`, so an earlier turn's `auto` doesn't carry into it.
- Reasoning summaries stream as `item/reasoning/summaryTextDelta`
  `{ threadId, turnId, itemId, summaryIndex, delta }`; `item/reasoning/summaryPartAdded` marks a
  new part. Raw reasoning (`item/reasoning/textDelta`) is not mapped.
