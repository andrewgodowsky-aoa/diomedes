# Runtime proof and Codex adapter continuation

Roadmap initially read: **2026-09-09.1**; reconciled cloud/local checkpoint:
**2026-09-09.5**. This is a local continuation of the published
runtime, not a new project or a replacement for the historical delivery reports.
Worktree: `F:\Achilles\diomedes-wt\codex-runtime-proof`, branch
`codex/runtime-proof-20260909`, original runtime base `eab162c58151704454867573ce2427c02559cdac`; now fast-forwarded
to `11829e1962b448360d3fc7aaba7c38fda6833a84` (roadmap/license/README changes only).

## Reconciliation

Fresh remote checks resolve app main to `11829e1` and the harness branch to
`eab162c`. Local main remains `86ee91d`. Other worktrees and the separate site
repository were preserved. Packaging's `postbuild` overwrites the checkout's
release output; all builds here used this isolated worktree. No running installed
application or real project data was used. `CURRENT_STATE.md` remains historical.

The handoff, live roadmap, integration map section 3, runtime verification,
CHANGES, existing verification artifact and current runtime were reconciled.
`AGENTS.md` and `CLAUDE.md` now carry the standing live-roadmap, version, evidence,
coordination and guarded-update rules. GitHub reports zero Actions runs and no
app releases; no `.github` workflow exists in the inspected remote base. The
credential-free workflow is now prepared locally; its first GitHub run remains
unverified. Website deployment does not prove desktop status.

## NR-02: completed local package proof

The resource risk was reproduced in a relocated, unmodified baseline package:
the fixture run failed with `ENOENT` for `report-lines.txt`. The initial probe
looked for the error in the wrong Session field; the corrected probe located it
in the durable run. Both attempts were retained. The fix copies only the fixture
asset into the package and uses a compile-time bundle location in
`format-report.ts`. No current-working-directory fallback was added.

The actual built UI then exposed a second defect: Show me first opened a task
preview without the harness's exact file text, and Review omitted that pending
Need. The existing dialog now renders the escaped complete proposal and target
path in Workbook and Console; Review includes the existing harness Need. The
fixture's usage caption explicitly says it makes no provider calls. No approval
digest, receipt authority or writer was replaced to fix the display.

`scripts/harness-desktop-smoke.mjs` exercised the actual relocated Windows
executable with a new profile, data directory, project directory and empty
synthetic Codex home. For the definitive NR-02 run, this worktree's `server`,
`client`, `fixtures` and `dist` directories were temporarily unavailable and
restored in `finally`. The package still passed:

- fixture progress to exact approval; full proposed text visible in Workbook,
  Review and the owning Console thread (screenshots personally inspected);
- restart while waiting, with the fixture read still at attempt 1;
- lost approval-response replay using the identical command and exact digest,
  producing one decision receipt and one recorded write;
- visible decline and Stop, with no additional project write;
- cursor reconnect, one completion event, History and supported restore of a
  newly created file, including persistence after another restart;
- renderer `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`,
  no `window.require`, and owned server shutdown/data-lock release.

NR-02 package: `F:\Achilles\deliverables\nr02-final-package-20260909`.
ASAR SHA-256: `f8c1c5f7dde3c470d8170f402d182972b6feab53940c084954b4fdeeb480b1f2`.
Proof: `F:\Achilles\deliverables\nr02-source-unavailable-proof-20260909`.
Portable evidence and the source/package manifest are under `evidence/nr02/`.
The old proof's `session`/`run` fields are waiting snapshots; its events and
execution receipt record subsequent completion. The newer smoke also records
`finalRun` and `finalSessions` to avoid that ambiguity.

Ten state reads in that proof took approximately 10.9-19.2 ms; the run JSON was
19,329 bytes. Electron recorded four process working-set samples. These are
bounded observations, not a long-session performance or OS containment claim.

## NR-03: bounded host-only native run proven

