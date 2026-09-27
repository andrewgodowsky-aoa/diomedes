# Engine conversations and reasoning: design

- **Feature:** engine conversations and reasoning. This is sub-project A of the 2026-09-27 driver program.
- **Branch and worktree:** `feature/codex-conversation-driver`, `F:/Diomedes/diomedes-wt/codex-conversation-driver`.
- **Base:** origin/main `bfc8c78`.
- **Owner:** Andrew Godowsky.
- **Prompt ID:** none. Andrew directed this work on 2026-09-27; it isn't a package prompt. It amends CD-01 Decision 5 and answers `QUESTIONS.md` O19 and O39.1.
- **Status:** Andrew approved the design section by section on 2026-09-27. This written spec awaits his review. No code is written until he approves it and a plan exists.

## 1. Decisions (Andrew, 2026-09-27)

1. **Two routes, one stream ("D1").**
   - Models run in Nectovia's own AI SDK harness, which owns their tools.
   - Outside agents keep their own loop and their own tools. They connect over ACP where the agent speaks it, and over their own protocol where it doesn't.
   - Every route feeds one live stream to the Console.
   - Rejected: wrapping every agent as an AI SDK model ("D2"), and running every model in our harness alone ("D3").
   - This confirms the 2026-09-13 runtime-seam rule: Diomedes' contract comes first, ACP is the preferred external transport, and the AI SDK is the plane for direct models.
2. **ChatGPT (Codex) conversations run on our own app-server client as a kept session**, not on `@agentclientprotocol/codex-acp`.
   - That adapter lists `@openai/codex` as a hard dependency, which would put Codex in the installer. Diomedes ships adapters, not engines.
   - It also needs Codex 0.156 or later, and that would need a new isolation proof.
   - The 2026-09-13 rule keeps Codex on its own protocol unless ACP proves better.
3. **Reasoning works on every conversation route that can supply it.** It streams live and is saved with the reply.
4. **Console conversation routes** are Claude Code, ChatGPT (Codex), OpenCode, Cursor, Devin and the model-API routes. oh-my-pi joins once it has a kept session.
5. **Only engines that are found.** This applies to the conversation surfaces: the engine choice, the refusal sentences and the free-version notice.
   - A conversation offers an engine only when Nectovia finds it installed, compatible and signed in on this computer.
   - None of those surfaces suggests installing or choosing a named engine.
   - When no engine is found, the only suggestion is the Nectovia plan.
   - AI setup keeps its install and sign-in flows. Section 9 asks Andrew to confirm this.
   - Andrew's words: "only loads with saved sessions found. does not suggest engines. if one doesn't have one installed, only suggest nectovia paid inference subscription."

## 2. Scope

**In this spec:**
- The ChatGPT (Codex) kept conversation.
- The Console reaching the kept sessions that OpenCode, Cursor and Devin already have.
- The found-engines rule for conversations.
- The reasoning channel: its contract, a producer on every conversation route, the Console's Thinking section, and saved thinking.

**Not in this spec:**
- oh-my-pi conversations, because it has no kept session yet.
- `codex-acp`.
- New model pickers for engines. Each engine's existing model setting and the H02 controls apply.
- Moving Claude Code project threads to the native session. O38 keeps its default.
- Build and Fix on any engine, and thinking in Build and Fix runs. Those runs keep their tool lines; a follow-up can add thinking through the same frame.
- Paid features on any engine: the Nectovia MCP server and rules (spec C).
- Managed tiers taken from the Operations catalog (spec B).
- omp-grade tools in our harness (spec D).
- The phone apps, which live in their own repositories.
- Texting the Nectovia bot, which never carries thinking.

## 3. Part 1: engine conversations

### 3.1 Routes and admission

- **The route list.** `CONVERSATION_ROUTES` in `shared/engines.ts` becomes Claude Code, ChatGPT (Codex), OpenCode, Cursor, Devin, then the model-API routes.
  - A new `KEPT_SESSION_ROUTES` names the four engines whose conversation runs on a kept session.
  - A person reads Codex as "ChatGPT" everywhere (`ROUTE_NAMES`). Nothing here renames it.
- **Project threads.** `planThreadSend` in `client/console/thread-send.ts` sends Ask, Plan and Automatic on a kept-session route through the conversation, as it already does for a model-API route.
  - Build and Fix keep the direct request path.
  - Claude Code project threads keep theirs (O38).
