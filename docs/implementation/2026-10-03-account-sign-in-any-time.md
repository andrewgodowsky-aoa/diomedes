# Signing in at any time, 2026-10-03

People must be able to sign in whenever they open the app, with nobody waking the database first.
Tracked as DIO-188.

## Cause

Every account action in `services/control-plane/src/account-service.ts` checks the verified proof
three times: after the identity provider answers, after the identity lock in the transaction, and
after the action, before the commit. A proof verified more than five seconds earlier was refused with
401 at any of the three.

The Postgres database (Neon) suspends when idle and starts on the next connection, in about 0.4 s and
1.5 s at worst over the last three days. A slow start or a slow lock wait could therefore age a correct,
live proof past five seconds. The answer was 401, and the desktop app treats 401 or 403 from
`GET /account/session` as a refusal: it ends the WorkOS sign-in and the person must sign in again.

Two smaller faults made this more likely and harder to see. `services/control-plane/src/worker.ts`
built the customer verifier once per request, so its five minute signing key cache never outlived a
request and every request fetched the signing keys from WorkOS. And when a provider call threw, the
`identity-unavailable` log line named the step but not what was thrown, which is why a runtime
`TypeError` looked like a network fault for two weeks (DIO-186).

## Change

A stale proof never signs a person out. Expired proofs, and proofs issued or verified in the future,
still answer 401 exactly as before. Only staleness changes. When it is found before the action runs,
in the first check or right after the identity lock, the service verifies the identity again once and
runs the whole transaction again from the start, in a new transaction after the first rolled back.
When it is found after the action, or the second attempt is stale too, the transaction rolls back and
the answer is 503 with the sentence "The sign-in check took too long. Try again." and the code
`identity_recheck`. The account handler adds `Retry-After: 1` to that answer and to no other.

The five second bound does not widen. Every check that ran before still runs, against a proof
verified at most five seconds earlier, and nothing a stale attempt wrote is kept. An action never
runs twice: once it has started, a stale proof is refused, not retried.

The staff key verifier and the faux identity produce proofs for the same service, so staff routes
and the faux cloud get the same 503 for staleness. The managed gateway used to answer 401
`sign_in_required` for a stale proof, which the desktop showed as "Sign in to use the Nectovia
Agent." without ending the session. It now answers 503 `identity_recheck`, which the desktop shows as
a provider error carrying the service's sentence. Naming that code in the desktop is a follow-up and
not part of this change.

The Worker now keeps the customer signing keys for the life of the isolate. They are fetched once and
reused for five minutes, and an unknown key id refreshes them at most once every thirty seconds, now
across requests. Only the keys and the time they were fetched are kept, in a plain object, for one
client id at a time: the signing key URL depends on the client id alone, and another client id gets a
new object. No API key or other secret is kept. Each request still builds its own verifier and hands
it that object. The session list and the user are still read from WorkOS on every request. The staff
verifier, the account service and the repository are still built per request. The thirty second and
five minute bounds hold for requests that come one after the other. Requests that arrive together on
a stale cache may each fetch the signing keys. That is no worse than main, where every request
fetched them.

Because the keys are now shared, the thirty second limit could hold back a real token. A token signed
with a key WorkOS has just rotated in would have been refused with 401 for up to thirty seconds after
any other request fetched the keys, and the desktop ends the WorkOS sign-in on a 401. On main every
request fetched fresh keys, so this could not happen. Now an unknown key id on keys fetched less than
thirty seconds earlier answers 503, through the `identity-unavailable` line with the step
`signing-key-recent`, and fetches nothing. After thirty seconds the keys are fetched again once, and a
key id still unknown answers 401 as before. When the request itself just fetched the keys, because
none were kept or they were five minutes old, an unknown key id answers 401 as before, since that
fetch is the fresh look.

Two key fetches on one cache can finish out of order. Each fetch now notes when it started and writes
its keys only if that start is not earlier than the stored fetch time, so an older key set never
overwrites a newer one. The time stored is when the fetch started.

