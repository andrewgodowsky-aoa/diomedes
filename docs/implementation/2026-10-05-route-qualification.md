# Route checks: Kimi K3 on the direct AWS route, qualified per connection, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | Route qualification: K3 over Chat Completions on the direct AWS route, and owner-run route checks for AWS and Azure |
| Branch | `feature/route-qualification` |
| Worktree | `F:/Diomedes/diomedes-wt/route-qualification` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), against the architect's frozen contract `shared/route-qualification.ts` |
| Base | origin/main at 6c697d1 |

## What it does

The direct AWS Bedrock route used to speak only Responses and refused Kimi K3 outright. Now:

- Each approved AWS model has one protocol (`AWS_MODEL_PROTOCOLS` in `shared/model-api.ts`). Luna
  goes over Responses as before. K3 goes over Chat Completions, at `<runtime base>/chat/completions`
  on the same Bedrock runtime, with the same Bearer key and request id headers.
- K3 sends only under a current route check receipt for that exact connection revision, model,
  protocol and rate card. Without one, every K3 path refuses with one sentence, before any spend is
  reserved: "Kimi K3 needs a passing route check on this connection before it sends. Run the route
  checks in AI setup."
- The owner can run the route checks from AI setup: up to eight small live requests through the
  route's own binding, key and spend limit, recorded as a receipt. The same runner checks an Azure
  deployment (for example GPT-6.1 Sol through Responses); there the receipt is evidence only.

## Why

K3's catalog row says nothing about whether this adapter's billed reasoning and output stay inside
the limit a request is sent with. A hold is reserved against that limit, so an unbounded answer
would bill past the hold. The route checks observe exactly that on the owner's own connection, and
the receipt binds the observation to the connection it was made on.

## The K3 request

`awsChatBinding` (`server/engines/aws-bedrock.ts`) builds the SDK's Chat Completions model on the
guarded transport. Its provider options, under `openai` (the only namespace the SDK's chat model
reads): `forceReasoning: true` (the Geo model id does not match the SDK's reasoning pattern;
forcing it sends the limit as `max_completion_tokens` and keeps `reasoning_effort`),
`systemMessageMode: 'system'`, `reasoningEffort`, `store: false`, and `parallelToolCalls: false`
only when the call offers a tool. The SDK sends that setting whenever it is set, and an
OpenAI-style Chat Completions endpoint can refuse it on a request that offers no tool.

The guard's body check (`inspectAwsChatBody`) refuses the request, with nothing sent, unless it
names the K3 model, streams with `stream_options.include_usage: true`, carries
`max_completion_tokens` as a positive integer equal to the call's output limit, and has no
`max_tokens`. Other fields pass, including the route checks' `prompt_cache_options`. The stream is
read by the Chat Completions reader shared with OpenRouter (`server/engines/chat-completions.ts`,
moved out of `openrouter.ts`, which re-exports it unchanged); OpenRouter's upstream and payer fields
are simply absent on AWS.

## The identity a receipt binds

`receiptQualifies` (the contract) compares seven fields: route, connection id, connection revision,
model, protocol, rate card version and deployment (null on AWS). On AWS the rate card compared is
the one the call is priced with, so a receipt never covers another price. Any reconnect bumps the
revision, so a new key, account or model needs a new run. A receipt is valid for 30 days.

Use is decided by three verdicts only: the first check got a complete answer, billed output stayed
inside the limit (`bounded`), and a tool round trip worked (`one-call`). The cache verdicts are
recorded and shown; they never decide use.

The gate reads the newest receipt for the connection and model. A failed run after a passing one
closes the gate again: the latest evidence governs.

## Where K3 is decided

One helper, `awsModelRefusal(connection, receipt, now, rateCard?)`, with the receipt from
`awsQualificationFor(store, connection)`, at every site:

- `server/engines/service.ts`, the AWS branch of `modelApiRoute`: refuses the handle, and passes the
  receipt to the adapter and the single exchange, which check it again per call.
- `server/engines/model-api-routes.ts`, the setup view's `next`. The spend limit sentence now comes
  before the K3 sentence, because the route checks cannot run without a spend limit.
- `server/agent-team-host.ts`, Team member admission.
- `respondOnce` and `createAwsModelAdapter` (`assertAwsModelQualified`), before any reservation.

No receipt store, or an unreadable one, reads as no receipt, so K3 stays refused.

K3's adapter profile includes the protocol, so its digest says which wire format a saved
continuation belongs to. Luna's profile is exactly what it was before protocols were named, so a
Luna step prepared by an earlier version still resumes after this one. K3's
contract (`awsModelContract`) names Chat Completions and streams no thinking (the SDK's chat model
emits none); `AWS_MODEL_CONTRACT` stays the route's registered one.

## The checks

Fixed prompts only, no person's content. Every call goes through `respondStream` with the route's
own binding and is held on the route's own ledger as run `qualify:<receipt id>`, step
`<check>:<n>`. Output limit 512 tokens per call, except the output bound's 64.

| Check | Calls | Passes when | Verdict |
| --- | --- | --- | --- |
| short-answer | 1 | a complete answer containing the word OK, with usage reported | `answers` |
| output-bound | 1, limit 64 | usage reported and billed output, reasoning included, is 64 or less (complete, or stopped at the limit) | `bounded`, `exceeded`, `unknown` |
| tool-round-trip | 2 | the model calls `lookup_fact` with exactly `{ key: "alpha" }`, then answers with the value `blue-42` from the tool result | `one-call`, `failed`, `unknown` |
| cache-default | 2 | both requests complete with usage | `caches` when the second read cache tokens, `no-cache-observed` when neither did |
| cache-off | 2 | neither request reads or writes cache tokens | `verified`, `not-verified`, `unsupported`, `unknown` |

