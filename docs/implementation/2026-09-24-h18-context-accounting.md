# H18: context accounting, selective retrieval, cache reuse and safe compaction

Version 2026-09-24.1. Lane `h18-context-accounting`, branch `feature/h18-context-accounting`,
Linear DIO-23.

- **Canonical documents read:** Core Pillars 2026-09-22.1, Live Roadmap 2026-09-23.1, Project Memory
  2026-09-23.1. H18 appears there only as an owner of "scoped context" (roadmap §4, memory §H-lanes);
  neither defines its acceptance, so the work order in the sprint brief is the scope used here.
- **Scope:** the Diomedes-owned model routes, where Diomedes assembles the context itself: the
  model-API conversation driver (`server/harness/model-session-run.ts`) on AWS, Azure, OpenRouter
  and Google Cloud. External engines (Codex, Claude Code, OpenCode, ACP routes) build and manage
  their own context; nothing here measures, changes or claims anything about theirs. The Claude
  native session keeps using `boundedHistory` exactly as before.

## What shipped

### 1. Context accounting (`shared/context-accounting.ts`, `server/harness/context-assembly.ts`)

Every answered model-API conversation turn records a `ContextAccount` on its `turn:` step output,
and the host projects it onto the thread's assistant turn (`Turn.context`). It holds:

