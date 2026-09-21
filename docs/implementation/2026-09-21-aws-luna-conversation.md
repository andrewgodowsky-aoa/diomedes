# AWS Luna in the Diomedes conversation (SDKR-CONN-02.F01)

AWS Bedrock is now a conversation route beside the native Claude session. A person connects the
company's own AWS account in AI setup, approves a spend limit, and a conversation on that route runs
the existing NativeAgent loop against `us.openai.gpt-5.6-luna` through the Bedrock runtime Responses
endpoint. Its registered read tools answer from the project's files. A request to change a file
becomes an exact proposal that the person approves or denies, and the recorded writer applies it.
This is one bounded route. It does not certify the CD-1 program.

This branch, `feature/aws-luna-conversation-on-repair`, composes the lane's work (`3c91a51`, on
`4e2c93c`) onto the CD-01 admission repair (`7b063b6`). The integrator merges it into
`feature/core-agent-bot` (PR #29). Nothing has reached AWS.

## The path

1. **Console.** The AI setup card (`client/AwsBedrockSetup.tsx`, pure view in
   `client/aws-bedrock-view.ts`) saves the key and the spend limit. The thread picker offers AWS only
   when the host reports nothing blocking a send.
2. **Conversation.** `POST /api/projects/:id/threads/:threadId/messages` goes to `InteractionTurns`
   (`server/interaction-service.ts`). The host's `resolve` in `server/app.ts` picks the conversation
   route with `selectedEngine`. It accepts only Claude Code or a model-API route (CD-01 Decision 5)
   and names the route on the resolved message. The driver is chosen by run ID: `model-…` runs belong
   to `ModelSessionRuns`, and every other run to the Claude session driver.
3. **Admission.** The route must be on, the saved account route and model must match the connection
   record, the key must be unexpired and the spend allowance must be above zero. Forged settings only
   cause a refusal, because the connection record and the sealed key are the authority. These checks
   govern sending a message. The conversation's child admission guarantees are separate: see the
   admission guard below.
4. **RunService.** Each conversation is a run. Each message is a child run
   (`…t<24 hex>`, capability `model-api-turn`), claimed before it steps. The conversation's turn step
   is a local orchestration step, so a known failure parks one message instead of wedging the
   lineage. Only the provider call itself is an external model step. It is egress-authorized at
   dispatch and again when its result is committed, against current settings.
5. **ModelAdapter.** `createAwsModelAdapter` implements `ModelAdapter.complete` with one exchange per
   step (`respondOnce` in `server/engines/aws-bedrock.ts`): reserve, send once, classify, settle.
6. **Registered tools.** `list_sources` and `read_source` (`server/harness/capabilities/conversation-sources.ts`)
   serve only the documents admitted for the message, through the existing `ToolRegistry` and the
   serial NativeAgent loop. No provider-hosted tool and no second SDK tool loop exist.
7. **Artifact writer.** An answer that proposes Work goes through CD-1 selection to Work on the
   `aws-bedrock` text route (`TextRouteRuntime`), then a Need, then the recorded writer.
   Deny writes nothing. Approve writes the exact approved text, attributed to
   `diomedes:recorded-writer` with the runtime-reported model.
8. **Evidence.** The message result carries the answer, the reported model and helper attribution.
   `verified` is true only when the provider reported the model. Run status is at
   `GET /api/projects/:id/model-sessions/:runId`, and a turn can be stopped at `…/interrupt`.
   Each paid call is listed in the AI setup card.

## Provider exchange

- The endpoint is `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses`, through an
  explicit `createOpenAI({ baseURL, apiKey, fetch }).responses(model)`. There is no bare model string,
  no gateway, no environment key and no fallback. The Luna Mantle base is not on this route.
- The request sets `store: false`, `include: ['reasoning.encrypted_content']`,
  `parallel_tool_calls: false` and a bounded `max_output_tokens`, and sends no `previous_response_id`.
  The developer instruction comes first (the SDK needs `forceReasoning` for the prefixed ID).
- The guarded fetch sends a Bearer key only. It refuses any other host, path, method or query, and it
  refuses redirects. It caps response bytes and enforces a per-call wall clock. A call is never
  retried.
- Only two outcomes are accepted: a complete answer, or exactly one direct function call to an
  offered tool. Refusals, incomplete output, several calls, non-direct, asynchronous or namespaced
  calls and unknown items are typed errors, and nothing takes effect.
- The provider transcript is private and durable (`server/harness/model-transcripts.ts`, at most
  1 MiB per run). It holds the call ID mapped to its canonical step and the encrypted reasoning that
  store:false continuation needs. A restart continues from it without resending.

## Credential and spend

- The key is sealed by Electron `safeStorage` (`desktop/main.mjs`, refusing the `basic_text`
  backend) through `server/connection-secrets.ts`. A server without protected storage answers the
  view and saves nothing. Settings and runs carry `aws-bedrock:aws-bedrock-1@r<revision>`. The
  account is recorded as declared, because a bearer key does not prove its account.
- Spend uses `server/spend-exposure.ts`. The cap starts at zero, so nothing is sent until the person
  approves a limit (at most $100, whole cents).
  - Every call reserves a ceiling before it is sent: the input bound comes from the request bytes,
    and output uses `max_output_tokens` at the highest rate.
  - A call settles from the usage AWS reports. If AWS answers and the cost cannot be recorded, the
    answer is not used.
  - A call is marked uncertain when it was sent and its outcome is unknown: stopped after sending,
    timed out, redirected, oversized or unreadable. An uncertain call is never released. A startup
    sweep turns pending calls into uncertain ones. The owner records the real cost or accepts the
    ceiling.
- The rate card is a list-price estimate for the Geo profile. It is not an invoice and not a
  statement about promotional credit.

## Hot files on this branch

At the integrator's request (Fable 68088), this branch carries the hot-file changes itself:

- patches 01 and 03 as they land on `7b063b6` (`server/app.ts`, `shared/types.ts`,
  `shared/engines.ts`, `shared/capabilities.ts`, `desktop/main.mjs`);
- patch 02, rewritten against the repair's `ConversationDriver` (`server/interaction-service.ts`).

The one `server/app.ts` conflict was in `createTask`/`startWork`. It is resolved by keeping the
repair's bodies and fencing on the driver that owns the source run (`conversationDriver(source.runId)`).
The integrator reviews that resolution when merging. The dependency pin (`ai` 7.0.107,
`@ai-sdk/openai` 4.0.71, lock closure and regenerated notices) came to this lane by handoff. The
per-owner patches remain under `deliverables/bedrock-integration-20260921/owner-patches/`.

## The conversation's admission guard

When an AWS conversation creates a task or starts Work, `server/app.ts` does two things:

1. It pre-checks with the owning driver's `assertLive`.
2. It commits inside `ModelSessionRuns.fenced`. That enters the repair's `RunService.fence` with the
   conversation's own run ID and checks the capability and project inside the callback. A settled
   run is refused there as `RUN_SETTLED`, before anything is committed.

Several guarantees sit above `ConversationDriver` and apply to both drivers:

- the current-Mode re-read, intersected with the saved restriction;
- the child-intent digests;
- the receipt-only selection replay;
- the outcome projection.

`record` joins identical concurrent saves into one write through `RunService.join`. `turnResult`
reads the interruption the turn saved, so a stopped message reads as interrupted on every later
read, including after a restart.

Codex's independent AWS review passes on this branch, 11 of 11. It is
`tests/aws-conversation-authority.review-20260921.test.ts`, the reviewer's file, unedited. It covers
AWS-R1 (ask and plan narrowing before Work), AWS-R2 (interruption polled before and after restart)
and AWS-R3 (receipt-only selection replay). Acceptance of the repair itself waits for its executing
reviewer's re-run.

## What the Console does not do yet

- **The Console cannot reach this conversation from this branch alone.** Here, as on `4e2c93c`, the
  composer posts to
  `/ask`, and a model-API route refuses `/ask` with a pointer to the conversation. The CD-1 client
  (`client/conversation-send.ts`, used by `DiomedesHome.tsx`) is on `feature/core-agent-bot` and its
  repair lanes, under CD-05 review. The candidate merges cleanly onto that line.
- **No conversation Stop, on any route.** Specification for the Console owner: while a message is
  in flight, show Stop. The recommended implementation is a route-agnostic
  `POST /api/projects/:id/threads/:threadId/messages/:commandId/interrupt` in the interaction
  service, which finds the message's run and calls that driver's `control(…, 'interrupt')`. The
  pending send then resolves with `interrupted: true`, and the Console never has to name a driver.
  Until it lands, journey step 8 has no UI.
- **Work follows the default route, not the thread.** CD-1 selection starts Work with no thread,
  so a person who picks AWS only in the thread picker gets AWS answers but Work on the default route.
  "Use AWS for new work" in the card is the precondition. Changing this is a CD-02h decision.
- **The home thread stays on Claude Code** (`26b33ff` refuses re-routing it). AWS reaches a
  project's conversation that follows the default route.
- **The Console does not show the tool call.** It appears in the run record.

## Verification

All results are local and deterministic. A fake `fetch` sits beneath the real installed SDK.
No AWS request was made and no credential was used.

On this branch (the `7b063b6` composition):

| Command | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run tests/aws-conversation-authority.review-20260921.test.ts` (heavy slot) | 11 passed |
| `npx vitest run tests/aws-model-adapter.test.ts tests/aws-conversation-seam.test.ts` | 16 passed |
| `npx vitest run` | 229 files, 4,359 passed, 1 failed, 1 skipped |

The one failure is `capability-record.test.ts`. After a repack of the shared object store, a pack
index search in `scripts/write-capability-record.ts` ran in the inverted direction. That is fixed
on the integration branch (`09e6929`, PR #34), which this branch does not carry. A mutation check
removed `RunService.join` from `record`, and the concurrent-save test then failed with "step already
in flight".

The lane's own results on `4e2c93c`, before composition:

| Command | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run tests/aws-bedrock-transport.test.ts` | 31 passed |
| `npx vitest run tests/aws-model-adapter.test.ts` | 7 passed |
| `npx vitest run tests/aws-conversation-seam.test.ts` (real `createApp` over HTTP) | 7 passed |
| `npx vitest run tests/aws-bedrock-view.test.ts` | 10 passed |
| `npx vitest run tests/spend-exposure.test.ts tests/model-transcripts.test.ts` | 32 passed |
| `npx vitest run` | 225 files, 4,316 passed, 1 skipped, exit 0 |
| `npx vite build` | exit 0 |
| `npx playwright test` (all 20 configured specs) | 126 passed, exit 0 |

The first full vitest run failed one test: `ai-setup-api` counted five setup cards, and there are now
six. The assertion now names the AWS card. The browser suite rewrote 40 tracked evidence PNGs. Copies
are in the deliverable, and the originals were restored.

Trial merges:

- Base plus `origin/main` `d4f5384` merges cleanly, and the candidate applies cleanly on the result.
- The candidate merges cleanly onto `feature/core-agent-bot`, `…-client-repair`, `…-client-review`
  and `…-pending-claim`. It conflicts with `…-project-conversation` in `server/app.ts`.
- On the merge with `feature/core-agent-bot`, `tsc` passes and 18 files / 340 tests pass (AWS,
  interaction, home conversation, Claude session and AI setup).

## Remaining gates to a packaged AWS proof

1. The executing reviewer re-runs the CD-01 repair. The integrator reviews this branch's
   `server/app.ts` resolution, merges it into `feature/core-agent-bot` (PR #29), and runs both
   reviewer files, the four gates and the full browser suite on the merged commit. CD-05's
   conversation client comes with that line.
2. The Console owner adds the conversation Stop above. CD-02h decides whether Work follows the
   thread's route.
3. Andrew separately approves the live action and its bound: the AWS account and a short-term
   Bedrock API key (entered only in the desktop card), model access to Luna in us-east-1, and an
   aggregate cap. He also confirms the rate card against the AWS page, and whether any promotional
   credit applies to this model.
4. On an isolated desktop build of the merged candidate, one real read-tool round trip: real SDK,
   real provider, reported model, settled usage.
5. Astra runs the packaged Windows journey: connect, a source-backed linen answer, a safe artifact
   proposal, denial, approval, usage, stop, and restart.

Until 4 and 5 pass, the prepared release wording ("AWS Luna was verified for the listed Diomedes
capabilities on this exact build.") is not earned.
