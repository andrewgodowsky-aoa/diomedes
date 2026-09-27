# Harness host integration changes, 2026-09-09

Continuation: [NR-02/NR-03 changes and proof](NR02_NR03_VERIFICATION_2026-09-09.md).
The descriptions below apply to the earlier packet, not every subsequent source change.

This integrates the runtime packet against committed main `86ee91d` and harness
boundary `c777c41`. Main already contains the approval/foundation integration at
`0ad3951`; the old Codex worktrees were not used as uncommitted sources.

`HARNESS_CONTRACT_VERSION` remains 1. `shared/harness.ts` is unchanged. The file
reader still refuses every run-file `v` other than 1. The host additionally
validates the structure and event sequence before attempting recovery.

## Necessary host seams

- `Need.harness?: { runId, intent }` is an optional binding in `shared/types.ts`.
  Existing Need, Session and text-approval records retain their shapes. A harness
  Need uses `preview: []` and `approval.actionDigest === step.intentHash`. Its
  stored intent allows the existing receipt validator and prepared-write journal
  to verify the exact text, destination, expected hash, project and run without
  loading run files during Store recovery. It is not a second approval record.
- Harness action hashes are bare SHA-256, as defined by the boundary. Proposal,
  base and command-payload hashes retain the existing `sha256:` format. The
  server and existing client decision helper understand the action-hash variant;
  text approvals still require their original identities.
- `Decision.expiresAt` is an optional absolute cap alongside `ttlMs`. The bridge
  passes the Need deadline as well as its remaining life, so queue or disk latency
  cannot extend the saved harness approval beyond the person's approval window.
- `Store.recordApprovalDecision`, `approvalId` links and `Store.writeRecorded`
  remain in use. A harness write settles its execution receipt in the existing
  journal, but only `presentRun` may finish the Session. Store startup preserves
  harness Sessions and pending Needs until the host has read their run records.
- `RunService.recover(runId, principal)` is an additive startup-only method. The
  caller must already own the data-folder lock, have completed Store recovery,
  and have dispatched no work. It invalidates the dead owner's lease, makes safe
  interrupted steps retryable and parks unknown non-idempotent effects. There is
  no HTTP recovery action or second scheduler. The CLI and desktop already claim
  the data-folder lock before calling `createApp`; tests use exclusive temp data.
- `server/app.ts` needs initialization, close, Work-start, service-selection and
  Need-resolution seams in addition to the route mount and imports. Its existing
  resolution branch sends every exact Need to `NativeWorkService`; one mount
  line alone cannot connect harness receipts without intercepting that route.
- The native token replacement function is shared with the harness. Error names,
  error messages, cancellation reasons, Session event lines and route responses
  use the scrubber. The fixture leases no credentials. Opaque transcript
  references are returned through the scrubber; no transcript content is loaded.
- The fixture adapter's filesystem label now describes its recorded local write.
  This is a trusted in-process adapter, not a security sandbox or a real model.
- Atomic run-file replacement has a bounded Windows sharing-error retry (six
  attempts, at most 300 ms of delay). It retries the same rename, preserves the
  previous record on permanent failure and never repeats a tool handler. The
  host itself starts no timer or poller.

## Recovery and rollback

Store replays a prepared document journal first. The harness then reclaims the
run and replays completed observations. `propose_write` uses the step's stable
idempotency key as the History label; a matching applied receipt returns the
existing observation without calling the document writer again.

Expired unanswered Needs stay waiting and are refused. Stop the run and start a
new fixture for a new approval window; the host does not silently renew consent.
Runs already requiring reconciliation never restart automatically. Unknown
versions, malformed records, duplicate run IDs and unavailable capabilities are
skipped; the corresponding active Session reports that its saved run could not
be read. Other projects can still open.

Runs live only under `projects/<projectId>/harness/runs/`. Removing that directory
does not remove project files, History, Sessions or decision receipts. A code
downgrade to the earlier exact-text-only reader requires the matching pre-run
data snapshot, since that reader cannot interpret an empty-preview harness Need.
No live data was migrated or removed by this work.

## Thinking channel, 2026-09-27

Spec: `docs/superpowers/specs/2026-09-27-engine-conversations-and-reasoning-design.md`. Plan:
`docs/superpowers/plans/2026-09-27-reasoning-end-to-end.md`.

`ADAPTER_CONTRACT_VERSION` remains 1. A route's descriptor gains `streaming.reasoning`,
`reasoning-delta` or `none`, and the conformance check `reasoning-needs-live-channel` refuses a
declaration without a live preview channel. EngineService builds the thinking sink only where the
route declares it, fenced to the same attempt as the text, and refuses a caller that supplies the
raw `onReasoningDelta` itself. Frames are `reasoning-delta` previews of at most 64 KiB on the
events stream (`engine-reasoning`). They are never persisted.

The finished thinking is saved on the reply only, as `Turn.thinking` (`text`, `ms`,
`shortened`), redacted and cut to 32 KiB. It is never in the run record, so a replayed or
reconciled answer has none. Work runs keep no thinking. The Console shows it above the reply,
open and muted while the engine thinks, then folded to one line that opens on click.

