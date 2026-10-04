# Harness host integration changes, 2026-09-09

## A route with no model refuses by name, and the export section draws once, 2026-10-04

A send on a model-API route with no model chosen refuses with the route's own name again ("Connect
AWS Bedrock (GPT-5.6 Luna) and choose its model in AI setup first."). Since the Agent Team work came
onto main, the send asked `nativeChoice`, whose generic "Select a model for this engine in Settings."
ran first and lost the route; the other engines keep that sentence. In Workspaces, the business
owner's records section and the credit asks below it carried the same React key, so the records
section could be drawn more than once (three times in the browser test); each now has its own. `tests/home-luna.spec.ts` and
`tests/organization-export-ui.spec.ts` hold them (DIO-203).

## Type and spacing keep one size at every window width, 2026-10-03

The Nectovia home greeting no longer grows with the window. It reads a new fixed token,
`--dm-type-display` (3rem), where it had `clamp(2.125rem, 1rem + 2.6vw, 3.5rem)`, so a bigger
window adds margin and never a bigger line. `tests/viewport-units.test.ts` fails on any new
viewport or container unit in a font, padding, margin or gap, or in a type, line or measure
token. Five older padding rules stay on its list with their reasons, and the list can only
shrink. `tests/readability.spec.ts` expects every type role to measure the same at 1280, 1920
and 2560, and the work column to hold at 920 at 1920 and 2560. This is Phase 1 of
`docs/superpowers/specs/2026-10-03-wide-windows-and-multitask-mode-design.md`, which the round 2
reskin is built against.

## Worker rows read on a timer, 2026-10-03

Worker rows no longer hold an event stream of their own. They're read when shown and again every
three seconds while they are (`client/work-rows.ts`). The page already keeps its event streams open,
and a browser keeps at most six connections to one host, so with two windows on the Agent page the
extra stream left no connection for an ordinary request and the second window waited forever
(`tests/diomedes-home.spec.ts`, CD05-R-10). The server's `/api/events?topics=work-rows` is unchanged.

## Automatic work only where the work loop runs, 2026-10-03

An explicit request in Automatic mode becomes automatic work only when its conversation's work
route can run the work loop: a model API route, Nectovia's included. On Codex, Claude Code and the
other outside tools the request stays the proposal the person starts, as every proposal did before
automatic work. Without this, a free conversation on an outside tool made a Board task it couldn't
start and answered "Nothing was started". `tests/interaction-seam.test.ts` holds it. The shipped
product knowledge names the route Codex too.

## The Codex route is named Codex, 2026-10-03

The codex route is named Codex everywhere a person sees it: the model picker, Settings, run
cards, attribution, receipts, worker rows and the route's own messages (owner decision,
2026-10-03). The account it signs in with is still called the ChatGPT account, so the sign-in,
connection check and account messages keep that name. The name comes from `ROUTE_NAMES` in
`shared/engines.ts`, and every label built from it follows.

## Subscription workers under a Personal Nectovia lead, 2026-10-03

A Nectovia loop a person starts in their Personal workspace can hand one task to their own Codex,
Claude Code or OpenCode, when they turned that on (DIO-175, slice S3). The lead spends Nectovia
credits; the worker runs on the person’s own plan through the tool’s programming interface, and the
account service records a paid Agent admission for it with no managed hold. Consent names the tools,
only the person’s own start takes such a worker (Board work and the Ready queue never do), a business
project keeps its single-agent path, and a reserve keeps the person’s share of their tool’s usage.
It’s off unless `DIOMEDES_EXTERNAL_WORKERS=1` and `DIOMEDES_SUBSCRIPTION_WORKERS=1`, and stays off
until the Pillar 07 wording (D1) is approved. See
[the record](../implementation/2026-10-03-subscription-workers.md).

## External team workers, 2026-10-03

A lead loop can hand a bounded task to a worker on the person's own installed Claude Code, Codex
or OpenCode (DIO-175, slice S2). Each goes through the tool's programming interface with its tools
off, signed in through the provider's own flow; nothing reaches a consumer chat. The worker answers
in one turn, one external turn runs per engine account at a time, and a turn that may have gone out
is never sent again by Retry. It's off unless `DIOMEDES_EXTERNAL_WORKERS=1`. See
[the record](../implementation/2026-10-03-external-team-workers.md).

## Free manual teams on the Board (S1), 2026-10-03

A person-run Team now works from the Board without the paid Agent (DIO-175 lane S1). The
person assigns a card to a Team member from the card (DIO-176). A card a member makes starts
on that member's own Codex or Claude Code engine through Native Work, with the usual send
confirmation, and only the person moves its phase. A manual hand-off carries what came of one
card, its changed files, checks and open issues to the next card, whose start begins with those
files; the files must fit one start, a file that left the project no longer blocks it, and the
person can retire a hand-off. Only the person assigns or removes a manual card; a member's tool
is told to ask. Worker rows for Sessions, Team members and H14 workers come from a production
source behind `GET /api/projects/:id/work/rows` and a `work-rows` event on its own stream,
`/api/events?topics=work-rows`, and never carry Team mail. Nothing in this lane calls the Agent
gate or a managed route. See [the implementation record](../implementation/2026-10-03-manual-teams.md).

