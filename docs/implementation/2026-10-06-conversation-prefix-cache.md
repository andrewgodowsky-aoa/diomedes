# Conversation prefix cache: the host reads attached files before the history (DIO-247.N4)

Status: built in the worktree, local commits only; not pushed or merged. No live provider call and no GPU
run was made for this record.

Work order: `conversation-prefix-cache`, DIO-247 item N4, owner Andrew, builder Claude, branch
`feature/conversation-prefix-cache`, worktree `F:/Diomedes/diomedes-wt/conversation-prefix-cache`.
Base is `98692c2` (the DIO-247 long-context local route). Pillars are version `2026-10-06.1`.

Owner decision (DIO-247, 2026-10-06): the host makes the read, as a recorded `read_source`
exchange after the system prompt and before the history. Acceptance is at least 95% of a second
turn's prompt served from cache. Andrew, 2026-10-06 08:36 EDT: caching at a 95%+ average on cloud
models and elsewhere matters; allow longer answers.

## The problem

A conversation message sent the history, then the list of attached files, then the person's
message, all in one user message. The model then read each file with `read_source`, so the file
text came after the history. Each message's history differs from the last, so a follow-up's
request changed straight after the instructions, and a provider could reuse only the
instructions. The DIO-247 dry run measured 2.08% of a 118,000-token follow-up served from cache.

## The order now

The host reads every attached text file itself, before the history and the message:

1. The instructions (system text), unchanged.
2. A fixed opener: "Read the files attached to the message that follows."
3. For each text file, in path order: a `read_source` call and its result.
4. The composed message: the history, the list of files, and the person's words, last.

- The reads are recorded tool steps `host:0`, `host:1` and so on, through the same registry, step
  record and replay as the model's own calls (`NativeAgent.run`, option `hostReads`). Only a tool
  the run offers, with effect `read`, no permission, no approval and a local destination, may be
  called without the model asking.
- Path order, compared by code unit, so the order the person picked the files in never changes
  the bytes.
- Each read's call carries a host id fixed by position, `host-read-1` and so on (`hostCallId`).
  The model's own calls keep the provider's ids and the private transcript.
- `hostReadCount` recognizes the reads by the opener at the start, so the shared harness contract
  does not change.
- The list of files in the message says which were read above. An image still goes as bytes on
  the person's message, after the reads.
- The person's words stay last, so the decision format still reads the issued identity from the
  last line of the message.

Two messages that attach the same files send the same bytes up to the person's message. That is
the part a provider's prefix cache can reuse:

- A provider that caches a repeated prefix by itself reuses the instructions and the files.
- On AWS and Azure under the owner's Explicit prefix setting (DIO-215), a provider caches only at
  marked breakpoints. A call that carries the host's reads now marks two: the end of the stable
  start of the instructions, as before, and the result of the last read. Provider default and Off
  send the same bytes as before.
- The local server keeps a checkpoint at the start of the last user message of each prompt and
  restores from it on the next one. The person's message is that last user message, so a
  follow-up restores at the end of the reads: reuse is about the tokens before it.

## Budgets and the record

- The turn's tool-call budget grows by the number of reads, so the model keeps its own sixteen.
  The reads cost no units. The model's own calls per message are unchanged.
- The context account counts the reads with the project files, detail "N attached, read before
  the message", and leaves them out of the tool results.
- Under Explicit prefix the record's `cache.marked` is `stable-prefix-and-files` (or
  `whole-instructions-and-files`) when the files were marked, with its own sentence. The
  too-short check counts the files in the marked start.
- `cacheFieldsMatch` accepts the second breakpoint only on the first part of a tool result whose
  call id is a host id that no later host read follows. Any other second breakpoint, or a missing
  one, is refused before the request leaves, and the hold is released.

## Longer loop answers

The Agent loop kept 4,000 characters of its lead's final answer as the finish claim. It now keeps
64,000 (`LOOP_LIMITS.claimChars`), still a bound on the run record. A delegate's answer was never
cut by this bound.

## What was measured

| What | Result |
| --- | --- |
| Follow-up on AWS, three 16 KB files, short history (test fixture) | 98.88% of the follow-up's input bytes shared with the first message |
| Message at the admission limits: eight files, 127,600 bytes of quoted Markdown, a 24,000 character history, Ask | 176,100 bytes of the route's 200,000 |
| Dry run, 115,000-token ledger with a follow-up, before | follow-up cache reuse 2.08%, two model calls for the first message |
| Dry run, same task, this branch | follow-up cache reuse 99.62%, one model call, simulated prefill 0.48 s against 125 s |

The dry run predicts reuse as the longest common prefix with an earlier prompt. A server that
restores only at checkpoints reuses up to the checkpoint at the start of the last user message,
which here is the end of the reads, so the two agree to within the message header.