Producers by route:

- Claude Code, one-shot and kept session: stream-json `thinking_delta`.
- Cursor and Devin, one-shot and kept ACP session: `agent_thought_chunk` text inside the
  prompted turn; anything else is dropped without stopping the turn.
- OpenCode, one-shot and kept session: the reasoning parts of the turn's assistant message.
- AWS Bedrock: Responses reasoning summaries, asked for (`reasoningSummary: 'auto'`) only while
  a thinking sink listens.
- Azure OpenAI declares `none` for now. A deployment marked reasoning may run a model that
  refuses `reasoning.summary`, which would fail every watched reply, so nothing is asked for until
  a live Azure proof turns `MODEL_API_REASONING['azure-openai']` on; the binding already asks
  for summaries when it's handed a sink.
- Google Vertex AI: thought parts, with `includeThoughts` only while a sink listens. The body
  check now allows visible thinking and keeps every other refusal.
- OpenRouter: only the reasoning its models return. Nothing new is requested, because
  `require_parameters: true` would narrow the endpoints a model may use; a per-model request is
  a follow-up.
- Nectovia: Responses summaries through the managed gateway, asked for only when the routing
  policy answers `reasoningSummaries` true for the tier the turn runs on. The gateway answers
  per tier from its provider registry: true only when the upstream serving the tier has a proven
  `reasoningSummaries` line.
- ChatGPT (Codex) follows with the engine-conversations plan; oh-my-pi joins once it has a kept
  session.

The gateway change (revision 3 of
`docs/implementation/2026-09-25-managed-inference-gateway.md`) is committed and not deployed.
Until the Worker deploys, the published policy has no `reasoningSummaries` and no desktop asks
for a summary. AWS Bedrock's acceptance of `reasoning.summary` is proven only by the paid Luna
proof; if Bedrock refuses it, `MODEL_API_REASONING['aws-bedrock']` goes back to `none` and the
gateway registry's GPT-6 Luna line loses `reasoningSummaries`.

Model-API conversations hand the thinking sink through each route's own adapter (`complete()`
and the five adapter factories), and their preview, activity and thinking frames get the route's
`redactFor`, as every other engine's do. `tests/model-api-thinking.test.ts` runs every model-API
route's own adapter against `MODEL_API_REASONING`, and `tests/model-session-activity.test.ts`
runs whole conversations on OpenRouter and AWS Bedrock. A provider's own continuation (the
private transcript of one reply's tool steps) keeps the reasoning items that provider returned,
summaries included, and sends them back only to that provider within the same reply. They count
toward the transcript's 1 MiB cap and each step's request cap, and never reach another engine,
route or history.

The roadmap's runtime section needs this paragraph. The cloud canonical is the authority, so the
repository mirror waits for that write (cloud synchronisation pending):

> Thinking (2026-09-27, feature/codex-conversation-driver): an engine's thinking streams on every
> conversation route that can supply it (Claude Code, Cursor, Devin, OpenCode, AWS Bedrock,
> Google Vertex AI, OpenRouter where its models return it, and Nectovia once the gateway deploys,
> on tiers whose model is proven to accept summaries), shown above the reply and saved on it.
> Azure OpenAI waits on a live proof. ChatGPT (Codex) follows with the engine-conversations plan.
> Fixture, conformance and browser proof only; live proof pending.

## Engine conversations, 2026-09-27

Branch `feature/codex-conversation-driver`, plan
`docs/superpowers/plans/2026-09-27-engine-conversations.md`, spec
`docs/superpowers/specs/2026-09-27-engine-conversations-and-reasoning-design.md` Part 1. It
amends CD-01 Decision 5 (Round 12 of `docs/implementation/2026-09-20-core-agent-contract.md`)
and answers `QUESTIONS.md` O19 and O39 item 1, now R16.

- ChatGPT (Codex) has a kept session: `server/engines/codex-session.ts` on the shared native
  conversation driver (`server/harness/codex-session-run.ts`, route contract `codex-session`,
  `streaming.reasoning: 'reasoning-delta'`). Each conversation has its own app-server process
  on Diomedes' proven runtime (0.153.4), which ends after 5 minutes without a turn. Every turn
  can resume the saved thread with `thread/resume`, and a failed resume starts a fresh thread
  with the continuity note. No version equality gate is added. Stop sends `turn/interrupt`,
  waits 3 seconds, then ends the process tree, and the checkpoint records which happened. The
  ChatGPT account is checked on every turn, and a changed account refuses the turn with
  nothing sent.
- ChatGPT's thinking streams through Plan 1's thinking channel. A turn asks for reasoning
  summaries (`summary: 'auto'`) only while a thinking sink listens, and sends `'none'`
  otherwise, because the protocol carries the setting to later turns.
- One table, `KEPT_SESSIONS` in `server/conversation-sessions.ts`, says which driver, run id
  prefix and turn each kept-session route uses, and the thread session view, the
  conversation projection and `resolve` read it. `isConversationRoute` and
  `CONVERSATION_ROUTES` admit `codex`, `opencode`, `cursor` and `devin` beside `claude-code`
  and the model-API routes, so the Home engine update and the send path admit the same routes.
