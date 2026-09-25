# DIO-107: the CD05-R-10 two-window test failed under load. The cause was the product.

Date: 2026-09-24/25. Lane `dio107-two-window`, branch `bugfix/dio-107-two-window-load`, based on
`origin/integration/overnight-batch-4` (`ceb4836`), then merged with `origin/main` (`4395331`).
Linear: DIO-107.

## What failed

`tests/diomedes-home.spec.ts` › `CD05-R-10: concurrent first sends adopt one project thread`: two
windows (two pages of one browser context) send their first messages to a new project at the same
time. Under load it failed with:

```
expect(locator('.turn.dio .body').last()).toHaveText('You said: First R10')
Error: element(s) not found   (12000 ms)
```

The page snapshot and trace show more than the assertion does:

- The first window showed the alert *"An earlier message on this conversation was never confirmed.
  Send it again or discard it first."*. It offered the **other** window's message, "Second R10", back
  as unconfirmed, and put its own words back in the box.
- The trace holds exactly one `POST …/messages`. That was the other window's, and it returned 200. So
  that message was confirmed, and the window that sent it had cleared its claim inside the send
  lock. The first window then took the lock, still read the cleared claim, and refused its own
  message without sending anything.

## Root cause: product, not test timing

`client/conversation-send.ts` keeps each conversation's pending claim in `localStorage` and
serialises sends across windows with an exclusive Web Lock. Its correctness assumed the next lock
holder reads what the previous holder wrote. Chromium does not guarantee that. Each renderer reads
`localStorage` from its own cached copy, and another renderer's change reaches that copy
asynchronously, with no ordering against the Web Lock's grant.

Measured with a standalone Playwright script (two pages of one context, each taking the same Web Lock
300 times to read a stored number and write it back plus one):

| Store under the lock | Idle | 4 CPUs busy |
|---|---|---|
| `localStorage` | 16 of 600 increments lost | 24 of 600 lost |
| IndexedDB, each write's transaction completed before release | 0 of 600 lost | 0 of 600, 0 of 2,000 lost |

This can go wrong in two ways, both reachable by a person with two windows or two desktop windows:

1. **A settled claim read back as pending** (the CD05-R-10 failure). The person's message is refused
   with a false "never confirmed", and an already-answered message is offered to Send again.
2. **A pending claim missed.** The next holder cannot see a claim that is still unconfirmed, and sends
   a second message while one is pending. That breaks the one-unconfirmed-message-per-conversation
   rule the module exists to keep.

The test's assertions were correct, and it was catching a real bug. Nothing in the spec was changed.

## The fix

`client/conversation-send.ts` only:

- The claim is **mirrored in IndexedDB** (database `diomedes.conversation`, store `claims`, keyed like
  the `localStorage` claim) on every change made under the lock. The mirror holds the claim's JSON, or
  `null` once the claim has settled.
- The lock holder decides from the mirror (`heldClaim`): the send, Send again, Discard and the
  failed-cleanup sweep all read the claim there. If the holder's `localStorage` copy disagrees, the
  holder writes the mirror's value back into it, so the strip the page shows catches up.
- `save` writes the mirror, and waits for it, before the first request. If the mirror write fails,
  the claim is taken back and nothing is sent, the same rule as a `localStorage` write failure.
  `clear` removes the `localStorage` claim and writes the mirror's `null`. If a mirror write fails,
  that conversation's mirror entry is deleted, so the next holder falls back to `localStorage`
  instead of an older claim.
- If IndexedDB cannot be opened, or the mirror holds nothing yet for a conversation (a claim saved
  before this change), the lock holder reads `localStorage` exactly as before.
- `pendingMessage` (the synchronous read a page uses to show the strip) still reads `localStorage`.

The module comment now says that clearing the site's stored data, rather than only its local storage,
is what turns the next send into a new message.

## Tests

Test first. `tests/conversation-send.test.ts` gained a new block, *"the claim a lock holder reads,
while local storage lags"*. It uses a `localStorage` fake whose writes can be held back from readers
and delivered later, in order, plus a minimal IndexedDB fake. Before the fix, 4 of its 5 tests were
red:

- *a claim the last holder settled is not read back as pending by the next one*. Before the fix it
  failed with the same "An earlier message on this conversation was never confirmed" as the browser.
- *a claim still pending is found by the next holder before local storage shows it*. Before the fix
  the second window minted and sent a second message.
- *a refusal leaves the pending claim readable here, so it can be offered back*. Red before, for the
  same reason.
- *a Discard that the next holder cannot yet see in local storage still holds*. Red before, with the
  false refusal.
- *without IndexedDB, the lock holder reads local storage as it did*. Green before and after; it pins
  the fallback.

