# Cache-stable conversation history: the history folds in steps (DIO-23)

Status: built in the worktree, local commits only; not pushed or merged. No provider call was made
for this record.

Work order: `cache-stable-history`, DIO-23 (proposal comment `6ac93689`), owner Andrew, builder
Claude, branch `feature/cache-stable-history`, worktree `F:/Diomedes/diomedes-wt/cache-stable-history`.
Base is `9e03d6e`: origin/main `e848fee` with N4, the conversation prefix cache, and the local read
progress line.

Owner decision (2026-10-06): build the cache-stable history now, and keep today's summary text, so
`compactTurns` stays a first-sentence extract and DIO-239's limitation is neither fixed nor made
worse. Andrew's standing goal is that cached prompt reuse averages 95% or more across
conversations, on cloud and local models.

## The problem

Inside its bounds (12 answered messages and 24,000 characters) a conversation's history is the
whole history, and each message only appends to it. Past either bound, `selectHistory` chose the
history again for every message: the newest messages, the opening one, the most relevant to this
message, a marker listing every omitted message by number, and a summary of the rest. The marker,
the summary and the picks changed with every message, so the history differed from its first byte
and a follow-up reused only the instructions. The N4 record measured 23% to 42% reuse past the
bound.

## The design

`server/harness/context-assembly.ts`.

### Fold in steps, without state

`foldPoint` says how many of the oldest messages are folded behind the marker. It is a pure
function of the messages' sizes, never of the new message or of what it recalls, so every message
of a conversation computes the same boundary from the same history.

The lattice is the conversation's own step points. Replayed from the first message, the boundary
stays where it is while the kept messages fit their room: 12 messages in `KEPT_ROOM_CHARS` (17,400
characters, each message counted with the blank line that joins it), the opening message counted
while it stays whole. When the kept messages outgrow that, the boundary steps to the first message
that leaves them at most half of both: 6 messages and 8,700 characters. The newest message is
always kept. A step point depends only on the messages before it, so a new message never moves an
earlier one.

A fixed multiple of messages was the other candidate. With answers of 2,000 characters, folding six
at a time leaves the kept block nearly full at the first crossing, so it steps at message 13 and
again at message 15. Stepping to half the room steps at message 13 and next at message 18.

### The order

1. The stable head:
   - a marker naming the folded range;
   - this lineage's opening message, whole, when it is 2,400 characters or less (`PINNED_MAX_CHARS`);
   - the summary of the rest of this lineage's folded messages, from `compactTurns`, unchanged.

   A carried lineage's folded messages give way without a summary, as before.
2. The kept messages after the fold, oldest first.
3. What this message recalls: summarised messages that share more of its words than every message
   already in full, at most two (`PICK_MAX`), whole, within 4,000 characters (`PICK_ROOM_CHARS`),
   after their own note.

Parts 1 and 2 are the same bytes for every message until the fold steps, so a follow-up's history
starts with all of them. Part 3 changes with each message, so it goes after them, next to the new
message. `SelectedHistory.stable` says how many characters of the history are parts 1 and 2.

The marker names ranges and never lists messages one by one, for example:

- `[Message 1 follows in full. Messages 2 to 15 are summarised after it.]`
- `[Messages 1 to 7 came before this conversation was updated and are left out.]`
- `[Messages 1 to 3 came before this conversation was updated and are left out. Message 4 follows in full. Messages 5 to 8 are summarised after it.]`

The recall note names what follows it: `[Message 2 is repeated in full here because it bears on the
new message.]`

A summarised message is recalled only when it shares more of the new message's words than every
message already in full (`relevance`, unchanged). A tie adds nothing the model does not have, and
every recalled byte comes after the part a provider can reuse. In the probe every message asks the
same thing, so nothing is recalled there.

### Room

The marker and summary keep their 2,600 characters, the recalled messages 4,000, and the opening
message and kept messages the remaining 17,400. A history therefore never passes 24,000
characters, and `cutHistory` never cuts inside a step. Only a newest message longer than the room
on its own is cut, keeping its end, as before; for that message the opening message is summarised
instead of kept whole.

### The record

`HistorySelection` and `CompactionRecord` keep their shapes (`shared/context-accounting.ts`).

- `method` is `stepped+lexical/2`. Older records keep `recency+lexical/1`.
- `included`, in message order: `pinned` for the opening message, `recent` for each kept message,
  `relevant` with its score for each recalled one.
- `omitted` names every message left out of the text, by number, carried or not. A recalled
  message is in the text, so it is included rather than omitted.
- The summary stands for every folded message of this lineage except the opening one, the
  recalled ones included, so it does not change with what a message recalls.
- `budget.turns` bounds the opening message and the kept messages. The recalled messages are at
  most two more, inside the character bound.