## A follow-up without the same files

The host's reads help a message that attaches the same files as the one before it. Other
follow-ups were measured on the AWS test fixture as the share of each request's bytes that matches
the request before it, which is the most a provider's prefix cache could reuse:

| Conversation | Reuse by message | Average |
| --- | --- | --- |
| 14 plain messages, answers of 600 characters | 87.3% at message 2, rising to 93.9% at message 13, then 41.6% at message 14 | 87.6% |
| 14 plain messages, answers of 2,000 characters | 73.7% at message 2, rising to 92.2% at message 12, then 23.1% and 22.9% | 76.5% |
| Three files on message 1, none attached on message 2 | 88.4% of a request that shrank from 61,440 to 7,512 characters | |

The fixture's instructions and tools are 6,585 characters. Longer instructions raise every figure.

- Each follow-up carries the previous answer and the new message, which no earlier request held.
  That share falls as a conversation grows, and no order of the request removes it.
- Past 12 answered messages or 24,000 characters of history, `selectHistory` chooses the history
  again for every message: the newest, the opening message, the most relevant to this message, and
  a summary of the rest behind a marker that lists what was left out. The history then changes from
  its first byte, and a follow-up reuses only the instructions. That selection is H18's (DIO-23).
  A cache-stable version would compact in steps and place each message's relevant picks after the
  part that stays the same.
- The composer clears a message's attached files once it is sent (`client/console/Composer.tsx:337`),
  and `read_source` reaches only the files attached to that one message. In the app, a follow-up
  carries a document, and reuses it from the cache, only when the person attaches it again.
  Keeping a thread's files attached for its next messages is a product decision.

## What is not verified

- No live provider call. Whether each provider accepts the shapes is checked by the SDK's
  serialization and the guard, not by a provider:
  - Gemini on Vertex: the host's call carries the SDK's documented placeholder signature, and the
    request holds a function response followed by the person's text as consecutive user contents.
  - Responses with `store:false` on AWS and Azure: function call items the host issued.
  - A cache breakpoint on a tool result's part, on AWS and Azure.
- Under the provider's default, reuse depends on the provider caching a repeated prefix by itself.
  DIO-215's route checks measure that per model. Routes outside DIO-215's setting send no cache
  fields, so their reuse is whatever their upstream does by default.
- The GPU proof of `cache_n` on a second turn belongs to the local route's own lane.

## Known limits

- A follow-up reuses the files only when it attaches the same files with the same contents.
  Changing, adding or removing a file changes the prefix from that file on.
- Every attached text file is now sent on the first call. Before, the model read the files it
  chose, and its last call carried what it had read. A message at the admission limits with files
  heavy in quotation marks or line breaks can exceed the route's request limit, which refuses it
  before anything is sent, as before when the model read every file.

## Tests

- `tests/conversation-prefix-cache.test.ts`: `hostReadCount` edges; two AWS messages that share
  every byte before the person's message; the recorded steps and budget; seven calls of the
  model's own after the reads, each call starting with the same reads; the explicit prefix on a
  real conversation; a message at the admission limits; the local route's chat messages on a
  follow-up; an image after the reads; the record's sentences and the too-short check.
- `tests/route-cache-bodies.test.ts`: the second breakpoint on all three bindings, the guard's
  cases, and Provider default and Off unchanged.
- `tests/native-loop.test.ts`: a long final answer is the whole claim; one past the bound is cut.
- Seven existing test files moved to the new order. In `tests/plain-writing-routes.test.ts`, the
  fake provider now reads the person's message as the last user item, after the host's opener.

## Gates

On `fc9ca1f`, under heavy slot `slot_muws2uwl_eb2b478e`, 2026-10-06 14:32Z to 14:52Z:

- `tsc --noEmit`: 0 errors.
- `vite build`: passed.
- Full vitest: 10,208 passed, 1 failed and 5 skipped of 10,214, in 605 files. The skips are
  platform and engine conditions in files this change does not touch. The failure was
  `tests/plain-writing-routes.test.ts`, whose fake provider answered from the first user item,
  now the host's opener. With the fix, under slot `slot_muwssuwo_f8b552a9`: 8 of 8.
- Full Playwright: 353 of 353 passed.
- Earlier, as the commits were made: the 28 affected test files, 481 of 481; the new tests, 64 of
  64 across five files; the loop's tests, 47 of 47.

## PILLAR IMPACT

Pillar 07: the same order works on every route's own cache, cloud or local, without naming a
model, provider or payer. Pillar 08: reading the attached files is deterministic host work, not a
model step, which saves the model calls that read each file. Pillar 09: the reads are recorded tool steps
under Runtime and Trust, and only files the person attached and the project's sharing allows are
sent, as before; a follow-up's cached input costs less on routes that price cache reads lower.