`CodexEngineAdapter` calls existing `askCodex` through one durable external
`model` step using pinned protocol 0.153.4, with one permitted proposal for
`Harness report.md`. It retains restricted/untrusted input labels. The host-only
start uses the existing canonical Work command parser, replay check, Store lock,
capacity gate and durable admission receipt before launch. Model/effort and
capability selection are part of this new command's digest; old v1 digests are
unchanged. No HTTP endpoint can arm Trust or mint this outbound grant.

The host issues a private, five-minute-or-shorter grant bound to its actual
frozen prompt, instructions, document text/hashes, model/effort, native workspace,
protocol/policy, project/run, account route, current authority fingerprint,
PrincipalRef/generations and expiry. It checks the actual native ChatGPT route
and context again before thread and turn dispatch. Global sending settings are
an additional gate. They cannot substitute for explicit per-run consent.
Inherited instruction files are refused on this bounded path; user configuration
is not edited. Credentials remain in the supported native sign-in route.

Authority is freshly resolved for admission, send, result acceptance, exact
decision, read/cancel and the later write. `egress.reconcile` is separate from
`egress.send`, `approval.decide` and `write.apply`. Only a PrincipalRef and stable
scope fingerprint are saved, not the resolved Authority. Trust policy belongs to
Opus's `server/trust/`; this work consumes its exported types and `refOf` rather
than implementing another identity model. Team authentication and its token lease
are untouched. Production human/device authentication is not claimed.

The outer completed provider observation is durable. Its opaque transcript
reference is bound to run lineage and the exact context hash. The native turn
itself has no resumable checkpoint. An error, crash, stale owner or cancellation
after uncertain external dispatch parks the step for reconciliation; no automatic
redispatch occurs just because its effect is `read`. Grants are not revived from
saved runs. Cached output still requires current acceptance and write authority.

Proposal parsing reuses the existing parser, and the exact Need binds selected
source hashes as well as the target's expected bytes. `Store.writeRecorded`
remains the sole writer and rechecks sources before application. Decision replay,
execution receipts and History preserve their existing authority.

The first delivered Trust prototype resolved admission but returned `no-resolver`
for its own stored reference. This was reproduced before provider access and
reported in the shared ownership note; no fake production backend was installed
to widen its capabilities or assurance. Opus corrected that seam in `5f1c69c`.
The four Trust files and its 18-test suite were copied from that exact commit;
`evidence/nr02/trust-source.json` records the blob identities. No merge or commit
was created in this runtime worktree. The strict runtime validator now recognizes
`prototype` as its own kind and accepts only that kind for this bounded driver.
`scripts/codex-harness-smoke.ts` refuses a reused proof directory and checks the
real Trust round trip before account access. It permits one native generation,
approves only a predeclared exact synthetic result and never retries uncertainty.
The live proof passed with one native ChatGPT turn using `gpt-5.6-luna` and
protocol 0.153.4, without a mock generator/account resolver, credential copy or
API fallback. Run `R59a0410f455e` reached completion with one model and one tool
step, each at attempt 1. Its durable start command replay returned the same
receipt. The proposed bytes matched the predeclared synthetic report exactly;
the report did not exist before approval. Recreating the host without its egress
grant replayed the cached result under the still-live independent Trust grant,
and repeated exact approval produced one recorded History write.

Live evidence: `evidence/nr03/live-proof.json`; original owned data and output:
`F:\Achilles\deliverables\nr03-live-codex-proof-20260909`.
Report SHA-256: `9b40f52c737980c02eec427a51d859472f8e7c84140a75a1164bfbed432313fc`.
This was an in-process host recreation, not a claim that prototype authority
survives an OS process restart. A separate fresh process confirmed the old ref
is denied while unarmed and still denied with 409 after rearming the same label,
without a provider call (`nr03-postprocess-reference.json`). No wider saved-run
authority or general reconciliation UI is delivered.

