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
