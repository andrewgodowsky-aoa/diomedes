# Observe asynchronous completion in integration tests

The Connections HTTP route acknowledges durable ingress before processing finishes.
Its test now observes the real ConnectionsService.drain calls made by that route and
awaits their returned promises. It does not invoke drain itself or swallow a failed
operation. A controlled durable-write hold confirms that HTTP 202 can arrive while
task creation is still pending, then releases the actual write and checks the HTTP
view.

The scoped-work tests now subscribe to Store change notifications before reading the
started task session. They follow the exact project and session until it leaves
queued/working, then retain all existing HTTP, authorization and filesystem checks.
The listener is removed on completion, error or test cleanup. A held generator checks
that unrelated project changes cannot complete the observation and that already
completed sessions do not require another event.

This removes incidental expect.poll/vi.waitFor deadlines. It does not increase test
timeouts, reduce the twenty-write loop, change production code or manufacture a
successful operation. Full coordinated gate and hosted CI results remain separate
acceptance requirements.

## Verification

The focused Connections/scoped-work run passed 41 tests. The coordinated full run
on 2026-09-20 passed TypeScript checking, 2,308 tests (one skipped), the Vite build
and all 35 browser checks. Evidence is in the preparation deliverable's
`gates-async-test-completion-1/` directory. Hosted CI and independent review remain
separate from this local result.