A verifier or a key fetch is never shared across requests. A fetch belongs to the request that
started it, and Cloudflare cancels it when that request ends or its client disconnects, unless
`waitUntil` holds it. A cancelled fetch never settles. The first version of this change kept one
verifier per isolate, and with it the promise of the key fetch in flight. In local workerd, a request
that started a verification and returned without awaiting it left that promise unsettled: its key
fetch never reached the network, and the next request in the isolate waited on it and had no answer
in 15 seconds, with nothing in the log. A verifier now waits only on a fetch it started itself, and
writes the keys and their fetch time together, with no await between them.

When a provider call throws, the `identity-unavailable` line now carries the thrown value's name as
`error`, such as `TypeError` or `AbortError`, or `unknown` when it has no usable name. Never the
message, a URL, a header or a body.

## Tests

`services/control-plane/tests/account-sign-in-any-time.test.ts` is new. A slow identity lock on the
first attempt is checked again and succeeds: the action runs once, the identity is verified twice and
only the second attempt's rows are stored. A proof already stale on arrival is checked again and
succeeds. Stale on both attempts answers 503 `identity_recheck`, verifies twice and stores nothing.
Stale after the action answers 503 `identity_recheck`, rolls back and does not retry. Expired proofs,
expired and stale proofs, and proofs issued or verified in the future still answer 401 with one
verification. An action's own refusal that carries the code is never replayed. Through the handler,
the 503 carries `Retry-After: 1`, `Cache-Control: no-store` and the code, and a 401 carries no
`Retry-After`. The signing key helper returns the same object for the same client id and a new one
for another, holds one client id at a time, and holds only the keys and their fetch time. The default
handler, with WorkOS answered by a stub and a token whose signature fails, answers 401 without
reaching the database and leaves the published key in the object the helper keeps for the
configured client id. That fails if the handler stops passing the helper's object or keys it on
another id.

`services/control-plane/tests/identity-workos.test.ts` gains the log line cases: a thrown `TypeError`
logs `"error":"TypeError"` and none of its message, an abort from the five second timeout logs
`"error":"AbortError"`, a string, `undefined` or an object without a usable name logs `"unknown"`,
and an HTTP refusal keeps its status form unchanged. It also gains the shared signing key cases. Two
verifiers on one cache fetch the keys once in five minutes and again after. An unknown key id
refreshes them at most once in thirty seconds across verifiers. A verifier whose key fetch never
settles does not hold up another on the same cache. The cache holds the keys and their fetch time
and nothing secret. Two verifiers on one cache whose key fetches finish in reverse order keep the
later started fetch's keys and its start time. An unknown key id inside the thirty seconds answers
503 with the step `signing-key-recent` in the log and fetches nothing. The same token after the thirty
seconds fetches once and answers 401 when the key is still unknown. A key rotated in after the cache
was filled answers 503 inside the thirty seconds and verifies after them, once the keys fetched again
carry it. An unknown key id on a cold cache still answers 401 after its one fetch.

Five existing account service cases expected 401 for staleness and now expect 503 `identity_recheck`:
the identity lock and the last write cases in `tests/account-service-review-independent.test.ts`, the
lock queue case in `tests/accounts.test.ts`, the aged cloud page case in
`tests/account-service-repair-review-independent.test.ts`, and the stale verification row of the
storage refusal table in `tests/account-service-review-independent.test.ts`. That table now checks
the status, the code and the number of verifications on every row: 401 once for the expired, future
and wrong issuer rows, 403 once for the unverified email row, and 503 `identity_recheck` after two
verifications for the stale row.

Two existing cases in `tests/identity-workos.test.ts` changed with the thirty second answer. In the
tampered signature and unknown key case, the unknown key id now answers 503 right after the keys were
fetched and 401 once thirty seconds have passed. In the case that refreshes at most once per thirty
seconds across verifiers, the second unknown key id now answers 503 instead of 401, with the same two
fetches.

