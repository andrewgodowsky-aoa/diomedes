# The reading line for a long local read (DIO-247)

2026-10-06. Client only, on `feature/local-read-progress` from `98692c2`. Andrew, 08:46 EDT:
"i do want to show that read progress".

## What the thread shows

While a local model reads a long prompt, the live answer in the thread shows one line in place
of the waiting line: the host's sentence, a bar, and the counts the local server reported.

> Reading the document. 65,536 of 117,536

Technical detail adds the unit ("65,536 of 117,536 tokens"). The owner-facing line leaves it out,
as `docs/reference/VOICE.md` section 6 asks. The bar is the Console's `SegmentBar` in its share
form, the same presentation as an update download, so it brings its own styles and adds none.

## Where it comes from

`98692c2` sends `engine-prompt-progress` over `/api/events`: the attempt's identity, a sequence,
the server's `total`, `cache`, `processed` and `time_ms`, and the fixed sentence. Until now no
client code listened for it.

- `client/console/engine-prompt-progress.ts` applies a frame. It keeps the tool-activity rules: a
  malformed, duplicate, late or foreign-attempt frame is dropped, and a newer attempt starts over.
  Every model call in a turn shares the turn's step, attempt and fence, and the sequence runs on
  across them, so a later call's read arrives as the next frame of the same state.
- `client/console/Shell.tsx` listens on the stream it already holds. A frame counts only for the
  ask on screen: the same project, request, run and thread, matched exactly as thinking is.
- `client/console/ThreadView.tsx` draws the line.

## When the line shows

- **Only for a long read.** The part the server did not take from its cache must be at least
  `READING_LINE_MIN_TOKENS` (16,384). llama.cpp reports progress on every streamed call, including
  the short call that only lists a message's files. A plain message, with the app's instructions
  and the longest history a thread keeps, stays under the limit in practice, so the sentence
  names a document only when one is being read. A follow-up read from the cache shows nothing.
- **While it moves.** The line goes when `processed` reaches `total`, when answer text arrives, or
  when the turn ends. The waiting line comes back between the end of the read and the first text.
- **For the thread's own conversation.** The Home conversation (`live-reply.ts`), a Work run's card
  and the Agent loop do not show it. Work emits the same frames under the run's id; the loop emits
  none.

## Tests

- `tests/engine-prompt-progress-client.test.ts`: 6 tests. Order, duplicates, late and foreign
  attempts, a retried attempt, both sides of the size limit, a second call's read inside one
  turn, and closing on answer text.
- `tests/local-read-progress.spec.ts`, in `playwright.bonsai.config.ts` beside the other local
  model spec: the real app, its event stream and the built Console, with only the local worker
  replaced. The transport answers the local server's endpoints with a stream the test steps
  through.
  - A long read shows the bar at 0 and then at 56 percent with its counts, in place of the
    waiting line. The bar goes when the read ends, the waiting line returns, then the answer.
  - A short prompt and a read served from the cache never draw the line.
- Mutation check: with the listener on another event name, the first spec test fails at the bar
  and the second still passes. Restored by hash before the build that followed.

## Coordination

`ThreadView.tsx` was held by the stale `nectovia-work-reskin` claim, and `Shell.tsx` is a charter
hot file. Both edits are under the owner override journaled at 16:12:39Z. The new files and
`playwright.bonsai.config.ts` are claimed by this lane. `console.css` is unchanged.