A final negative recovery test reproduced denied authority aborting host startup.
Startup now inspects records internally, catches only typed authority loss, leaves
the run/Need untouched and records a waiting Session explaining the pause. It does
not turn that inspection into client access or revive any rights; list/get still
deny. Storage and protocol errors still propagate. A fresh process opened a copy
of the real run's synthetic data with no Trust grant, confirmed the saved run was
unchanged and client reads denied, and made zero provider calls. Evidence:
`evidence/nr03/fresh-process-recovery.json`. This final pause correction followed
the live generation; no additional generation was needed or performed.
The next full suite also exposed shutdown cancelling a just-waiting approval
before worker cleanup ended. Shutdown now cancels only queued/running Codex work,
preserving waiting Needs. The reproduced failures and successful reruns are kept.

## Validation actually run

- Source suite before Trust integration: **515/515** passed. The integrated suite
  then passed **533/533** across 21 files. The final recovery regression adds one
  test: **534/534 passed** in `evidence/nr02/verified-final-tests.log`. The final
  typecheck/client/package build passed in `verified-final-build.log`.
- After consuming Opus's exported contract/refOf: **97/97** targeted tests passed.
  Coverage includes missing/forged/cross-run grants, context/account mismatch,
  expiry, revocation, changed model under one command, admission persistence
  failure, source drift, exact replay and uncertain outcomes.
- With the corrected Trust implementation, **115/115** targeted tests passed,
  including all 18 Trust tests. The recovery-pause regression first failed at
  startup, then passed with the relevant host/provider suites (**52/52**).
- `npm run build` passed, including Windows packaging. A relocated NR-03 candidate
  then passed the complete fixture smoke again. This proves fixture compatibility
  in that build, not real provider execution. Candidate output and proof are
  `F:\Achilles\deliverables\nr03-candidate-package-20260909` and
  `F:\Achilles\deliverables\nr03-candidate-fixture-proof-20260909`.
- The final corrected source was built and relocated once more to
  `F:\Achilles\deliverables\nr03-verified-package-20260909`. With source/client/
  fixtures/dist unavailable, its full fixture smoke passed, including shutdown.
  `evidence/nr03/manifest.json` binds its source hashes and package/proof identities.
  Final ASAR: `1101f1c2993277b89c02aecb52679d123ad874a431f3cd9bc8156b94997ed555`.
- Existing desktop smoke passed, including durable starts and renderer checks.
  Generated inherited evidence was retained under `regression-artifacts` and the
  original tracked artifacts restored so historical proof is not overwritten.
- The earlier full-browser Usage failure is preserved in the original logs. After
  reproducing a controlled stale-settings race, the complete browser suite passes
  **27/27**. Navigation used to send the full settings snapshot; a delayed refresh
  let it turn off an engine another client had just enabled. `App.tsx` now sends
  only `openProjects` or `lastPage`. The regression proves the server setting and
  Usage chip survive, without a sleep or a skipped assertion.
- A fresh full unit run exposed a separate concurrency-test scheduling assumption:
  a 20 ms delay did not prove the first handler had entered. Two related tests now
  wait for an explicit entry signal. The full suite passes **534/534 across 21
  files**, including a run using the CI command with an empty CODEX_HOME and JUnit
  output. The failing run is retained in `evidence/m1/usage-final-tests.log`.
- The newest client build and package passed. The relocated package at
  `F:\Achilles\deliverables\m1-usage-package-20260909` passed **11 checks**, including
  the settings race, with checkout source directories unavailable. ASAR SHA256:
  `68a36fd126d4f9e3126decad7bf262cfe3343885581f909aed7d07346835665c`.
  Its first smoke attempt exposed a driver-only route cleanup race; the driver now
  waits for pending routes, and the corrected attempt uses a fresh profile/data
  directory. Both logs remain available. Owned processes stopped, the data lock
  was released, and source folders were restored. Exact preview screenshots were
  personally inspected. `evidence/m1/manifest.json` binds current source and proof.
