# Google Vertex AI + Gemini 3.8 Flash: first managed model route (2026-09-23)

Status: **implemented and fixture-tested; not live-proven, not merged, not released.**
Nothing was sent to Google, no Google Cloud resource was created, and no billing was changed.

## Base

- Branch `feature/vertex-managed-inference`, worktree `F:/Diomedes/diomedes-wt/vertex-managed-inference`.
- Base `74da363` (`feature/nectovia-credits-usage`, the funded parent-job ledger), which sits on
  `475fb11` = PR #38 `feature/nectovia-routing` (the shared model-API core, Azure and OpenRouter).
  Neither is on `main` (`cf40cd6`). This branch must land after PR #38 and after the credits lane's
  commit, or be retargeted onto them; a PR against `main` would carry both.
- PR #35 (commercial contract) is documentation only and unmerged. Its cumulative-credit and
  parent-job direction is the owner's intent; the runtime here uses only what the credits lane
  implemented in source (`shared/managed-usage.ts`, `services/control-plane/src/funding.ts`).

## What the route is

`google-vertex` is a fourth `ModelApiRoute` beside `aws-bedrock`, `azure-openai` and `openrouter`.
It is a native Nectovia model route: NativeAgent owns the loop, RunService owns each step, the
registry owns tools, Trust owns authorization. It is not an external agent engine, so the
external-agent limitation warning does not apply to it (see "UI" below for where that warning
lives, or does not yet).

| Fact | Value |
| --- | --- |
| Provider | Google Cloud Vertex AI, `@ai-sdk/google-vertex` 5.0.90 (`@ai-sdk/google` 4.0.77, `google-auth-library` 10.9.1, `ai` 7.0.107) |
| Model | `gemini-3.8-flash` only; `modelVersion` reported by Vertex recorded as the reported model |
| Location | `global` (`aiplatform.googleapis.com`), Standard tier; Priority/Flex headers are stripped |
| Endpoint | `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, the only URL the credential may reach |
| Payer | the Google Cloud project in the URL, also sent as `x-goog-user-project` |
| Account route | `google-vertex:google-vertex-1:<project>@r<revision>` |
| Auth | Application Default Credentials from one exact file, fingerprinted at setup |

Refused before anything is sent: the Gemini API (AI Studio) host, Express Mode API keys (an
explicit empty key keeps the SDK out of Express Mode even with `GOOGLE_VERTEX_API_KEY` set),
partner models (`publishers/anthropic/...`), any other project, region, model or query string,
server-side Google tools (search, code execution, URL context), explicit caches, visible thinking,
multiple candidates.

### Authentication

- Founder / local proof: `gcloud auth application-default login` writes
  `%APPDATA%\gcloud\application_default_credentials.json` (or `~/.config/gcloud/...`);
  `GOOGLE_APPLICATION_CREDENTIALS` may name another file. Setup records the file's identity
  fingerprint (type, client id, principal, quota project, impersonation target; never a secret).
  Each turn mints a short-lived token from exactly that file with `GoogleAuth({ keyFilename })`;
  the metadata server is never consulted. A different file is a different credential and is
  refused until the owner connects again.
- The SDK never loads a credential: it is handed a placeholder auth client, and the guarded
  transport attaches the real bearer token only after the destination checks.
- Quota project: the request names the billed project in `x-goog-user-project`, so an ambient
  quota project in the ADC file cannot move billing. The signed-in user therefore needs
  `serviceusage.services.use` on that project (Owner or Editor has it). If the first live call
  answers 403 with a quota-project message, run
  `gcloud auth application-default set-quota-project <PROJECT_ID>` and connect again. Not yet
  observed live.
- Nothing logs or returns a token, refresh token, key or the ADC file's contents. The token is a
  secret for the scrubber on every error.

### Model adapter

`server/harness/vertex-model-adapter.ts` on the shared `createModelApiAdapter`. One provider
exchange per `complete`, `maxRetries: 0`, `stopWhen: stepCountIs(1)`, descriptor-only tools. The
profile digest binds saved context to route, project, location, model, payer, credential
fingerprint, revision, instructions, effort, limits and rate card, so an AWS continuation cannot
become a Google one and a Google continuation cannot cross a project, credential or price.

Tool calls: Gemini `functionCall` parts are read from Vertex's own bytes and cross-checked with the
SDK. When Gemini issues no call id, both sides use the same deterministic sequence
(`vtx-<digest>-<attempt>-<n>`, injected through `createVertex({ generateId })`); the function
response goes back by name, with Gemini 3's `thoughtSignature` preserved in the private
continuation. More than one call, an unoffered function, streamed partial arguments, or
`MALFORMED_FUNCTION_CALL` is refused and nothing is run. Printed tool-looking text is text.

Classification of the stream: `STOP` completed; `MAX_TOKENS` incomplete; `SAFETY`, `RECITATION`,
`BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `LANGUAGE`, `MODEL_ARMOR` or a
`promptFeedback.blockReason` are refusals; no finish reason or any other reason is not completed;
code execution, inline data or unknown parts are unexpected output; a different reported model is
refused. None of these is ever a success.

