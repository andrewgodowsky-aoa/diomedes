# Gateway route checks: Operations runs the five route checks through the Worker, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | Gateway route checks (DIO-217), and field-named route refusals (DIO-198 item 3) |
| Branch | `feature/gateway-route-checks` |
| Worktree | `F:/Diomedes/diomedes-wt/gateway-route-checks` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), against the frozen contract `shared/gateway-route-checks.ts` (2a8096d) |
| Base | b1d6037 (the route checks lane, DIO-214) plus 2a8096d |

## What it does

`POST /ops/routes/:id/checks`, staff with `routes.write` only, runs the five route checks on one saved
managed route through `callManagedProvider`, the call customer requests take, with the Worker's own
company key for that route's approved connection. It answers `RouteChecksResult`: the receipt, whether
it qualifies the route, the evidence sentence, and the run's bound, spent and uncertain micro-USD. It
writes one `route.checked` row to the Operations audit log and nothing else. The person reads the
receipt and saves the route's evidence themselves, as today.

It covers Amazon Bedrock and Azure OpenAI routes on the Responses and Chat Completions protocols: Kimi
K3 on `aws-bedrock-us-east-1` (Chat Completions) and the `azure-foundry-dev` deployments (Responses or
Chat Completions). Anything else refuses with 422 `protocol_unsupported`.

## The calls

The plan is the app's own (`shared/route-qualification-plan.ts`, a copy of the constants in
`server/engines/route-qualification.ts`, held byte for byte equal by `tests/route-qualification-plan.test.ts`
until the two lanes dedupe it). Each call is a gateway `ResponsesBody`: `instructions`, `input`, the
`lookup_fact` tool where planned, `max_output_tokens`, and `reasoning: { effort: 'low' }` only when the
binding says the model reasons. The gateway's own encoder turns it into the provider's request, and its
own normalizer turns the answer into a Responses stream, which the runner reads with `sseObjects` and
`responsesUsage`, the usage reading settlement uses.

| Check | Calls | Passes when |
| --- | --- | --- |
| short-answer | 1 | a complete answer with the word OK and usage |
| output-bound | 1, at 64 tokens | billed output, reasoning included, stays at or under 64 |
| tool-round-trip | 2 | the model calls `lookup_fact` once, then answers from its result |
| cache-default | 2, the same long instructions | both complete; the cache verdict is recorded |
| cache-off | 0 | never: `unsupported`, "The gateway sends no cache setting, so this route cannot make a no-cache request." |

Every call carries the scope key `ops:route-checks` (`ROUTE_CHECKS_SCOPE_KEY`). The continuation codec
admits exactly that key beside account scopes, so a checkpoint sealed by a check never opens under a
customer's scope, or the reverse. Redirects are never followed (`redirect: 'manual'`); a redirect on the
first check stops the run.

A first check refused on the key (401 or 403), answered with a server error or a redirect, or with no
answer at all ends the run; the other checks are recorded as not run.

## The receipt

The identity is the gateway connection: `route` is the connection's provider, `connectionId` and
`connectionRevision` are the approved connection's, `endpoint` is the URL the gateway calls, `deployment`
is the Azure deployment (null on Bedrock), `model` is the route's model, `servedModels` come from the
completed answers, `protocol` is `openai-responses` or `openai-chat-completions`, `sdk` is `nectovia-gateway
callManagedProvider`, `effort` is `low` and `rateCard` is the route's price version. The id is `rq_` and 24
lowercase hex characters, and the receipt is valid for 30 days. It parses with
`routeQualificationReceiptSchema`, and `qualifies` is `receiptQualifies` for that identity at the time of
the run. A provider message is kept only after the key is scrubbed from it, and it is bounded.

## Spend

- **Bound.** Each planned call is bounded with the gateway's own estimate (`estimateRouteCost` on the
  route's price, with the larger of the gateway body's and the provider request's input bound, and
  `max_output_tokens` at the dearer of the output and reasoning prices), at least 1 micro-USD. The tool
  answer is bounded with room for the model's call, and a model call larger than that room is not sent.
  A price record with no input or output price refuses with 422 `price_missing`.
- **Cost.** A call with reported usage is priced with `usageCost`, the cost settlements use. A refusal
  the gateway releases for customers (400, 401, 403, 404, 413, 422, 429) costs nothing. Any other sent
  call without usage, a redirect, a server error, a broken stream or a timeout included, is uncertain at
  its bound.
