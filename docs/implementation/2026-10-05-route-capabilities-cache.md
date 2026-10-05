# Prompt caching: the owner's setting per route, and one capability record per route, model and protocol, 2026-10-05

| Field | Value |
| --- | --- |
| Feature | route-capabilities-cache: the owner's prompt caching setting for AWS Bedrock and Azure OpenAI, scoped cache keys, and capability records |
| Issue | DIO-215 |
| Branch | `feature/route-capabilities-cache` |
| Worktree | `F:/Diomedes/diomedes-wt/route-capabilities-cache` |
| Owner | Andrew |
| Builder | Claude (Opus 5.5), against the architect's frozen contract `shared/route-capabilities.ts` (committed unedited) |
| Base | `04954ab` on `feature/model-routes-integration`: origin/main `0104556`, route qualification `b1d6037`, local model connection `41d0981` |

## What it does

- The owner chooses, per route, one of three settings: Provider default, Off or Explicit prefix.
  Version 1 covers the two routes that have route checks, `aws-bedrock` and `azure-openai`.
- The setting lives in Settings services under `cachePolicyKey(route)` (`aws-bedrockCachePolicy`,
  `azure-openaiCachePolicy`) and is read with `readCachePolicy`. A route whose owner never chose
  reads as `provider-default`, so its requests do not change.
- Every AWS and Azure call reads the setting fresh when its adapter is built. A loop reads it again
  for every step, like the rest of the route.
- AI setup shows the control, what each model can do with where each fact comes from, and the
  newest route check's verdict on caching off. A turn's context record says which setting it was
  sent under and what was marked.

## What each setting sends

| Setting | Top-level fields | System text |
| --- | --- | --- |
| Provider default | none | unchanged |
| Off | `prompt_cache_options: {"mode":"explicit"}` | unchanged |
| Explicit prefix | `prompt_cache_key: "dio1-<40 hex digits>"`, `prompt_cache_options: {"mode":"explicit","ttl":"30m"}` | split in two, the first part carrying `prompt_cache_breakpoint: {"mode":"explicit"}` |

- Provider default adds nothing. Every request is byte for byte what the base commit sent, on AWS
  Luna (Responses), AWS Kimi K3 (Chat Completions) and Azure (Responses). The base bodies were
  captured at `04954ab` into `tests/fixtures/cache-base-bodies.json` before any cache code existed.
- Off adds the explicit mode alone: no key, so no routing hint, and no breakpoint, so no block is
  marked for caching.
- Explicit prefix sends the scoped key, the explicit mode with the 30-minute lifetime
  (`EXPLICIT_CACHE_TTL`), and exactly one breakpoint, on the first system part. The options go under
  the namespace the binding's SDK model reads (`cacheNamespace(route, protocol)`): `openai` on AWS
  for both protocols, `azure` on Azure.

Where the breakpoint lands in the serialized body, with the pinned SDK (ai 7.0.107,
@ai-sdk/openai 4.0.71, @ai-sdk/azure 4.0.75):

- AWS Kimi K3, Chat Completions: the first message is
  `{"role":"system","content":[{"type":"text","text":"<stable prefix>","prompt_cache_breakpoint":{"mode":"explicit"}}]}`
  and the rest follows as `{"role":"system","content":"<rest>"}`.
- AWS Luna and Azure, Responses: the first input item is
  `{"role":"developer","content":[{"type":"input_text","text":"<stable prefix>","prompt_cache_breakpoint":{"mode":"explicit"}}]}`
  and the rest follows as a second item with the same role. An Azure deployment without reasoning
  gets role `system` instead of `developer`, as it did before.

The stable prefix comes from `server/harness/model-session-run.ts`, which already computed
`stablePrefix(lineage, variable)`; it now passes `system.prefix` through the adapter seam to
`respondStream`. Only conversation turns have one. Every other path (a Work turn, a generate call,
a loop step) passes null, and an explicit prefix then marks the whole instructions as one part
(`marked: 'whole-instructions'`): reuse holds only while the whole text is unchanged. With a stable
prefix, the newlines between the prefix and the rest are dropped by `systemParts`, so the model
reads two system messages where it read one string.

## The cache key

