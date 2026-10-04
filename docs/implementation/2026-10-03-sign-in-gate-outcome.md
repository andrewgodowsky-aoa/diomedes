# The sign-in gate shows how a browser sign-in ends, 2026-10-03

After a person finished signing in in the browser, the app stayed on the sign-in screen until they
pressed "Sign in with your browser" a second time. Tracked as DIO-187. This change covers the first
part of it: the gate now draws the end of a sign-in on its own.

## Cause

`BrowserSignIn` in `client/AccountGate.tsx` asked `GET /api/account` every 1.5 seconds, but only while
the view said `waiting`. `browserView()` in `server/accounts/session.ts` said `waiting` only while the
native identity was `signing-in`.

When the callback arrives, the listener in `init()` starts `followBrowser()` and does not wait for it.
The account session is set late in `start()`, after the calls to the account service. In between,
`browserView()` answered `ready` with an empty message and `signedIn` was false. A poll that landed
there stopped the polling, so the sign-in, or its failure, was never drawn.

A second path was silent for good. If the reconcile rejected before the session was set, for example
from a write inside `loadAccess`, the caller swallowed the error. The view stayed `ready` with no
message.

The second press worked because `signInWithBrowser()` waits for `followBrowser()`.

## Change

- `shared/accounts.ts`: `BrowserSignInView.status` gains `accepting`, meaning the browser step is done
  and the app is asking the account service to accept the sign-in. A small pure function,
  `browserSignInPending`, says whether the gate keeps polling: true for `waiting` and `accepting`.
- `server/accounts/session.ts`: two new sentences, "Signing you in." and "Sign-in could not finish. Try
  again." The second is the sentence the gate already shows when the browser hand-off itself fails
  (`desktop/native-auth.ts`), so one outcome has one wording. A counter holds the reconciles
  queued and not yet settled. It is raised in `followBrowser()` and lowered in a `finally`, whether
  the reconcile resolved or rejected.
- `browserView()` keeps its `unavailable` and `signing-in` answers first. It then answers `accepting`
  when the identity is `signed-in`, there is no account session and a reconcile is in flight. Without
  the counter, "signed in, no session, no failure" would never end on the silent path above.
- A reconcile that fails sets "Sign-in could not finish. Try again." only when four things hold: it was
  not superseded, there is still no account session, no more specific failure was set, and WorkOS still
  holds a sign-in. Superseded means the lifecycle moved since the attempt began (a cancel, a sign-out or
  a newer attempt), or the error is one `signedOutError()` made, which `assertSignIn` can throw without
  the lifecycle moving. A superseded attempt never sets the sentence, whatever error it ended with. When
  WorkOS holds no sign-in, the person signed out or the kept sign-in ended, so a failure to end the
  local session says nothing. The rejection still reaches the caller exactly as before.
- `BrowserSignIn` polls on `browserSignInPending` and draws `accepting` like `waiting`: the message and
  the Cancel button.
- What 401, 403, an unreachable service and an unchecked WorkOS session do is unchanged.

## Tests

In `tests/browser-sign-in.test.ts`, with the account service's answer to the session call held back:

- After the callback, and before the service answers, `state()` is signed out with `accepting` and
  "Signing you in."; after the answer it is signed in and `ready`.
- In the host API test, the first `GET /account` after the callback is `accepting`, and every answer
  after it is either signed in or one the gate polls through, never `ready` and signed out.
- A reconcile that fails after the service answered, before the session exists, ends `failed` with
  "Sign-in could not finish. Try again.", and the WorkOS sign-in is kept.
- Signing out while a reconcile is in flight reports `ready` with no message at once, and again after
  the held answer is released. This test does not reproduce the defect. It guards the superseded
  branch, which the change had right already.
- A cancel followed by a late failure: the reconcile is held after the service answered, the person
  signs out, and the held step then fails with an error of its own. The view stays `ready` with no
  message. Without the checks the person saw a failure sentence after they had cancelled. Either check
  alone keeps it quiet, because the sign-out also ends the WorkOS sign-in.
- A newer attempt that supersedes a held reconcile, with WorkOS still holding a sign-in: the held
  reconcile fails with an error of its own, and the view stays `ready` with no message. This pins the
  lifecycle check alone. With only the identity check in place it fails.
- WorkOS ends its session elsewhere and ending the local session then fails to write: the view stays
  `ready` with no message. This pins the identity check alone. With only the lifecycle check in place it
  fails.
- `browserSignInPending` is true for `waiting` and `accepting`, and false for `ready`, `failed`,
  `unavailable` and null.

Each of these failed before the change. The sign-out test failed only at its starting point, where the
view must say `accepting`; the branch it guards was right already. The three tests added after the
review failed on the tree as the review found it, because the failure sentence was set. The existing refused,
unreachable, unchecked and password cases pass unchanged, as do the other suites that call
`signInWithBrowser`.

## Not yet proven

No browser-level test drives the gate. The tests above prove what the host answers and when the gate
polls, not what the screen draws.

The WorkOS read inside `identity.session()` has no time limit of its own. While it is pending the gate
shows "Signing you in." with Cancel, and a read that never answers leaves it there.

The rest of DIO-187 is not part of this change: a visible retry and a way to start over, and different
wording for a network fault, a service fault and a refusal.

## Gates

Run on 2026-10-03 from 23:28Z to 23:41Z in `F:/Diomedes/diomedes-wt/sign-in-gate-outcome`, on main
`4dbbd88` with this change, one command at a time under the machine-wide heavy slot:

- `tsc --noEmit`: clean, 31 s.
- `vitest run --maxWorkers=4`: 566 of 566 files passed, 9,647 tests passed, 5 skipped, none failed,
  643 s.
- `vite build`: clean, 13 s.
- Playwright, `tests/ui.spec.ts`, `tests/native-ui.spec.ts` and `tests/field.spec.ts`: 36 passed,
  2.0 minutes.

An independent review read the first pass. It found that the failure sentence could be set after a
cancel, and after a sign-out whose local write failed. The second pass fixed both, added the three
tests that pin them and reused the sentence the gate already had. The gates ran on the second pass.
