# Read connector fixtures

Prompt 12, lane `read-connector-fixtures`.

## Verified integration evidence: 2026-09-28

The scoped lane gate and guard mutation passed on the coordinator's integration
candidate. The coordinator independently reviewed the scoped source and evidence
and found no concrete defect. This is not a main merge, DONE, release, real
vendor or installed-desktop acceptance record.

- Verified integration commit: `978e104e4751a01635a2ef4bb2f16a0493932bb6`.
- Integration worktree: `F:/Diomedes/diomedes-wt/astra-program-integration`.
- Source repair checkpoint: `7447ffe38ba9d8942576f63b166579ecae48dcd9`.
- Shared repaired test blob: `cea1f96ef2044f9ef596651085a1ab4c1d4b8068`.
- Integration freeze: `F:/Temp/andre/astra-read-connectors-integration/20260928-1128/source-freeze.json`.
- Reviewer/coordinator: chat `01a0e6b9-e93f-7462-bb6f-b7daca623eda`.

The focused 13-case run preceded the commit: its recorded HEAD is `ab5c805c`,
with only the repaired test changed to the blob above. Commit `978e104` records
that exact test change. Root TypeScript and the subsequent covering run used
clean `978e104`; its 86 cases include all 13 new fixture/launcher cases.

| Executed check | Exit | Passed | Failed | Skipped/filtered |
| --- | ---: | ---: | ---: | ---: |
| Focused fixture and Windows files | 0 | 13 | 0 | 0 |
| Six covering test files on clean `978e104` | 0 | 86 | 0 | 0 |
| Selected `read-sales` baseline | 0 | 1 | 0 | 7 |
| Selected `read-sales` with allowlist removed | 1 | 0 | 1, intended refusal assertion | 7 |
| Selected `read-sales` after exact restoration | 0 | 1 | 0 | 7 |

Root `tsc --noEmit --pretty false` exited 0. The covering command was
`vitest run tests/read-connector-fixtures.test.ts tests/read-connector-windows-launch.test.ts tests/read-connector-routes.test.ts tests/model-read-tools.test.ts tests/model-read-tools-routes.test.ts tests/read-scope.test.ts --maxWorkers=1 --minWorkers=1 --reporter=verbose`.
Do not add the 13 focused cases to the covering total or treat repeated mutation
phases as distinct coverage. Client build/browser and control-plane suite gates
are not applicable to this test-only slice. Required composed pre-merge gates
remain with the integration owner.

Focused logs and exit metadata are under
`F:/Temp/andre/astra-read-connectors-integration/20260928-1120/`.
TypeScript, covering logs and exit metadata are under `20260928-1128/` in the
same directory. The earlier collection error and seven revocation failures
remain unchanged under `20260928-1105/`; their record below is historical.

### Executed scope mutation

The coordinator temporarily added a partial mock of the read-scope module to
the new host test. It preserved every other export and approved-server lookup,
while removing only the tool allowlist from `approvedMcpTool`. Production files
and assertions were unchanged. The same command ran for all three phases:
`vitest run tests/read-connector-fixtures.test.ts -t 'read-sales: approve' --reporter=verbose`.

Both forbidden tools returned `UNAPPROVED_FIXTURE_TOOL_REACHED` with
`isError: false`. The existing refusal assertion failed at temporary line 166
(restored line 156). This was an assertion failure, not a setup error or timeout.
Later receipt and revocation assertions were not reached in the failed phase.
Logs are `20260928-1135-scope-mutation-{baseline,red,restored}.log` under the
evidence directory above. The command history preserves exits 0, 1 and 0.

The restored integration file matched raw SHA-256
`55A019B9ADE290443CF68B499133C550C72AE77C0A32E3C563B22C6549B28BBF` and the
shared Git blob. Its CRLF bytes differ from the source worktree's LF bytes;
restoration was checked against integration's own bytes. All seven freeze hashes
matched and Git was clean. Mutation slot `slot_mul67olz_d1a74740` and test claim
`claim_mul679uj_4f7d8323` were released after verification.

### Observed Windows behavior and remaining limits

All four owned `.cmd` forms passed: `node_modules/.bin` and an ordinary
directory, each by absolute path and extensionless PATH lookup. They preserved
the literal probe and created no shell-output marker. The direct Node control
also passed. This closes R12-01's missing execution evidence for those forms;
the proposed O10 wording is in the external lane report for the integrator.
Installed `npx`, percent-variable expansion and delayed expansion were not tested.

