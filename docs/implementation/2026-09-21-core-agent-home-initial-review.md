# Home implementation initial independent review

Candidate: `b387059367cca89dfa32268793ac2132b748aeb3`.
Verdict: changes required in two test fixtures; expanded Home acceptance remains open.

The implementation came from separate authors. This review and execution used the clean
`F:/Diomedes/diomedes-wt/core-agent-home-driver-review` checkout at that exact candidate,
coordination identity `astra`, PID 43452, start `2026-09-21T04:32:24.4162630Z`, and exclusive
slot `slot_mubbknns_c65981ef`. The slot was released and the checkout stayed clean.

## Executed evidence

- `node node_modules/typescript/bin/tsc --noEmit`: exit 2, one error at
  `tests/home-luna.spec.ts:86`. The Promise resolver passed directly to the inner
  `requestAnimationFrame` takes void, while the frame callback receives a number (TS2345).
- Nine focused Vitest files: 140 passed, one failed, exit 1. The files were
  `home-luna-routing.test.ts`, `conversation-interrupt.test.ts`,
  `home-conversation.test.ts`, `project-conversation.test.ts`,
  `conversation-send.test.ts`, `diomedes-page.test.ts`, and the frozen AWS authority,
  CD-01 authority matrix and interaction seam review files. Workers were limited to one.
- The held-preparation disconnect case passed. On the existing public native session-open
  boundary, the client disconnected before preparation was released; no dispatch occurred.
  Its actual outcome was unresolved with `interrupted: false`, followed by Stop `idle`.
  This proves that fixture's request-signal path; it is not a live provider result.
- The original three frozen oracle SHA-256 values, 3,034-byte R4 reproducer, and R5/R6,
  admission-successor and composed-baseline reports all remained unchanged.

Full commands, raw failure output and per-command exit codes are retained in
`F:/Diomedes/deliverables/core-agent-continuation-20260921/run-home-focused-review.ps1`,
`home-initial-tsc.log`, `home-initial-vitest.log` and `home-initial-results.json`.
No browser test or full-suite acceptance is claimed by this review.

## HCR-1: browser helper callback does not typecheck

The exact failing expression is in the newly added `painted` helper:

```ts
() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
```

Required repair: adapt the inner frame callback to call the void resolver. Retain the two-frame
schedule and all test assertions. This is a test-only correction; no client behavior change is
authorized by HCR-1.

## HSR-1: strict-body fixture conflates two rejection layers

The case `the interrupt endpoint names the command in its path and takes nothing else` failed
at line 388. Its loop sends three objects with forbidden fields and a JSON string (`halt`),
requiring HTTP 400 and `no body` for all four. The string is rejected first by the app's existing
strict JSON parser. Its actual response is:

```json
{"error":"The request is not valid JSON or is too large."}
```

All three forbidden objects reached the endpoint and satisfied the existing assertion before
the string failed. Required repair: preserve every payload and HTTP 400 assertion, preserve
the endpoint-specific wording check for forbidden objects, and separately assert the existing
parser's response for the scalar JSON payload. Do not weaken the endpoint schema or change
production error handling to satisfy this fixture.

Both failures above were executed and retained before the author received a repair request.
The independent route-display counterexamples have separately received a static fixture
review; their runtime findings are not part of this initial verdict.
