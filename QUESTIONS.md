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