- Minimal CI is prepared at `.github/workflows/build-test.yml`: Windows, Node 22,
  locked npm install, typecheck, synthetic tests, client compilation, SHA-pinned
  actions, read-only token, bounded timeout and seven-day JUnit artifacts. The
  existing formatter parsed its YAML; typecheck, tests and client build were run
  locally. A clean GitHub runner/install has not been tested. Desktop/native
  packaging and signed-in smoke remain separate gates.


Older published 483-test and desktop reports are recorded historical results.
They are not substituted for the above tests or the actual relocated package.

## Security limits and recovery

Local ID strings, the client header, loopback or a saved PrincipalRef do not
authenticate a human. The bounded synthetic driver is explicitly labeled and off
by default. A saved reference is a worker lookup, never an HTTP bearer credential.
Other OS-user isolation and malicious code running as the same OS user have not
been certified. Worktrees isolate changes, not access to the machine.

Native sandbox write denial is checked by the existing transport. Provider tool
inventory and network-policy echoes retain their observed/instructional limits;
they are not an independent outbound-network containment proof. Stopping cannot
unsend content or guarantee provider-side cancellation or quota reversal.

Renderer isolation remains enabled; proposals render as escaped text, and model
output cannot grant permission. Local bootstrap, authenticated device/session,
durable revocation, credential brokerage/migration, delegated rights, remote
pairing, online accounts/passkeys/PKCE, and tenant-scoped data/search/memory/events,
retention and offboarding remain NR-04 or later. No cloud login service is added.

Rollback requires the appropriate pre-run data snapshot when using an older
reader. Deleting run files alone does not undo Sessions, Needs, History or
document effects. A lost or revoked prototype reference must fail closed; broader
rights must not be restored merely to make a saved run continue.

## BUILD / PUBLICATION / DEPLOYMENT STATUS

| Layer | Status |
| --- | --- |
| Source publication | New continuation is local and uncommitted; remote main is 11829e1; only its documentation/license changes were fast-forwarded |
| CI | Workflow prepared locally; no GitHub run; clean-runner install remains unverified |
| Client build | Passed in the owned worktree |
| Windows package | Built and relocated into separate deliverables |
| Tested package | NR-02, integrated NR-03 and M1 source-unavailable proofs passed; latest evidence is in evidence/m1/manifest.json |
| Live Codex adapter | One real native ChatGPT run passed, with synthetic context, exact approval and recorded application |
| Local installation | User's running app untouched; no replacement or installer run |
| Public release / production | No release, push, deployment or live-data migration performed |
| Website | Separate repository; no website change/deployment made here |

## ROADMAP IMPACT

Version **2026-09-09.5** reconciles the clean repository .4 and concurrent cloud
.4 after the other roadmap writer finished. The guarded nine-edit cloud update
passed exact full-text readback; the planning cache matches its normalized hash.
The repository mirror retains the clean structure and materially equivalent
current decisions; cloud historical amendments remain preserved. Evidence:
`evidence/m1/roadmap-sync.json` and the exact planning patch
`DIOMEDES-ROADMAP-IMPACT-2026-09-09.5.json`.

NR-02 is proven for the named packages. NR-03's bounded host-only native provider
slice is proven; production authentication and ordinary HTTP/UI admission remain
outside that proof. M1 is complete locally; M4/NR-05 CI is prepared but has never
run on GitHub. Opus retains its separately authorized full Trust/account track,
with provider and recovery architecture pending its research reconciliation.
This continuation adds no competing identity or credential service.

Next smallest safe slice: review and authorize source publication, then observe
and verify the first credential-free CI run. Subsequent runtime authentication
work must consume Opus's shared host/device/session contract before exposing a
normal Codex start or saved-run reconciliation UI. Do not promote the synthetic
prototype to human authentication to make those paths work.
