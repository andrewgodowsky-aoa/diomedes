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
