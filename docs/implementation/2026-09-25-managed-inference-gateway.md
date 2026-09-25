# Managed inference gateway: contract `nectovia-managed/1`

Status: frozen for implementation, 2026-09-25. Feature `bot-mode`, branch `feature/bot-mode`,
worktree `F:/Diomedes/diomedes-wt/bot-mode`. Base origin/main `844cf0c`.

## Why

Andrew, 2026-09-25: customers never connect AWS or any other provider. The company connects
the provider on the backend, and each customer gets managed inference plus a set credit amount
(Business: 1,000 credits = $100 a month, `MONTHLY_CREDIT_GRANTS`) controlled from the backend.
Model: GPT-6 Luna on Bedrock (`us.openai.gpt-6-luna`, US Geo CRIS, Responses API on
`bedrock-runtime`), chosen because it is cheap ($0.11 input / $0.011 cache read / $0.1375 cache
write / $0.55 output per million tokens, AWS model card checked 2026-09-25). Frontier models stay
out of the tier map.

Today the bot (Home and each project's Diomedes conversation) is provisioned on the local
`aws-bedrock` route, which needs a key pasted into the desktop's protected storage. No customer
has one, so every fresh install refuses every message. `server/accounts/agent-gate.ts` already
names the missing piece: "Per-call enforcement for Diomedes-funded routes belongs to the company
proxy, which sees every call." This document is that proxy's contract.

What already exists and is reused, not rebuilt:

| Concern | Owner in source |
| --- | --- |
| Identity, membership | `services/control-plane/src/account-service.ts` (`membership`, `signIn`) |
| Paid-Agent entitlement | `commercial.ts` `entitlementFromGrants`, `contract/contract.ts` `decideAgentAdmission`, `admitAgent` + `admissionRecordSchema` |
| Route registry, tier policy | `commercial.ts` `routeEntrySchema`, `tierPolicySchema`, `routingPolicy`; staff publish via `/ops/routing/publish` |
| Credits and holds | `funding.ts` `FundingService`: `openJob`, `reserve`, `markDispatched`, `settle`, `markUncertain`, `release`, `recoverAfterRestart` |
| Pricing and usage | `shared/managed-usage.ts` `RateSnapshot`, `usageCost`, `validateProviderUsage`; `shared/job-caps.ts` `inputTokenBound`, `approvedJobCap` |
| Desktop model calls | `server/engines/model-api-core.ts` `RouteBinding`, `respondStream`; `server/engines/aws-bedrock.ts` `awsBinding` |

## 1. Endpoint

`POST {accountService}/managed/v1/responses`

An OpenAI Responses-compatible streaming endpoint, so the desktop reuses `@ai-sdk/openai`'s
`responses()` model exactly as the AWS binding does, with a different base URL and credential.
The gateway is not a general proxy: it forwards only the allowlisted body below, only to the
endpoint the resolved route names, only with the company credential that route names.

### Request headers (all required unless marked)

| Header | Value | Checked against |
| --- | --- | --- |
| `Authorization` | `Bearer <account session token>` | `accounts.membership(token, org)` |
| `X-Nectovia-Organization` | organization id | membership; must own the admission |
| `X-Nectovia-Admission` | id returned by `POST /account/organizations/:id/agent-admissions` | stored `AdmissionRecord`: same org, same person, `decision: 'admitted'`, `routeKind: 'managed'`, `at` no older than 15 minutes, and `rootJobId` equal to the job header when the record names one |
| `X-Nectovia-Job` | root job id (the desktop's run id), `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | `funding.openJob` (idempotent) |
| `X-Nectovia-Attempt` | attempt id, unique per provider call, same pattern | `funding.reserve` (idempotent on identical inputs, 409 `attempt_conflict` otherwise) |
| `X-Nectovia-Parent-Attempt` | optional; a retry or child names its parent | `funding.reserve` |
| `X-Nectovia-Tier` | `efficient` \| `focused` \| `thorough` | current published policy |
| `X-Nectovia-Usage-Class` | `included-chat` \| `metered-work` \| `worker` \| `automation` | `isUsageClass` |
| `X-Nectovia-Policy-Revision` | the policy revision the client resolved the model from | must equal the current revision, else 409 `policy_changed` |

Entitlement is also re-decided on every call from the current grants (`entitlementFromGrants` +
`decideAgentAdmission`), so a revoked grant refuses the next call even inside an admission's
window. A stored admission is evidence of intent, never a bearer credential.

### Request body allowlist

Anything not listed is refused with 400 `unsupported_field` naming the field. Request bytes are
capped at 2,000,000 (413 `request_too_large`).

| Field | Rule |
| --- | --- |
| `model` | Must equal the resolved route's `model` for the header tier, else 409 `policy_changed`. |
| `input` | Array. Item types allowed: `message` (roles `developer`, `system`, `user`, `assistant`; content parts `input_text`, `output_text`, `input_image` with a `data:` URL only), `function_call`, `function_call_output`, `reasoning` (with `encrypted_content`). No `item_reference`, no file ids, no remote URLs. |
| `instructions` | Optional string. |
| `tools` | Optional array of at most 64 `{ type: 'function', name, description?, parameters, strict? }`, each at most 16 KB serialized. No built-in tools (web search, file search, computer use, MCP). |
| `tool_choice` | `auto`, `none`, `required` or `{ type: 'function', name }` naming a listed tool. |
| `parallel_tool_calls` | `false` or absent. |
| `reasoning` | `{ effort: 'low' \| 'medium' \| 'high', summary?: null }`. |
| `include` | Absent or exactly `['reasoning.encrypted_content']`. |
| `max_output_tokens` | Integer 1..`route.maxOutputTokens`; absent means the cap. The cap is our own product limit (16,000 for GPT-6 Luna), not a claim about the model's maximum. |
| `store` | `false` or absent; always sent as `false`. |
| `stream` | `true` or absent; always sent as `true`. |
| `text` | Optional `{ format: { type: 'text' } \| { type: 'json_schema', name, schema, strict? } }`. |

The allowlist must be checked against a body the real `@ai-sdk/openai` `responses()` model
produces with the AWS binding's `providerOptions` (see `awsBinding`). A field that SDK sends and
this table omits is a contract bug to raise, not a field to drop silently.

## 2. Order of checks (the gateway's admission order)

1. Parse headers. Bad or missing → 400 `invalid_header` (named).
2. `accounts.membership(token, org)` → 401 `sign_in_required` or 403 `not_a_member`.
3. Load the admission record → 403 `admission_invalid` (not found, wrong org/person/job, refused,
   not `managed`, or stale).
4. Re-decide entitlement from current grants → 403 `agent_not_included` with the contract's
   reason sentence.
5. Validate the body (section 1) → 400 / 413.
6. Resolve the route: current policy `tiers[tier]` → 409 `tier_unrouted` when null. The route
   entry must be `qualified`, and the provider registry (section 4) must have an endpoint, a
   rate card and a configured credential for `(provider, region, model)` → else 503
   `route_unavailable` (no provider detail in the message).
7. Input bound: `inputTokenBound(bodyBytes, inputItems)` above 272,000 → 413 `context_too_long`
   (v1 refuses long-context pricing rather than guessing it).
8. `funding.openJob({ rootJobId, runRef: rootJobId, parentRunRef: null, tier, capMicroUsd:
   approvedJobCap(tier) })`.
9. `funding.reserve({ kind: 'generation', route: entry.id, requestDigest: sha256(canonical
   body), rateSnapshot, maxMicroUsd, usageClass, ... })` where `maxMicroUsd` is the input bound
   priced at the input rate plus `max_output_tokens` at the output rate, rounded up. Refusals
   pass through as 402 with the funding code (`insufficient_allowance`, `cap_request_required`,
   `no_period`) and its reason sentence.
10. `funding.markDispatched`. Only after it commits is the provider called.
11. Call the provider (section 4) with the body, `model` replaced by `entry.model`,
    `store: false`, `stream: true`.

Every refusal before step 10 sends nothing to the provider and holds nothing.

## 3. Response and settlement

- **Provider 2xx:** stream the provider's SSE bytes to the client unchanged. Inject nothing into
  the stream (the SDK's parser owns it). Tap the events: the terminal `response.completed`,
  `response.incomplete` or `response.failed` carries `response.id` and `response.usage`.
  At the end of the stream, settle with `receiptRef = response.id` (or the provider request id
  when absent), `usage` normalized from `response.usage`, `raw` the usage object,
  `reconciledFrom: 'response'`. In the Worker, settlement runs under `ctx.waitUntil`.
- **Provider error before any byte, with a releasable status** (400, 401, 403, 404, 413, 422,
  429): `funding.release`. 429 → 429 `provider_busy` with `Retry-After` passed through.
  401/403/404 → 503 `route_unavailable` (never tell a customer our key failed). 400/413/422 → 400
  `provider_refused` with the provider's `error.message` truncated to 300 characters and scrubbed
  of the credential.
- **Anything else after dispatch** (network error, timeout, 5xx, the client disconnecting
  mid-stream, a stream that ends without a terminal event or usage): `funding.markUncertain` with
  the reason. The hold stays until provider reporting reconciles it. Never release, never retry.
- **Response headers:** `X-Nectovia-Attempt`, `X-Nectovia-Route` (entry id), `X-Nectovia-Model`
  (entry model), `X-Nectovia-Rate-Card` (version).
- **Error body** (every non-2xx): `{ "error": { "code": string, "message": string } }`, the
  message a plain sentence a customer can read.

`GET {accountService}/managed/v1/attempts/:attemptId` with the same `Authorization` and
`X-Nectovia-Organization` returns `{ attemptId, state, providerCostMicroUsd | null,
allowanceDebitMicroUsd | null, usage | null }` for that organization's attempt, 404 otherwise.

## 4. Provider registry (code, not staff input)

A reviewed code table in `services/control-plane/src/managed-providers.ts`, keyed by
`(provider, region, model)`. Staff choose which qualified route serves a tier; they cannot set a
price, an endpoint or a credential.

| provider | region | model | endpoint | rate card (µUSD / M: in, cache read, cache write, out) | max output | credential |
| --- | --- | --- | --- | --- | --- | --- |
| `aws-bedrock` | `us` | `us.openai.gpt-6-luna` | `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses` | `aws-bedrock-gpt-6-luna-us-2026-09-25.1`: 110,000 / 11,000 / 137,500 / 550,000 | 16,000 | Worker secret `BEDROCK_API_KEY` (a Bedrock long-term API key, sent as `Authorization: Bearer`) |

The credential is read from the Worker environment at call time and is never logged, returned,
stored in Postgres or put in an error. The faux cloud uses a scripted provider (below) unless the
owner sets `NECTOVIA_FAUX_BEDROCK_API_KEY` for a live test, which needs Andrew's separate spend
approval before it is ever set.

## 5. Faux cloud

- The faux cloud (`services/control-plane/src/faux/`) serves the same handler.
- Its default provider is a scripted Responses SSE stream: a short answer, a `function_call` when
  the request offers tools and the last input item is a user message containing
  `[[tool:<name>]]`, and exact usage numbers, so desktop tests can drive the full loop offline.
- The seed marks `aws-luna-6` qualified with evidence
  `Faux seed: scripted provider, 2026-09-25`, and publishes all three tiers to it. Reasoning
  effort differs by tier on the desktop (efficient low, focused medium, thorough high); the route
  does not.

## 6. Desktop side (owned by the bot-mode lane)

- A new conversation route, `nectovia`, shown as "Nectovia". It is a model-API route on the
  desktop (it runs through `ModelSessionRuns` and `respondStream`) but it is **not** a provider:
  the control plane's `routeEntrySchema.provider` enum must never accept it.
- Its `RouteBinding` points `@ai-sdk/openai` at `{accountService}/managed/v1`, and the guarded
  transport attaches the session bearer and the headers above. No provider credential exists on
  the desktop for this route.
- `CONVERSATION_DEFAULT_ROUTE` becomes `nectovia`. The tier's model comes from
  `GET /account/routing-policy`, not local Settings.
- The desktop's `SpendExposure` stays a local, non-authoritative guard. The gateway's funding
  ledger is the authority.
- Refusals are shown in the conversation in plain words: signed out → sign in; no plan → the
  plan sentence; out of credit → the allowance sentence; `route_unavailable` → "Nectovia's model
  service is not available right now."

## 7. Tests the gateway lane must include

Provider-spy tests (the spy counts provider calls):
- Free organization, Harbor Hardware (no grant), a revoked grant, a wrong-org admission, a stale
  admission and a refused admission: 0 provider calls, 0 holds.
- Every unsupported body field, a remote image URL, a built-in tool and `store: true`: 400 and 0
  provider calls.
- Entitled Business: one call, the body the provider receives has `model` replaced and
  `store: false`; the stream reaches the client byte-for-byte; the attempt settles at exactly
  `usageCost(rate, usage)`; the organization's usage projection drops by that amount.
- Idempotent attempt replay (same attempt id and body) makes no second provider call.
- 429 before dispatch releases; a stream cut after dispatch leaves the attempt `uncertain`; a
  provider 401 surfaces as 503 `route_unavailable` with no credential text anywhere in the body.
- Out of credit: 402 with the funding reason, 0 provider calls.
- The credential string never appears in any response body, header, log line or stored row
  (canary test).
