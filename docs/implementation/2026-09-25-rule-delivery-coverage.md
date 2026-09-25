# Rule delivery coverage: every model call that writes for a person gets the rules

Date: 2026-09-25 · Lane `rule-delivery-coverage` · Branch `feature/rule-delivery-coverage`

## Why

H11 (PR #75) made project instruction files reach the model through the rule path, and H16
(PRs #118, #126, #130) added stream-time triggers. Andrew asked for proof that rule injection
reaches every model call that produces text for a person. It did not. `assembleInstructions`
(`server/harness/instruction-delivery.ts`), which renders shipped product knowledge and the
project's instruction files (root and nested, H11 precedence and scope), had two callers:
Work runs (`server/native-work.ts`) and work loop runs (`server/native-loop-routes.ts`).
Every conversation message, on Home and in project threads, on every route, was sent its
mode's text and nothing from the rule path. So were the explicit native session routes, the
direct Ask route and the loop's own helpers.

"Rules" below means what the rule path delivers: **product** (shipped product knowledge,
`resources/product-knowledge`, route scoped) and **workspace** (the project's `AGENTS.md` and
`CLAUDE.md`, root and nested, through the Software Engineering pack, H11 scope and precedence,
cloud sharing). Pack playbooks are a separate, person-selected channel (`assembleSkillSection`
on the Ask route, P04 index on model-API conversations); the table notes where they go.

## The constraint that decided the design

A conversation's `instructions` are bound to its lineage (`server/lineage-continuity.ts`,
`KNOWN_INSTRUCTION_DIGESTS`) and a native session's checkpoint digest
(`claude-session.ts:108,229`, `acp-session.ts:212`, `opencode-session.ts:197`). Folding rules
into that text would either never reach an open conversation (a known recorded text is kept)
or retire every open conversation whenever an instruction file changed. So the rules travel
**per message**, beside the lineage text, in one new optional field:

- `TextRequest.rules?: { text, record }` (`server/engines/contract.ts`), set only by the host
  from `messageRules()` (a thin wrapper over `assembleInstructions`).
- **Diomedes-owned routes** (AWS Bedrock, Azure OpenAI, OpenRouter, Google Vertex): the text
  goes in the system text *after* the lineage's stable prefix (`model-session-run.ts`, H18
  `stablePrefix(lineage, variable)`), so the cached prefix and the lineage binding are unchanged.
- **Native sessions** (Claude Code, OpenCode, Cursor, Devin): the session's system prompt is
  fixed for its life, so the text rides in the per-turn message `contextMessage` builds, as its
  own `rules` field ahead of `request` and apart from `documents`. Every native adapter builds
  its turn with `contextMessage` (`claude-session.ts:222`, `opencode-session.ts:189`,
  `acp-session.ts:204` for Cursor and Devin), so one change covers all four.
- **One-shot requests** (the Ask route): no lineage, so the section is appended to the
  instruction channel, as Work runs already did.

No second prompt system: every row below that now delivers calls the same
`assembleInstructions`.

## Route table

"Before" is `origin/main` at 90f23fa. Proof is a test in this PR unless a citation is given.