- `dio1-` and the first 40 hex digits of sha-256 over the canonical JSON (sorted keys) of the
  `CacheKeyScope`: tenant, route, connection id, connection revision and model
  (`cacheKey`, `server/engines/route-cache.ts`). It is made only there, only for an explicit prefix,
  and no response carries a key or its scope.
- Tenant: when accounts are on and someone is signed in, the organization's tenant for a project
  that belongs to an organization, otherwise the signed-in person's id. With no one signed in, or no
  account routing, it is `local` (`cacheTenant` in `server/app.ts`).
- Any reconnect bumps the connection revision, so a new key, account or model gets a new cache key.
- A scope with an empty part or a revision below 1 is refused rather than shared.

## Refusals

Each is a `ModelApiError` with `dispatched: false`:

- Before anything is held, `<prefix>_cache_refused` (`aws_cache_refused`, `azure_cache_refused`):
  - "The cache key for this call could not be made." The scope is incomplete, or the key fails
    `CACHE_KEY_PATTERN`.
  - "This call’s cache setting is not one Diomedes can send." The request is not one of the three
    shapes `cacheRequest` makes.
  - "The <route> route has no cache setting other than the provider’s default." A binding with no
    cache namespace was given Off or Explicit prefix.
- In the guard, after the SDK serialized the body and before it leaves, the same code with "The
  request’s cache fields differ from the cache setting this call was given." The hold is released.
  `cacheFieldsMatch` (`server/engines/model-api-core.ts`) finds every `prompt_cache_key`,
  `prompt_cache_options` and `prompt_cache_breakpoint` wherever it sits in the body:
  - Provider default: none of the three anywhere.
  - Off: exactly one `prompt_cache_options`, at the top level, equal to `{ mode: 'explicit' }`; no key
    and no breakpoint.
  - Explicit prefix: the derived key and `{ mode: 'explicit', ttl: '30m' }` at the top level, and
    exactly one breakpoint, at `messages[0].content[0]` or `input[0].content[0]`, whose message is a
    system or developer message.

The SDK drops cache options and breakpoints under the wrong namespace without a word. The guard
check refuses that too, because the body then lacks what the call asked for.

## Route checks keep their bytes

The runner (`server/engines/route-qualification.ts`) now sends every check through the same cache
request type. The cache-off check sends `CHECK_CACHE_OFF = cacheRequest({ policy: 'off' })`, so its
cache fields are exactly an ordinary Off call's. A receipt verifies Off only for the shape it sent,
and a test holds the two equal. The other checks send Provider default, with the guard refusing any
cache field. The checks ignore the owner's setting: they test fixed shapes.

## Capability records

- One `capabilityRecord` per identity: the AWS connection's model, and each Azure deployment.
- Declared facts live in `shared/declared-capabilities.ts`, for Kimi K3 on the direct AWS route
  only, each with the source "AWS Bedrock model card for Kimi K3,
  https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html, read
  2026-10-05": context 1,000,000 tokens, client-side tool calling, structured outputs, image input,
  explicit prompt caching, and a minimum of 1,024 tokens per cache checkpoint. The page does not
  state an output limit, parallel tool calls or reasoning, so those read as not known. Luna and every
  Azure deployment declare nothing.
- The newest receipt for the connection and model (`RouteQualifications.latest`) overlays the
  declared facts only while it qualifies that exact identity now: route, connection, revision,
  model, protocol, rate card and deployment, inside its 30 days. It contributes tool support,
  reasoning (when any call reported reasoning tokens), and the two cache verdicts.
- `MODEL_CONTEXT_WINDOWS` (`shared/context-accounting.ts`) gains K3's window with the same source,
  so the context ring and the turn's context record show it.
- The optional owner-declared window for an Azure deployment is not built.

## Owner API

Mounted from `mountModelApiRoutes` (`server/engines/route-cache-routes.ts`), guarded like the
connection and spend-limit routes: the client header every write needs, and the store lock.