Plan covers an allowed read only. Revocation removes the last connector between
completed Ask turns, with refusal before dispatch; retaining another connector,
readTools-only changes and in-flight revocation are outside this matrix. Child
receipts prove stdin closure, not independent OS/process-tree termination or
stubborn-child cleanup. No child-environment canary is asserted. Current-main
composition and product/runtime acceptance remain separate.

### Documentation follow-up ownership

This docs-only follow-up uses retained claim `claim_mul5n13p_740fdd2c`, PID
67556, process start `2026-09-28T06:26:04.4976080Z`, in the source feature
worktree. The separate report claim is `claim_mul6i3fp_391f563e`. No source or
test edit, test execution, slot request, push or merge belongs to this follow-up.
The external report binds the resulting documentation commit and file blobs.

## Preserved preparation and repair history

All status, process, ownership and pending-test statements below describe their
earlier checkpoints. The dated verified-evidence section above supersedes them;
the original failed-run artifacts and historical verdicts remain unchanged.

- Worktree: `F:/Diomedes/diomedes-wt/read-connector-fixtures`
- Branch: `feature/read-connector-fixtures`
- Fetched base: `af0fbec122e49f04895ea85137e5be0fc500685a`
- Owner: chat `01a0e576-acc5-7751-91a3-8ff01969ae78`, Codex PID 27832,
  process start `2026-09-27T22:22:25.3506430Z`.
- Claim: `claim_mukiy8y3_f1780fd8`, from the pinned app coordination root.

Current-session correction, 2026-09-28: the owner and claim above record original
preparation. PID 27832 ended. Live parent-process and pinned-tool inspection now
confirm PID 37900, start `2026-09-28T01:39:36.1378700Z`, and replacement source
claim `claim_mukn7omu_ed649b29` for the same node, worktree, base and exact paths.

The exact worktree carries Core Pillars 2026-09-27.1, Roadmap 2026-09-25.2 and
Project Memory 2026-09-25.2. This slice adds test evidence for approved read
connectors and does not change a product definition or canonical status.

## Source findings

`shared/read-connectors.ts` declares seven vendor-neutral kinds: sales,
accounting, bank, payroll, inventory, reviews and leads. `provides` is descriptive;
the owner-approved server and exact `readTools` list determine authority.
`loadApprovedReadServers` reloads that persisted list for each Ask or Plan turn.

The host's `McpReadClients.call` checks `approvedMcpTool` before starting a process
or sending a call. Existing route tests cover approval storage and existing model
tests use an in-memory connector. The new fixtures exercise real child processes
through the existing transport and real conversation route.

The locked MCP SDK is 1.30.0 with cross-spawn 7.0.6. The SDK passes `shell: false`,
but cross-spawn itself resolves Windows shims and escapes their command and
arguments for `cmd.exe`. It double-escapes package shims under `node_modules/.bin`
and takes a different branch for ordinary `.cmd` locations. The O10 carry-over
description of direct spawning does not capture that dependency behavior.
Neither branch has been exercised in this lane yet; no launcher form has an
observed support or refusal result.

## Verification scope

For every kind: refusal without consent, approval over HTTP, discovery through a
real stdio client, an Ask that first attempts two unapproved tools and then reads
the approved tool, a Plan read, revocation over HTTP, and a refused read in the
same conversation. Child receipts check which tools actually ran and record
stdin closure; they do not independently prove OS process exit. Discovery does
not grant authority, including for a tool annotated as read-only. Model response
bytes are scripted; no live account or provider is used.

The preliminary independent review identified R12-01: both original Windows
cases selected the package-shim branch. Preparation now retains those two cases
and adds identical owned shims outside `node_modules/.bin`, also exercised by
absolute path and extensionless PATH lookup. All four cases retain the same
literal-argument and absent-side-effect marker assertions. Spaces and shell
metacharacters are included. The direct Node control is unchanged. No installed
package runner, install or remote connector is invoked by the fixtures. The
coverage addition is unrun and is not an observed shell-safety defect or a closed
review finding.

## Gate and mutation evidence