| # | Entry point | Routes / engines | Product rules | Workspace rules (root + nested) | Pack playbooks | Delivery record | Before | Proof |
|---|---|---|---|---|---|---|---|---|
| 1 | Home conversation (`POST /api/home/conversation`, then `/threads/:id/messages`) | model-API: AWS, Azure, OpenRouter, Vertex (`ModelSessionRuns`); Claude Code (`ClaudeSessionRuns`) | yes | yes (Home project's own files; none by default) | P04 index on model-API | model-API: child run input `rules`; native: turn step input `rules` (sha, bytes, per-file path/sha/state, product knowledge state; never a body) | **none** | `rule-delivery-coverage.test.ts` "Home is sent the shipped product knowledge" |
| 2 | Project thread conversation (`/threads/:id/messages`, `interactionHost.resolve` in `app.ts`) | same as 1 | yes | yes, scoped to the message's selected documents | P04 index on model-API | as 1 | **none** | "a project thread message is sent the instruction file…" (AWS), "an open conversation gets the edited rules… does not retire", "a conversation message carries the rules…" (Claude Code, real `ClaudeAdapter` session over a scripted child) |
| 3 | Explicit native session routes (`/claude-sessions`, `/opencode-sessions`, `/cursor-sessions`, `/devin-sessions`; `nativeSessionDependencies.prepare`) | Claude Code, OpenCode, Cursor (ACP), Devin (ACP) | yes | yes, scoped to selected documents | none (unchanged) | turn step input `rules` | **none** | "the explicit native session route sends the rules the same way" (Claude Code). OpenCode, Cursor and Devin use the same `prepare` and build their turn with `contextMessage` (citations above); the wire shape is proven by "a native session message carries the rules as their own field" |
| 4 | Direct Ask / Plan (`POST /api/projects/:id/ask`) | Claude Code, OpenCode, Oh My Pi, Cursor, Devin (one-shot `generate`); Codex (`askCodex`) | yes | yes, scoped to selected documents | person-selected playbook (`assembleSkillSection`), unchanged | external engines: the text route run's intent records `instructions` verbatim (`engines/service.ts:1566`); Codex: none (the Ask route keeps no run for Codex) | **none** | "a direct Ask is sent the rules in its instruction channel"; `answer-format.test.ts` updated to the new shape |
| 5 | Work runs (Build / Fix proposals, board task work, ready scheduler, team member runs) | Codex, all external engines, all model-API routes | yes | yes (H11) | none | `Session.instructions` + `Session.productKnowledge` (H11) | delivered | `native-work.test.ts` H11 block, `nested-instructions.test.ts`, `fd03-readiness.test.ts` |
| 6 | Work loop (`POST /api/projects/:id/loop/start`, H13) | scripted `native-fixture`, AWS, Azure, OpenRouter, Vertex | yes | yes (H11) | none | `Session.instructions`; **now also** `Session.productKnowledge` (was not recorded) | delivered, product knowledge unrecorded | `native-loop-routes.ts:393` |
| 7 | Loop helpers: `delegate` children and team workers / advisors | loop's routes | yes (the loop's section) | yes (the loop's section) | none | the root loop's session record covers the same bytes | **none** (loop instructions and role only) | "a loop's helpers and team members are sent the loop's rules after their own role"; `loopRules` walks `parentRunId` to the root loop |
| 8 | Weekly brief (automations) | none: deterministic procedure | n/a | n/a | n/a | n/a | no model | `automations.ts:1129` starts the `WEEKLY_BRIEF` procedure; `harness/capabilities/weekly-brief.ts` calls no adapter |
| 9 | Sample route | none: fixed text | n/a | n/a | n/a | n/a | no model | `app.ts` Ask route's sample branch; now assembles nothing for it |
| 10 | Harness proof routes `codex-report` and `native-fixture` format-report | ChatGPT via `CodexEngineAdapter`; scripted adapter | no | no | no | run record | unchanged, not reachable from the Console | the Console never sends `capabilityId` (`grep capabilityId client/`); `codex-engine.ts:104` is a fixed synthetic contract ("Use only the supplied synthetic request… No tools, memory, skills") that this PR does not widen |
| 11 | Connection read agent (`connections/service.ts:1017`) | registered scripted fixture only | no | connector-scoped rules through `RuleModelAdapter` | no | run record | unchanged | "Only the registered scripted fixture model is admitted by this proof" |
| 12 | H17 reviewer and "Approve for me" reviewer (`verification/reviewer.ts`, `trust/codex-reviewer.ts`) | Codex | no, by design | no, by design | no | verdict record | unchanged | a typed verdict with a bounded note; project instruction files are the reviewed project's words and must not be able to instruct its reviewer |
| 13 | Jev preflight (`harness/jev-advisor.ts`) | model-API | no | no | no | advice record | unchanged | typed routing hints, not text for a person |

Nested workspace rules on conversations follow H11's scope exactly: a nested file governs a
message only when a selected document is inside its folder. A message with no selected
document is scoped to the project root (H11's recorded gap, unchanged).

## What changed

- `server/engines/contract.ts`: `TextRequest.rules`; `contextMessage` carries it as its own
  field ahead of `request`.
- `server/harness/instruction-delivery.ts`: `messageRules()` and `ruleDeliveryRecord()`.
- `server/app.ts`: rules assembled for conversation messages (`interactionHost.resolve`), the
  explicit native session routes (`nativeSessionDependencies.prepare`) and the Ask route; the
  conversation cost estimate counts the rules bytes.
- `server/harness/model-session-run.ts`: rules in the system text after the stable prefix; the
  turn's child run records them.
- `server/harness/claude-session-run.ts`: the turn step records them (a turn saved before this
  keeps its shape, as `binding` does).
- `server/harness/capabilities/native-loop.ts`, `team-loop.ts`: helpers get the loop's section.
- `server/native-loop-routes.ts`: the loop session records its product knowledge receipt.

## Costs and limits

- Product knowledge measured on this build (0.2.0): 1,931 bytes for Claude Code, 1,927 for
  OpenCode, 1,357 for Codex, 1,264 for AWS Bedrock (about 300 to 500 tokens). A project's
  instruction files add their own bytes, bounded by `instructionSectionBudget` exactly as for
  Work.
- On a native session the section is sent with every message and stays in that session's own
  history. Sending it only when it changed since the session's last delivered turn would save
  tokens but depends on the engine never compacting it away; not done here.
- A retried message whose instruction files changed between attempts is refused as a changed
  request by the native session (`claude-session.ts` request digest), as any changed context is.

## Tests

`tests/rule-delivery-coverage.test.ts` (8), all shown red against `origin/main`'s `server/` and
green with this change. Full `npx vitest run` in this worktree: see the PR for counts.

## Proposed canonical-doc patch (for the integrator)

**`docs/DIOMEDES_LIVE_ROADMAP.md`**, after the H11 paragraph:

> Rule delivery coverage (2026-09-25, `docs/implementation/2026-09-25-rule-delivery-coverage.md`):
> the rule path's section (product knowledge and instruction files) now reaches conversation
> messages on Home and in project threads on every route, the explicit native session routes,
> the direct Ask route and the loop's helpers, per message and outside the lineage's recorded
> text, so an open conversation gets today's rules without retiring. Each turn records the sha
> of what it was sent.

**`docs/DIOMEDES_CORE_PILLARS.md`**: no change.