The cache checks send the same stable prefix twice: 56 numbered neutral rules, about 6,100 bytes,
about 1,530 tokens by Diomedes' estimator (UTF-8 bytes / 4), well above the 1,024-token minimum
before providers cache, so a result with no cache cannot be blamed on a short prefix.

- cache-default sends no cache field at all: no key, no options, no breakpoint, exactly as an
  ordinary call goes out.
- cache-off sends only `promptCacheOptions: { mode: 'explicit' }`, with no key and no breakpoint,
  under the route's namespace: `openai` on AWS (Responses or Chat), `azure` on Azure. The SDK drops
  the option without a word under the wrong key, so a test asserts the serialized body carries
  `prompt_cache_options` under the right one and lacks it under the wrong one.

`unsupported` means a 4xx with a readable error body: the provider refused the request's shape. A
4xx with no readable body is a failure.

## Spend

- Before the first call, the run refuses with nothing sent when the spend limit has less room than
  every planned call's ceiling together. With today's K3 rate card a run holds at most $0.25; a
  Luna run about $0.02. The tool round trip's second call is planned with an allowance for the
  first call's answer, and is reserved on its real request.
- Each call is settled from the usage it reported, released when nothing was sent or a 4xx with a
  readable body came back, and uncertain when nobody knows. Cache writes are recorded on every
  call; the hold prices input at the dearest of input, cache write and cache read.
- If the first check fails on the key (401, 403), the network or a 5xx, the run stops and the rest
  are recorded as not run.
- Stop closes the request. The call in flight is cancelled through the exchange and its hold stays
  uncertain, for the owner to record or accept in the spend list; the checks after it are recorded
  as not run, and the partial receipt is kept.
- The receipt's spend is the settled total and the uncertain (or still pending) total.

## Owner API

Mounted from `mountModelApiRoutes` (`server/engines/route-qualification-routes.ts`):

- `POST /api/ai/model-api/aws-bedrock/qualify` `{ consent: true, effort? }`
- `GET /api/ai/model-api/aws-bedrock/qualification`
- `POST /api/ai/model-api/azure-openai/qualify` `{ consent: true, model, effort? }`
- `GET /api/ai/model-api/azure-openai/qualification?model=<logical model>`

Each returns a `RouteQualificationView`: the newest receipt for the connection and model, whether
it qualifies now and why not, whether the model needs one, why a run cannot start, the most a run
can hold, and whether one is running. Refusals are 409 with a code and a sentence, plus "Nothing
was sent." on a run: `qualify_no_storage`, `qualify_no_connection`, `qualify_key_expired`,
`qualify_running`, `qualify_no_limit`, `qualify_no_room`, `qualify_key_mismatch` and
`qualify_unknown_model` (Azure). A run takes no store lock (it can last minutes); one run at a time
per connection. No response carries a key, a prompt or answer text. A call's recorded error is the
route's own sentence, which can quote the provider's bounded error message.

Receipts live in `<data>/connections/qualifications/<route>.json`, at most 20 per route, newest
last, each validated by the contract's schema and written with `jsonWrite`. An unreadable file
reads as no receipt and is set aside under a new name on the next record, never overwritten. The
family is registered in `server/migrations/registry.ts`.

## In AI setup

A Route checks block on the AWS card, and one per deployment on the Azure card: what a run sends
and the most it can hold, the qualification sentence ("Kimi K3 can send on this connection." or the
contract's reason), the last run's time, served models and spend, one line per check with its
outcome and detail, and Run route checks (disabled with the host's reason) or Stop. The sentences
come from `client/aws-bedrock-view.ts`. The connect form keeps its K3 note: saving starts a new
revision, which no check covers yet.

## What is not claimed

- No live provider call was made in this lane. Every test uses fixture transports; nothing reached
  AWS or Azure.
- It is not shown that Bedrock serves K3 over Chat Completions for any account, or accepts
  `max_completion_tokens`, `reasoning_effort`, `store` or `prompt_cache_options` there. A 400 on the
  first check points at one of those. `parallel_tool_calls` is sent only beside a tool, so only the
  tool round trip shows whether Bedrock accepts it.
- It is not shown that an Azure deployment accepts `prompt_cache_options`.
- A passing receipt is evidence about the calls that run made, with its prompts, on that day. It does
  not prove every later call stays bounded, which is why it expires and is bound to the revision
  and the price.
- The cache verdicts are observations, not guarantees.
- `server/observability/sanitize.ts` lists only the Luna ids in its AWS model catalog; this lane does
  not change it.

## Tests

- `tests/aws-kimi-k3.test.ts`: the protocol map, the chat binding's serialized request and guard,
  the gate at `respondOnce`, the adapter, the setup view and a send through the app, each with no
  receipt, a qualifying one, and an expired, revision-bumped, re-priced, exceeded, unconfirmed,
  tool-failed, unanswered, wrong-protocol or wrong-connection one.
- `tests/route-qualification-team.test.ts`: Team admission of a K3 lead, before and after a receipt
  and after a reconnect.
- `tests/route-qualification.test.ts`: the runner end to end for AWS K3 over Chat Completions and an
  Azure deployment over Responses (all pass; output above the limit; a 400 on the no-cache option;
  cache writes under it; a 401 that stops the run; Stop in flight; no room; no limit), the prefix
  size, and the provider-options namespace for both protocols.
- `tests/route-qualification-routes.test.ts`: gating and refusal sentences, a passing and a failing
  K3 run, one run at a time, Stop by closing the request, and an Azure deployment.
- `tests/route-qualification-store.test.ts`, `tests/model-api-observe.test.ts` (the exchange's
  observer), `tests/chat-completions.test.ts`, and the new helpers in `tests/aws-bedrock-view.test.ts`.
