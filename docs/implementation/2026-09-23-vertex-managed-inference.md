# Google Vertex AI + Gemini 3.8 Flash: first managed model route (2026-09-23)

Status: **implemented and fixture-tested; not live-proven, not merged, not released.**
Nothing was sent to Google, no Google Cloud resource was created, and no billing was changed.

Three milestones, never interchangeable:

- **Owner-live proof** (Andrew's own project and ADC, Andrew pays): code ready on
  `feature/vertex-owner-setup`; not run. Runbook: `docs/runbooks/vertex-owner-live.md`.
- **Customer-managed inference** (a server-held company credential, customer credits): not ready.
  The hosted execution boundary does not exist; see
  `docs/implementation/2026-09-23-vertex-customer-backend-design.md`.
- **Packaged release**: not built, not run.

## Base and ancestry

Checked 2026-09-23 after `git fetch`: `origin/main` = `1da6917` (PR #38 merged; contains `475fb11`).

```
origin/main 1da6917
  └─ feature/nectovia-wave2 a34b66d   (LOCAL, integrator-owned; contains 74da363 credits lane,
       │                               provider-setup cards and credits-usage UI; not on main)
       └─ feature/vertex-owner-setup  (LOCAL, this lane; the candidate)
            1613512  route            (cherry-pick of 9042bbd)
            8973cd1  funded seam      (cherry-pick of bd76143)
            bcd67f4  review fixes     (cherry-pick of 45b9cf8)
            43d65fa  gross card, promotion/credits/raw usage apart, team carriage
            790fa25  owner setup card (unmounted: AISetup.tsx is held; the integrator mounts it)
            4f71a7c  runbook, backend design, corrected record, team sentence
```

Candidate: `feature/vertex-owner-setup-usage1`, the same six commits rebased onto
`9a33c0d` (nectovia-usage/1, on `fe58141` job caps, on a34b66d, all on the local
feature/nectovia-job-caps branch), plus the commit that adopts the contract.
`feature/vertex-owner-setup` stays as the pre-contract stack.

- `feature/vertex-managed-inference` (`9042bbd`, `bd76143`, `45b9cf8` on `74da363`) is the
  original lane and is superseded by the stack above. Do not land both.
- Not in main: `74da363`, anything on wave2, and every commit above.
- Dependency order for the integrator: wave2 (with its tier-routing, job-caps and thread-build
  lanes), then this branch rebased onto it. `nectovia-usage/1` (`9a33c0d`, feature/nectovia-job-caps)
  lands with wave2; the usage1 candidate already consumes it.
- PR #37 (draft) and PR #35 (commercial contract, documentation) are open and not required by this
  branch.

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

## Rate card and the five cost figures

Read 2026-09-23 from https://cloud.google.com/vertex-ai/generative-ai/pricing (Gemini 3.8 Flash,
Global, Standard; ≤200K and >200K columns equal; non-global is 10% more and unused).

Google's page shows $0.75 / $0.075 / $3.75 through 2026-12-31, but its footnote says the
promotional pricing is "provided through 50% credits back on net spend". So the invoice line is
at the standard rate, and the credit is applied afterwards on net spend. Net spend is after other
credits, so the promotion is expected not to stack with Free Trial spend.

| Card | Applies | Input | Cached input | Output (answer + thinking) |
| --- | --- | --- | --- | --- |
| `google-vertex:gemini-3.8-flash:global:standard:gross-2026.1` | from 2026-09-23; evidence good until 2027-02-01 | $1.50 | $0.15 | $7.50 per 1M |

- The card applies to every date: it is the conservative provider-cost bound. A date past
  `verifiedUntil` is refused as stale evidence until someone re-reads Google's page.
- `VERTEX_EXPECTED_PROMOTION` records the credit-back apart from the card: 50%, through
  2026-12-31, status `expected-unconfirmed`, stacking `unknown`. It is displayed and never
  subtracted from a hold, a settlement or a debit.
- The owner view (`VertexConnectionView.accounting`) keeps five figures apart:
  - the gross estimate (settled, standard rate) and the unresolved estimate (pending plus uncertain);
  - the expected promotion;
  - confirmed credits (only the Cloud Billing account knows);
  - customer debit (0 on the owner route, where the owner's project pays);
  - the invoice (Google's).
- Usage is normalized once:
  - input = `promptTokenCount` + `toolUsePromptTokenCount`;
  - cache read = `cachedContentTokenCount`, a subset of input;
  - cache write = 0;
  - output = `candidatesTokenCount + thoughtsTokenCount`;
  - reasoning = `thoughtsTokenCount`, a subset of output.

  A `totalTokenCount` that does not add up is refused, not repaired. The raw `usageMetadata` is
  kept beside the normalization (`ClassifiedEnvelope.rawUsage`, `RespondResult.rawUsage`).
  `tests/vertex-usage-normalization.test.ts` proves cached input and reasoning are counted once
  (960 micro-USD at the page's intro figures, 1,920 at the gross card, for 1,000 prompt / 800
  cached / 150 candidates / 50 thoughts).
- The funded settlement stores the `nectovia-usage/1` record with the raw `usageMetadata` as `raw`
  (`tests/vertex-managed-funding.test.ts`). The local owner ledger stores the counts only.
  `fundedUsage` is gone: both ledgers read the same totals.

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
  nothing), `PUT .../spend-limit`, hold reconcile / write-off.
- Client: `client/VertexSetup.tsx` (`GoogleVertexSetup`) plus the pure `client/vertex-setup-view.ts`.
  The card shows:
  - the ADC source and whether it still matches;
  - the billed project, model and location;
  - the price card and its staleness;
  - the spend limit;
  - the last answered call;
  - each hold (with cached-input counts);
  - the five cost figures;
  - the next action.

  It shows no secret and has no default-engine button: the tier map owns routing, and Focused
  maps to `google-vertex`.
- Deliverable level: **app-UI-supported once mounted.** `client/AISetup.tsx` is held by a
  2026-09-21 claim (`claim_mub0roly_521e3a96`, SDKR-CONN-02.F01), so the routing integrator adds
  the one-line mount when integrating. Until then the route is developer-configurable over the
  HTTP API only.
- `server/app.ts` is claimed by the security-hardening lane, so the route's record and transcripts
  are attached in `mountProviderRoutes` when absent.

## Owner live proof (needs Andrew)

Not run. Follow `docs/runbooks/vertex-owner-live.md`, which covers:
- project, billing, API, ADC and quota project, completed before connecting;
- connection and the spend-limit approval;
- the exact-response, streaming/Stop, synthetic file read and proposal steps;
- the payer and usage check, including uncertain holds.

## Tests

| File | What it proves |
| --- | --- |
| `tests/google-vertex-model-api.test.ts` (36) | route identity, binding, real SDK request shape, ambient keys ignored, tool round trip with thought signature, prose not a tool, multiple/unoffered calls refused, destination refusals, ADC missing/changed, gross card and staleness, promotion kept apart, finish reasons, malformed/incomplete/blocked, model mismatch, usage arithmetic, 401/403/404/429/503, timeout, Stop |
| `tests/google-vertex-conversation.test.ts` (10) | setup over HTTP (no secret in views, detection grants nothing, nothing sent), native NativeAgent+RunService conversation with read_source, attribution and spend, Ask cannot write, Work offers no tools, Work proposal as text, ADC change, reconnect generation, cross-route account, no spend room |
| `tests/vertex-managed-funding.test.ts` (10) | real `FundingService` (memory repository): reserve/settle with cache pricing, parent-job children, job cap, concurrent jobs vs the month, entitlement missing, revocation before dispatch, 429 at zero, Stop uncertain across restart, crash after dispatch commit, BYO/local/personal payer |
| `tests/managed-client-bundle.test.ts` (3) | client imports no Vertex/Google auth, no Google key or token tracked, connection schema holds no secret field |
| `tests/vertex-usage-normalization.test.ts` (7) | one normalization; cached input and reasoning counted once (960 at page-intro figures, 1,920 gross); tool-use prompt; missing/malformed usage unknown or refused; raw usageMetadata kept beside the counts |
| `tests/vertex-setup-view.test.ts` (6) | the card's state rows, connect body and consent, five cost figures, no credential contents |
| `tests/vertex-setup-ui.spec.ts` (3, Playwright) | the card in Settings › Engines against served host views: exact connect body, consent, payer and cost figures, host refusal shown, blocked states, no fingerprint on screen. Needs the AI setup mount |

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
- Browser: the Vertex card spec and the full Playwright suite were run on a verification copy of
  the candidate with the two-line AI setup mount the integrator will add. Vertex streaming, Stop
  and route errors are proven by fixture transports server-side, not in a browser against Google.
- Base note: PR #38 (`475fb11`) merged into `main` while this work ran, so relative to `main` this
  branch now carries the credits lane's `74da363` plus its own commits.

## AWS GPT-6 Luna (owner correction, 2026-09-23): qualification pending

Correction: an earlier version of this record said Bedrock offers no GPT-6 Luna. That was wrong.
AWS announced GPT-6 Sol and GPT-6 Luna generally available on Amazon Bedrock on 2026-09-22
(https://aws.amazon.com/about-aws/whats-new/2026/09/openai-gpt-6-sol-luna-on-amazon-bedrock/).

What was not yet published where it could be read on 2026-09-23:
- Bedrock's model-card index lists GPT-6 Astra only. Its URL for a GPT-6 Luna card redirects to
  the index.
- The pricing page's GPT-6 Luna tab links to the docs only.
- The public price-list files contain no frontier OpenAI SKUs.

So the exact model id or inference profile, API (bedrock-runtime vs mantle), regions, usage
schema and prices are unqualified.

- The AWS route keeps `us.openai.gpt-5.6-luna`. No explicit pin is migrated and no payer changes.
- `server/engines/aws-bedrock.ts` belongs to the routing lane, which sets the id once Andrew's
  account confirms it. The lane's Efficient tier defaults to the existing Luna constant, and
  Thorough (GPT-6 Sol) refuses until an owner-set id exists.
- Owner qualification is read-only and costs nothing:
  `aws bedrock list-foundation-models --by-provider openai --region us-east-1`,
  `aws bedrock list-inference-profiles --region us-east-1` (and `us-west-2`), plus the
  Bedrock console's model access page and price table. Send the output to the routing lane.