The Context panel's Left out line now reads which messages have a line from the summary record
itself (`leftOutLine`, `client/console/ContextUsed.tsx`), so a recalled message never shifts the
line onto the wrong message. An older record reads as before.

## What was measured

The N4 follow-up probe (`deliverables/conversation-prefix-cache-20261006/probe-plain-followup.test.ts.txt`
in the workspace) ran under the heavy slot on the base `9e03d6e` and on this change. It was copied
into the worktree as an untracked test, and its plain conversation was extended from 14 messages to
14 and 30. It sends a conversation with no files on the AWS test fixture and reports, for each
message after the first, the share of the request that is a prefix of the previous request, and
their average. The instructions and tools are 6,585 characters. Every message asks the same
question, so nothing is recalled.

Percent of each request shared with the previous one, over 30 messages. Messages 2 to 12 are inside
the bounds and the same before and after. A 14-message conversation reads the first 14 rows.

| Message | 600, before | 600, after | 2,000, before | 2,000, after |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 87.3 | 87.3 | 73.7 | 73.7 |
| 3 | 88.7 | 88.7 | 79.0 | 79.0 |
| 4 | 89.6 | 89.6 | 82.3 | 82.3 |
| 5 | 90.4 | 90.4 | 84.8 | 84.8 |
| 6 | 91.0 | 91.0 | 86.6 | 86.6 |
| 7 | 91.6 | 91.6 | 88.0 | 88.0 |
| 8 | 92.1 | 92.1 | 89.2 | 89.2 |
| 9 | 92.5 | 92.5 | 90.2 | 90.2 |
| 10 | 92.9 | 92.9 | 91.0 | 91.0 |
| 11 | 93.3 | 93.3 | 91.6 | 91.6 |
| 12 | 93.6 | 93.6 | 92.2 | 92.2 |
| 13 | 93.9 | 93.9 | 23.1 | 38.4 |
| 14 | 41.6 | 50.6 | 22.9 | 88.0 |
| 15 | 41.0 | 93.2 | 22.7 | 89.2 |
| 16 | 40.3 | 93.6 | 22.5 | 90.1 |
| 17 | 39.6 | 93.9 | 22.3 | 90.9 |
| 18 | 38.9 | 94.1 | 22.2 | 38.7 |
| 19 | 38.3 | 94.4 | 22.2 | 88.0 |
| 20 | 38.2 | 94.6 | 22.2 | 89.2 |
| 21 | 38.2 | 50.9 | 22.2 | 90.1 |
| 22 | 38.2 | 93.2 | 22.2 | 90.9 |
| 23 | 38.2 | 93.6 | 22.2 | 38.7 |
| 24 | 38.2 | 93.9 | 22.2 | 88.0 |
| 25 | 38.2 | 94.1 | 22.2 | 89.2 |
| 26 | 38.2 | 94.4 | 22.2 | 90.1 |
| 27 | 38.2 | 94.6 | 22.2 | 90.9 |
| 28 | 38.2 | 50.9 | 22.2 | 38.7 |
| 29 | 38.2 | 93.2 | 22.2 | 88.0 |
| 30 | 38.2 | 93.6 | 22.2 | 89.2 |

The averages:

| Conversation | Before | After |
| --- | ---: | ---: |
| 14 messages, 600-character answers | 87.6% | 88.3% |
| 14 messages, 2,000-character answers | 76.5% | 82.7% |
| 30 messages, 600-character answers | 60.6% | 88.4% |
| 30 messages, 2,000-character answers | 46.6% | 81.2% |

- The fold steps at messages 14, 21 and 28 with 600-character answers and at messages 13, 18, 23
  and 28 with 2,000-character answers. A message whose fold steps shares little more than the
  instructions with the previous one (38.4% to 50.9%). Between steps every message shares as much
  as a message inside the bounds.
- What a follow-up cannot share is what it adds: the previous answer and the new message. With
  2,000-character answers that is 7% to 26% of each request, so this probe stays under the 95%
  goal even without steps.
- The requests are smaller. At message 30 they are 14,599 characters instead of 17,533 with
  600-character answers, and 21,583 instead of 30,117 with 2,000-character answers, because the
  kept messages fill between half and all of their room.
- The document follow-up in the same probe is inside the bounds and unchanged: 88.4% before and
  after.

## Tests

New, `tests/cache-stable-history.test.ts` (12 tests), on `selectHistory` and `foldPoint`:

- (a) Between steps each message's history starts with the previous message's stable part, then
  the newly answered message, for 600 and 2,000-character answers over 30 messages.
- (b) The fold steps at the same messages every time and for other words of the same sizes, and
  `foldPoint` agrees with the selection. In the test's conversations it folds 8, 15 and 22
  messages from messages 14, 21 and 28 (600 characters), and 9, 14, 19 and 24 from messages 13,
  18, 23 and 28 (2,000 characters). The fold never moves back, steps at least four times in 40
  messages, and with even sizes steps at least five messages apart.
