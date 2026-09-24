# Independent reviews: PR #36, PR #27 and the CD-01 contract marker

Linear: DIO-96 (independent reviews of merged PR #27 and PR #36), DIO-72 (CD-01 contract marker).
Branch `review/pr27-pr36-cd01-marker`, based on `main` at `559a1ab`. Reviewer: Claude Code,
overnight sprint of 2026-09-24. Both PRs reached `main` without an independent review; this is that
review, done after the fact.

## Scope

1. **PR #36**, "Stream ChatGPT replies, keep its process warm, and name routes from one place"
   (merge `cf40cd6`, first-parent diff `c10b7b2..cf40cd6`, 25 files). I reviewed the code that PR
   introduced as it stands on current `main`, which already includes later changes to the same
   code: the read-scope keyed warm process, and PR #71's "Wait for the child's exit before calling a
   Windows stop failed" (`b2366ab`).
2. **PR #27**, "Add mobile stock receipts with durable History and explicit reconciliation"
   (fast-forward to `dadb72d` over base `d8e3921`, 18 files). A parallel lane (DIO-95) is adding
   authentication and tenant authorization to `server/inventory/`. So I report findings in
   `server/inventory/` here with a proposed patch and do not edit them. The fixes I made are in the
   receipt client, which sits outside the command and authorization path.
3. **CD-01 contract marker**: `shared/contract-revision.ts` `CONTRACT_REVISION.status`.

## Method

I read each diff adversarially against the brief's checklist: process lifecycle and leaks, Stop
races (during spawn, during the stream and after exit), parsing of partial or garbled lines,
backpressure, restart recovery, Windows versus POSIX tree kill, how errors surface, truthful
attribution (decision 8) and whether the tests are adequate. For receipts the checklist was
receipt/view correctness, pagination, pending-intent handling and reply handling. Each real finding
got a failing test first. I then applied the fix and showed the same test passing. Anything I did
not fix is recorded with the reason.

Severity: **P0** is data loss or authority breach. **P1** is a guard that can be bypassed or a
security floor that does not hold. **P2** is incorrect behaviour with limited blast radius, or a gap
in parity or diagnosis.

## PR #36 findings

### R36-1 (P1): a failed sandbox proof did not withdraw a cached pass. FIXED in `d47d9d9`

`askCodex` trusts a passed Windows write-denial proof for `SANDBOX_PROOF_TTL_MS` (10 minutes).
`codexStatus` (Settings > Engines and Check connections) ran `dependencies.verifySandbox()`
directly, so a failure there never cleared `sandboxProvenAt`. The failing scenario: a request passes
the proof, then the connection check reports "Read-only boundary unavailable", and the next Ask or
Plan still dispatches on the cached pass for the rest of the window. That breaks the adapter's own
rule that "a failed proof is never remembered".

Fix: both callers now go through one `runSandboxProof()`, which clears the cached pass before every
proof and restores it only when the proof passes.
Test: `tests/integrations.test.ts` "a failed sandbox proof in the connection check withdraws the
proof a request would have trusted". It failed before the fix (the third request resolved) and
passes after it.

### R36-2 (P2): a request that finishes after shutdown parked its app-server. FIXED in `d47d9d9`

`closeWarmCodex()` runs when the service closes. A person's request still in flight at that moment
ended in `park()`, so a Codex app-server stayed alive for up to `KEEP_WARM_MS` (5 minutes) after the
service had closed. Its timer is `unref`'d, and nothing else would close it.

Fix: `closeWarm` bumps a generation counter. A request compares the generation it started under
before it parks, and closes its process when the two differ. No state is disabled permanently,
because the adapter is a module singleton shared by every `createApp` in one process.
Test: "a request that finishes after shutdown closes its process instead of keeping it". It failed
before the fix and passes after it.

### R36-3 (P2): ChatGPT preview frames skipped the baseline redaction. FIXED in `d47d9d9`

Every `EngineService` preview runs through `redactFor(engine)`, which is `baselineRedact` in
`server/app.ts`: `sk-…` keys, bearer tokens and home-folder paths. The ChatGPT route's own
`previewSink` in the `/ask` handler passed no `redact`, so raw deltas reached the `engine-text`
stream.

Fix: `redact: baselineRedact` on that sink.
Test: `tests/backend.test.ts` "a ChatGPT Ask preview is redacted like every other engine preview".
It failed before the fix and passes after it.

### R36-4 (P2, not fixed; a decision for Andrew): a status line names the agent while ChatGPT writes

`server/native-work.ts:761` logs "Nectovia is writing the proposal." during a direct ChatGPT
proposal run. `shared/agent-name.ts` states the choice deliberately ("Lines about what the agent is
doing name it, never the model or route serving it"), and the run's `origin` stays truthful: the
requested model is recorded as a request and the reported model as the runtime's report. Standing
decision 8, however, says direct-agent work is "never casually described as Diomedes reasoning". A
persisted session log line saying the agent is writing, when the engine is writing, sits on that
line. Picking between the two is not a reviewer's call, so I changed nothing. Proposed wording if
Andrew wants decision 8 to win: `${routeDisplayName(run.engine)} is writing the proposal.`

### Reviewed and found sound

- **Stop during spawn.** `fresh()` records the client before it checks `aborted`, so `finally`
  closes a process created after a Stop.
- **Stop during a kept-process check.** `watchAbort` binds Stop to whichever process is serving.
  An abort during `requireChatGpt` rethrows and does not fall through to a fresh process.
- **Stop during the stream.** Stop closes the process, `diomedes/error` rejects `completed`, and
  `finally` closes rather than parks because `signal.aborted` is set.
- **Stop after exit.** The abort listener is removed in `finally`, and a parked process has no
  signal bound to it.
- **Stream framing.** Newline-delimited JSON goes through a UTF-8 decoder (`setEncoding`), so a
  multibyte character split across chunks is safe and a trailing `\r` is tolerated. A partial last
  line waits in the buffer. A garbled line fails every pending request and stops the process. A
  2 MB unterminated buffer is refused.
- **Delta routing.** Only this thread's `item/agentMessage/delta` reaches `onDelta`, the returned
  text is still the completed item, and `previewSink` drops frames after the request signal aborts.
- **Restart recovery.** A kept process that exited or changed account fails `account/read`. That
  process is closed and a fresh one proves everything again (existing test).
- **Tree kill.** POSIX kills the process group of a `detached` child. Windows uses `taskkill /T /F`
  and, since `b2366ab`, judges the stop by the child's own exit, not by taskkill's exit code. The
  adapter itself refuses to start off Windows.
- **Attribution at admission.** `originFor` records `requested` with `source: 'not-recorded'`
  until the runtime reports a model, and the History sentence uses the runtime-reported model.

Two lower notes, not fixed: a Stop that arrives while the Windows sandbox proof runs takes effect
only when the proof returns (at most 12 s). Preview deltas are emitted one event per delta with no
coalescing, which matches the other engines.

**Test adequacy.** The PR's warm, Stop and streaming tests were good but did not cover the status
path's proof, shutdown mid-request or preview redaction. The three new tests close those gaps.

**Verdict, PR #36: ACCEPT WITH FIXES** (R36-1 to R36-3 fixed on this branch; R36-4 left to Andrew).

## PR #27 findings

### R27-1 (P2): corrupt saved receipt intent surfaced a parser error. FIXED in `65a42ff`

`readPending` called `JSON.parse` outside its guard. A truncated or hand-edited `sessionStorage`
entry made the page show "Expected property name or '}' in JSON…" instead of the intended "Saved
receipt intent is unreadable. Preserve it and reconcile before receiving more stock." The page still
blocked, so no receipt could be duplicated, but it gave no instruction.
Test: `tests/inventory-receipt-client.test.ts` "unreadable saved intent says to preserve and
reconcile, whatever made it unreadable".

### R27-2 (P2): a non-JSON reply surfaced a parser error. FIXED in `65a42ff`

`InventoryReceiptClient.request` awaited `response.json()` unguarded. An HTML 502 from a proxy or a
crashed host reached the person as "Unexpected token '<'…" rather than an `InventoryAccessError`
with the HTTP status. A receipt whose reply is unreadable still reports `uncertain`, as before.
Test: "a reply that is not JSON reports its HTTP failure, not a parser error".

### R27-3 (P2, report only; `server/inventory/`, DIO-95 lane): a history read is authorized as a status check

`server/inventory/stock-service.ts:87-95`: `view()` calls `authorize` with `phase: 'status'` and the
synthetic `operationId: 'inventory-history'`. The authorization callback therefore cannot tell a
history listing, which returns every receipt, actor id and History sentence in the project, from a
single operation's status check. It also cannot refuse the listing separately. The failing scenario:
a policy that lets a person poll their own pending operation is enough to list the whole ledger.
Proposed patch for the DIO-95 owner: add `'view'` to the authorize phase union, and pass
`{ phase: 'view', projectId, operationId: null, command: null }` from `view()`. Then have the host
authorizer map `view` to the read capability explicitly. Separately, `canReceive`
(`stock-service.ts:140`) is derived from that status-phase authorization. It is advisory only,
because `execute` re-authorizes at effect time, so nothing breaks, but it should read from the same
`view` decision.

### Reviewed and found sound

- **Pagination.** Twenty rows per page; the `olderThan` cursor is schema-validated and an unknown
  cursor is a 404. `olderThan` is set exactly when rows remain, and every row must match its linked
  History entry (kind, label, time, file) or the view refuses with 409.
- **Receipts.** Intent is persisted before dispatch and retried byte for byte. A lost reply is
  `uncertain` and never retried automatically. Retry is offered only after a `not-found` status, a
  conflict forces a fresh review, and the pending key is bound to organization, tenant and project.
- **Routes.** `no-store`, an 8 KB body limit, strict query keys, typed status codes, and a 503
  that tells the person to check status before retrying. Express 5 routes async throws to the error
  handler.

One lower note, not fixed: "Show older receipts" replaces the page instead of appending to it, and
only Refresh returns to the newest page. That is a design choice, not a defect.

**Verdict, PR #27: ACCEPT WITH FIXES** (R27-1 and R27-2 fixed; R27-3 handed to the DIO-95 lane).

## CD-01: the contract-revision marker

**What the records say.**

- `docs/implementation/2026-09-13-rebaseline.md` created revision `2026-09-13.1` as "status
  `proposed` until C00.R accepts it". Its last recorded outcome is C00.R-3 (2026-09-16), rejected
  only for C00-R2-2, a coordination-tool rollout prerequisite.
- `evidence/unified-20260913/C00.R-rollout-20260917.json` is a later, dated C00.R verdict:
  `verdict: accepted` and `approved_contract_revision: 2026-09-13.1`, with no blockers. It closes
  C00-R2-2 through the pinned-tool rollout and states that it is a new verdict, not a rewrite of
  C00.R-3.
- CD-01's own reviews (source map section 7, contract "A conflict in the records", work items
  R-09, the package-scope review and reconciliation) all confirmed that the marker contradicts this
  record. They left it for the integrator and consumed nothing from it.

**Decision.** The marker must say `accepted`. The newest authoritative record for the node that
gates it (C00.R) accepts exactly this revision, and nothing later withdraws that. CD-01's own
acceptance as a development seam is a separate record about `shared/interaction.ts`, which neither
amends nor consumes `2026-09-13.1`. So this change does not certify CD-01's remaining open items
(C24 cross-tenant evidence, crash-atomic admission, process-kill proof, live provider). The rollout
record's post-merge invocation proof lives in detached evidence under `F:/Diomedes/deliverables/`
and cannot be checked from this checkout. That is recorded here, not assumed.

**Change** (`8f5b563`). `CONTRACT_REVISION` is now `{ status: 'accepted', acceptedBy:
'evidence/unified-20260913/C00.R-rollout-20260917.json' }`. The header comments in
`shared/contract-revision.ts` and `shared/interaction.ts`, and the AGENTS.md line on the revision,
now say the same.
New test: `tests/contract-revision.test.ts` "says what its C00.R acceptance record says, and names
that record". It reads the record and requires `node_id: C00.R`, a verdict equal to the marker's
status, approved and produced revisions equal to the marker's revision, and no blockers. It fails if
either side drifts.

**Verdict, DIO-72: the marker now matches the record.** CD-01's other open acceptance items are
unchanged.

## Findings not fixed

| ID | Severity | Why not |
|---|---|---|
| R36-4 | P2 | Decision 8 against the agent-name convention: Andrew's call |
| R27-3 | P2 | Inside `server/inventory/` authorization, owned tonight by DIO-95 |
| Stop during the sandbox proof | P2 (note) | Bounded at 12 s; the proof is not abortable |