After the fix all 5 pass. The existing 51 tests in the file pass unchanged: they run without an
`indexedDB` global, so they exercise the fallback, which is the old path.

## Loaded repeat runs (4 busy-loop processes on 4 CPUs, `--retries=0`)

`stress-ng` is not installed in this container; four `node -e 'for(;;){}'` processes pinned every
CPU for the whole run.

| Build | Runs of CD05-R-10 | Failed |
|---|---|---|
| Base (`ceb4836`) | 20 | 1 |
| Base client file swapped back in, fix removed | 40 | 1 |
| **Before, total** | **60** | **2 (3.3%)** |
| Fixed | 40 | 0 |
| Fixed | 80 | 0 |
| **After, total** | **120** | **0** |

Both base failures had the same signature: the false "never confirmed" refusal, with no answer
painted.

Sibling cross-window tests (`-g "CD05-R-1[01]"`, 7 tests: R-10, its two closure cases, the two
R-11 reproducers and their two closure cases), fixed build, same load, `--repeat-each=10`: **70 passed, 0 failed**. None of them has
R-10's concurrent pattern; the others send in sequence and wait on a web-first assertion between
steps. They share the product fix and needed no change.

## A second finding: Send again assertions that ran before the delivery ended

On the merged head, the first full run of `diomedes-home.spec.ts` failed `CD05-R-06 closure: another
window offers the unconfirmed message and sends the same command`. It expected 3 message POSTs under
one command and saw 2. In the trace, the second window's Send again POST *was* issued; the test
counted before it was. `answers(other).last()` was already "You said: Lost R06", from the transcript
the window opened on, and the unconfirmed strip is hidden while any delivery runs (`Diomedes.tsx`,
`unconfirmed !== null && !pending`). So both web-first assertions passed while the resend was still
in flight, and the count raced it. That is a test defect. The spec's own `say()` helper and the
R-11 closure tests already name this trap, and they wait for `.dio-pending` to reach 0. The fix in
this lane widens the race: the resend now awaits one IndexedDB read before its POST.

The same wait was added after Send again in the three tests that count requests, or act, right after
it: R-06 closure (counts POSTs), R-09 closure (counts request bodies) and the first R-10 closure (presses
Enter, which the box ignores while a delivery runs). No assertion was removed or loosened.

- R-06 closure on the fixed build, before the test change, idle: 1 of 10 failed.
- After the test change, idle: 0 of 30 failed.
- The base rate of this race was not measured: `diomedes-home.spec.ts` was not in this lane's
  base gate run.

## Gates

See the PR body for the counts from the final run on the merged head. Base counts, recorded before
any change (`ceb4836`): `tsc` clean; vitest 393 files passed and 1 skipped, 7,036 tests passed and 18
skipped; `vite build` OK; Playwright `ui` + `native-ui` + `field` 36 passed.

## Known gaps

- `pendingMessage`, which the page uses to show or hide the unconfirmed-message strip, still reads
  the window's own `localStorage` copy. A window that is behind can briefly show a settled message's
  strip, or not show a pending one. Any action on the strip (Send again or Discard), and any new
  send, decides from the mirror under the lock, so a stale strip cannot send or discard the wrong
  command. Only the display can lag. Reading the mirror there would make those reads asynchronous
  in `DiomedesHome.tsx` and `Shell.tsx`; this lane left that alone.
- The IndexedDB fake in the unit test models only the calls the mirror makes. The consistency
  property itself was measured in real Chromium (table above), not in the fake.
- `lastCommand` (the "claim naming the last confirmed command" check) still reads `localStorage`.
  With the mirror, that check only matters on the fallback path or after a mirror write failed.

## Proposed canonical-doc patch

No status change is warranted. This is a defect fix inside an already-shipped CD-05 behaviour; no
capability is added and no definition changes. Proposed, for the integrator to apply if wanted:

- `docs/DIOMEDES_PROJECT_MEMORY.md`, wherever the pending (unconfirmed) conversation message is
  defined: append *"Across windows, the claim a send decides on is read from IndexedDB under the
  send lock; local storage is what the page shows (DIO-107,
  docs/implementation/2026-09-24-dio107-two-window.md)."*
- `docs/DIOMEDES_LIVE_ROADMAP.md`: none.
- `docs/DIOMEDES_CORE_PILLARS.md`: none.
- `QUESTIONS.md`: none.

## PILLAR IMPACT / ROADMAP IMPACT / BUILD STATUS

- **Pillar impact.** Supports "the record is the authority, never a guess". The one-unconfirmed-message
  rule now holds across windows under load, where before it could be broken both ways. No conflict.
- **Roadmap impact.** None: a defect fix, and no roadmap item changes status.
- **Build status.** Branch only, with a draft PR against `main`. Not merged, not packaged, not
  released. Version and native-runtime hashes are untouched.