- **Home.** The Nectovia conversation accepts the same list. The host's refusal "…runs on {CONVERSATION_ROUTE_LIST}" follows the constant.
- **The driver.** `conversationDriver` in `server/app.ts` already sends every run whose id doesn't start with `model-` to the native session driver. Each kept-session engine brings its own `NativeSessionProfile`.
- **Found engines.**
  - The host decides which conversation engines a person may choose, using the existing install, compatibility and sign-in checks (`EngineCandidate`, `server/engines/install.ts`, `server/engines/login.ts`).
  - An engine that isn't found is not offered, and no sentence tells a person to install one.
  - A saved thread whose engine is no longer found is refused, in the engine's own sign-in or install wording, for example "ChatGPT isn't signed in on this computer, so this conversation can't continue here. Nothing was sent." The thread is never moved.
- **Free and paid.**
  - Kept-session engines are the person's own AI, so they are free (Pillar 12 amendment 2026-09-27.1 on `feature/free-harness-paid-agent`).
  - That branch's free fallback picks them up through `isConversationRoute && !isModelApiRoute`.
  - The Nectovia Agent stays paid.

### 3.2 The ChatGPT (Codex) kept session

- **Where.**
  - `server/engines/codex-session.ts` holds the session.
  - `server/harness/codex-session-run.ts` holds its `CODEX_SESSION_PROFILE`.
  - `NativeSessionProfile.engine` gains `'codex'`.
  - The session reuses the app-server client in `server/integrations.ts`. Shared pieces are extracted there, not copied.
- **Checkpoint.** The driver saves it durably, like `acpCheckpointSchema`. It holds:
  - the Codex thread id and the lineage id;
  - the project and thread;
  - the CLI version and the account route;
  - the requested model, the reported model, and the effort;
  - the instruction and scope digests;
  - the state: `idle`, `busy` or `uncertain`;
  - the origin: `started`, `resumed`, `restarted-fresh` or `recovered`;
  - the lost thread id and the interrupted request id;
  - how the last Stop ended: `acknowledged` or `killed`;
  - the number of turns.
- **A turn.**
  - It calls `thread/start`, or `thread/resume` with the saved id. The thread id is saved before `turn/start`, so after a restart the app always knows which thread to continue.
  - `turn/start` carries the read-only tools that `askCodex`'s `readScope` already gives Ask and Plan: the project folder under the read-only sandbox, web search when the person allowed it, and approved MCP read tools. There is no shell and no edits.
  - Answer text streams as previews. Reads stream as tool activity, with the existing narration. Thinking streams as described in Part 2.
  - Each conversation has its own app-server process, never shared with another conversation. The process may stay warm between turns, but it ends after a bounded idle time.
    - The limit exists because the Codex app-server keeps each thread's MCP servers running until the process exits. A shared, long-lived process would pile them up.
    - Nothing depends on a warm process, because every turn can resume from the saved thread id.
- **Stop.** It sends `turn/interrupt`, waits a bounded time (3 s, the same as `ACP_CANCEL_WAIT_MS`), and then ends the process tree. The checkpoint records which of these happened.
- **Steering: `queue`.** A message sent while ChatGPT is answering is held and sent as the next turn, as with Claude and OpenCode.
- **Restart mid-turn.** `recoverInterrupted` keeps the checkpoint for an explicit resume and records the interrupted message as not completed. That message is never resent.
- **Fork.** It uses `thread/fork`, through the existing H02 code.
- **Route contract** (`server/harness/route-contract.ts`):
  - mode `external-session`;
  - `start`, `interrupt`, `resume` and `fork` are native;
  - `follow-up` and `steer` are host, queued as the next turn and never mid-turn;
  - `retry`, `status`, `reconcile` and `close` are host;
  - streaming is `text-delta` and `reasoning-delta`, and durable events are `run-record`;
  - models are `runtime-reported`, authentication is `native-sign-in`, and `testedWith` is the pinned protocol version.
- **Pinned version.**
  - `CODEX_PROTOCOL_VERSION` is 0.153.4. A different installed version is refused before anything is sent, with the existing setup sentence.
  - The plan's first task generates the app-server schema from the installed CLI. It confirms that `turn/interrupt` and the reasoning-summary notifications exist at 0.153.4. If they don't, work stops and the question comes back to Andrew.

### 3.3 OpenCode, Cursor and Devin in the Console

- Their kept sessions exist already (H04, H05). Today only API routes reach them.
- The Console now sends their conversations through those sessions and offers exactly `sessionControls(contract)`, as O19 proposed.
- Their read policies don't change. An ACP read turn allows `fetch` and `think` only, and the documents a person chose travel in the prompt.
- A kept conversation's private engine folder is still never removed automatically (O39.2).

## 4. Part 2: reasoning, end to end

### 4.1 Contract

These changes go in `shared/adapter-contract.ts` and `server/engines/contract.ts`.

- **`reasoningPreviewSchema`.**
  - Its kind is `'reasoning-delta'`.
  - It carries the same run identity as `text-delta`: project, thread, request, run, step, attempt and fence.
  - It has its own dense `seq`, and `text` of at most 64 KiB in UTF-8.
