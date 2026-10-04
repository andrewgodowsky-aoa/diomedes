# The browser lands on a page of the app after sign-in, 2026-10-03

After a person signed in with WorkOS in the system browser, the browser tab stayed on a loading bar.
The owner saw it on Windows with Firefox on 2026-10-03. Tracked as DIO-190.

## Cause

WorkOS sent the browser to `diomedes-auth://callback`. The operating system handed that address to
the app, and sign-in went on in the app. The browser had no page to show for a custom protocol, so
the tab never finished loading.

## Change

The owner approved this design. While a sign-in attempt is waiting, the app listens on
`http://127.0.0.1:47319/callback` and uses that address as the redirect. The browser lands on a small
page. The custom protocol stays as the fallback when the port cannot be had.

WorkOS was checked against the customer environment the same day. It accepts exactly
`http://127.0.0.1:47319/callback` and `diomedes-auth://callback`. Another port, `localhost` or another
path is refused as redirect-uri-invalid.

All of it is in `desktop/native-auth.ts`.

- `NATIVE_AUTH_LOOPBACK_CALLBACK` is the production redirect. `NATIVE_AUTH_CALLBACK` and its line are
  unchanged, so `scripts/account-readiness.ts` and the packaging test still find it.
- `createNativeAuth` takes `callbackPort`, which defaults to 47319. Tests pass a port of their own.
- The SDK fixes the redirect when it is built. So the app builds a second session manager for the
  loopback redirect, with its own config, `AuthOperations` and ceremony. It shares the core, the
  client and the storage with the first. Kept sessions, refresh and sign-out stay with the first
  manager, as before. Three facts in the SDK make the sharing safe. `AuthKitCore` never reads the
  redirect. Checking the callback state reads only the cookie password. The code exchange,
  `authenticateWithCode`, sends no redirect at all.
- Each attempt tries to bind `127.0.0.1` on the port first. If that works, the attempt uses the
  loopback manager. If it fails for any reason, the attempt uses the custom protocol manager exactly
  as before. Protocol registration is still checked first, as before.
- An attempt that falls back because the port could not be had writes one warning line, in the same
  way as the callback warning already in this file: "Native sign-in could not listen on its callback
  port, so this attempt returns through the app protocol." It names no code, state, URL or other
  program, and it is written at most once per attempt. It tells why the old loading bar came back.
- The safe browser now opens an authorize URL only when its redirect is the one this attempt chose.
  Everything else it checked is unchanged. As it opens that URL it keeps a SHA-256 digest of the
  OAuth state in memory. The state and the code are never kept, logged or written.
- The listener answers only `GET /callback` with the Host header `127.0.0.1:<port>`, sent once.
  Another Host gets 403, another path 404 and another method 405, each with an empty body.
- A callback whose state does not match the digest gets the failure page and never reaches the
  sign-in. Any page on the machine can send requests to the port, and none of them can end, fail or
  use up the attempt. A matching callback is turned into the same `diomedes-auth://callback?...` URL
  the operating system would deliver and goes through `handleCallback`, so the state and PKCE checks
  stay where they were.
- A web page can still tell that a sign-in is waiting, by whether the port accepts connections. It
  cannot learn the code or the state, and it cannot affect the attempt. That comes with a fixed
  loopback redirect.
- The page is sent once the WorkOS step is known. It says "You're signed in. You can close this
  tab." when the code exchange with WorkOS succeeded and the app holds the sign-in. In every other
  case it says "Sign-in could not finish. Try again." The page speaks for the WorkOS step only. It is
  sent before the account service answers, so the tab can say the person is signed in while the app
  then shows the service's refusal, or that the service did not answer.
- The page is sent after fifteen seconds at most. When the limit passes before the code exchange
  answers, the attempt ends as failed there, so the tab's sentence stays true. The listener closes.
  The storage generation advances, so the late exchange can neither keep a session nor sign anyone
  in, whether it then succeeds or fails. The handling lock is released, so the callback of a new
  attempt is not refused while the old exchange is still pending. The app shows signed out with
  "Sign-in could not finish. Try again." and its listeners are told. The person can press Sign in
  again at once. If the attempt already ended before the limit, the limit does nothing. Tests pass a
  shorter limit through `callbackPageLimitMs`, which defaults to fifteen seconds.
- The page is fixed bytes with the title Nectovia, one inline style, no script and no outside
  resource, and it reads in light and dark. Its Content-Security-Policy allows nothing but that
  style, by its hash.
- The listener closes when the attempt succeeds or fails, when the page limit passes, when it is
  cancelled or replaced, on sign-out, when secure storage becomes unavailable, and when the app
  quits. `desktop/main.mjs` already calls `dispose()` on `will-quit`, so it is unchanged.
- One behaviour changes on both paths. When WorkOS sends the person back with an error, such as
  `access_denied`, the app now shows "Sign-in could not finish. Try again." Before, it went back to
  signed out with no message.
- What a 401, a 403, an unreachable service or an unchecked session do after the callback is
  unchanged. Nothing changed in `server/accounts/session.ts` or `client/AccountGate.tsx`.

What the loopback redirect gives up. When the app quits, crashes or restarts for an update while the
browser step is open, the browser reaches no listener and shows its own cannot-connect page. Nothing
relaunches the app, and the person opens it and signs in again. Before this change the custom
protocol relaunched the app and the sign-in completed, because the pending sign-in is kept on disk
for ten minutes. On Windows, closing the window quits the app, so closing it during the browser step
has the same effect. An attempt that fell back to the custom protocol still relaunches the app as
before.