## Agent Team reconciliation onto main, 2026-10-03

The Agent Team, automatic work and Personal Trust work now sits on current main as
`feature/agent-team-automatic-work` (DIO-177). The Individual funding repair, the Mac
packaging changes and the release workflow stay with their owners. See
[the reconciliation record](../implementation/2026-10-01-agent-team-automatic-work.md#reconciliation-onto-main-2026-10-03).

## Current engine compatibility amendment, 2026-09-27

Vendor build equality no longer admits or refuses native/subscription engines.
Current installation, authenticated model catalogue, protocol capabilities,
account route, isolation and executable identity determine admission. Earlier
entries below describing exact version equality are historical evidence.
The app refreshes models and reasoning options after engine changes; a stale
choice is refused without selecting a different model or payer. See
[engine discovery and provider evidence](../implementation/2026-09-27-engine-capability-discovery.md).

The owner selected GPT-5.6 Luna temporarily for managed AWS calls. Both Luna
models still fail account access; a separate tiny Haiku call succeeded through
the existing key. Paid Nectovia Agent entitlement remains independent of the
inference engine or payer, and free accounts retain manual Board access.

The current candidate also closes gaps identified while reviewing the earlier
conversation driver: a fork checks its saved account on the same process before
any thread operation; cleanup failures remain observable; and an absent runtime
model report remains unverified. Native answers now pass the route's redaction
before durable evidence, history and replay. Live channels reserve output order
without flushing incomplete text when another channel speaks. Safe text still
streams; frames behind an incomplete channel can wait until the attempt ends.
Stop discards those held frames. Final checks remain pending for these amendments.

Sandbox metadata uses the existing durable JSON writer and its bounded Windows
sharing-error retry. A permanent failure preserves the prior manifest, removes
the temporary file and remains a failure; no tool operation is retried.

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

## Kept sessions continue across engine updates, 2026-09-27

Review finding M-3 of the engine conversations branch. Branch
`feature/session-restore-across-updates`, stacked on `feature/codex-conversation-driver`.

- A saved OpenCode, Cursor or Devin conversation now resumes after the engine updated itself, as
  a ChatGPT or Claude Code conversation already did. `openOpenCodeSession` and `openAcpSession`
  refused a checkpoint saved under another engine version with `SESSION_MISMATCH`, which the
  conversation service reads as a changed scope. After every engine update, the next message
  therefore started a fresh engine session with a note saying the settings had changed. Both
  version equality checks are gone (engines are version-agnostic since 2026-09-23). The account,
  route, lineage and scope checks stay.
- A restored Cursor or Devin checkpoint now records the version installed now, as an OpenCode
  or Claude Code resume already did. Each ACP turn compares the version the CLI reports with the
  saved one, so without this the first turn after an update would be refused after its answer
  had arrived.
- Not changed: that per-turn comparison still refuses a turn when the engine updates between two
  turns of a conversation that stays connected (`AcpNativeSession.run`).

`tests/opencode-session.test.ts` and `tests/acp-session.test.ts` (Cursor and Devin) continue a
session saved under an older version. `tests/h04-opencode-session-routes.test.ts` and
`tests/h05-acp-session-routes.test.ts` update the engine between two runs of the app and resume
over HTTP, and the answer is attributed to the version installed now. The two tests that pinned
the refusal no longer list the version, and now also check the account route. Fixture proof only.

## A connected Cursor or Devin conversation continues across an engine update, 2026-09-27

Follow-up to review finding M-3. Branch `feature/acp-live-engine-update`, stacked on
`feature/session-restore-across-updates` (5c9dcc7).

- A Cursor or Devin conversation that stays connected now continues when the engine updates
  itself between two of its turns. Each ACP turn starts its own process and reads `--version`
  again, and `AcpNativeSession.run` refused a turn whose version differed from the one the
  conversation was opened with (`SESSION_MISMATCH`). The refusal came after the agent had
  answered, so the answer was dropped and the message failed with a 409 naming both versions.
  The run was left needing reconciliation, so the next message retired the conversation with the
  note that it had stopped and could not be picked up again, and started a fresh engine session.
- The turn now adopts the version the CLI reported, and the saved checkpoint records it, as a
  Claude Code resume already does. This replaces the "Not changed" line of the section above.
  Every other check stays, including the driver's identity check (`result.version !==
  admission.version` in `server/harness/claude-session-run.ts`): admission and the turn read the
  same installation, so both name the new version and the answer is attributed to it.
- Not changed, for Andrew to decide: that driver check still refuses the first message on a live
  OpenCode or Claude Code connection after the engine updated itself in place. Those sessions
  report the version they were opened with while admission finds the new one, so the answer is
  dropped, the run is parked as `reconcile_required`, and the message fails with "The native
  response did not match this request." The next message then starts the conversation fresh with
  the same note.

`tests/acp-session.test.ts` (Cursor and Devin) and `tests/acp-session-runtime.test.ts` (Cursor
through the driver, with admission and the turn both finding the newer version) update the engine
between two turns of one connected conversation. The second turn continues the same session with
`session/load`, and the checkpoint and the answer's attribution name the newer version. All three
failed on the old check before the fix. Fixture proof only.