Pending explicit verification-queue handoff from the integration owner. The queue
is prompts 3, 2, 1, 26, 12 and 15, subordinate to the older owners. This lane holds
no slot and will not request one until that handoff. No verification result is
claimed yet. All 13 new test cases remain unrun: seven per-kind round trips, one
kind-set check, four Windows launcher cases and one direct Node control.
The final report is
`F:/Diomedes/deliverables/astra-week-20260927/reports/read-connector-fixtures.md`.

The scope mutation will replace only the imported `approvedMcpTool` decision in
the lane's new test with server lookup alone, omitting the exact tool allowlist.
The same public-interface assertions must fail. This avoids editing shared
contracts or harness tools; the temporary test edit will be restored exactly.

## Boundaries

Plan has an allowed-read case, not separate negative scope or revocation cases.
Revocation is tested between completed Ask turns after removing the last
connector; in-flight revocation, a retained second connector and readTools-only
changes are outside this matrix. No child-environment canary is asserted. Stdin
closure is not independent OS-exit or process-tree proof, and stalled startup or
interrupted/stubborn children are not exercised. The Windows argument probe does
not cover environment-variable expansion or delayed expansion. Future O10 text
must name the exact observed launcher forms and supported/refused results with
their evidence, without generalizing from the package-shim branch or claiming
installed `npx` compatibility.

No production code, dependency, shared contract, existing test, session driver,
canonical document or completion record is changed. No push, PR, merge, deployment,
browser run, live account, cloud write or provider call belongs to this slice.
Independent review and integration remain with the coordinating chat.

## Local checkpoint authorized 2026-09-28

Andrew explicitly requested saving tonight's stopped work in local commits with
unperformed-test caveats. That instruction permits this checkpoint before the
queued gates. It does not make the candidate accepted, merged or DONE.

The checkpoint retains the seven prepared files on the same branch and base.
The six fixture/test files retain their prepared SHA-256 values; only this
implementation record gained checkpoint metadata. Status, exact path scope and
file hashes were inspected. The external lane report binds the resulting commit,
Git tree and file hashes and records the staged whitespace-check result.

NOT RUN: all 13 declared cases (passed 0, failed 0, skipped 0, did not run 13),
typecheck, dependency installation, covering regressions and the scope-removal
mutation. No collection, build, service, provider call or slot request was made.
R12-01 has a prepared coverage correction but remains open for execution and
independent re-review; O10 remains open. Existing limits above still apply.

The source claim `claim_mukn7omu_ed649b29` stays held for the later gate handoff.
The coordinator alone owns combined integration. No push, PR or merge is part of
this checkpoint. Exact commit details are in the external report named above.

## Executed failure and narrow revocation-contract repair, 2026-09-28

The coordinator ran the focused files on clean integration commit
`ab5c805c3718c68efdd91e3235114a868651ebfd`. The first attempt passed all five
launcher cases but could not collect the fixture suite because the locked
control-plane Neon dependency was not installed. After the locked control-plane
install, 13 cases executed: passed 6, failed 7, skipped 0, did not run 0, exit 1.
These are two separate attempts, not additive pass totals. Original logs and
exit records remain in
`F:/Temp/andre/astra-read-connectors-integration/20260928-1105/`.

All seven per-kind failures reached the same final revocation expectation:
actual HTTP 409 / PROVIDER_ERROR, expected 503 / RUNTIME_UNAVAILABLE. The model
API checks whether a tool was offered before returning a tool outcome
(`server/engines/model-api-core.ts:976-1001`). Its invalid-tool failure maps to
PROVIDER_ERROR; the conversation route returns EngineError failures as HTTP 409
(`server/engines/interaction-routes.ts:87-91`). Existing AWS transport cases
explicitly require this refusal (`tests/aws-bedrock-transport.test.ts:391-400`).
The later harness unknown-tool error is a separate boundary, not the expected
response here.

The repair changes only this test's status, code and exact error-message
expectations, with one explanatory comment. It retains the assertions that
connector_read is not offered and no new child receipt appears. Those assertions
were not reached in the failed original run and still need a passing recheck.
No production code, fixture data, launcher assertion or permission rule changes.

Repair ownership is source claim `claim_mukwcg7q_82ea1d47`, PID 67556, start
`2026-09-28T06:26:04.4976080Z`, in the original feature worktree. The external
report freezes the repair's exact commit and hashes. No local tests, collection,
install or slot request ran for this repair. The revised 13-case recheck,
typecheck, covering regressions, mutation and final acceptance remain pending.
The prior failure is preserved; this repair is not a passing-gate claim.
