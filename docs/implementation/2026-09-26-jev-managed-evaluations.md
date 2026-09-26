# Typed evaluations on managed inference: `POST /managed/v1/evaluations`

Status: implemented on `feature/jev-managed-gateway` (worktree
`F:/Diomedes/diomedes-wt/jev-managed-gateway`), 2026-09-26. Part of contract `nectovia-managed/1`
(docs/implementation/2026-09-25-managed-inference-gateway.md): the same account service, the same
checks, the same credits and the same hold lifecycle as `POST /managed/v1/responses`. The desktop
and the phone apps read this note to call it.

## Why

Owner decisions: customers never connect an AI provider (2026-09-25), and the Jev preflight runs
through OpenRouter (2026-09-23) with the company's key. So a paid business's preflight has to be
paid and metered by the company's gateway, like its conversation. A business without included AI
usage is refused before anything is sent, and its conversation goes on exactly as it would without
a preflight.

## 1. Endpoint

`POST {accountService}/managed/v1/evaluations`. Any other method is 405 `method_not_allowed` with
`Allow: POST`; a query string is 400 `invalid_request`. The gateway sends the request to one
reviewed provider row (section 5) and nowhere else.

### Request headers

The job headers of a response, less the policy revision: the model is fixed by the provider row,
not resolved from the tier policy.

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <account session token>` |
| `X-Nectovia-Organization` | the business's organization id |
| `X-Nectovia-Admission` | an admission from `POST /account/organizations/:id/agent-admissions` with `routeKind: 'managed'`, no older than 15 minutes, pinned to the job below when it names one |
| `X-Nectovia-Job` | the root job id, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| `X-Nectovia-Attempt` | an attempt id unique to this call, same pattern |
| `X-Nectovia-Parent-Attempt` | optional: the attempt this one retries |
| `X-Nectovia-Tier` | `efficient` \| `focused` \| `thorough`: the job's tier, which sets its cap |
| `X-Nectovia-Usage-Class` | `included-chat` for a person's own conversation |

### Request body

Exactly what the desktop's `providerQuestions()` produces, nothing else:
`{ "state": ..., "questions": { "<id>": <question>, ... } }`. The check is
`checkEvaluationRequest` in `shared/evaluation-wire.ts`, which the desktop's adapter shares, so
both sides count one request the same way.

| Field | Rule |
| --- | --- |
| top level | only `state` and `questions`; anything else is 400 `unsupported_field`, named |
| `state` | text, a list or an object; JSON values only, nested at most 64 deep |
| `questions` | 1 to 32 questions (more is 413); ids of 1 to 120 characters |
| a question | only `type`, `instructions` and `criteria`; instructions of 1 to 4,000 characters |
| `choice` | `criteria` names 1 to 64 options (ids of 1 to 200 characters), each described in text or `null` |
| `score` | `criteria` lists 2 to 16 levels, lowest first, each described; an undescribed level is 400 `unsupported_field` |
| `boolean` | `criteria` absent, or `{ true, false }` with both described; one side alone is 400 `unsupported_field` |
| any other `type` | 400 `unsupported_field` |

Bounds, all 413 `request_too_large`: at most 524,288 bytes; a state of at most 32,000 tokens; a
whole request of at most 32,000 tokens (the route's published context); the state and its longest
question together at most 32,000 tokens. Tokens are estimated at three characters each, on
purpose high.

## 2. Order of checks

1. Headers → 400 `invalid_header`, named.
2. Membership → 401 `sign_in_required`, 403 `not_a_member`.
3. The stored admission → 403 `admission_invalid`.
4. The Agent, decided again from the current grants → 403 `agent_not_included`.
5. Included AI usage (`managed-inference`), decided again from the current grants → 403
   `agent_not_included`, "Included AI usage isn’t part of this business’s plan, so the Nectovia Agent
   can’t answer here. Nothing was charged." Steps 2 to 5 are one shared step for both managed routes
   (`admitted()` in `managed-inference.ts`), so a response and an evaluation refuse this the same way.
   (Integration, 2026-09-26: this lane's own code `managed_inference_not_included` was folded into
   `agent_not_included`, which the desktop and the phone apps already read on the response route.)
6. The body (section 1) → 400 or 413.
7. The provider key (`OPENROUTER_API_KEY`) and the owner's spend settings → 503
   `route_unavailable`.
8. The input bound, `inputTokenBound(bytes of the body as sent, questions)`, above 272,000 → 413.
9. The job (`openJob`, cap `approvedJobCap(tier)`), this month's credit (allocated on first use),
   and the hold (`reserve`, kind `advisor`, route `openrouter-jev-1.13`), with the company
   ceiling checked in the same transaction. Funding refusals pass through as 402
   (`insufficient_allowance`, `cap_request_required`, `no_period`); the ceiling is 503
   `route_unavailable`, "Nothing was charged." An attempt id already used is 409
   (`attempt_in_flight`, `attempt_replayed`, `attempt_conflict`).
10. `markDispatched`, exclusive: only the caller whose update moved the attempt sends it.
11. One call to the provider.

Every refusal before step 10 sends nothing and holds nothing, and carries no `X-Nectovia-Charge`.

## 3. Response

A 200 carries the answer in the shape `shared/evaluation.ts` validates:

```json
{
  "answers": {
    "needs-review": { "type": "boolean", "probability": 0.1 },
    "workload": { "type": "choice", "choice": "lookup", "probabilities": { "lookup": 1 } },
    "effort": { "type": "score", "score": 0, "probabilities": { "0": 1 } }
  },
  "usage": { "inputTokens": 125, "outputTokens": 3 },
  "rounding": { "probabilityDecimals": 2, "scoreDecimals": 2 },
  "warnings": [],
  "response": { "modelId": "typesafe/jev-1.13-20260917", "id": "gen-..." }
}
```

A yes-or-no answer is P(true). `modelId` and `id` appear only when the provider named them;
`modelId` is the dated snapshot that answered.

### Response headers

| Header | When | Value |
| --- | --- | --- |
| `X-Nectovia-Attempt` | always, when the request named a valid attempt | the attempt |
| `X-Nectovia-Model` | once the route is resolved | `typesafe/jev-1.13` |
| `X-Nectovia-Rate-Card` | once the route is resolved | `evaluation-price-2026-09-22.openrouter.1` |
| `X-Nectovia-Charge` | once the call was dispatched | `settled`, `uncertain` or `released` |
| `X-Nectovia-Charge-Micro-Usd` | with `settled` | what came off the business's credits |
| `X-Nectovia-Input-Tokens`, `X-Nectovia-Output-Tokens` | with `settled` | the usage it was priced from |

What a client reads from `X-Nectovia-Charge`:

- absent, with the gateway's error body: nothing was held or sent.
- `released`: the provider refused before any model answered; the hold was released and nothing
  was charged.
- `uncertain`: the call was sent and its cost is not known. The hold stays at its ceiling until it
  is reconciled; it is never zero. A 200 can carry it (the answer is usable, the cost is not yet
  known).
- `settled`: exact.

Every error body is `{ "error": { "code": string, "message": string } }`, the message a sentence
a customer can read.

### Error codes (evaluations)

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_header`, `unsupported_field`, `invalid_body`, `invalid_request` | as for responses, section 1 |
| 400 | `provider_refused` | the provider answered 400, 413 or 422 before any output (released) |
| 401 | `sign_in_required` | the session ended |
| 402 | `insufficient_allowance`, `cap_request_required`, `no_period` | funding refusals |
| 403 | `not_a_member`, `admission_invalid`, `agent_not_included` | membership, admission, the Agent or included AI usage |
| 405 | `method_not_allowed` | not a POST |
| 409 | `attempt_in_flight`, `attempt_replayed`, `attempt_conflict` | the attempt id was used |
| 413 | `request_too_large` | over a bound in section 1, or an input bound over 272,000 |
| 429 | `provider_busy` | the provider answered 429 (released), with `Retry-After` |
| 503 | `evaluation_provider_policy` | no provider meets the data policy (released), "No provider that meets Nectovia’s data policy can take this right now. Nothing was charged." |
| 503 | `route_unavailable` | no key, an unreadable spend setting, the company ceiling, a provider 401/403/404 (released), or anything after dispatch that left the cost unknown (uncertain) |
| 503 | `unavailable` | the account service itself failed |

