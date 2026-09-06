# Team service v0 — open questions (spec did not settle behaviour)

1. `team_send_message` acknowledgement for shutdown: spec requires the member to acknowledge with "a message of type `message` with summary `shutdown_approved`", but `team_send_message` input is `{ to, message, files? }` with no summary field. Implemented: accept optional `summary`; mark `stopped` when `summary === "shutdown_approved"` OR `message === "shutdown_approved"` and a `shutdown_request` is pending. Otherwise any message does not stop. Chosen so the probe can ack without breaking the stated input shape.
2. `team_interrupt_agent` "flagged `interrupt: true` in summary": `summary` is a string, not an object. Implemented: `summary = "interrupt:true[ reason:...]"`, `content = message`. Tests assert the substring `interrupt:true`.
3. `blocked_by` / `idempotency_key` persistence: Diomedes `Task` has no such fields and `TeamState` is `{ members, messages, runs }`. Implemented: persist in `StoredState.teamMeta = { idempotency, blockedBy }` inside `state.json` (stripped from `/state` output); `blocked_by` ids are validated for existence. No extra API fields on `Task`.
4. `History` attribution for non-status board edits (description/owner/blocked_by): spec gives only put/done sentences. Implemented: `"<Name> (<Engine>) updated '<subject>' on the board"`; status moves use put/in-progress/done/removed sentences with member name + engine label.
5. Engine display names: spec example "Luna (Codex)". Implemented: codex→Codex, claude-code→Claude Code, opencode→OpenCode, oh-my-pi→oh-my-pi, sample→Sample, probe→Probe.
6. Message `threadId` selection: spec says server sets identities, never trusts caller. Implemented: outgoing mailbox `threadId` = sender member's `threadId` (owner sends use recipient's); `runId`/`approvalId` = null (no runs/approvals in v0).

All of the above are implemented as described so `npm test` and `npm run probe:team` pass; confirm or redirect and I will adjust.