Failures: 401/403/404/409/413/422/429 and readable 5xx release the local hold, because Google
charges only for HTTP 200. A 429 is capacity, never "credit exhausted", and never moves provider
or payer. Timeout, Stop after sending, lost responses and missing usage stay **uncertain**; nothing
is replayed. Stop closes the HTTP read and does not claim Google stopped processing.

### Shared-core changes (additive; AWS/Azure/OpenRouter behaviour unchanged)

- `GuardedFetchOptions.expectedQuery` (default `''`, the previous behaviour).
- `CallExposure` (the four ledger methods respondStream uses) plus optional `beforeDispatch`,
  awaited after every request check and immediately before the bytes leave.
- `ConnectedRoute.credential` (`check`/`open`) and `ConnectedRoute.exposure`: keyed routes use
  protected storage and the local ledger exactly as before.

## Rate card

Read 2026-09-23 from https://cloud.google.com/vertex-ai/generative-ai/pricing (Gemini 3.8 Flash,
Global, Standard; ≤200K and >200K columns equal; non-global is 10% more and unused).

| Card | Applies | Input | Cached input | Output (answer + thinking) |
| --- | --- | --- | --- | --- |
| `google-vertex:gemini-3.8-flash:global:standard:intro-2026.1` | 2026-09-23 to 2027-01-01T00:00Z | $0.75 | $0.075 | $3.75 per 1M |
| `google-vertex:gemini-3.8-flash:global:standard:2027.1` | from 2027-01-01T00:00Z; evidence good until 2027-02-01 | $1.50 | $0.15 | $7.50 per 1M |

- The introductory card ends at midnight UTC, 8 hours before Google's Pacific-time end, so the
  last hours of 2026 are priced at the higher rate (overstates only).
- A call prepared under a card no longer in force is refused; a date past `verifiedUntil` is
  refused as stale evidence until someone re-reads Google's page. An expired promotional price is
  never carried forward.
- Usage mapping: input = `promptTokenCount` (+ `toolUsePromptTokenCount`), cache read =
  `cachedContentTokenCount` (a subset of the prompt), cache write = 0 (implicit caching has no
  write charge; no explicit cache is created; cache storage at $1/M token-hours therefore never
  arises), output = `candidatesTokenCount + thoughtsTokenCount`, reasoning = `thoughtsTokenCount`.
  A `totalTokenCount` that does not add up is refused, not repaired.

## Managed credits (the customer route)

`server/managed-funding.ts` `fundedExposure()` wraps the local ledger with the control plane's
`FundingService` for one parent job:

1. entitlement check (subscription, route, model, not revoked), else refused with nothing held;
2. local hold (company provider cap), then funded hold on the root job at the card's rate snapshot
   (the month first, then top-ups, under the organization lock);
3. immediately before dispatch: entitlement again (revocation between queue and send stops the
   send and releases both holds), then `markDispatched` committed;
4. settle funded first, then local, from Vertex's reported usage; the funded ledger receives fresh
   input only (it prices `inputTokens` beside the cache counts);
5. a readable provider refusal after dispatch settles the credit at zero (Google bills only 200);
   anything unknown stays uncertain and survives restart (`recoverAfterRestart`).

Every child call (worker, reviewer, advisor, correction, retry) names the same root job and
spends inside its cap. Provider gross cost (local ledger), credit debit (funded settlement) and
the customer invoice (not written here) stay separate. The Google welcome credit is not an input
to any of this.

**Not built (blocker for customer use):** the hosted execution boundary. `FundingService` runs in
the Cloudflare control-plane Worker and has no reserve/dispatch/settle HTTP API yet;
`google-auth-library` needs Node. A customer build must not hold a company Google credential, so
customer-managed Vertex calls need a server-side Node boundary that (a) authenticates the
organization through the control plane's WorkOS identity, (b) runs `fundedExposure` against the
control plane's `FundingService` over its PostgreSQL repository, (c) holds the Google credential
as keyless Workload Identity Federation or service-account impersonation (no JSON key), and
(d) streams the result back. `services.vertex.funding` is the seam it plugs into. No such
boundary was designed into a deployable service, deployed or authorized.

## Plans and entitlement

No plan number was changed. The grants in `shared/managed-usage.ts` are the credits lane's;
nothing is sellable (`sellable: false`). The $99 Solo / 250-credit figure and "Managed included
everyday chat" are not activated (`includedChat: null`). "Gemini 3.8 Flash is the first managed
model" is a provider-policy statement for this route only; no default engine or plan was switched.

## UI

- Server: `GET/PUT/DELETE /api/ai/model-api/google-vertex`, `POST .../test` (offline; sends
  nothing), `PUT .../spend-limit`, hold reconcile / write-off. `VertexConnectionView` shows project,
  location, model, payer, credential source and whether it still matches, rate card and staleness,
  last verified call, spend (settled/pending/uncertain/available) and the next action. Detection of
  gcloud credentials grants nothing.