## 4. Funding

The responses route's lifecycle, unchanged: reserve, `markDispatched` (exclusive), then settle,
mark uncertain, or release on a refusal the provider does not bill (400, 401, 403, 404, 413, 422,
429). Charge kind `advisor`; no new kind.

- **Hold:** the input bound (`inputTokenBound` over the body exactly as sent) at the dearest
  input-side rate, plus 64 output tokens a question at the output rate, rounded up once. At
  today's price the output side is nothing. `EVALUATION_OUTPUT_TOKENS_PER_QUESTION` lives in
  `shared/evaluation-wire.ts`, so the desktop's guard holds the same bound.
- **Settle:** from the usage the provider reported (`input_tokens`, `output_tokens`), priced
  under the row's rate by `usageCost`, against the provider's response id. The provider's own
  `usage.cost` is a check, not the price: a cost above the published price holds the charge as
  uncertain.
- **Uncertain, never zero,** when the usage is missing or incomplete, when another model
  answered (anything but the row's model or a dated snapshot of it), when the cost is above the
  price, when the answer cannot be read, on a network failure or timeout, and on any provider
  status not listed above.
- **Limits:** the company ceiling (`MANAGED_SPEND_CEILING_MICRO_USD`) applies inside the reserve.
  `MANAGED_MAX_OUTPUT_TOKENS` does not: the Decisions API takes no output cap, and output is
  held at 64 tokens a question and priced at nothing.

## 5. Provider

One reviewed row, `EVALUATION_PROVIDER` in `services/control-plane/src/managed-providers.ts`:
Jev 1.13 on OpenRouter's Decisions API, `POST https://openrouter.ai/api/alpha/decisions`, model
`typesafe/jev-1.13`, as OpenRouter listed it on 2026-09-26: one endpoint (TypeSafe), 32,000 tokens
of context, $0.000000042 a prompt token (42,000 micro-USD a million) and nothing a completion
token. The desktop prices the same model with `EVALUATION_PRICE_JEV_113_OPENROUTER`, and a test
holds the two equal.

- **What is sent:** `{ model, state, questions, provider: { data_collection: 'deny' } }`. A
  yes-or-no question goes as the Decisions API's `noul`. Nothing else is forwarded.
- **Private processing by default (Pillar 09):** every call denies data collection, so OpenRouter
  routes only to providers that do not collect data. `zdr` is never set: OpenRouter lists no
  zero-retention endpoint for this model, so a zero-retention-only request would find none.
- **Fail closed:** when OpenRouter answers 404 because no endpoint meets the data policy (its
  message says no allowed providers or endpoints, or names the data policy, or its
  `openrouter_metadata.attempt` is 0), the hold is released and the call is refused as 503
  `evaluation_provider_policy`. It is never sent to another model or provider.
- **The key:** the Worker secret `OPENROUTER_API_KEY`, read at call time and passed explicitly,
  never read from an ambient variable. One call, no retries, no redirects followed. Without a
  usable key this route alone answers 503 `route_unavailable`, and the Worker logs
  `{"event":"managed-configuration-unavailable","setting":"OPENROUTER_API_KEY","rule":"missing"}`
  (or `whitespace`, or `format`), never the value.

## 6. Faux cloud

The faux cloud serves this route with the Worker's own handler. A scripted Decisions provider
answers offline and deterministically (each choice its first option, each score its lowest
level, each yes-or-no question 0.1, under a dated snapshot, with the usage and cost the real API
reports). OpenRouter is called for real only when `NECTOVIA_FAUX_OPENROUTER_API_KEY` is set, which
needs the owner's spend approval; with that key set and no readable
`MANAGED_SPEND_CEILING_MICRO_USD`, the faux cloud refuses to start.

## 7. Desktop

`server/harness/evaluation-managed.ts`. A business conversation on the `nectovia` route asks its
preflight through this route; every other thread keeps the owner's own route, and neither stands
in for the other, so the payer never switches. A thread without its advisor gets no advice and
the deterministic resolution.

Each preflight is its own job, `preflight-<uuid>`: admitted through the Agent gate as managed
conversation work pinned to that job, then held on the Nectovia route's local guard for the
business's month (`ensureNectoviaGuard`) before anything leaves. The hold's id is the attempt id.
The session's `includes(organizationId, 'managed-inference')` is read first, so a plan without
included usage is refused without a round trip. The gateway's receipt is the preflight's charge:
the port releases the local hold when nothing was charged, and the advisor's charge sink settles
it (only when this computer prices the same usage at the same amount) or marks it uncertain.

How the gateway's answers reach the advice:

| Gateway | Advice | Charge | Local hold |
| --- | --- | --- | --- |
| 200, `settled` | `advised` | known, the gateway's amount | settled |
| 200, `uncertain` | `advised` | uncertain | uncertain |
| `released`, `evaluation_provider_policy` | `refused` | none | released |
| `released`, `provider_refused` | `refused` | none | released |
| `released`, otherwise | `unavailable` | none | released |
| no charge header, `not_a_member`, `agent_not_included` | `refused` | none | released |
| no charge header, `request_too_large` | `refused` | none | released |
| no charge header, anything else (sign-in, admission, credits, `route_unavailable`) | `unavailable` | none | released |
| no charge header, `attempt_in_flight` or `attempt_replayed` | `unavailable` | uncertain | uncertain |
| `uncertain` with an error, no answer, a network failure, an unnamed 5xx | `unavailable` | uncertain | uncertain |

The managed preflight is a launch-time authorization, like the owner's routes: off unless the host
is given `managedJev` or started with `DIOMEDES_MANAGED_JEV=1`, and only on a host with accounts.

## 8. Phone apps

Call it as the desktop does: sign in, ask for an admission with `routeKind: 'managed'` and a
`rootJobId` of your own, then send one evaluation under that job with a fresh attempt id. Never
send the same attempt id twice; a retry is a new attempt naming the old one in
`X-Nectovia-Parent-Attempt`. Read `X-Nectovia-Charge` as section 3 says, and show a refusal's
`message` as it is. Don't name the model or its provider to a customer.

## 9. Owner steps

1. Set the key: `npx wrangler secret put OPENROUTER_API_KEY --name diomedes`.
2. Cap the key's credit at $10 in OpenRouter for testing.
3. To try the preflight on a computer, start the desktop with `DIOMEDES_MANAGED_JEV=1`.

No live call has been made. Every test runs against the faux cloud and scripted providers.