Five test files and one smoke driver built a native sign-in without a port. With the new default
they would bind 47319. Each now holds a port of its own and passes it, so they stay on the custom
protocol path and their assertions are unchanged: `tests/native-auth.test.ts`,
`tests/browser-sign-in.test.ts`, `tests/native-sign-in-repair.test.ts`,
`tests/native-sign-in-repair-review-independent.test.ts`,
`tests/native-sign-in-review-independent.test.ts` and `tests/fixtures/native-sign-in-review-smoke.mjs`
(which passes its own fixture server's port).

## Tests

In `tests/native-auth.test.ts`, under "loopback callback page", each with a free port of its own:

- The production constant is exactly `http://127.0.0.1:47319/callback`.
- With the port free, the authorize URL carries the loopback redirect. `GET /callback` with the
  attempt's code and state signs in, the body is the success page, it holds neither the code nor the
  state, and the port is closed afterwards.
- With the port already held inside the test, the authorize URL carries `diomedes-auth://callback`
  and the protocol callback signs in as before.
- A loopback attempt finished by the protocol callback also closes the port.
- Both pages: the exact headers, the policy with the hash of the page's own style, the title, one
  sentence each, and no script, link, image, italics or dash. Two different foreign requests get the
  same bytes.
- A wrong, longer, shorter or missing state, a duplicate state and an unknown key each get the failure
  page. No code exchange happens, the attempt is still waiting, and the right callback then signs in.
- Wrong paths are 404, wrong methods 405 and wrong Hosts 403, each with an empty body. The attempt
  then still signs in.
- `<script>x</script>` in the code, the state, the error, a key, the path and the Host header appears
  in no response.
- A cancel, a sign-out from the account session and app quit each close the port.
- A new attempt after a cancel listens again on the same port. The first attempt's state gets the
  failure page and the second signs in.
- `error=access_denied` gets the failure page with no exchange, and the app shows "Sign-in could not
  finish. Try again."
- A failed code exchange gets the failure page, and the app shows the same sentence.
- An authorize URL whose redirect is not the attempt's is never opened, on either path.
- A callback whose state is not the attempt's, with a code or with an error, never reaches the SDK's
  single-use take of the pending sign-in. The test spies on that take. Only the digest check passes
  this test: without it, a foreign state is still refused later by the SDK, so every other assertion
  holds.
- With the port held, exactly one warning line is written for the attempt, and it holds neither the
  code nor the state. With the port free, none is written.
- Under "page limit", with a limit of 500 milliseconds passed through `callbackPageLimitMs`:
  - An exchange slower than the limit: the tab gets the failure page at the limit, the app is signed
    out with "Sign-in could not finish. Try again.", and the port is closed.
  - The slow exchange then succeeds: the app is still signed out, nothing more is sent to the window,
    and no session was kept.
  - A new attempt begun after the limit binds the port again, and its callback signs in while the old
    exchange is still pending. The old exchange then fails, and the app stays signed in.

In `tests/browser-sign-in.test.ts`, one end to end test with the faux WorkOS stand-in: the redirect is
the loopback address, the test follows the stand-in's redirect to the app's own listener, the page
says the person is signed in, the account session signs in, WorkOS traded the code once, and the
listener is gone afterwards.

Every new test failed on the base except two. The held-port test passes on the base because it
describes today's behaviour. The protocol callback test was tightened to check first that the port
is open, so it fails on the base too.

The five tests added after review were proven another way. With the digest check, the page limit's
ending of the attempt and the warning line all removed at once, exactly those five failed and the
other 54 tests in the file passed. The digest test failed on the spy alone, which shows that no other
test needs the digest check. All three were then restored.

The helper `signInAtWorkOS` in `tests/browser-sign-in.test.ts` still asserts the custom redirect. It
is unchanged: `launch()` now passes a held port, so those tests stay on the custom path.
`tests/desktop-packaging.test.ts` is unchanged, because the line it pins is unchanged.

## Not yet proven

Nothing has run the listener inside Electron. Both smoke fixtures stay off the loopback path: one
holds the port, and the other refuses protocol registration before any bind. The changed fixture
`tests/fixtures/native-sign-in-review-smoke.mjs` was not run. Nothing was run on macOS. No real
browser was driven: the tests make the browser's requests with Node. The fifteen second default
itself is not waited out by a test; the tests pass a shorter limit. A listener whose attempt is
never finished stays open while the app waits, as the waiting state itself does; the SDK's pending
state expires after ten minutes, and the listener does not close on its own at that point.
`scripts/account-readiness.ts` still checks only the custom redirect with WorkOS.

## Gates

Run on 2026-10-04 from 03:21Z to 03:38Z on commit `98ee7f8`. That commit is this change with main at `cb4c490` merged in, so the tree is the one main gets. Each command ran alone, under the coordination heavy slot.

| Gate | Result |
|---|---|
| Root typecheck | clean |
| Root unit suite, two workers | 567 of 567 files. 9,674 tests passed, 5 skipped |
| Production build | passed |
| Browser suite | 36 passed |

Before that, on the uncommitted change: the eight sign-in test files passed 191 of 191 with a clean typecheck, and the two release notes test files passed 50 of 50.

This change touches nothing under `services/control-plane`, so the service gates were not run for it. They ran for the service change that main already holds (pull request 213).