- Found engines: `foundConversationEngines` (`shared/conversation-engines.ts`) lists only the
  engines that are installed, compatible and signed in, and suggests the Nectovia plan when
  none is. A turn on an engine that's gone is refused in its own words (`engineGoneSentence`),
  translated where `EngineService.nativeTurn` fails, with nothing sent.
- Project threads on ChatGPT, OpenCode, Cursor and Devin send Ask, Plan and Automatic through
  the conversation (`client/console/thread-send.ts`). Claude Code project threads (O38) and
  Build and Fix keep the direct path.

The final review's fixes (2026-09-27): a ChatGPT conversation's turn has no deadline of its own,
because Stop ends it as it ends a Claude Code conversation's turn, and the direct request path
keeps its two minutes. A playbook message on ChatGPT, OpenCode, Cursor or Devin keeps the direct
request path it had, because the conversation takes no playbook yet, so that message isn't part
of the engine's kept session. The session line names ChatGPT, Cursor and Devin as people read
them, and a ChatGPT answer records the model ChatGPT reported. A Codex runtime that was never
prepared is refused as not installed before the sandbox proof runs.

Fixture, conformance and browser proof only. Live proof is pending on Andrew's machine: one
ChatGPT conversation that shows thinking, takes a Stop, and continues after an app restart.

The roadmap's runtime section needs this patch. The cloud canonical is the authority, so the
repository mirror waits for that write (cloud synchronisation pending):

> Section 5, the H05 sentence "H05 is an API route, not a Console conversation route
> (QUESTIONS.md O39)." becomes: "Since 2026-09-27 (feature/codex-conversation-driver), H05's
> kept Cursor and Devin conversations are Console conversation routes (QUESTIONS.md R16). A
> kept conversation's folder is still never removed automatically (O39)."
>
> Section 5, H04's clause "no Console surface until OpenCode is admitted as a conversation
> route (CD-01 Decision 5, QUESTIONS.md O19)" becomes: "a Console conversation route since
> 2026-09-27 (CD-01 Decision 5 as amended in Round 12, QUESTIONS.md R16)".
>
> A new paragraph after H05: "Engine conversations (2026-09-27,
> feature/codex-conversation-driver): a Console conversation runs on Claude Code, ChatGPT,
> OpenCode, Cursor, Devin or a model-API route, and offers only the engines this computer has
> installed and signed in. ChatGPT answers through a kept Codex session on Diomedes' own
> runtime, with thinking, Stop and continuing after a restart. Fixture, conformance and browser
> proof only; live proof pending."

## Live frames redacted across chunks, 2026-09-27

Engines stream answers and thinking in small token chunks, so a secret a model echoes usually
arrives in pieces. `previewSink` and `reasoningSink` redacted each chunk on its own, which let a
split secret reach the Console's live answer and Thinking over `/api/events` (`engine-text`,
`engine-reasoning`). The saved reply and `Turn.thinking` were already redacted as one piece.
Branch `feature/live-frame-redaction`, stacked on `feature/codex-conversation-driver`.

- Both sinks (`shared/adapter-contract.ts`) now redact the stream's text as one piece and show
  only what more text can no longer change. They hold back the newest part: always the last 32
  characters, and the word still being written, up to 256 (`LIVE_REDACTION`). A secret without
  spaces is caught up to 256 characters long, and one with spaces up to 32. A longer one can
  still show its first part live; the saved reply and saved thinking are redacted whole either way.
- Held text is shown when more text arrives, when another channel of the same attempt speaks
  (`liveOrder`), or when the attempt ends. Every site flushes before its channels close:
  `generate`, `nativeTurn`, `fencedSinks` (model-API conversations and Work turns) and the ChatGPT
  Ask preview in `server/app.ts`. A kept-session turn that fails now drains its channels, as a
  model-API turn already did, so it still shows what it wrote; Claude Code, ChatGPT, OpenCode,
  Cursor and Devin share that driver (`ClaudeSessionRuns`). Showing held text when another channel
  speaks assumes an engine switches channels between blocks rather than inside a word; a secret
  cut by a channel switch would show its first part live.
- The order is unchanged: a tool line never overtakes the text written before it, and the answer
  never overtakes its thinking.
- A stopped or fenced attempt shows nothing it held, and a poisoned preview shows nothing more.
  The adapter's bound is still one chunk of 64 KiB after redaction; a release longer than one
  frame is split into frames within the budget, and sequences stay dense.
- Frames follow what is safe to show, not the engine's chunks, so the newest words of a live
  answer or thought appear with the next chunk, and a short answer can arrive as one frame at the
  end. A sink with no redaction (only test fixtures build one) still sends one frame per chunk.

`tests/live-redaction.test.ts` cuts a provider key, a bearer token and a home folder at random
under `baselineRedact`, and covers the hold's bounds, budgets, surrogate pairs, Stop and channel
order. Split secrets also run through `generate`, the ChatGPT kept session, model-API
conversations and the ChatGPT Ask path, and a failing Claude Code kept-session turn shows its
held text. Fixture and unit proof; no live run is needed for this change.
