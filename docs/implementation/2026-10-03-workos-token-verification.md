# WorkOS token verification on the Workers runtime, 2026-10-03

Andrew signed in with the installed 0.2.2 build. Firefox went blank, the app did not sign in, and its
sign-in button then did nothing. The callback fix of 2026-10-02 worked: the app received the callback
and stored a WorkOS session. The account service then refused it. Tracked as DIO-186.

## Cause

The deployed Worker answered every `GET /account/session` that carried a WorkOS token with 503 in 2 to
4 ms, and logged `{"event":"identity-unavailable","step":"jwks"}` with no HTTP status.

`services/control-plane/src/identity-workos.ts` stored the global `fetch` and called it as a method,
`this.fetcher(url, ...)`. The Workers runtime refuses that with `TypeError: Illegal invocation`. It also
passed `redirect: 'error'`, which the runtime refuses with `TypeError: Invalid redirect value`. Both
throw inside the `try` whose `catch` reports the provider as unavailable. Node accepts both. Both date
from the file's first commit, so the deployed service had never accepted a WorkOS sign-in.

Checked on 2026-10-03 in local workerd (wrangler 4.135.0, compatibility date 2026-09-19) against the
real signing-keys address: the member call gave Illegal invocation, a plain call with `'error'` gave
Invalid redirect value, and a plain call with `'manual'` gave 200.

The app's button did nothing because it already held a WorkOS session. It retried the same call
without opening a browser, got the same 503 and redrew the same screen. That behaviour is DIO-187.

## Change

`identity-workos.ts` now calls the global as a function, the form `credit-purchases.ts` already uses,
and passes `redirect: 'manual'`, as the managed-provider calls do. A redirect is still never followed:
a 3xx fails the existing `!response.ok` check, and nothing is sent to its target.

## Tests

- `scripts/runtime-smoke.mjs` with the new `tests/runtime/default-fetch-worker.ts`: the verifier runs in
  workerd with no `fetch` passed in. Provider answers come from fixtures at the Worker's outbound
  boundary (`dev.outboundService` feeding an undici `MockAgent` that refuses anything unregistered).
  Three cases: a signed token verifies with three provider calls, the signing-keys call without the API
  key and the other two with it; a 302 from the signing-keys call answers 503 and its target is never
  requested; a 302 from the sessions call, which carries the API key, answers 503 and its target is
  never requested.
- The same run fails on the old code, and with either edit alone: 503 and no outbound request. With
  `redirect: 'follow'` the two redirect cases fail, and the trace shows the runtime sending the API key
  to the redirect target.
- `tests/account-service-review-independent.test.ts` pinned `redirect: 'error'` on every provider call.
  It now pins `'manual'`. The deploy build runs this suite.

Why the old tests passed: each one handed the verifier a JavaScript `fetch`, including the workerd
smoke through `tests/runtime/crypto-worker.ts`. Production passes none.

## Review

An independent review found the pinned test above and asked for direct proof that the API key is not
sent to a redirect target. Both are in this patch. It found nothing else on the `/account/session` path
that the Workers runtime treats differently from Node.

## Gates (2026-10-03, on this patch)

In `services/control-plane`:

- `npm run typecheck`: passed.
- `npm test`: 1,004 passed and 55 skipped, out of 1,059 tests in 58 files (53 passed, 5 skipped).
- `npm run test:runtime`: passed, with the three default-fetch cases above.
- `wrangler deploy --dry-run`: passed.

At the repository root:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: two default runs failed in one file. The first gave 9,635 passed, 5 failed and
  5 skipped, and the second 9,638 passed, 2 failed and 5 skipped, out of 9,645 tests in 566 files. Every
  failure was a bounded wait in `tests/automatic-work-host.test.ts`. This patch does not touch that
  file, and its faux cloud runs in password mode, so it never builds the WorkOS verifier. Run alone, the
  file passed 38 of 38. With `--maxWorkers=4` the full suite passed: 9,640 passed and 5 skipped, 566
  files. Another lane saw the same file fail the same way on its own branch that day.
- `npx vite build`: passed.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: 36 passed
  (ui 17, native-ui 11, field 8).

## Proven on 2026-10-03

Pull request 210 merged as 4dbbd88. Workers Builds deployed version 0bff8bf9 at 22:38Z. The installed
0.2.2 build signed in at 22:42Z, and again after an account swap at 22:43Z. `GET /account/session`
answered 200 both times. The session list, the user lookup, the freshness window and the subject check
on a first sign-in all passed.

The behaviour on a cold database was not observed. It is the subject of DIO-188.