- Not built here: the Settings card and the model-picker entry. Azure/OpenRouter setup cards and
  picker entries live on `feature/nectovia-provider-setup`, which is not in this base; the Vertex
  card belongs beside them. The Nectovia usage bar (`NectoviaUsage.tsx`) is being built,
  uncommitted, in the credits lane; its projection (`UsageProjection`) already separates granted,
  settled, pending, uncertain, available, top-up, reset time and observation time, which the
  funding tests assert. No "External Agent Mode" / "functions limited" warning exists in this base
  or in any committed or working-tree Nectovia lane (searched 2026-09-23). Whoever adds it must key
  it to external engines only; `isConversationRoute`/`isModelApiRoute` already classify
  `google-vertex` as a native model route.
- `server/app.ts` is claimed by the security-hardening lane, so the route's record and transcripts
  are attached in `mountProviderRoutes` when absent. The integrator can move that block into
  `app.ts` beside Azure and OpenRouter.

## Founder live proof (needs Andrew)

Not run: this machine has no `gcloud` and no ADC file. Steps, in order, each separately recorded:

1. Install the Google Cloud CLI; `gcloud init`; `gcloud config set project <PROJECT_ID>`;
   enable `aiplatform.googleapis.com`; confirm the project's billing account shows the Free Trial
   credit. `gcloud auth application-default login`.
2. In the desktop app: connect Google Vertex AI with `<PROJECT_ID>`, approve a small limit
   (for example $1), switch it on.
3. First request: `Reply with exactly DIOMEDES_VERTEX_OK.` Record HTTP status, `modelVersion`,
   `x-goog-request-id`, usage and the settled hold.
4. A native conversation over a synthetic project file (read_source round trip).
5. One Work proposal through the existing writer and Trust approval.
6. Next day: the project's Billing report for the Vertex AI SKU, and whether the Free Trial credit
   was applied. A successful request is not evidence that credit paid for it.

## Tests

| File | What it proves |
| --- | --- |
| `tests/google-vertex-model-api.test.ts` (35) | route identity, binding, real SDK request shape, ambient keys ignored, tool round trip with thought signature, prose not a tool, multiple/unoffered calls refused, destination refusals, ADC missing/changed, rate-card expiry and staleness, finish reasons, malformed/incomplete/blocked, model mismatch, usage arithmetic, 401/403/404/429/503, timeout, Stop |
| `tests/google-vertex-conversation.test.ts` (10) | setup over HTTP (no secret in views, detection grants nothing, nothing sent), native NativeAgent+RunService conversation with read_source, attribution and spend, Ask cannot write, Work offers no tools, Work proposal as text, ADC change, reconnect generation, cross-route account, no spend room |
| `tests/vertex-managed-funding.test.ts` (10) | real `FundingService` (memory repository): reserve/settle with cache pricing, parent-job children, job cap, concurrent jobs vs the month, entitlement missing, revocation before dispatch, 429 at zero, Stop uncertain across restart, crash after dispatch commit, BYO/local/personal payer |
| `tests/managed-client-bundle.test.ts` (3) | client imports no Vertex/Google auth, no Google key or token tracked, connection schema holds no secret field |

## Known unverified points and limits

- `VERTEX_API_VERSION` is `v1`; the SDK's default is `v1beta1`. Whether `v1` accepts
  `gemini-3.8-flash` with `thinkingConfig.thinkingLevel` is known only from the first live call. If
  it answers 400 or 404, that constant is the switch (and the tests' URL).
- The request-id headers (`x-goog-request-id`, `x-request-id`, `x-cloud-trace-context`) are
  guesses; `providerRequestId` may be null on live calls. `responseId` from the body is recorded
  either way.
- `FundingService.recoverAfterRestart` is not wired to any host start on this branch. It belongs
  to the unbuilt hosted boundary; the local ledger's own startup sweep still parks pending holds.
- `tests/managed-client-bundle.test.ts` is a source-level guard over `client/` and tracked files.
  The built `dist/` was also scanned once on 2026-09-23 (no Google auth code); the packaged
  desktop app was not built or inspected.
- An abort landing between the funded dispatch commit and the send settles the credit at zero with
  an `unsent_` receipt: nothing left, nothing is charged.
- `licenses/DEPENDENCIES.txt` records the lock hash of Windows working-copy bytes; an LF checkout
  computes a different hash. Nothing validates it.
- Browser (Playwright) suites were not run: no client file changed on this branch. The client
  build passes.
- Base note: PR #38 (`475fb11`) merged into `main` while this work ran, so relative to `main` this
  branch now carries the credits lane's `74da363` plus its own commits.

## AWS "Luna 6" (owner request, 2026-09-23): not changed

The owner asked to move the AWS route's model from GPT-5.6 Luna to Luna 6. Amazon Bedrock's model
cards (https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html, read 2026-09-23)
list GPT-6 only as `gpt-6-astra` (`us.openai.gpt-6-astra`, `global.openai.gpt-6-astra`); there is
no GPT-6 Luna card. `gpt-6-luna` exists on OpenAI's own API
(https://developers.openai.com/api/docs/pricing). Switching the Bedrock model id would make every
AWS call fail as model-not-found, so the AWS route still pins `us.openai.gpt-5.6-luna`.