- **`reasoningSink`**, the sibling of `activitySink`.
  - It redacts, and splits a chunk that is over the byte limit into several frames.
  - It drops frames once the request aborts.
  - It never fails the answer.
- **The two hooks.** `TextRequest.onReasoning` receives caller-facing frames. `TextRequest.onReasoningDelta` receives the adapter's raw text. EngineService sets `onReasoningDelta` only when it wraps `onReasoning`; a caller that supplies one is refused, as for `onDelta`.
- **`TextResponse.reasoning`** holds the finished thinking, redacted, and how long it took.
- **Declaring support.** Every route contract declares `streaming.reasoning: 'reasoning-delta' | 'none'`. Conformance tests fail a route that emits thinking while declaring `none`. They also fail one that declares `reasoning-delta` but has no producer.
- **The contract version.** The descriptor schema is strict, so the new key is a contract change.
  - The plan's first task checks whether any saved record parses a route descriptor again later.
  - If none does, every descriptor is updated in one change and `ADAPTER_CONTRACT_VERSION` stays 1.
  - If one does, the version moves to 2 and a reader for version 1 descriptors is kept.
- **The event.** The host emits `engine-reasoning` on `/api/events`, beside `engine-text` and `engine-activity`.

### 4.2 Where thinking comes from

| Route | Source | Today | Change |
|---|---|---|---|
| ChatGPT (Codex) | app-server reasoning-summary notifications | not requested | turn summaries on in the thread config and map the deltas |
| Claude Code (Home session and direct path) | stream-json `thinking_delta` | ignored | map it (`--include-partial-messages` is already on) |
| Cursor, Devin | ACP `agent_thought_chunk` | accepted and dropped | map it |
| OpenCode | reasoning parts | filtered out of the answer | map them to thinking and keep them out of the answer |
| AWS Bedrock, Azure OpenAI | AI SDK reasoning stream parts | `reasoningSummary: null` | request summaries (`'auto'`) where the model supports them |
| OpenRouter | AI SDK reasoning stream parts | not requested | request reasoning through OpenRouter's reasoning option |
| Google Vertex AI | AI SDK reasoning parts (`includeThoughts`) | refused by `inspectVertexBody` | allow visible thinking and keep every other refusal |
| Nectovia (managed) | AI SDK reasoning parts through the gateway | the gateway refuses `reasoning.summary` | the gateway accepts it; the desktop asks for summaries only from a gateway that says it accepts them |

- **When a provider says no.** A provider or model that refuses summaries declares `none`. Conformance testing finds this. The app never discovers it at run time by retrying without the option.
- **The Vertex check.**
  - `inspectVertexBody` has refused visible thinking since the route's first commit (5284be9, 2026-09-23). That commit kept the request to the one shape it had proven, and nothing then had a place to show thinking or a way to keep it out of the answer.
  - Part 2 gives thinking its own channel. The Vertex stream classifier therefore sends thought parts there and never into the answer.
  - The check allows `includeThoughts` and keeps every other refusal: server-side tools, explicit caches, several candidates.
- **The gateway.**
  - Its change is in `services/control-plane/src/managed-inference.ts`. It changes the Worker, so it lands only with Andrew's approval and deploys with the next approved merge to main.
  - Desktop releases and Worker deploys ship separately, so the Nectovia route's reasoning support can't be fixed into the desktop build. Instead, the gateway reports whether it accepts reasoning summaries: as a capability in the reply the desktop already reads, or as a managed-contract version. The plan uses whichever the gateway already exposes.
  - A desktop never asks a gateway that doesn't accept summaries, and it starts asking as soon as the gateway reports that it does.
  - The plan's first task also confirms that the gateway passes reasoning-summary events back in the streamed response, not only that it accepts the field in the request.
- **Cost.** Reasoning tokens are already counted in `reasoningTokens`. The Luna proof in section 7 checks whether a provider bills its summary separately.

### 4.3 The Console

- `client/console/engine-reasoning.ts` accepts `engine-reasoning` frames for the request on screen. It uses the same attribution and gap checks as `engine-text-preview.ts`, and `live-reply.ts` advances it.
- **While thinking streams,** a muted Thinking section sits above the live reply. When the first answer text arrives, or the turn ends, it folds to one line ("Thought for 14s") that opens on click.
- **Saved replies** show their thinking folded the same way. A turn without thinking shows nothing.
- **Everywhere.** Home and project threads use the same component.
  - Text wraps inside it (standing decision 5).
  - It never repeats what the waiting line or the reply already says (standing decision 4).

### 4.4 Saving

- Streaming pieces are never saved. That is the contract's rule for previews.
- The finished thinking is saved on the reply's `Turn` in `shared/types.ts` as `thinking: { text, ms, shortened }`.
  - It is redacted and capped at 32 KiB. Past the cap it is cut and marked as shortened.
  - Turns written before 2026-09-27 have no `thinking`.