Three tests in the root `tests` folder pinned the old answers. They reach the same source through
the desktop app's wrappers, `server/business/account-service.ts` and
`server/business/identity-workos.ts`. Nothing in the app imports those wrappers at this commit, only
tests do, so the app's own behaviour does not change. In
`tests/account-foundation-independent.test.ts` the Store queue case is now two cases. A proof that
aged in the queue is checked again, and the second proof creates the organization at the later time.
A person the provider refuses on that second check gets no organization. In
`tests/identity-workos.test.ts` the tampered signature and unknown key case follows the service's
copy, and checks the number of key fetches. In `tests/browser-sign-in.test.ts` the refusal case now
builds its service with the keys fetched thirty seconds earlier, so the refusal comes from a second
fetch and every later assertion is unchanged. A new case beside it shows the other side: a key the
service has not seen, moments after it fetched its keys, keeps the WorkOS sign-in and shows the
sentence for a service that did not answer. The first full run of the root suite found these three.

`services/control-plane/scripts/runtime-smoke.mjs` gains three workerd cases, each building a verifier
per request on the Worker's own signing key helper. In `client_kept_keys`, two requests one after the
other in one isolate fetch the signing keys once and read the session list twice. In
`client_concurrent_cold`, two requests at once on a cold isolate, with the signing key answer held for
300 ms, both verify, with one or two signing key fetches. In `client_abandoned_refresh`, a request
returns at once with its verification never awaited while its signing key answer is held for 2000 ms,
and the next request in the same isolate must answer 200 within 15 seconds. With no shared keys, as
on main, the first case fails: the second request fetches the signing keys again. With one verifier
per isolate the third case fails: the next request has no answer in 15 seconds. A client that aborts
its request is not covered. Through Wrangler's local server the abort does not cancel the request,
which runs on to the end, so it cannot show the hazard.

## Not yet proven

A sign-in against the deployed service on a database that has just started. The retry and the 503
are proven only with an in-memory store and a moved clock.

The desktop does not retry a 503 by itself. When the first attempt is stale a request can take about
twice as long, and the desktop gives up at fifteen seconds and keeps the sign-in. The person then
tries again.

Whether WorkOS publishes a new signing key before it signs with it is not known.

## Gates

Run on 2026-10-04 from 00:33Z to 01:21Z (the evening of 2026-10-03 for the owner) in
`F:/Diomedes/diomedes-wt/account-sign-in-any-time`, on main `4dbbd88` with this change, one command
at a time under the machine-wide heavy slot:

- Service `npm run typecheck`: clean.
- Service `npm test`: 54 files passed and 5 skipped, 1,038 tests passed and 55 skipped, none failed.
- Service `npm run test:runtime` (workerd): passed, with the three kept key cases.
- Service `wrangler deploy --dry-run`: passed.
- Root `tsc --noEmit`: clean, 25 s.
- Root `vitest run --maxWorkers=2`: 566 of 566 files passed, 9,642 tests passed, 5 skipped, none
  failed, 1,543 s. The repository names `npx vitest run`; this is the same suite with two workers.
- Root `vite build`: clean, 15 s.
- Playwright, `tests/ui.spec.ts`, `tests/native-ui.spec.ts` and `tests/field.spec.ts`: 36 passed,
  2.4 minutes.

Two earlier full runs of the root suite on this branch failed, both at four workers while a game was
running on the machine. The first, before the three root tests were updated, failed 6 of 9,645
tests: those three, and one test each in `tests/codex-session-runtime.test.ts`,
`tests/independent-h01-20260917.test.ts` and `tests/opencode-session.test.ts`. The second, with the
root tests updated, failed 4 files and passed 9,638 of 9,647 tests:
`tests/h03-thread-session-routes.test.ts`, `tests/h04-opencode-session-routes.test.ts`,
`tests/h05-acp-session-routes.test.ts` and `tests/read-connector-fixtures.test.ts`. None of those
seven files is in this change, the two sets share no file, and every failure was a bounded wait. The
seven passed alone at one worker, 73 of 73. An earlier run of three of them alone failed one other
test in `tests/opencode-session.test.ts` on its five second start limit.

An independent review read the first pass. The second pass applied its findings, and the gates ran on
the second pass with the three root tests updated.
