# Managed inference gateway: contract `nectovia-managed/1`

Status: frozen for implementation, 2026-09-25; revision 2 the same day (the owner's rulings on
the gateway lane's findings, listed at the end). Feature `bot-mode`, branch `feature/bot-mode`,
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
| Credits and holds | `funding.ts` `FundingService`: `openJob`, `allocatePeriod`, `reserve`, `markDispatched` (exclusive), `settle`, `markUncertain`, `release`, `releaseRefused`, `recoverAfterRestart` |
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
| `input` | Array. Item types allowed: `message` (with or without an explicit `type: 'message'`; roles `developer`, `system`, `user`, `assistant`; an assistant message may carry `phase`, text of at most 32 characters; content parts `input_text`, `output_text`, `input_image` with a `data:` URL only and an optional `detail` of `low`, `high` or `auto`), `function_call` (`call_id`, `name`, `arguments` only: no `async`, `namespace` or `caller`), `function_call_output`, `reasoning` (with `encrypted_content`; `id` and `summary` optional). No `item_reference`, no file ids, no remote URLs, no `prompt_cache_breakpoint` anywhere (v1 does not price explicit caching). |
| `instructions` | Optional string. |
| `tools` | Optional array of at most 64 `{ type: 'function', name, description?, parameters, strict? }`, each at most 16 KB serialized. No built-in tools (web search, file search, computer use, MCP). |
| `tool_choice` | `auto`, `none`, `required` or `{ type: 'function', name }` naming a listed tool. |
| `parallel_tool_calls` | `false` or absent. |
| `reasoning` | `{ effort: 'low' \| 'medium' \| 'high', summary?: null }`. |
| `include` | Absent or exactly `['reasoning.encrypted_content']`. |
| `max_output_tokens` | Integer 1..`route.maxOutputTokens`; absent means the cap. The cap is our own product limit (16,000 for GPT-6 Luna), not a claim about the model's maximum. Above the route cap is 400 `invalid_body`. When `MANAGED_MAX_OUTPUT_TOKENS` (section 4) lowers the cap, a request between it and the route cap is clamped to it silently, absent means it, and the response names it in `X-Nectovia-Max-Output`. The value forwarded is the value the hold is priced at. |
| `store` | `false` or absent; always sent as `false`. |
| `stream` | `true` or absent; always sent as `true`. |
| `text` | Optional `{ format: { type: 'text' } \| { type: 'json_schema', name, schema, strict?, description? } }`, `description` text of at most 1,000 characters. |

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
6. Read the owner's spend settings (section 4); an unreadable value → 503 `route_unavailable`.
   Resolve the route: current policy `tiers[tier]` → 409 `tier_unrouted` when null. The route
   entry must be `qualified`, and the provider registry (section 4) must have an endpoint, a
   rate card and a configured credential for `(provider, region, model)` → else 503
   `route_unavailable` (no provider detail in the message). A policy revision or model that
   differs from the current one → 409 `policy_changed`.
7. Input bound: `inputTokenBound(bodyBytes, inputItems)` above 272,000 → 413 `context_too_long`
   (v1 refuses long-context pricing rather than guessing it).
8. `funding.openJob({ rootJobId, runRef: rootJobId, parentRunRef: null, tier, capMicroUsd:
   approvedJobCap(tier) })`. If the month has no credit period yet, allocate it now
   (`funding.allocatePeriod`, idempotent) from the current active grant that includes managed
   inference on a plan with a published monthly grant, the one ending last. A revoked or expired
   grant never reaches this step. The credit period's `sourceGrantId` and `allocatedAt` are the
   record of the allocation; no audit row is written, because the audit schema has no system
   actor and is not widened for this.
9. `funding.reserve({ kind: 'generation', route: entry.id, requestDigest: sha256(canonical
   body), rateSnapshot, maxMicroUsd, usageClass, companyCeilingMicroUsd, ... })` where
   `maxMicroUsd` is the input bound priced at the highest input-side rate on the rate card
   (the greatest of fresh input, cache write and cache read: 137,500 for GPT-6 Luna) plus
   `max_output_tokens` at the output rate, rounded up, so no mix of cache use can cost more than
   the hold. Refusals pass through as 402 with the funding code (`insufficient_allowance`,
   `cap_request_required`, `no_period`) and its reason sentence. A hold that would pass the
   company spend ceiling (section 4) → 503 `route_unavailable`, "Nectovia’s model service isn’t
   available right now. Nothing was charged.", with no ceiling detail. An identical reservation
   that already exists: while it is pending and dispatched → 409 `attempt_in_flight`; once it has
   finished → 409 `attempt_replayed` naming the attempt read below; a different body under the
   same id → 409 `attempt_conflict`.
10. `funding.markDispatched`, exclusive. One conditional update moves the attempt from pending
    with no dispatch time, and only the caller whose update moved exactly one row calls the
    provider. Any other caller for the attempt, in any isolate, gets 409 `attempt_in_flight`
    ("That request is already being answered.") and sends nothing.
11. Call the provider (section 4) with the body, `model` replaced by `entry.model`,
    `store: false`, `stream: true`, and `max_output_tokens` set to the value the hold was priced
    at.

Every refusal before step 10 sends nothing to the provider and holds nothing.

## 3. Response and settlement

- **Provider 2xx:** stream the provider's SSE bytes to the client unchanged. Inject nothing into
  the stream (the SDK's parser owns it). Tap the events: the terminal `response.completed`,
  `response.incomplete` or `response.failed` carries `response.id` and `response.usage`.
  At the end of the stream, settle with `receiptRef = response.id` (or the provider request id
  when absent), `usage` normalized from `response.usage`, `raw` the usage object,
  `reconciledFrom: 'response'`. In the Worker, settlement runs under `ctx.waitUntil`.
- **Provider error before any byte, with a releasable status** (400, 401, 403, 404, 413, 422,
  429), when the gateway received nothing beyond the error body:
  `funding.releaseRefused({ providerStatus, providerRequestId })`. It releases the dispatched hold
  and records the status and the provider's request id (`x-amzn-requestid`, else `x-request-id`,
  else "not given") on the attempt as the evidence, in its `uncertain_reason` column, the
  attempt's one free-text field (`writeOff` records its evidence there too). It refuses any other
  status (422 `release_not_allowed`); a plain `release` still refuses a dispatched hold. If
  `releaseRefused` fails, the hold is parked uncertain. 429 → 429 `provider_busy` with
  `Retry-After` passed through. 401/403/404 → 503 `route_unavailable` (never tell a customer our
  key failed). 400/413/422 → 400 `provider_refused` with the provider's `error.message` truncated
  to 300 characters and scrubbed of the credential.
- **Anything else after dispatch** (network error, timeout, 5xx, the client disconnecting
  mid-stream, a stream that ends without a terminal event or usage): `funding.markUncertain` with
  the reason. The hold stays until provider reporting reconciles it. Never release, never retry.
- **Response headers:** `X-Nectovia-Attempt`, `X-Nectovia-Route` (entry id), `X-Nectovia-Model`
  (entry model), `X-Nectovia-Rate-Card` (version), and `X-Nectovia-Max-Output` (the output-token
  cap in force) whenever `MANAGED_MAX_OUTPUT_TOKENS` lowers the route's cap. Headers set once the
  route is resolved also ride on later refusals.
- **Error body** (every non-2xx): `{ "error": { "code": string, "message": string } }`, the
  message a plain sentence a customer can read.

### Error codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_header` | a required header is missing or malformed (named) |
| 400 | `unsupported_field` | a body field outside the allowlist (named) |
| 400 | `invalid_body` | a malformed body or value, or `max_output_tokens` above the route cap |
| 400 | `invalid_request` | a query string on a managed URL |
| 400 | `provider_refused` | the provider answered 400, 413 or 422 before any output |
| 401 | `sign_in_required` | the session ended |
| 402 | `insufficient_allowance`, `cap_request_required`, `no_period` | funding refusals |
| 403 | `not_a_member`, `admission_invalid`, `agent_not_included` | membership, admission, entitlement |
| 403 | `origin_refused` | a browser origin outside the allowed list |
| 404 | `not_found` | an unknown managed path |
| 404 | `unknown_attempt` | the attempt read found no attempt for this organization |
| 405 | `method_not_allowed` | the wrong method for a managed path, with `Allow` |
| 409 | `policy_changed`, `tier_unrouted` | routing moved or the tier is empty |
| 409 | `attempt_conflict` | the attempt id is used for a different hold |
| 409 | `attempt_in_flight` | the attempt is already being answered |
| 409 | `attempt_replayed` | the attempt was already sent and has finished |
| 413 | `request_too_large`, `context_too_long` | over 2,000,000 bytes, or an input bound over 272,000 |
| 429 | `provider_busy` | the provider answered 429 before any output |
| 503 | `route_unavailable` | no usable route or key, no readable funding login (`FUNDING_DATABASE_URL`, section 4), a provider 401/403/404, 5xx, network failure or timeout before any byte, an unreadable spend setting, or the company spend ceiling |
| 503 | `unavailable` | the account service itself failed, with `Retry-After: 5` |

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

### Owner spend settings

Two optional settings are read beside the credential at call time, from the Worker's
environment or, under the same names, the faux cloud's. Both are whole numbers. Unset or blank
is off. Any other value that is not a whole number in range refuses every managed call with
503 `route_unavailable`, sending and holding nothing, and logs the setting's name.

| Setting | Effect |
| --- | --- |
| `MANAGED_SPEND_CEILING_MICRO_USD` | The most the company's provider account may owe, across every tenant and organization, for all time: settled provider cost, plus every pending, uncertain or written-off hold at its full `maxMicroUsd`, plus the new call's hold. A call that would pass it is refused inside the reserving transaction, before any hold, with 503 `route_unavailable` and no ceiling detail. `0` refuses every call. `FundingService.reserve` takes a company-wide lock (last, after the organization lock) before it reads the total, so two concurrent calls cannot both slip under. Unset (production's default): no lock, no read, no ceiling. Staging runs with `100000000` ($100). |
| `MANAGED_MAX_OUTPUT_TOKENS` | Lowers the registry's per-route output cap, never raises it (section 1, `max_output_tokens`). Testing runs with `2000`. |

The ceiling counts the ledger of the service it runs in: the Worker's database, or the faux
cloud's own store. The two never share a total.

### The funding login (2026-09-26)

The gateway's funding rows (credit periods, funded jobs, holds, dispatch claims, settlements)
are read and written through the Worker secret `FUNDING_DATABASE_URL`, the login `cp_funding`,
never through `DATABASE_URL`'s `cp_runtime`, which may only read funding rows. Its grants are
`services/control-plane/scripts/funding-permissions.sql`: exactly the statements
`PostgresFundingRepository` runs on the gateway's paths, with column-level UPDATE on
`funded_jobs` and `funding_reservations`, and `tests/funding-permissions.test.ts` fails when the
two differ. The URL must name the same Neon endpoint and database as `DATABASE_URL`. Unset,
blank or unreadable, every managed call (both routes) answers 503 `route_unavailable` before
membership, any hold or any provider call, and logs `managed-funding-database-unavailable`.
The admission, grant and routing reads, the usage projection and every other route stay on
`DATABASE_URL`. The faux cloud has one store and no logins.

## 5. Faux cloud

- The faux cloud (`services/control-plane/src/faux/`) serves the same handler.
- Its default provider is a scripted Responses SSE stream: a short answer, a `function_call` when
  the request offers tools and the last input item is a user message containing
  `[[tool:<name>]]`, and exact usage numbers, so desktop tests can drive the full loop offline.
- The seed marks `aws-luna-6` qualified with evidence
  `Faux seed: scripted provider, 2026-09-25`, and publishes all three tiers to it. Reasoning
  effort differs by tier on the desktop (efficient low, focused medium, thorough high); the route
  does not.
- It reads the owner spend settings (section 4) from its environment under the Worker's names.
  With `NECTOVIA_FAUX_BEDROCK_API_KEY` set and `MANAGED_SPEND_CEILING_MICRO_USD` unset, blank or
  unreadable, it refuses to start, with an error naming both, because the live testing budget is
  a hard $100.

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
- 429 before any byte leaves the attempt `released` with the full credit restored; a 5xx before
  any byte leaves it `uncertain`; `releaseRefused` with a disallowed status refuses; a stream cut
  after dispatch leaves the attempt `uncertain`; a provider 401 surfaces as 503
  `route_unavailable` with no credential text anywhere in the body.
- Out of credit: 402 with the funding reason, 0 provider calls.
- The credential string never appears in any response body, header, log line or stored row
  (canary test).

Added in revision 2:
- Exclusive dispatch: two interleaved dispatchers on separate service instances sharing one
  store; exactly one sends, the other gets `attempt_in_flight`.
- Hold pricing: a call whose input is all cache writes settles within its hold.
- Company spend ceiling: a call exactly at the ceiling passes; the next is refused with 0
  provider calls; concurrent calls near the edge cannot both pass; an uncertain hold counts in
  full.
- Output cap override: a larger request is clamped, the hold is priced at the clamp, and
  `X-Nectovia-Max-Output` names it; the route cap is never raised.
- Allowlist clarifications, in the real-SDK capture where the SDK can produce them.
- The faux cloud refuses to start with a live key and no ceiling.

## Revision 2, 2026-09-25

The owner's rulings on the gateway lane's findings. Each is in the code and tests on
`feature/managed-inference-gateway`.

1. **Exclusive dispatch.** `markDispatched` is a conditional update (pending, no dispatch time,
   exactly one row). Any other caller for the attempt gets 409 `attempt_in_flight`, "That request
   is already being answered.", and sends nothing. Memory, faux and Postgres repositories
   implement it (`FundingTransaction.claimDispatch`). An already-dispatched pending attempt also
   answers `attempt_in_flight`; a finished one still answers `attempt_replayed`.
2. **Hold pricing.** The input bound is priced at `max(input, cacheWrite, cacheRead)`: 137,500
   µUSD per million for GPT-6 Luna, not 110,000.
3. **Releasing a refused hold.** New `FundingService.releaseRefused(ref & { providerStatus,
   providerRequestId | null })` releases a dispatched attempt only for 400, 401, 403, 404, 413,
   422 or 429 received before any output, recording the status and request id on the attempt.
   Every other failure after dispatch stays uncertain. This replaces `funding.release` in
   section 3, which refuses once a hold is dispatched.
4. **Allowlist clarifications.** Accepted: `phase` on assistant messages (text, at most 32
   characters), `detail` on `input_image` (`low`, `high`, `auto`), `description` on a
   `json_schema` format (at most 1,000 characters), and an explicit `type: 'message'` (already
   accepted in revision 1; the lane's earlier report listed it as refused in error). Still
   refused: `async`, `namespace` and `caller` on function calls, and `prompt_cache_breakpoint`.
5. **Company spend ceiling** (`MANAGED_SPEND_CEILING_MICRO_USD`, section 4): written-off holds
   count in full; an unreadable value fails closed, blank is unset, `0` refuses every call; the
   check runs after the replay check and the organization's own credit check. The customer sees
   503 `route_unavailable`, "Nectovia’s model service isn’t available right now. Nothing was
   charged." (curly apostrophes, as elsewhere).
6. **Output cap override** (`MANAGED_MAX_OUTPUT_TOKENS`, section 4) and the response header
   `X-Nectovia-Max-Output`, added to section 3. Requests above 16,000 are still 400
   `invalid_body`.
7. **Faux cloud**: separate ledger from the Worker's; refuses to start with a live key and no
   ceiling.
8. **Error codes** chosen where revision 1 was silent are listed in section 3: `invalid_body`,
   `invalid_request`, `origin_refused`, `method_not_allowed`, `not_found`, `unknown_attempt`,
   `attempt_in_flight`, `attempt_replayed`, `unavailable`, and 503 `route_unavailable` for a 5xx,
   network failure or timeout before any byte. `release_not_allowed` (422) is `releaseRefused`'s
   own refusal and never reaches a customer.
9. **Monthly credit** is allocated on the first call that needs it (section 2, step 8). The
   credit period's `sourceGrantId` and `allocatedAt` are its record; the audit schema is not
   widened.
10. **Not changed here:** `shared/job-caps.ts` pulls engine code into the Worker bundle through
    `inputTokenBound`; the coordinator moves `inputTokenBound` into a smaller shared module during
    integration.