- **Saved thinking never leaves the reply.**
  - It is never part of the history a new lineage carries over (`carriedFrom`) or of the context a model-API route assembles.
  - It is never sent to any engine or cloud share.
  - The person reads it in the Console, and nothing else consumes it. Claude's thinking can never reach ChatGPT's context this way.

## 5. When something goes wrong

Each case ends the turn with one plain sentence. Nothing is retried behind the person's back.

- **ChatGPT is missing, signed out, or not the pinned version.** The turn is refused before anything is sent, with the setup step. A version change during a conversation stops it, as for the ACP sessions (`SESSION_MISMATCH`).
- **ChatGPT no longer has the saved thread.** The message starts a fresh thread and says that earlier messages weren't carried over.
- **Stop isn't acknowledged in time.** The process is ended and the record says `killed`, not `acknowledged`.
- **The app restarts mid-reply.** The message is recorded as not completed and is never resent. The next message continues the thread.
- **The ChatGPT account changes between turns.** The turn is refused with `ACCOUNT_CHANGED`, using the existing account-route check.
- **A tool call is outside the read-only policy.** The turn stops, as it does today.
- **Thinking never fails a reply.** Unlike answer text, thinking that is oversized or malformed is split, trimmed or dropped, the way tool lines already are.

## 6. Tests

- **ChatGPT session.** `tests/codex-session.test.ts` and `tests/codex-session-runtime.test.ts` run on `tests/fixtures/codex-app-server.mjs`, extended with interrupt and reasoning notifications. They cover:
  - starting a conversation, and resuming after a restart;
  - a lost thread;
  - Stop acknowledged, and Stop killed;
  - a version change and an account change;
  - a read-policy stop;
  - queued steering and fork.
- **Console route tests** for each kept-session engine, next to `tests/h05-acp-session-routes.test.ts` and `tests/h04-opencode-session-routes.test.ts`.
- **Found engines.**
  - An engine that isn't found is not offered.
  - No sentence suggests installing one.
  - A thread whose engine is gone is refused, not moved.
- **Reasoning.**
  - `reasoningSink`: size limits, splitting, redaction and abort.
  - Each producer, from recorded frames: the Codex fixture, `tests/fixtures/claude-stream-json.mjs`, `tests/fixtures/acp-agent.mjs`, `tests/fixtures/opencode-session-server.mjs` and `tests/fixtures/model-api-streams.ts`.
  - The Vertex check allows visible thinking and still refuses everything else.
  - The gateway accepts `reasoning.summary` and still refuses everything else (control-plane tests).
- **Route contracts.** Every descriptor declares reasoning, and conformance checks it.
- **Playwright.** Thinking streams, folds when the answer starts, reopens, and survives a reload. Nothing shows on a route that declares `none`.
- **Heavy commands** run under the heavy slot, one at a time.

## 7. Live proof

This runs on Andrew's machine with his own sign-ins.

- **One ChatGPT (Codex) conversation.** It shows thinking, takes a Stop mid-reply, and continues its thread after an app restart.
- **One Luna reply showing its reasoning summary.** This is a small paid call, made only after Andrew approves it.

## 8. Coordination

- **Shared file.** `server/app.ts` is an integrator-owned shared file. It changes here under Andrew's direction of 2026-09-27. Claims are checked with `scripts/coordination.ts` before editing.
- **`feature/free-harness-paid-agent`** (local, not merged).
  - Its free fallback picks up the new routes.
  - Decision 5 changes its hint sentences: they stop naming Claude Code or any other engine, and when no engine is found they suggest only the plan. That change is made on that branch.
- **The gateway change** deploys the Worker, so it needs approval first.
- **Merge order.** The free-harness branch lands first, then this one. Otherwise this branch is rebased onto it.
- **Canonical documents,** updated with the code:
  - `QUESTIONS.md` O19 and O39.1 are recorded as answered.
  - CD-01 Decision 5 in `docs/implementation/2026-09-20-core-agent-contract.md` is amended.
  - The runtime-seam section of `docs/DIOMEDES_LIVE_ROADMAP.md` is amended.
- **Product knowledge.** The ChatGPT (Codex) conversation route contract gets its statement in `resources/product-knowledge/`. `server/readiness/projection.ts` looks for one statement per route contract. A route appears in four places there: `core.json` scopes, `core.json` routes, the statement's scopes, and the `index.json` entry.

## 9. For Andrew's review

- Decision 5 is read here as: offer only engines that are found installed and signed in, and only those with a kept session. Is that right?
- Decision 5 is scoped to the conversation surfaces, and AI setup keeps its install and sign-in flows. Is that right?
- Saved thinking is capped at 32 KiB.