- **Preflight.** On the Worker login: company spend (the funding ceiling's own query), plus every earlier
  run's spent and uncertain amounts from the `route.checked` audit rows, plus this run's bound. When the
  total would pass `MANAGED_SPEND_CEILING_MICRO_USD` the run refuses with 409 `company_ceiling` before
  anything is sent. With no ceiling set there is nothing to check against, and the run goes ahead.
- **Not counted elsewhere.** Customer calls' own ceiling check does not count route check spend,
  because the funding login cannot read the audit log.
- **Concurrency.** There is no lock. Two runs at once can both pass the preflight, so together they can
  pass the ceiling by at most one run's bound.

`MANAGED_MAX_OUTPUT_TOKENS` does not lower the checks' fixed limits (512 and 64): the checks send what
the plan says, so a customer clamp below 512 is not exercised by them.

## Refusals

| Status | Code | When |
| --- | --- | --- |
| 403 | `forbidden` | not a staff key, or no `routes.write` |
| 404 | `unknown_route` | no saved route has this id |
| 409 | `route_changed` | the saved revision is not `baseRevision` |
| 409 | `company_ceiling` | the preflight above |
| 422 | `route_not_checkable` | retired, no binding, the connection is not approved or is on another revision, the binding breaks a connection rule, or a planned call cannot be sent |
| 422 | `protocol_unsupported` | not Bedrock or Azure OpenAI, or not Responses or Chat Completions |
| 422 | `price_missing` | no input or output price |
| 503 | `credential_unavailable` | the connection's Worker secret is unset or unusable |

An unreadable ceiling setting answers 503 with no code, as every other unreadable spend setting does.
If the audit row cannot be written after calls were sent, the Worker logs one JSON line with the route,
the receipt id and the spend, never the key, and answers 500 naming the receipt.

## The audit row

One `ops_audit` row per run: action `route.checked`, target kind `route`, target the route id, no
organization, reason the evidence sentence (`Route checks <receipt id>, audit <audit id>, <YYYY-MM-DD>.`),
and detail `{ receipt, routeRevision, boundMicroUsd, spentMicroUsd, uncertainMicroUsd }`. No migration:
`AUDIT_ACTIONS` gains `route.checked`, and the Worker login already has INSERT and SELECT on `ops_audit`.

## The faux cloud

When the faux cloud is given no connections of its own, it approves the two deployed connections
(`src/faux/route-checks.ts`, held equal to `wrangler.jsonc` by a test) and seeds `aws-kimi-k3` and
`azure-sol-6-1`, unqualified, with no access, privacy or qualification evidence, so no tier resolves to
either. A scripted provider answers their checks offline in each route's own protocol: Bedrock Chat
Completions chunks for K3 and an Azure Responses stream for Sol, with usage, one tool call, an answer
bounded at its limit, and cache read tokens on the second identical long request. It refuses a request
without the key, any other path, and any request that would follow a redirect.

## In workerd

`npm run test:runtime` (`scripts/runtime-smoke.mjs`) now also starts `tests/runtime/route-checks-worker.ts`:
the Worker's own handler with memory stand-ins for the staff sign-in, the route registry and the audit
log, made again for every request, and the Worker's own transport (`workerFetch`, the global fetch
called as a plain function). Every provider call leaves through workerd's global fetch and reaches the
smoke's outbound handler, which answers offline as Bedrock would for K3. One run must make six calls,
pass every check it can and write one audit row; a second run answered with a redirect must make one
call and never follow it.

## How Andrew runs it

1. Approve and deploy the Worker with this change. Set `MANAGED_SPEND_CEILING_MICRO_USD` first: without
   it the run has no ceiling to check against.
2. Save the route in Operations with its binding and price record, unqualified (for K3: connection
   `aws-bedrock-us-east-1` revision 1, Chat Completions; for Sol: `azure-foundry-dev`, deployment
   `gpt-6.1-sol`, Responses).
3. Press Run checks on the route, which sends `POST /ops/routes/<id>/checks` with the revision on screen.
4. Read the receipt. If it qualifies, save the route's access, health and qualification evidence with
   the evidence sentence, and choose its tiers and quality floor yourself.

The first run is the first K3 call on AWS and the first Sol call on Azure through the gateway.

## What is not claimed

- No live provider call was made in this lane. Every test uses scripted transports.
- It is not shown that Bedrock accepts `reasoning_effort` with K3 over Chat Completions, or that Azure
  accepts every field the gateway sends. A 400 on the first check points at the request shape.
- A passing receipt is evidence about the calls that run made, with its prompts, on that day.
- The cache verdicts are observations, not guarantees, and the no-cache request is never made.

## Related changes in this lane

- Bedrock's Chat Completions body no longer carries `store` (Bedrock documents no such field); every
  other connection's body keeps `store: false`.
- The continuation codec admits `ops:route-checks` beside account scopes, and nothing else new.

## Field-named route refusals (DIO-198 item 3)

Every refusal of `POST /ops/routes` now carries `fields` beside `error` (and `code` where one exists),
so the Operations app can mark each field. Statuses are unchanged.

- Paths are relative to the request body, joined with dots, array members by index:
  `binding.price.inputMicroUsdPerMillion`, `binding.privacy.ingressCountries.0`, `id`.
- A body the schema refuses gets one plain sentence per failing field, five at most, then a count of
  the rest: "binding.price.evidence is required.", "binding.price.validUntil must be after
  binding.price.observedAt.", "extra is not a field a route accepts." `fields` lists every one.
- Rules that span fields name the field to change: a price that expires before it was observed is
  `binding.price.validUntil`; a repeated long context threshold is `binding.price.longContext`; a
  protocol the connection does not allow is `binding.protocol`; a profile it does not list is `model`;
  an unknown or disabled connection is `binding.connectionId`; another connection revision is
  `binding.connectionRevision`; an Azure deployment it does not list is `binding.deployment`; an
  identity change without fresh evidence names the stale block (`binding.privacy`,
  `binding.qualification` or `binding.access`); qualified without evidence is `evidence`; removing a
  binding is `binding`.
- A 409 for a route that still serves a tier names what the save changed: `status`, `provider` or `model`.
- A refusal about no field (403, 409 route changed, 415, an unreadable body) carries `fields: []`.
- The binding rules' sentences come from `bindingProblems` in `shared/routing-policy.ts`. A test holds
  the field table to every sentence there, so a new rule fails it until it names its field.
- Other endpoints' refusals are unchanged and carry no `fields`.
