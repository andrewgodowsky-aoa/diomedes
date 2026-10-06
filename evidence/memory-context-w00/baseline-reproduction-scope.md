# W00 baseline reproduction scope

Source base: `9f14078eef3d864f4c2569ac61ce791577cf8b2c`.
Candidate branch: `feature/memory-context-contracts`.
Canonical mirrors read: Core Pillars, Live Roadmap and Project Memory, all `2026-10-05.1`.

This note describes authored tests, not their execution result. The root worker owns
the shared test slot and captures actual test verdicts separately.

## Reproduction

`tests/memory-context-baseline.test.ts` calls the real `compactTurns`, `selectHistory`,
`ModelSessionRuns`, `NativeAgent`, `validatePrepared`, `RunService` and `FileRunStore`.
Adapters return fixed fictional responses. No live provider, model reasoning, customer
incident, order placement or corrected production behavior is asserted.

The three cases force the affected message into omitted positions 2-4 of a 15-message
history. The probe has no lexical relevance to any message. Cases cover:

- An assistant answer beginning `The purchase order is approved.` followed by
  `Correction: approval is still pending; do not place the order.`
- A later user update whose second sentence contains that correction.
- An exception after a first sentence longer than 160 characters.

Tests check the current exact target excerpt, original prompt/answer SHA-256 references,
compaction digest, omission positions, original persisted History steps and actual
downstream dispatched text. Controls retain a first-sentence correction and an entire
recent corrected answer.

The two synthetic tenants use real stored runs. `selectHistory` is a pure selector,
not a tenant authorization boundary; scoped inputs alone do not prove authorization.
A separate real NativeAgent test challenges its cross-tenant ancestry refusal.
The current public ModelSessionRuns conversation path uses tenant `local`, so the
three driver traces are explicitly local, not cloud tenant acceptance.

## Admission and replay controls

- The serialized JSON guard accepts exactly 262144 UTF-16 code units and rejects
  262145. The existing one-million-token declaration does not override it.
- Multibyte text can have fewer serialized units and more UTF-8 bytes; JSON escaping
  can exceed the serialized guard despite a smaller raw body. Token counts remain estimates.
- An unknown native window and unreported provider usage remain unknown.
- Preparation cannot change scope or opaque transcript, add tool authority, or remove
  source restrictions.
- Prepared context remains a durable pure transform at zero cost. A fictional host
  epoch validator refuses stale context both before dispatch and on resumed observation.
  That validator exercises the existing hook, not an implemented memory epoch service.
- Repeated opaque transcript references stay separate from portable messages and
  completed model/tool steps replay without another adapter call or tool execution.

## Root-run commands

Normal baseline:

```powershell
$env:NC_MEMORY_BASELINE_WRITE_EVIDENCE = '1'
Remove-Item Env:NC_MEMORY_BASELINE_EXPECT_PRESERVED -ErrorAction SilentlyContinue
& .\node_modules\.bin\vitest.cmd run tests/memory-context-baseline.test.ts
```

Desired invariant reproduction:

```powershell
$env:NC_MEMORY_BASELINE_EXPECT_PRESERVED = '1'
& .\node_modules\.bin\vitest.cmd run tests/memory-context-baseline.test.ts
Remove-Item Env:NC_MEMORY_BASELINE_EXPECT_PRESERVED
Remove-Item Env:NC_MEMORY_BASELINE_WRITE_EVIDENCE
```

There are 21 authored tests. The intended normal result is 21 passing. The intended
desired-invariant result is 9 ordinary assertion failures and 12 passing controls.
These are expectations, not run evidence. There are no expected-failure wrappers.
If enabled, evidence output records observed data only; the runner log supplies the
verdict. The observations contain exact selected/dispatched text and source references.
No production files, dependencies or schemas are changed by this lane.