- (c) The newest message is never dropped. It is cut only when it alone passes the room, and then
  keeps its end.
- (d) The marker, the summary and the summary's record are the same between steps, and the marker
  names a range.
- (e) A summarised message that shares more of the new message's words than every message in full
  follows the kept messages, after its note; a tie recalls nothing; at most two are recalled,
  oldest first, under one note.
- (f) No message inside a step is cut (`cutChars` is 0 and every included message is whole) for
  600, 2,000 and mixed sizes. A carried lineage gives way first, without a summary, and the
  history then only appends.
- The Context panel's Left out line with a recalled message and a summary that has no line for
  every folded message, and with an older record.

Changed, where the design changes the expected values:

- `tests/context-accounting.test.ts`. Over the budget: the method is `stepped+lexical/2`; the kept
  messages are 16 to 20 instead of 15 to 20; the recalled messages are exactly message 3; 7
  messages are included instead of 12 and 13 are omitted instead of 8; the recalled message
  follows the newest one; the marker reads `[Message 1 follows in full. Messages 2 to 15 are
  summarised after it.]` instead of listing the omitted numbers; the summary stands for messages
  2 to 15, every omitted one among them. The newest message never dropped for relevance: now the
  kept messages are the same for two different new messages and end with the newest. Carried
  messages give way first: 8 own messages are in the text instead of 12, 3 carried and 4 own
  messages are omitted, the own ones are summarised instead of no summary, and the marker names
  the carried range, the opening message and the summarised range. Its check against
  `boundedHistory`'s message count is gone, since the selection now keeps fewer messages than that
  plain reader. The newest message alone over
  the bound: messages 1 and 2 are omitted and summarised instead of message 1, since two
  10,000-character messages do not fit the kept room of 17,400.
- `tests/context-accounting-driver.test.ts`. The summary stands for messages 2 to 8 and the omitted
  messages are 3 to 8, since recalled message 2 is in the text and its line stays in the summary.
  Added: the recalled message follows the newest kept one, and message 15's request starts with
  message 14's history.
- `tests/conversation-update.test.ts`. The carried history folds to half: message 15 leaves out
  carried messages 1 to 7 instead of 1 and 2, under the marker `[Messages 1 to 7 came before this
  conversation was updated and are left out.]`; message 16 leaves out message 7 instead of 3.
  Added: message 16's history starts with message 15's. The test's title no longer says 12.
- `tests/review-c-h18-context.test.ts` is unchanged and passes.

Run under the heavy slot on this change:

- `npx tsc --noEmit`: passed.
- `npx vitest run tests/cache-stable-history.test.ts tests/context-accounting.test.ts
  tests/review-c-h18-context.test.ts tests/conversation-history.test.ts
  tests/context-accounting-driver.test.ts tests/conversation-update.test.ts
  tests/conversation-prefix-cache.test.ts tests/bonsai-provider.test.ts
  tests/nectovia-agents.test.ts tests/route-capabilities.test.ts tests/rule-authority.test.ts
  tests/ask-row.test.ts tests/pack-playbooks-driver.test.ts tests/route-qualification.test.ts`:
  14 files, 195 tests passed, none failed or skipped.
- `npx vite build`, then `npx playwright test tests/context-used.spec.ts`: 3 passed.
- The probe, `npx vitest run tests/zz-probe-plain-followup.test.ts` (untracked, not committed):
  5 passed, on the base and on this change.

## What is not verified

- No live provider call. The probe measures the longest common prefix of consecutive requests on
  the AWS test fixture, which is the most a provider's prefix cache could reuse.
- Under the owner's Explicit prefix setting (DIO-215), AWS and Azure cache only at the marked
  breakpoints: the stable start of the instructions and the last attached file read. The history
  follows them, so this change raises reuse under Provider default, where the provider caches a
  repeated prefix by itself, and not under Explicit prefix. A breakpoint at the end of the stable
  history would be a separate change.
- The N4 record says the local server restores from a checkpoint at the start of the last user
  message. The history is in that message, so whether the local route reuses the stable history
  depends on the server reusing past that checkpoint. Not measured here.

## Known limits

- A step still changes the history from the marker on, so the message after a step reuses only
  the instructions and the attached files.
- After a step the model sees about half as many messages in full as just before it, with the
  rest summarised. That is the room that lets several messages append before the next step.
- The summary lists the oldest folded messages first and counts the rest, as before (DIO-239).

## PILLAR IMPACT

Pillar 07: the same history works on every route's own cache without naming a model, provider or
payer. Pillar 08: the history is chosen by deterministic host code, not a model step. Pillar 09:
the record still names every message left out and every message the summary stands for, and the
messages stay in their run untouched (decision 10).
