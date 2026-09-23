# Artifacts v2, lane 2: the answer format, "Update this conversation" and recorded artifacts

**Decision record.** Version 2026-09-23.0. Artifacts panel v2 was approved by Andrew on 2026-09-23 and
targets 0.1.9. This lane carries frozen decisions 2 (the composed order), 3 ("Update this
conversation"), 4 (conversations keep their starting instructions, through the lineage lane) and 5
(artifacts recorded as index-only evidence).

**Status: complete on `feature/artifacts-conversation-format` (worktree
`F:/Diomedes/diomedes-wt/artifacts-conversation-format`), on `origin/main` at `fc6a981`, which already
holds the lineage lane (#45) and lane 4 (#46, `8f73322`). Lane 3 was not on main when the gates ran.
Committed locally; not pushed, not merged, not released.**

It builds on the lineage lane and re-implements none of it: `KNOWN_INSTRUCTION_DIGESTS`,
`recordedInstructions`, `boundInstructions`, `lineageNoteTurn` and the lineage choice in `resolve` are
used as they are.

## (a) The answer format, for new lineages only

`server/answer-format.ts` holds `ARTIFACT_FORMAT` (`:26`) and `answerInstructions(mode)` (`:30`), which
composes outside `MODES`, so `MODES` and the Plan length test are unchanged:

| Mode | Composed text |
|---|---|
| Ask, Plan | the mode's text, then `ARTIFACT_FORMAT` |
| Automatic | the mode's text, then `VISUAL_INSTRUCTIONS`, then `ARTIFACT_FORMAT`, then `DECISION_FORMAT` (last, through `instructionsFor`) |
| Build, Fix | unchanged: `MODES[mode].instructions` |

`ARTIFACT_FORMAT` was checked against the parser now in `shared/artifacts.ts` and
`shared/turn-blocks.ts`:
- its two example declarations parse, and each fence it names becomes an artifact;
- its Mermaid rules are lane 4's: `$$...$$` within one line; in a diagram with math, `\lt` for `<`,
  no `~`, and no `&` or `\` outside the math; a flowchart row break written `\\\\`; pictures only as
  `A@{ img: "data:image/...;base64,..." }` in PNG, JPEG, GIF or WebP; under 50,000 characters. The
  wording says nothing about where math shows.
- `tests/answer-format.test.ts` runs a diagram written by those rules through lane 4's own
  `refusal()`.

Where it is used:
- `resolve` composes a new lineage's text with it (`server/app.ts:3502`), and the job estimate prices
  the same text (`nextModelInstructions`, `:3416`).
- `/ask` gives Ask and Plan the composed text (`:4544`). Build and Fix reach `/ask` only on the sample
  route; on every other route they go to native work, which sends `modeDef.instructions` itself.
- The direct `/api/projects/:id/claude-sessions` route keeps the `MODES` text, as the draft says. No
  client calls it.

### The three new digests

Each was produced by running `answerInstructions` on this branch, and each is known only for its own
mode. Every older digest stays.

| Mode | SHA-256 | Characters |
|---|---|---|
| Ask, 0.1.9 | `a63f0bf66f53a24da85b3473afd3921b3e8ece5f21f35e77ca9cf1dea7b828e1` | 1,816 |
| Plan, 0.1.9 | `8cdfca1b93844d5a8f993a53674d39ed7ca3a3fdbc0f42d13cf1f169c03075c9` | 1,862 |
| Automatic, 0.1.9 | `e19fd738cc3fddb78ee8e12c271c59f3b820daf4d774f6122ab00321ced99dd5` | 3,253 |

The texts are kept verbatim in `tests/fixtures/instruction-texts.json`, and the golden test
(`tests/instruction-digests.test.ts`) checks them, including that 0.1.8's texts stay known for their own
modes.

**Continuity.** A lineage opened under main's 0.1.8 text keeps it: it is sent as recorded, on the same
run and generation, with its history. The tests cover Ask, Plan and Automatic on the model-API route
and Automatic on Claude Code.

## (a) "Update this conversation"

### The endpoint

`POST /api/projects/:id/threads/:threadId/answer-format`, body `{ commandId }` (strict), answering
`{ updated: boolean; noteId: string | null }` (`shared/conversation.ts`). The route is in
`server/engines/interaction-routes.ts:48`, `:125`; the work is the host's `answerFormat`
(`server/app.ts:3832-3892`), under the store lock, on a clone of the state.

1. **Idempotent per command.** A lineage retired `format-change` whose note
   `lineageNoteId(runId, commandId)` is in the thread means this command already ran: it answers
   `{ updated: true, noteId }`, before anything is refused and even after the conversation moved on.
2. **Refused with a 409 and the reason**, before anything changes:
   - `conversation_busy`, while a message in this thread is being answered: "Nectovia is still working
     on a message in this conversation. Update it once that has finished." Two signals are read: the
     interaction service's per-thread hold (`server/interaction-service.ts:285-313`, taken by every
     message and selection) and each open lineage's driver (`busy(runId)`).
   - `proposal_waiting`, while the thread ends on an Automatic answer whose proposal waits for the
     person's choice (`proposalWaiting`, `:3450`): "Nectovia is waiting for your choice on what it
     proposed. Start it, or send another message, before you update this conversation." The outcome is
     computed from that message's recorded phases, as the outcome read computes it.
3. **Retires** every open lineage whose recorded text is not today's, with the new `'format-change'`
   reason (`ConversationLineage.retired`, `LineageRetirement`, `RetirementCause`). A lineage that never
   started recorded nothing and is left alone. With nothing to retire it answers
   `{ updated: false, noteId: null }` and writes nothing.
4. **Writes one note turn** through `lineageNoteTurn`, with the application's origin, anchored on the
   first retired lineage.
5. **Records `carriedFrom`** on the next lineage of the same mode that `resolve` opens (`:3727`), pointing
   at the run it replaces.

The note (`server/lineage-continuity.ts:113`):
- carried: "Nectovia started this conversation fresh because you updated it to the current
  instructions. Your earlier messages are still here, and it carried over the most recent ones."
- not carried: "… Your earlier messages are still here, but it won't remember them."

"Carried" is decided when the person confirms: every retired lineage's route must share conversation
history then. Each send decides again, so turning sharing off afterwards carries nothing, and the note
stays as written. The action never turns sharing on.

### Carry-over, on each driver

The bound is draft a.3's, shared by both drivers (`server/harness/conversation-history.ts`): the last
12 answered messages, then the last 24,000 characters with a leading "…", counted across the carried run
and the new one together. Only `turn:` steps that succeeded are read, and the decision block is stripped
(`spoken`). The note is a thread turn, never a run step, so it can never reach a model.
`carriedRun` follows the pointer only to a conversation run of the same project and thread.

- **Model API** (`server/harness/model-session-run.ts`). `history()` (`:628`) reads the carried run's
  turns first, then the lineage's own, under the one bound. It is gated per send, as before: first the
  route's history grant (`historyPolicy`, `:742`), then `sharingPolicy(…, history.length > 0, route)`.
  So the new lineage keeps carrying the earlier messages, within the bound, on every send, and they give
  way to its own as it grows. The turn's child run records `carriedFrom` only when history was sent
  (`:792`).
- **Claude Code** (`server/harness/claude-session-run.ts`). A new native session is opened for the new
  lineage. Only its first turn (mode `start`) is prefixed with the bounded transcript (`carriedPrompt`,
  `:24`; `carried`, `:213`), and only when Claude Code's history grant is on at that send (the host's
  second policy, `server/harness/host.ts:411-420`). The native session keeps it from then on, and later
  turns are not prefixed. That first turn counts as prior conversation for the sharing check (`prior`,
  `:836`). The turn step still records the person's own prompt, and the adapter never sees the pointer
  (`wire`, `:748`).
- **Across drivers.** A lineage may carry from a run the other driver wrote, in the same project and
  thread, under the receiving route's own grant.

The carry is one step deep: a second update carries only the messages of the lineage it retires, which
already begin with what the first update carried, within the bound.

### The client

- `client/api.ts`: `updateConversation(projectId, threadId, commandId)`.
- **The menu is a new component, `ThreadMenu` (`client/console/ThreadMenu.tsx`)**: the conversation's
  own "···" button, at the end of the conversation's head, in the thread view (`ThreadView`'s `menu`
  slot, from `Shell`) and on the Nectovia page (`Diomedes`'s `menu` slot, from `DiomedesHome`). It is the
  top strip's `.surface-menu` and `.pmenu` with the same outside-click and Escape handling, labelled
  "Conversation menu". Its one item is "Update this conversation". The Shell's top-strip "···" is the
  interface Detail menu and was left alone.
- **The confirmation** is the Console's `Modal` as an alert dialog, like the job-cap warning:
  "Update this conversation?", saying the conversation starts fresh on the current instructions and the
  messages stay on screen. It reads `GET /projects/:id/cloud-sharing` and states the memory consequence
  for the conversation's route: "History sharing is on for AWS Bedrock (Luna), so Nectovia will carry
  over your most recent messages." or "History sharing is off for …, so your earlier messages stay on
  screen but Nectovia won't remember them. Updating doesn't turn sharing on." Cancel takes focus
  first. Update is the only thing that sends.
- One command id is minted per confirmation, so pressing Update again after a lost response reads back
  what the first press did. A refusal stays in the dialog with the server's reason, in the attention
  colour, and Update can be pressed again once it has passed. `updated: false` says the conversation
  already uses the current instructions.
- After an update the thread view reloads the project state; the Nectovia page re-reads the transcript
  and drops the outcome card, which belonged to the answer the note now follows.

The dialog decides by the conversation's route. The server decides by the route of each lineage it
retires. They differ only when a thread's open lineages sit on different routes; the note is then the
authority.

## (c) Recorded artifacts, as index-only evidence

### The step

`server/harness/artifact-steps.ts`, with the shape shared with the client in
`shared/recorded-artifact.ts`. One pure `transform` step per artifact in an answered conversation
message, at most 16:

```text
id:     artifact.v1:<first 40 hex of digest({ sourceMessageId, blockIndex })>
kind: 'transform'   effect: 'pure'   cost: 0   destination: 'local'   maxAttempts: 3   version: '1'
name:   'Artifact <kind>'
input:  { v: 1, artifactId, declaredId, kind, lang, title, sha256, blockIndex, turnId, turnStepId, sourceMessageId }
origin: the application's, with producerId = the model turn's step id
```

- No source text: `sha256` is the SHA-256 of the UTF-8 bytes of the artifact's source as the panel
  shows and copies it (`ArtifactRecord.source`: the fence body as written, or a table's own lines).
- `artifactId` is the key the panel indexes it by (`artifactKey(threadId, turnId, blockIndex)`), and
  `turnId` is the assistant turn the host projects for that command, so the pointer lands on the turn
  that shows it.
- No contract revision: the existing `transform` kind carries it, and it charges no model call, tool
  call or unit. The model's attribution stays on its turn step (Pillar 07).
- The artifacts are read from what the person sees, `answerText ?? response.text`: anything after an
  Automatic decision block is neither shown nor recorded.

### Where it is written

On both drivers, right after the message's decision phase and before the run parks: the drive tail
(`model-session-run.ts:864`, `claude-session-run.ts:970`). On a replay of a live run (`:418`, `:404`),
`unrecordedArtifacts` decides what may still be written:
- nothing recorded for the message: all of them (a crash after the answer was saved);
- some recorded: only the ones not yet written (a crash between two of them), and only while this build
  reads every recorded block exactly as its step says. A parser that reads a recorded block differently
  writes nothing, so a retried command is never refused as a conflict and a record is never rewritten.

This refines the draft's "write only when the message has no `artifact.` step yet", which could not
finish a set a crash had cut in half. A settled run is read and never written, as before. `/ask` replies
have no lineage run and record nothing.

### Where it is read

`client/console/artifact-evidence.ts` reads a conversation's lineage runs through the existing
`GET /projects/:id/harness/runs/:runId`, keeps the succeeded, well-formed `artifact.v1:` steps, and sets
each beside what the thread's text holds at `index.forBlock(turnId, blockIndex)` now, digesting with
`crypto.subtle`:
- `recorded`: the same kind and digest;
- `changed`: an artifact is there, but another digest or kind, shown as "Changed since recorded";
- `missing`: the turn is there but holds no artifact at that place.

A record whose answer the thread does not show yet is left out, so a late projection never reads as a
change. A digest that cannot be computed is shown as a failure, never as a match.

`client/console/RecordedArtifacts.tsx` shows them, read-only, under the artifact panel's head: a folded
"Recorded in this conversation" list whose summary line keeps the count of changed ones in the attention
colour, so a change is never folded out of sight. Each row opens the artifact from the thread's text; a
missing one has nothing to open. It reads nothing until an artifact is open, and again when the thread's
lineages or turns change. It is mounted in lane 4's `ArtifactPane` through one new slot, `recorded`,
under `board`: from `useArtifactHost` in the thread view, and from `Diomedes` on the Nectovia page,
whose `DiomedesHome` supplies the reader (the page itself still never fetches).

## Tests

Every test below was seen to fail. Mutations were applied one at a time by
`scratchpad/v2-lane2/mutate.py` and `pw-mutate.py`, which restore each file byte for byte; each mutation
made its named test fail.

| File | Tests | Proves | Mutations it failed |
|---|---|---|---|
| `tests/instruction-digests.test.ts` | 10 | The golden list: every fixture reproduces its digest; today's texts are the 0.1.9 fixtures, each known for its own mode; 0.1.8's stay known. | Before the digests were registered it failed; dropping the 0.1.8 Ask digest fails it. |
| `tests/answer-format.test.ts` | 8 | The composed orders; an artifact before the decision block survives `splitDecision`; the examples parse; every named fence is an artifact; the Mermaid rules pass lane 4's pre-check; `/ask` gives Ask and Plan the format and Build only its mode text. | Automatic without visuals; `/ask` Ask without the format; Build given more; an example id the parser refuses; a Mermaid rule drifting from the pre-check. |
| `tests/lineage-continuity-aws.test.ts` | 15 | Ask, Plan and Automatic lineages opened under 0.1.8's text continue; a new lineage records today's composed text. | 0.1.8 Plan digest dropped. |
| `tests/lineage-continuity-claude.test.ts` | 6 | Automatic under 0.1.8 continues; the Claude Code carry with sharing on (first prompt only, pointer never reaches the adapter) and off. | First prompt not prefixed; carried on every turn; carry ignoring sharing; host never granting it; adapter handed the pointer; 0.1.8 Automatic digest dropped. |
| `tests/interaction-seam.test.ts` | 19 | A conversation opens under the composed text. | The conversation sent without the format. |
| `tests/conversation-update.test.ts` | 9 | The endpoint on the model-API route: the note with sharing on and off, the carry and its 12-message bound, the note never sent, idempotency, nothing to update, the two 409s, the body. | Read-back removed; busy check removed; proposal check removed; note never or always "carried"; pointer never set; note text reaching the model; a 13-message bound; retiring current lineages; a loose body; the carry ignoring sharing at send. |
| `tests/conversation-history.test.ts` | 6 | The bound, the order, answered messages only, the pointer's project and thread. | 13 messages; carried run last; no character bound; unanswered turns read; another thread carried. |
| `tests/artifact-steps.test.ts` | 13 | The step's shape with no source; the index matches the text and tampering is caught; the cap; the replay rule; on the model-API route through the app: recorded after the decision, free, readable through the run read, pointing at the projected turn; a retry writes nothing; a failure between two artifacts is finished by the retry; a changed parser writes nothing; nothing after the decision block. | Digest of the title; place shifted; steps charged; drive tail writing none; replay ignoring the rule; append dropping them; recording past the decision block; no cap. |
| `tests/artifact-steps-claude.test.ts` | 6 | The same on Claude Code, including a crash before the phase and between two artifacts, each finished after a restart with one model call. | Source kept in the step; origin with no producer; drive tail writing none; replay ignoring the rule; a changed reading still written; a half-written set never finished; append dropping them; recording past the decision block. |
| `tests/artifact-evidence.test.ts` | 9 | What the server records reads as recorded; a changed block and a changed kind are "changed since recorded"; a missing one; an answer not shown yet; no digest is never a match; the browser digest is the server's; the run read and its 404. | Digest ignored; kind ignored; missing read as changed; unshown answers listed; unfinished steps read; a missing run failing the read; any digest accepted. |
| `tests/home-luna.spec.ts` | 1 new | On the Nectovia page: "···", "Update this conversation", the confirmation's sharing sentence, Update; the note shows once; the next answer continues on a new lineage that carried the earlier exchange and not the note. | The pointer never set (server); the page never reading the note back (client). |

The first run of the `update` batch reported false passes: the runner matched the "Failed Tests"
banner. It now reads the summary line, and every mutation fails. One mutation, "`/ask` Build given the
format", genuinely survived at first: Build and Fix reach native work on every real route, so it was
moved to `server/native-work.ts`, where it fails.

The Playwright test sets up a conversation 0.1.8 opened by rewriting its lineage run's recorded text in
the run file to main's 0.1.8 Automatic text from the fixture. No product hook composes an older text,
and that rewrite is exactly the state an update from 0.1.8 leaves.

## Gates

Under the heavy slot (`slot_mue9hsoh_600beb2a`, 11:32 EDT), with `DIOMEDES_UI_CLIENT_PORT=5274` and
`DIOMEDES_UI_SERVICE_PORT=47732`, on the tree committed with this record, on `origin/main` `fc6a981`.
Logs are in the session scratchpad, `v2-lane2/gate-*.log`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 334 files; 5,870 passed, 4 skipped; exit 0 |
| `npx vite build` | exit 0 |
| `npx playwright test` | 208 passed, none flaky; exit 0 |

`field.spec.ts` C07 did not cascade. `evidence/` and `docs/verification/2026-09-17-design-center/` were
restored afterwards.

## Decisions that differ from the draft

1. The endpoint answers `{ updated, noteId }`, not `{ retired: n }`: the note id is what a retry reads
   back, and a count says nothing a person or a test uses.
2. The carry is one step deep (above).
3. The note's "carried" is fixed when the person confirms; each send checks sharing again.
4. The replay rule finishes a half-written set when the reading is unchanged (above).
5. The direct `claude-sessions` route and Build and Fix are unchanged.
6. On Claude Code the sharing check treats a carried first turn as prior conversation, as well as the
   host's own grant check: two gates, not one.

## Open items

1. **Not verified against the real Claude Code CLI.** The carried first prompt is tested with the
   fixture adapter.
2. **The dialog and the note can differ** when a thread's open lineages sit on different routes (above).
3. **History fills faster.** Artifact sources ride in history verbatim, so a large design pushes earlier
   messages out of the 24,000-character window sooner (draft, "History fills faster").
4. **Recorded artifacts on older messages.** Messages answered before this build have no steps; the
   list shows nothing for them, and the panel still opens them from the text.
5. **Run reads for the list.** The list reads every lineage run of the thread whenever an artifact is
   open and the thread changes. A conversation with many long lineages will show this in a profile.