- `GET` and `PUT /api/ai/model-api/aws-bedrock/cache-policy`, and the same for `azure-openai`.
  `PUT` takes `{ policy }` and nothing else; anything else is a 400 ("Choose the provider’s default,
  off or an explicit prefix."). Both return `RouteCachePolicyView`: the setting, whether the owner
  chose it, and per model its capability record and the turn note the setting would give. The
  setting belongs to the route, so it can be chosen before a connection exists.
- `GET /api/ai/model-api/aws-bedrock/capabilities` and
  `GET /api/ai/model-api/azure-openai/capabilities?model=<logical model>` return one record. Azure
  needs the model (400 "Name the Azure model to read.") and refuses one that is not a deployment
  (409 `azure_unknown_model`).
- A whole Settings save (`PUT /api/settings`) never changes the stored setting: a client that echoes
  an old value, or leaves it out, keeps what is stored.

## The run record

- `ContextAccount.cache` gains `policy`, `offVerified` and `marked`, and on AWS and Azure turns its
  note is `cacheAccount`'s sentence. Older records without these fields still read; all three are
  optional.
- When the marked part (the tool definitions plus the marked system text, by the existing
  estimator) is under the record's declared minimum for a cache checkpoint, the note adds: "The
  marked start is about N tokens, under this model’s minimum of 1,024 tokens for a cache checkpoint,
  so it is too short to be cached." Only K3 declares a minimum, so only K3 turns can say it.
- The turn's adapter reports what the setting marks when it is made, and again after each answered
  call with what the breakpoint actually marked.
- The adapter profile, which a saved continuation's digest covers, does not include the setting, so
  changing it never strands a continuation.

## In AI setup

A Prompt caching block on the AWS card, after Route checks, and on the Azure card, after the
deployments' Route checks (`client/PromptCaching.tsx`, words in `client/route-cache-view.ts`):

- The three settings, each with one sentence, saved through the route on choice.
- "Every call is sent with store set to false, so the provider keeps no response object. That is
  not the same as caching off."
- Per model, "What <model> can do": nine facts with their value and source. Declared carries the
  citation, Observed by a route check carries the receipt id and time, and Not known says why.
  Parallel tool calls and structured output also say what this build sends (`BUILD_REFUSALS`).
- The newest receipt's verdict on caching off and on the provider's default, and the turn note the
  current setting gives.

The Console's context view needed no change: its Cache row already shows `account.cache.note`.

## What is verified, and by what

All with fixture transports at the HTTPS boundary.

- `tests/route-cache-bodies.test.ts`: Provider default bodies against the base capture (with and
  without a stable prefix); Off and Explicit prefix bodies on all three bindings, each equal to the
  base once its cache fields are taken out and its system parts joined; the route check's Off equal
  to an ordinary Off call; every guard case; refusals before any hold; what each call reports it
  marked.
- `tests/route-capabilities.test.ts`: key derivation (each scope field changes the key, the
  pattern, no part in clear), `cacheRequest` and `systemParts` shapes, the capability overlay (a
  receipt for another revision, protocol or rate card, or an expired one, contributes nothing), K3's
  window, and the run record's cache fields and too-short note.
- `tests/route-cache-routes.test.ts`: the API guard, validation, a whole Settings save, records for
  K3 before and after a route check and for each Azure deployment, and conversation turns sent under
  each setting end to end, with the key and the marked prefix checked in the bytes.
- `tests/route-qualification.test.ts`: the namespace tests now go through the generalized
  `withCacheOptions`, and a cache request under the wrong namespace is refused with the hold
  released.
- `tests/prompt-caching.spec.ts` (Playwright, own host, built bundle): the AWS and Azure controls,
  facts and sources, a saved choice read back, a route check run from the card confirming Off, and
  the context view's cache note.

## What is not claimed

- No live provider call was made in this lane. Nothing reached AWS, Azure or any model.
- It is not shown that AWS (Luna or K3) or Azure accepts or honors `prompt_cache_key`,
  `prompt_cache_options` or `prompt_cache_breakpoint`. The breakpoint's place is verified only in the
  bytes the pinned SDK serializes.
- Whether K3 honors explicit mode with no breakpoint, which is what Off sends, is shown only by a
  live cache-off route check on the owner's connection. Until one passes, AI setup says caching off
  is not confirmed. The same holds for Luna and for each Azure deployment.
- It is not shown that a marked prefix above the minimum is cached and read back, or that the
  30-minute lifetime is kept. The cache-default route check observes only the provider's default.
- The too-short note uses Diomedes' estimator (UTF-8 bytes / 4), not the provider's tokenizer.
