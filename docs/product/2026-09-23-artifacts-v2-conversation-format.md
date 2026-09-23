# Artifacts v2, lane 2: the answer format, "Update this conversation" and recorded artifacts

**Decision record.** Version 2026-09-23.1. Artifacts panel v2 was approved by Andrew on 2026-09-23 and
targets 0.1.9. This lane carries frozen decisions 2 (the composed order), 3 ("Update this
conversation"), 4 (conversations keep their starting instructions, through the lineage lane) and 5
(artifacts recorded as index-only evidence). Version .1 answers the lane's independent review, "merge
after fixes": no P0, one P1 and several P3s. The review's probes are in the session scratchpad,
`v2-lane2-review/`.

**Status: complete on `feature/artifacts-conversation-format` (worktree
`F:/Diomedes/diomedes-wt/artifacts-conversation-format`). `origin/main` `1c62427` is merged in: the
lineage lane (#45), lane 4 (#46) and lane 3 (#49, which carries #47 and #48). Committed locally; not
pushed, not merged to main, not released.**

It builds on the lineage lane and re-implements none of it: `KNOWN_INSTRUCTION_DIGESTS`,
`recordedInstructions`, `boundInstructions`, `lineageNoteTurn` and the lineage choice in `resolve` are
used as they are.

## (a) The answer format, for new lineages only

`server/answer-format.ts` holds `ARTIFACT_FORMAT` (`:26`) and `answerInstructions(mode)` (`:30`). It
composes outside `MODES`, so `MODES` and the Plan length test are unchanged:

| Mode | Composed text |
|---|---|
| Ask, Plan | the mode's text, then `ARTIFACT_FORMAT` |
| Automatic | the mode's text, then `VISUAL_INSTRUCTIONS`, then `ARTIFACT_FORMAT`, then `DECISION_FORMAT` (last, through `instructionsFor`) |
| Build, Fix | unchanged: `MODES[mode].instructions` |

`ARTIFACT_FORMAT` was checked against the parser now in `shared/artifacts.ts` and
`shared/turn-blocks.ts`:
- Its two example declarations parse, and each fence it names becomes an artifact.
- Its Mermaid rules are lane 4's:
  - `$$...$$` stays within one line;
  - in a diagram with math, `\lt` stands for `<`, there is no `~`, and there is no `&` or `\` outside
    the math;
  - a flowchart row break is written `\\\\`;
  - pictures only as `A@{ img: "data:image/...;base64,..." }`, in PNG, JPEG, GIF or WebP;
  - under 50,000 characters.

  The wording says nothing about where math shows.
- `tests/answer-format.test.ts` runs a diagram written by those rules through lane 4's own
  `refusal()`.

Where it is used:
- `resolve` composes a new lineage's text with it (`server/app.ts:3554`), and the job estimate prices
  the same text (`nextModelInstructions`, `:3411`).
- `/ask` gives Ask and Plan the composed text (`:4613`). Build and Fix reach `/ask` only on the sample
  route. On every other route they go to native work, which sends `modeDef.instructions` itself.
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

The texts are kept verbatim in `tests/fixtures/instruction-texts.json`. The golden test
(`tests/instruction-digests.test.ts`) checks them, including that 0.1.8's texts stay known for their own
modes.

**Continuity.** A lineage opened under main's 0.1.8 text keeps that text: it is sent as recorded, on
the same run and generation, with its history. The tests cover Ask, Plan and Automatic on the
model-API route, and Automatic on Claude Code.

## (b) "Update this conversation"

### The endpoint

`POST /api/projects/:id/threads/:threadId/answer-format` takes the body `{ commandId }` (strict) and
answers `{ updated: boolean; noteId: string | null }`. `GET` on the same path is the dry run described
below (`shared/conversation.ts`).
- The routes are in `server/engines/interaction-routes.ts:48`, `:123` and `:132`.
- The work is the host's `answerFormat` and `answerFormatPreview` (`server/app.ts:3900-3961`), under
  the store lock. The update works on a clone of the state.

The update:
1. **Is idempotent per command.** A lineage retired `format-change` whose note
   `lineageNoteId(runId, commandId)` is in the thread means this command already ran. It answers
   `{ updated: true, noteId }`, before anything is refused and even after the conversation moved on.
2. **Is refused with a 409 and the reason**, before anything changes:
   - `conversation_busy`, while a message in this thread is being answered: "Nectovia is still working
     on a message in this conversation. Update it once that has finished." Two signals are read: the
     interaction service's per-thread hold (`server/interaction-service.ts:306-326`, taken by every
     message and selection) and each open lineage's driver (`busy(runId)`).
   - `proposal_waiting`, while the thread ends on an Automatic answer whose proposal waits for the
     person's choice (`proposalWaiting`, `:3502`): "Nectovia is waiting for your choice on what it
     proposed. Start it, or send another message, before you update this conversation." The outcome is
     computed from that message's recorded phases, as the outcome read computes it.
3. **Retires** every open lineage whose recorded text is not today's, with the new `'format-change'`
   reason (`ConversationLineage.retired`, `LineageRetirement`, `RetirementCause`). A lineage that never
   started recorded nothing and is left alone. With nothing to retire it answers
   `{ updated: false, noteId: null }` and writes nothing.
4. **Stores its decision** on each lineage it retires: `carry: { route }` when it carries, and nothing
   when it does not (`ConversationLineage.carry`, `shared/types.ts`).
5. **Writes one note turn** through `lineageNoteTurn`, with the application's origin, anchored on the
   first retired lineage, saying what was decided.

The note (`server/lineage-continuity.ts:113`):
- carried: "Nectovia started this conversation fresh because you updated it to the current
  instructions. Your earlier messages are still here, and it carried over the most recent ones."
- not carried: "… Your earlier messages are still here, but it won't remember them."

### One decision, made by the server (review P1)

In version .0, three parts decided separately and could disagree, as the review's cases A, B, V1 and
V2 and a grant given after the update showed:
- the confirmation decided by the conversation's recorded route;
- the note decided by each retired lineage's route;
- the next send decided by whatever route and grant it met.

Now one function, `updateDecision` (`server/app.ts:3464`), decides for both the dry run and the update:
- **`retiring`:** the open lineages whose recorded text is not today's.
- **`route`:** the conversation route the next message takes (`threadRoute`). Where a WorkStyle tier
  applies this is the tier's route, which only the server can resolve; otherwise it is the thread's
  engine. It is null when that route would refuse the message.
- **Carried:** only when all of these hold:
  - the route is not null;
  - every retiring lineage was answered on that route (`lineageRoute`);
  - every retiring lineage recorded a text this build knows for its mode (review P3 5: an unknown or
    revoked text carries nothing, as the lineage lane intends);
  - that route shares conversation history now (`sharesHistory`, `server/cloud-sharing.ts:49`).
- **`reason`:** otherwise, why nothing is carried: `history-off`, `other-route` (the messages were
  answered on another route than the next message takes) or `other`.

The dry run answers `{ retiring, carried, route, reason? }` (`ConversationUpdatePreview`) and changes
nothing.

At the next send, `resolve` (`:3782-3788`) opens a new lineage in that mode. The new lineage points
back at the retired run (`carriedFrom`) only when all three hold:
- the retired lineage holds `carry`;
- `carry.route` is the route this message takes;
- the retired lineage's text is still known (`carrySource`, `:3451`).

What the thread shows otherwise:
- **The promise names another route.** The new lineage starts fresh, and the thread gets the note a
  route or tier change writes, once per message: "…because this conversation moved to Google Vertex AI
  (Gemini 3.8 Flash). Your earlier messages are still here, but it won't remember them."
- **The update promised nothing.** The new lineage starts fresh with no second note, because the
  update's note already said so.

The carry is checked again at every later send (`carrying`, `:3821`): once the text is withdrawn, the
lineage carries nothing more. The driver still sends carried messages only while the route shares
history at that send, which stays the final gate. The action never turns sharing on.

| Case (from the review) | The confirmation | The note | The next message |
|---|---|---|---|
| A: history shared with AWS only; the thread's engine is Claude Code and its tier sends to AWS | on for AWS Bedrock, carries | carried over | carries the recent messages |
| B: Home, history shared with Claude Code only; the same thread | off for AWS Bedrock | won't remember | carries nothing |
| Sequence 2: history off at the update, shared afterwards | off for AWS Bedrock | won't remember | carries nothing, then or later |
| V1: carried on AWS, then moved to Vertex, both granted | on for AWS Bedrock, carries | carried over; on the move, a second note: moved to Google Vertex AI, won't remember | nothing reaches Vertex; a retry writes no third note |
| V2: Home, history shared with Vertex only; updated on AWS, then moved to Vertex | off for AWS Bedrock | won't remember | nothing reaches Vertex, and no second note |
| Answered on AWS, moved to Vertex before the update, both granted | answered on another service | won't remember | carries nothing |

### Carry-over, on each driver

The bound is draft a.3's, shared by both drivers (`server/harness/conversation-history.ts`,
`boundedHistory`):
- the last 12 answered messages, then the last 24,000 characters with a leading "…", counted across
  the carried run and the new one together;
- the cut never leaves half a character: a surrogate pair it would split is left out whole (review P3
  6);
- only `turn:` steps that succeeded are read, and the decision block is stripped (`spoken`);
- it also counts how many of each run's messages the text holds, including one the cut shortened.

The note is a thread turn, never a run step, so it can never reach a model. `carriedRun` follows the
pointer only to a conversation run of the same project and thread. A run it cannot read (a damaged
file, or one a newer build wrote) carries nothing, and the message is answered without it (review P3
1).

- **Model API** (`server/harness/model-session-run.ts`).
  - `history()` (`:630`) reads the carried run's turns first, then the lineage's own, under the one
    bound.
  - It is gated per send, as before: first the route's history grant (`historyPolicy`, `:745`), then
    `sharingPolicy(…, history.text.length > 0, route)`.
  - So the new lineage keeps carrying the earlier messages, within the bound, on every send, and they
    give way to its own as it grows.
  - The turn's child run records `historyShared`. It records `carriedFrom` and `carriedMessages` only
    when that turn actually sent some of the carried run's messages (`:797`, review P3 3).
- **Claude Code** (`server/harness/claude-session-run.ts`).
  - A new native session is opened for the new lineage.
  - Only its first turn (mode `start`) is prefixed with the bounded transcript (`carriedPrompt`, `:24`;
    `carried`, `:219`). Nothing is prefixed where Claude Code's history grant is off at that send (the
    host's second policy, `server/harness/host.ts:418`), where the carried run cannot be read, or where
    it has no answered message.
  - The native session keeps the transcript from then on, and later turns are not prefixed.
  - That first turn counts as prior conversation for the sharing check (`prior`, `:845`).
  - The turn step records the person's own prompt. Its output records `carried: { from, messages }`:
    the run and the count, never the text (review P3 2). The adapter never sees the pointer (`wire`,
    `:757`).
- **Across drivers.** A lineage may carry from a run the other driver wrote, in the same project and
  thread, under the receiving route's own grant.

**The carry is one step deep** (corrected from version .0, review P3 7). The carried messages are read
from the retired run at each send and never stored in the new lineage's run: its turn steps hold only
the person's own prompts and the answers. So a second update carries only the messages that the
lineage it retires answered itself. What the first update carried is dropped.

### The client

- **`client/api.ts`**: `updateConversation(projectId, threadId, commandId)` and
  `conversationUpdatePreview(projectId, threadId)`.
- **The menu is a new component, `ThreadMenu` (`client/console/ThreadMenu.tsx`).**
  - It is the conversation's own "···" button, at the end of the conversation's head: in the thread
    view (`ThreadView`'s `menu` slot, from `Shell`) and on the Nectovia page (`Diomedes`'s `menu` slot,
    from `DiomedesHome`).
  - It uses the top strip's `.surface-menu` and `.pmenu` with the same outside-click and Escape
    handling, and it is labelled "Conversation menu". Its one item is "Update this conversation".
  - The Shell's top-strip "···" is the interface Detail menu and was left alone.
  - It shows only where it can act (review P3 9): where the dry run says the update would start
    something fresh (`retiring > 0`), or where an update was sent and its answer never came back. It
    reads the dry run again whenever the thread's turns change, and keeps the last read for each
    thread.
- **The confirmation is worded from the server's decision.**
  - It is the Console's `Modal` as an alert dialog, like the job-cap warning: "Update this
    conversation?". It says the conversation starts fresh on the current instructions and the messages
    stay on screen.
  - It reads the dry run when it opens, and `memorySentence` (`client/console/conversation-update.ts`)
    says the memory consequence, naming the route with `routeDisplayName`:
    - carried: "History sharing is on for AWS Bedrock, so Nectovia will carry over your most recent
      messages."
    - `history-off`: "History sharing is off for AWS Bedrock, so your earlier messages stay on screen
      but Nectovia won't remember them. Updating doesn't turn sharing on."
    - `other-route`: "Your earlier messages were answered on another service, so Nectovia won't carry
      them over to AWS Bedrock. They stay on screen."
    - otherwise: "Your earlier messages stay on screen, but Nectovia won't remember them."
  - Update stays disabled until the dry run answers. If the dry run cannot be read, the dialog says
    so. Cancel takes focus first, and Update is the only thing that sends.
- **One command id per thread**, kept in `conversation-update.ts` outside React until the server
  answers it (review P3 9). Pressing Update again after a lost response sends the same command and
  reads back what the first press did, in the same dialog or after it was closed and opened again.
  - A lost answer says: "The update's answer didn't arrive. Press Update again to check whether it went
    through; it's never done twice."
  - Opened again after that, when the dry run finds nothing left to update, the dialog says: "Your last
    update may have gone through already. Press Update to check; nothing is done twice."
  - A refusal counts as an answer. It stays in the dialog with the server's reason, in the attention
    colour, and the next press is a new command.
  - `updated: false` says the conversation already uses the current instructions.
- **After an update**, the thread view reloads the project state. The Nectovia page re-reads the
  transcript and drops the outcome card, which belonged to the answer the note now follows.

Version .0 noted that the dialog (deciding by the conversation's route) and the note (deciding by each
lineage's route) could differ. That is gone: the dialog decides nothing.

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

- **No source text.** `sha256` is the SHA-256 of the UTF-8 bytes of the artifact's source as the
  panel shows and copies it (`ArtifactRecord.source`: the fence body as written, or a table's own
  lines).
- **`title` is the artifact's own, or null** (review P3 8): a visual's title, a declaration's, or the
  heading written just above it (`ownTitle`, `:37`). The server indexes one answer, so it cannot know a
  number such as "Diagram 2" that only the whole thread gives an untitled artifact. The panel numbers
  those itself.
- **The pointer lands on the turn that shows it.** `artifactId` is the key the panel indexes it by
  (`artifactKey(threadId, turnId, blockIndex)`), and `turnId` is the assistant turn the host projects
  for that command.
- **No contract revision.** The existing `transform` kind carries it, and it charges no model call,
  tool call or unit. The model's attribution stays on its turn step (Pillar 07).
- **Only what the person sees.** The artifacts are read from `answerText ?? response.text`: anything
  after an Automatic decision block is neither shown nor recorded.

### Where it is written

On both drivers, right after the message's decision phase and before the run parks: the drive tail
(`model-session-run.ts:871`, `claude-session-run.ts:981`). On a replay of a live run (`:418`, `:413`),
`unrecordedArtifacts` decides what may still be written:
- **Nothing recorded for the message:** all of them (a crash after the answer was saved).
- **Some recorded:** only the ones not yet written (a crash between two of them), and only while this
  build reads every recorded block exactly as its step says. A parser that reads a recorded block
  differently writes nothing, so a retried command is never refused as a conflict and a record is never
  rewritten.

This refines the draft's "write only when the message has no `artifact.` step yet", which could not
finish a set that a crash had cut in half. A settled run is read and never written, as before. `/ask`
replies have no lineage run and record nothing.

### Where it is read

`client/console/artifact-evidence.ts` reads a conversation's lineage runs through the existing
`GET /projects/:id/harness/runs/:runId` and keeps the succeeded, well-formed `artifact.v1:` steps. It
sets each one beside what the thread's text holds at `index.forBlock(turnId, blockIndex)` now,
digesting with `crypto.subtle`:
- **`recorded`:** the same kind and digest.
- **`changed`:** an artifact is there, but with another digest or kind. It is shown as "Changed since
  recorded".
- **`missing`:** nothing is at that place now, because the turn no longer holds an artifact there or
  the thread no longer holds the turn. It is shown as "No longer in the conversation".

Every record is listed; none is dropped (review P3 8). A record is written just before its answer
reaches the thread, so a read in that moment shows it as missing. The next read, which the new answer
itself causes, corrects it. A digest that cannot be computed is shown as a failure, never as a match.

`client/console/RecordedArtifacts.tsx` shows the list, read-only, under the artifact panel's head:
- It is a folded "Recorded in this conversation" list.
- Its summary line names each state it counts, in the attention colour (`evidenceSummary`): "1
  changed since recorded", "2 no longer in the conversation". A change is never folded out of sight.
- A row is titled as the panel titles the artifact now, else by its recorded title, else "Untitled"
  (`evidenceTitle`).
- Each row opens the artifact from the thread's text; a missing one has nothing to open.
- It reads nothing until an artifact is open, and reads again when the thread's lineages or turns
  change.

It is mounted in lane 4's `ArtifactPane` through one new slot, `recorded`, under `board`:
- in the thread view, from `useArtifactHost`;
- on the Nectovia page, from `Diomedes`. `DiomedesHome` supplies the reader, so the page itself still
  never fetches.

## Tests

Every test below was seen to fail:
- **The review-fix unit tests** failed on the unfixed tree before the fixes were written: 22 tests in
  6 files, each for its own reason (`v2-lane2-fix/red-vitest.log`). The client module's test failed
  because the module did not exist yet (`red-client.log`), and mutations C1 to C5 show what each of
  its tests catches.
- **The browser tests** were written after the fixes, so they were made to fail by putting each
  defect back: the reviewed carry and the old client behaviours, one at a time.
- **Mutations.** They were applied one at a time by `scratchpad/v2-lane2/mutate.py` and `pw-mutate.py`
  (version .0) and `scratchpad/v2-lane2-fix/mutate-fix.py` (version .1). Each restores the file byte
  for byte, and each mutation made its named test fail. Logs: `v2-lane2-fix/mutations.log`, with each
  run's output in `mutations-runs.log`.

| File | Tests | Proves | Mutations it failed |
|---|---|---|---|
| `tests/instruction-digests.test.ts` | 10 | The golden list: every fixture reproduces its digest; today's texts are the 0.1.9 fixtures, each known for its own mode; 0.1.8's stay known. | v.0: before the digests were registered it failed; dropping the 0.1.8 Ask digest fails it. |
| `tests/answer-format.test.ts` | 8 | The composed orders; an artifact before the decision block survives `splitDecision`; the examples parse; every named fence is an artifact; the Mermaid rules pass lane 4's pre-check; `/ask` gives Ask and Plan the format and Build only its mode text. | v.0: Automatic without visuals; `/ask` Ask without the format; Build given more; an example id the parser refuses; a Mermaid rule drifting from the pre-check. |
| `tests/lineage-continuity-aws.test.ts` | 15 | Ask, Plan and Automatic lineages opened under 0.1.8's text continue; a new lineage records today's composed text. | v.0: 0.1.8 Plan digest dropped. |
| `tests/lineage-continuity-claude.test.ts` | 6 | Automatic under 0.1.8 continues. The Claude Code carry with sharing on: first prompt only, the pointer never reaches the adapter, and the turn records the run and the count. With sharing off: nothing carried, nothing recorded. | v.0: first prompt not prefixed; carried on every turn; carry ignoring sharing; host never granting it; adapter handed the pointer; 0.1.8 Automatic digest dropped. v.1: no carry recorded (H5); the count taken from the whole run (H6). |
| `tests/interaction-seam.test.ts` | 19 | A conversation opens under the composed text. | v.0: the conversation sent without the format. |
| `tests/conversation-update.test.ts` | 15 | The endpoint on the model-API route: the dry run before and after; the note, the stored promise and the send, with sharing on and off; a grant given after the update carries nothing (sequence 2); sharing turned off after it carries nothing; a turn records the carry only while its messages are sent; the 12-message bound; the note never sent; idempotency; nothing to update; the two 409s; unknown, revoked and later-revoked texts; a tier whose route cannot answer; the body, and a missing thread for POST and GET. | v.0 (on its own code): read-back removed; busy check removed; proposal check removed; note never or always "carried"; pointer never set; note text reaching the model; a 13-message bound; retiring current lineages; a loose body; the carry ignoring sharing at send. v.1: carrying without a promise (X2); unknown texts counted as known (X3); the carry not asked again at each send (X4); the grant left out of the decision (X6); the carry source ignoring the text (X7); a promise stored when none was made (X8); a dry run that always finds something (X9); `carriedFrom` named when nothing was sent (H1). |
| `tests/conversation-update-routes.test.ts` (new) | 5 | The review's cases through the app, with AWS and Vertex fakes and the Vertex token stub: A, B, V1 (with a retry), V2, and a conversation moved before the update. | v.1: the promised route ignored (X1); carrying without a promise, Case B (X2b); lineages on another route promised (X5); no note when the promised route is not taken (X10). |
| `tests/conversation-history.test.ts` | 9 | The bound, the order, answered messages only, the pointer's project and thread; no half character at the cut, whichever way it falls; the per-run counts, a shortened message included; an unreadable run carries nothing. | v.0: 13 messages; carried run last; no character bound; unanswered turns read; another thread carried. v.1: the cut splitting a surrogate pair (H2); an unreadable run failing the send (H3); a shortened message not counted (H4). |
| `tests/artifact-steps.test.ts` | 14 | The step's shape with no source; the index matches the text and tampering is caught; the cap; the replay rule; on the model-API route through the app: recorded after the decision, free, readable through the run read, pointing at the projected turn; a retry writes nothing; a failure between two artifacts is finished by the retry; a changed parser writes nothing; nothing after the decision block; a title recorded only when the artifact has its own. | v.0: digest of the title; place shifted; steps charged; drive tail writing none; replay ignoring the rule; append dropping them; recording past the decision block; no cap. v.1: a thread-numbered title recorded (E1). |
| `tests/artifact-steps-claude.test.ts` | 6 | The same on Claude Code, including a crash before the phase and between two artifacts, each finished after a restart with one model call. | v.0: source kept in the step; origin with no producer; drive tail writing none; replay ignoring the rule; a changed reading still written; a half-written set never finished; append dropping them; recording past the decision block. |
| `tests/artifact-evidence.test.ts` | 11 | What the server records reads as recorded; a changed block and a changed kind are "changed since recorded"; a missing one; a record outside the thread is no longer in the conversation, never dropped; the summary's words; an untitled row named as the panel names it; no digest is never a match; the browser digest is the server's; the run read and its 404. | v.0: digest ignored; kind ignored; missing read as changed; unfinished steps read; a missing run failing the read; any digest accepted. v.1: records outside the thread dropped (E2); missing counted as changed (E3); the recorded title only (E4). |
| `tests/conversation-update-client.test.ts` (new) | 4 | The command id kept for each thread until the server answers it; an older answer never clears a newer command; the menu only where it can act; the sentence for each decision. | v.1: a new command each press (C1); an older answer clearing a newer command (C2); the menu everywhere (C3); history-off not said (C4); an unanswered update never marked (C5). |
| `tests/home-luna.spec.ts` | 3 for this lane (1 changed, 2 new) | On the Nectovia page, a conversation 0.1.8 opened: no menu until there is something to update; the confirmation in the server's words; a lost answer, closed and opened again, sends the same command and reads back; one note; the menu goes; the next answer carries. With history off: "won't remember" in the dialog and the note, and a grant given afterwards carries nothing. A refusal: the server's reason in the dialog, which stays open, and nothing changes. | v.0: the pointer never set; the page never reading the note back. v.1: the refusal not shown (P1); a lost answer read as a refusal (P2); a new command after a reopen (P3); the menu everywhere (P4); history-off not said (P5); carrying without a promise (P6). |

The first run of the version .0 `update` batch reported false passes: the runner matched the "Failed
Tests" banner. It now reads the summary line, and every mutation fails. One version .0 mutation, "`/ask`
Build given the format", genuinely survived at first. Build and Fix reach native work on every real
route, so the mutation was moved to `server/native-work.ts`, where it fails.

The Playwright tests set up a conversation that 0.1.8 opened by rewriting its lineage run's recorded
text, in the run file, to main's 0.1.8 Automatic text from the fixture. No product hook composes an
older text, and that rewrite is exactly the state an update from 0.1.8 leaves. The page is then opened
again, as after the update to this build.

## Gates

The gates ran under the heavy slot (`slot_muenflqg_2df08b3c`, granted 18:02 EDT), with
`DIOMEDES_UI_CLIENT_PORT=5274` and `DIOMEDES_UI_SERVICE_PORT=47732`. They ran on the tree committed
with this record: `origin/main` `1c62427` merged in as `b446c68`, plus this version's changes. The logs
are in the session scratchpad, `v2-lane2-fix/gate-*.log`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| `npx vitest run` | 339 files; 6,007 passed, 4 skipped; exit 0 |
| `npx vite build` | exit 0 |
| `npx playwright test` | 216 passed, none flaky; exit 0 |

Two runs came first, in the same slot:
- **P6 again.** The history-off browser test was changed to check what was sent before the stored
  record, and P6 now fails on what was sent (`p6-rerun.log`).
- **The two tests main's Mermaid change could move.** #48 changed lane 4's `refusal()`, so
  `tests/answer-format.test.ts` and `tests/instruction-digests.test.ts` were run first on the merged
  tree: 18 passed (`precheck.log`).

The suite rewrote `evidence/` and `docs/verification/2026-09-17-design-center/`, and both were restored
afterwards.

## Decisions that differ from the draft or the review

1. The endpoint answers `{ updated, noteId }`, not `{ retired: n }`: the note id is what a retry reads
   back, and a count says nothing a person or a test uses.
2. The carry is one step deep (above).
3. The decision is fixed when the person confirms, and each send checks sharing and the text again.
4. The replay rule finishes a half-written set when the reading is unchanged (above).
5. The direct `claude-sessions` route and Build and Fix are unchanged.
6. On Claude Code the sharing check treats a carried first turn as prior conversation, as well as the
   host's own grant check: two gates, not one.
7. **One more condition than the review proposed:** every retiring lineage must have been answered on
   the route the next message takes (`other-route`). The review's threat was messages reaching a
   different route than the one they were recorded on. Without it, a conversation answered on AWS and
   moved to Vertex before the update would carry to Vertex.
8. The confirmation names the route as `routeDisplayName` does ("AWS Bedrock"). The notes keep the
   lineage lane's names, which include the model ("Google Vertex AI (Gemini 3.8 Flash)").
9. When a send finds a promise made for another route, it writes the lineage lane's route or tier
   note. When the update promised nothing, the send writes no second note, because the update's note
   already said the conversation won't be remembered.
10. Claude Code's carry evidence is on the turn step's output, since its input keeps the person's own
    prompt.

## Open items

1. **Not verified against the real Claude Code CLI.** The carried first prompt is tested with the
   fixture adapter.
2. **A retired run that cannot be read still fails a send (main-level, separate task).** The carry now
   skips a run it cannot read, but `locate` still reads every lineage's run before the driver runs, so
   the send fails with 409 `unsupported_run_version`. The call path is `conversationLocator`
   (`server/app.ts`), then `ModelSessionRuns.locate`, `get`, `HostRunService.load` and
   `ProjectRunStore.read`. This happens with history on and off.
3. **Known gap, recorded only (review P3 4): a chosen but unfinished Start can be stranded.**
   `proposalWaiting` refuses only an outcome that is still `proposed`. If a crash lands between the
   person choosing Start and its work starting, an update retires the lineage, and the retried Start is
   refused as moved on. The window is narrow.
4. **Known gap, recorded only (review P3 10): extra file writes.** Each artifact is its own step, so a
   message with 16 artifacts rewrites the whole run file up to 16 more times, each under the store
   lock. The panel also re-reads every lineage's full run whenever the message count changes.
5. **History fills faster.** Artifact sources ride in history verbatim, so a large design pushes
   earlier messages out of the 24,000-character window sooner (draft, "History fills faster").
6. **Recorded artifacts on older messages.** Messages answered before this build have no steps. The
   list shows nothing for them, and the panel still opens them from the text.