- **Sections**, each with UTF-8 bytes and an estimate (`utf8-bytes/4`, rounded up; stated in the
  record and in the Console): instructions, answer format (the artifact format, the visual
  guidance and the decision format, wherever the lineage's text contains them), tool definitions,
  project files (the attachment list; bodies are read through tools), conversation history, the
  message, and tool results (what the loop sent back on later calls). The first six sum exactly to
  the first call's system text, tool descriptors and user message; a driver test proves the byte
  identity against what the adapter was actually given.
- **Provider usage** summed across the turn's model calls, from each model step's recorded usage,
  with cache reads and writes kept apart. Missing usage is unknown, never zero: `reportedCalls`
  says how many calls reported, and the reconciliation is null when the first call reported nothing.
- **Reconciliation** of the first call only (its context is exactly the estimated sections): the
  estimate, what the provider reported and the difference.
- **Window** from `modelContextWindow` — a registry that holds a window only where a declared source
  names it. No connection or rate card in this build declares one, so every shipped model reads
  "not declared". The route's own request ceiling (`CONVERSATION_LIMITS.maxRequestBytes`) is
  recorded beside it.

The shared model-API adapter now passes `cacheReadTokens` and `cacheWriteTokens` through to the
model step (`ModelResult.usage`, additive optional fields), so the record has something to read.

### 2. Selective retrieval (`selectHistory`)

Inside the existing bounds (12 messages, 24,000 characters) the history is byte-identical to
`boundedHistory`, and no selection is recorded. Past them:

1. The lineage's newest `RECENT_KEEP` (6) messages and its opening message are always kept.
2. The remaining slots go to this lineage's earlier messages ranked by lexical relevance to the new
   message (shared content words over the square root of the candidate's distinct words; a fixed
   stopword list; no dependency, no embeddings), then by recency.
3. Messages carried from a retired lineage fill what is left, newest first, and give way first —
   unchanged from the owner's rule that carried history is bounded and gives way.
4. A marker at the top of the history names every message left out by number, and says which were
   carried and not summarised.
5. If the kept messages alone still pass the character bound, the oldest part is cut exactly as
   before (`…`), so the newest message is never the one cut.

The selection (method, budget, each included message with its reason and score, each omitted one,
the marker, characters cut) is recorded on the turn's own run input as `history.selection`.

### 3. Cache reuse

- The system text is now built by `stablePrefix`: the lineage's recorded instructions and the tool
  note first, then the per-message read-scope note. The bytes sent are the same as before this
  change; what is new is that the prefix is named, hashed and recorded on every turn, with
  `sameAsPrevious` compared against the conversation's last answered turn. A driver test proves the
  prefix is byte-identical across four turns.
- Provider prompt caching, as this build actually wires it (`cacheSupport`):
  - **AWS (OpenAI Responses on Bedrock) and Azure OpenAI:** any reuse is the provider's own
    automatic prefix caching. Diomedes sends no cache directive and records the cached input tokens
    the provider reports (`input_tokens_details.cached_tokens`).
  - **Google Cloud (Vertex):** any reuse is Google's implicit caching; cached tokens are recorded
    from `cachedContentTokenCount`. Explicit context caching (`cachedContents`) is **not wired**.
  - **OpenRouter:** whether the upstream reuses a prefix depends on the model; no cache directive is
    sent. Recorded as `not-wired`.
  - No route in this build speaks Anthropic Messages or Bedrock Converse for conversations, so
    Anthropic `cache_control` / Bedrock `cachePoint` markers have nowhere to go. Recorded as a gap,
    not implemented.

### 4. Safe compaction (`compactTurns`)

When this lineage's own messages are left out, they are summarised into a `CompactionRecord`:

- **Deterministic**: the first sentence of each side, at most 160 characters each, at most 2,000
  characters in all, with a closing line counting any it could not list. Same turns, same record.
- **Attributed truthfully**: `author: 'diomedes-application'`, and the text says itself that no model
  wrote it (decision 8).
- **Evidence, not a rewrite**: stored on the turn's own run input (`history.compaction`) and in the
  turn's account; it names each message by run id, step id, position and the sha-256 of the prompt
  and of the answer. The conversation run's `turn:` steps are never touched (decision 10), and a test
  proves the run is byte-identical before and after selection.
- **Reversible for the person**: the Console opens the summary and names the messages it stands for,
  which are still in the thread above it.

### 5. Console: "Context used"

`client/console/ContextUsed.tsx`, under an assistant turn that carries an account: one mono line
(`Context used · ~6.7k estimated · 14k reported · 5.9k cached · 2 summarised`) that opens the
section rows, then facts (estimate, provider, first call, window, prefix, cache, left out) and a
"What was summarised" toggle. Same graphite panel and metadata type as the H11 instructions
inspector; the model name and prefix sha truncate or wrap where written (decision 5).

## Tests

- `tests/context-accounting.test.ts` (16): estimator and window; selection inside the budget equals
  `boundedHistory`; over the budget the newest, the opening and the relevant message stay; newest
  never dropped for relevance; carried messages give way unsummarised; character cut keeps the newest;
  relevance is deterministic; compaction record shape, determinism, bound and evidence retention;
  stable prefix identity across read scopes; per-route cache declaration; budget table sums;
  usage reconciliation with cache reads; missing usage stays unknown; prefix comparison.
- `tests/context-accounting-driver.test.ts` (4): through the real `RunService` and
  `ModelSessionRuns` with a scripted adapter — sections equal the bytes the adapter was given,
  usage reconciled, prefix byte-identical over four turns, selection and compaction recorded on the
  turn run with every original message intact, no-usage stays unknown.
- `tests/aws-conversation-seam.test.ts` (+1): the real host and the AWS Responses wire format — the
  thread's assistant turn carries the account, two reported calls, a tool call, no body and no secret.
- `tests/context-used.spec.ts` (3, Playwright): the line and panel, the summary toggle with the
  summarised messages still in the thread, and no horizontal overflow at 900 px.

## Known gaps

- No declared context windows: `MODEL_CONTEXT_WINDOWS` is empty until a connection or rate card
  declares one. The Console says "Not declared for <model>".
- Explicit provider caching (Vertex `cachedContents`, Anthropic/Converse cache points, OpenAI
  `prompt_cache_key`) is not wired; reuse is whatever the provider does automatically.
- The account is written only for an answered turn. A turn the person stopped, or one that failed,
  records none (its child run still holds every model step's usage).
- Model-API **Work** turns (`generateModelApi`, team Work) and the native Diomedes Agent are not
  accounted here; they do not use conversation history.
- The estimate counts tool descriptors as Diomedes' JSON, not the provider's wire schema, so it is
  an estimate of the right order, reconciled against the provider where one reports.
- Pinning is the lineage's opening message only; there is no person-facing "pin this message"
  control. Adding one is a product decision and was not taken.

## Decisions taken conservatively (for Andrew)

- Carried history keeps giving way first and is **not** summarised, because the existing owner rule
  (carried history is bounded and gives way) and its tests say so. Summarising it would be a new
  meaning for "Update this conversation".
- The history bounds themselves (12 / 24,000) are unchanged; H18 changes what fills them, not their
  size.

## Proposed canonical-doc patch

Not applied here (the sprint forbids editing the canonical documents); for the integrator.

**Live Roadmap, §4 (H-lanes), append to the H09/H18/H19/H20 sentence:**

> H18 slice 1 (2026-09-24, DIO-23) is implemented for the model-API conversation driver only:
> per-turn context accounting by section with a stated estimate reconciled against provider usage
> and cache reads, recency-plus-lexical history selection past the existing bounds with a truthful
> marker, a deterministic application-attributed compaction record kept as evidence, a recorded
> byte-stable instruction prefix, and the Console's "Context used" line. Declared context windows,
> explicit provider caching and accounting for Work turns remain open.

**Project Memory, definitions, add:**

> **Context used** — the per-answer record, on a Diomedes-owned model route, of what went into the
> model's context by section (estimated), what the provider reported (usage and cache reads), and,
> when history passed its budget, which messages were left out and summarised. External engines
> manage their own context and carry no such record.
>
> **Compaction record** — a deterministic summary of earlier messages left out of a turn's history,
> written by the application (never a model), naming each message it stands for by run, step and
> sha-256. Evidence only: the messages themselves stay in History (decision 10).
