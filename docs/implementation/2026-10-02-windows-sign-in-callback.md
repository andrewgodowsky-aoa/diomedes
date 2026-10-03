# Windows sign-in callback, 2026-10-02

Andrew reported that sign-in left a gray screen in Firefox and never finished. The AuthKit page was
fine. The browser handed the callback to the app, and the app dropped it.

## Cause

Windows' shell adds one slash before the query when it hands a protocol URL to its handler, whatever
browser launched it. `diomedes-auth://callback?code=…` reaches a second instance's argv, or a cold
launch's, as `diomedes-auth://callback/?code=…` (electron/electron#10786). Checked on Windows 11 on
2026-10-02 with a throwaway protocol handler that logged its argv. `parseNativeCallback` accepted only
the form without the slash, so it silently refused every real callback, and the app kept waiting
for one that never came.

## Change

`desktop/native-auth.ts` reads that one exact form as the same callback. A doubled slash, any other
path, a traversal or a fragment is still refused, and every other check on the callback is unchanged.

## Tests

- `tests/native-auth.test.ts`: the Windows form parses for a code and for an error, a full sign-in
  completes from it, and it is delivered from a cold launch and from a second instance. New hostile
  cases cover `callback//?`, `callback/x?`, `callback/%2e%2e/?`, a fragment and a bare `callback/`.
- `tests/native-sign-in-repair-review-independent.test.ts`: its malformed-URL example used the
  Windows form, so it now uses `callback//?` and keeps its intent.

## Gates (2026-10-02, on this patch)

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 8,970 passed, 47 failed and 5 skipped, out of 9,022 tests in 542 files. All 47
  failures were in 23 session and host files, none of which imports the sign-in code. Nearly all were
  20 to 30 second timeouts while the machine was busy. Rerun alone, 20 of those files passed. The
  other 3 (`h03-thread-session-routes`, `h04-opencode-session-routes`, `scoped-work`) passed
  42 of 42, both on this patch and on clean main f72c6ac.
- `npx vite build`: passed.
- `npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`: passed.

Not yet proven: a real sign-in on an installed build. That needs a release or a local test build.
