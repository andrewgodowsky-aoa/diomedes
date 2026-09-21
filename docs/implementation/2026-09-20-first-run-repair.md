# First-run repair: route truth, setup instructions and what a proof proves

A hostile audit dated 2026-09-20 read installation, provider discovery and the path to a
first real result, and recorded nine findings. This record is the shared ledger for the
repair. It says what each finding is, what the repair changes, what the audit could not
see, and what this work still does not prove.

Feature: `first-run-repair`. Branch: `feature/first-run-repair`. Integration worktree:
`F:/Diomedes/diomedes-wt/first-run-repair/integration`. Contract: `357fa7c`, the committed
first-run repair contract every lane started from. `main` was merged in at `443253e`
(0.1.5 and the Console design language). Each lane worked in a worktree of its own beside
the integration one, on `feature/first-run-repair-<lane>`, was rebased onto this branch
and merged fast-forward, so every lane below is one contiguous run of commits. Files that
several lanes needed (`server/app.ts`, `shared/engines.ts`, the browser specs' shared
helpers) stayed with the integrator.

## The findings and what the repair changes

Each paragraph says what the finding is and what the repair changes. Which commits carry
a change is the lane table below, not this section.

**F01 — exact version compatibility has an unrecoverable normal-user path.** An engine
is supported only when its installed version equals `TESTED_VERSIONS[engine]`, discovery
took the first found installation, a private managed copy was considered only when
nothing was found, and the setup screen offered Install only when an installation was
missing. A customer could install a current upstream tool and be left with neither a
usable connection nor a repair. The repair enumerates candidates instead of taking the
first hit, keeps an explicit binding that survives a restart, isolates a failing
candidate so one bad copy cannot hide the rest, and extends the existing guided installer
to the incompatible and corrupt cases without touching the person's own installation.
Discovery recommends and never binds: a person's choice is written only by the explicit
bind, or once by adoption when no record exists. A record that could not be read is not a
record that may be replaced; the save is refused with `RECORD_UNREADABLE` rather than
written over a file nobody has seen.

**F02 — OpenCode support is a specific Go route with limited capabilities.** The adapter
pins `opencode:opencode-go`, enables only that provider, and refuses a request that names
any other account route. Its configuration also disables plugins, instructions and MCP,
disables tools and denies permissions. "I have OpenCode", "I pay for an OpenCode
service" and "I hold the account route this adapter accepts" are three different
statements. `shared/engine-routes.ts` now carries, per route, the exact account route the
adapter accepts and what a task through it can actually do, and the README repeats those
same two facts for a reader who is deciding whether to install anything at all. The
setup screen renders the same profiles, so the label a person chooses by is the label the
adapter enforces.

What that route cannot do at this commit is name the other account a person holds. With
only `opencode-go` enabled (`server/engines/opencode.ts:93`), OpenCode 1.18.4 prunes every
other provider out of its own state before it answers `/provider`, so the adapter's
`routeIssue` branch for "other providers connected" (`:652-659`) cannot fire over HTTP
and is kept only as a guard if that configuration changes. A person who holds OpenCode
Zen and no Go account gets the sentence at `:358-361`: no OpenCode Go account is
connected here, and a sign-in to Zen or any other provider inside their own OpenCode is a
different account this route cannot see. Nothing over HTTP tells an expired credential
from an absent one either. Detecting the other account would mean running
`opencode auth list` against the person's real credential store; that was deliberately
not built and is a decision left with the owner, below. Claude Code and oh-my-pi do report
a different kind of account, because their tools say which kind is signed in.

**F03 — isolation contradicts the apparent promise to inherit a person's setup.** Each
adapter reuses the installation and the native sign-in location, and deliberately does
not carry over configuration, plugins, MCP servers, instruction files or the working
directory; `server/engines/process.ts` passes a child process a short allowlist of
environment variables, so provider keys and proxy settings never reach it. That was true
and unsaid. Every profile now lists `reuses` and `doesNotReuse` as short factual phrases
taken from the adapter, and the README says the same thing once, in prose, for the
install-time reader.

**F04 — setup completion does not prove a working paid or usable route.** Reading a
provider catalogue and finishing a native sign-in do not prove that a real request will
pass entitlement, quota, policy and network checks. The repair separates found, account
detected, models listed and test succeeded; adds one consented, bounded, synthetic
request through the ordinary admitted dispatch path; and binds the host-issued receipt to
the selected binding revision, so a later change invalidates the evidence rather than
inheriting it. The test runs under a reserved project of the host's own that no client
accessor can open and no saved registry row may name, so it never lands in a customer's
project. A route whose test succeeded offers to start a first task; that offer expires
after five minutes, is re-derived from a fresh reading of the host before it is applied,
and never overwrites a thread that is running or that already asks for a different model.
The README states the same boundary in its list of connection states: only Ready can
send, and the live checks run again at dispatch.

**F05 — remembered preferences, transient readiness and a five-minute TTL diverge.**
Connection observations are transient while settings retain an enabled engine and a
selected model, and the client freshness check and the server stale comparison differed
at the boundary. The repair shares one freshness helper across both surfaces, treats an
invalid or future timestamp as needing a refresh, deduplicates concurrent refreshes, and
keeps "last verified" visually separate from "can run now". When a native sign-in window
closes, the host waits for any check already running to settle and then checks again, so
a check that began before the sign-in finished is never the last word.

**F06 — useful diagnostics exist but do not identify enough of the failure.** The
scrubbed support bundle already reported version, host, paths, engine state and recent
errors. What it could not say was where a failure happened. The repair adds the typed
stages declared in `shared/engines.ts` — `discovery` through `cleanup` — to every failure
on all five routes, so a 401 from the owned loopback server is a `local-handshake`
failure and not a missing subscription; a time limit running out, a person stopping their
own request and the host withdrawing a run are three different answers on every route;
and a wrong kind of account is one code at one stage (`ACCOUNT_ROUTE` at `provider-auth`).
The bundle records build identity, candidate source and account route as identifiers,
never secrets, passes every string through one scrubber, and is shown to the person in
full before anything is copied.

**F07 — the stream parser accepts a narrower format than SSE allows.** The OpenCode event
reader split on `\n\n` and took the first `data:` line, while the specification permits
CR, LF and CRLF and concatenates multiple data fields. This characterises a
non-conformance; it is not evidence that the pinned version emits those forms today. The
repair replaces the framing with a conforming implementation and keeps session and model
attribution, cancellation and the existing refusal to retry after an ambiguous dispatch.
OpenCode's `session.error` is read as the union the tool actually sends, discriminated on
`error.name`, rather than by looking for a word inside a sentence.

**F08 — setup instructions and roadmap authority disagree.** The README called the
application 0.1.0 and described OpenCode as having no adapter, while `package.json` said
0.1.4 and five adapters existed; the site's getting-started page mixed installer, loose
folder and source-development instructions and sent readers to a roadmap to learn which
accounts work. The existing README is repaired rather than joined by another guide: it
states the version once and a test fails when that literal disagrees with
`package.json`; it lists each adapter with its account route, task scope and reviewed
version; it separates installing the published build from running from source and from
design authoring, and the consumer path requires no Node, npm or Git; and it distinguishes
implemented in source, packaged in a release, and verified on a clean machine. One
generated capability record (`docs/reference/capability-record.json`,
`npm run capability-record`) now carries those facts for the README and for the site,
which keeps a verbatim copy and stops its build when the copy's version and the download
page's version disagree.

**F09 — installer proof is not first-customer proof.** The v0.1.4 manifest records unit
and browser test counts, and the installer proof records payload hashes, repair, uninstall
retention, restoration of a previous registration and a desktop restart smoke. That work
is real and is kept. It was performed on the development machine with an isolated profile:
it is not evidence that a clean customer PC, a fresh account or the reporting customer's
existing OpenCode route produced a result. The installer is unsigned, and a matching
SHA-256 checks bytes against a published value without authenticating the publisher. The
README says exactly that, in one place, and tells nobody to lower Windows protection. The
release README is now written from the candidate record instead of from literals: a gate
the record does not carry prints as not verified, and so do the tested Windows version
and the signing state when the record is silent.

## Lanes and their evidence

One row per lane. Each row names the lane's commits as a range on this branch and the
test files that range added or changed, both read from git. A verification lane wrote
tests only; its commits were carried into the repair lane that answered them, so the two
share a row and the verifier's tests stay in the suite as regression tests.

| Lane | Answers | Commits | Test files added or changed |
| --- | --- | --- | --- |
| `route-truth-docs` | F02 labels, F03 disclosure, F08, and this record for F09 | `db2d41f..95c324f` (5) | `engine-routes.test.ts` |
| `support-diagnostics` | F06 build identity and bundle facts | `780ad78..2324670` (4) | `build-identity.test.ts`, `support-bundle.test.ts` |
| `setup-ui` | F01 repair offer, F04 four states, F05 display | `0e76a0b..5aa4239` (4) | `ai-engines-ui.spec.ts`, `ai-setup-states.test.ts`, `engine-routes.test.ts`, `picker-setup.test.ts` |
| `candidate-binding` | F01, F05 binding revision | `ba34f68..aa8ca07` (8) | `candidate-binding.test.ts`, `discovery.test.ts`, `engine-install.test.ts` |
| `capability-record` | F08 one generated record | `31ee04f..8f7e9ff` (4) | `capability-record.test.ts` |
| `sign-in-recheck` | F04, F05 recheck when a sign-in window ends | `87e21d9..9e69755` (3) | `native-login-recheck.test.ts`, `sign-in-recheck-wiring.test.ts` |
| `opencode-adapter` | F02, F06 stages, F07 | `0f27e85..6774870` (7) | `opencode-adapter.test.ts`, `sse.test.ts` |
| `adapter-stages` | F06 on Claude Code, oh-my-pi, Cursor and Devin | `e91d5ea..37b591f` (4) | `claude-adapter.test.ts`, `cursor-adapter.test.ts`, `devin-adapter.test.ts`, `omp-adapter.test.ts` |
| `first-result` | F04 the consented test and its receipt | `122acca..4f747d1` (4) | `connection-test.test.ts`, `engine-service.test.ts` |
| `setup-ui-followup` | a render crash in setup, F05 in the thread picker, the sign-in wait, onboarding labels | `d1082d1..f0879b4` (7) | `ai-engines-ui.spec.ts`, `ai-setup-states.test.ts`, `onboarding.test.ts`, `picker-setup.test.ts` |
| `engine-stage` | F06 one stage classifier; a route issue that outlived its observation | `5915238..f1a6f1a` (4) | `engine-service.test.ts`, `engine-stage.test.ts` |
| `harness-host-test` | F04 through the wiring the packaged app uses | `12192ea..fb6959c` (3) | `connection-test-wiring.test.ts` |
| `first-task-handoff` | F04 from a verified route to a first task | `e17be93..bd9c2f1` (3) | `ai-engines-ui.spec.ts`, `first-task-handoff.spec.ts`, `first-task-handoff.test.ts` |
| `verify-binding` and `binding-repair` | first hostile pass over F01 and F05 | `e2e0b73..b5d2098` (10) | `candidate-binding.test.ts`, `discovery.test.ts`, `engine-install.test.ts`, `engine-service.test.ts`, `hostile-binding-boundary.test.ts`, `hostile-binding-freshness.test.ts`, `hostile-binding-inventory.test.ts`, `hostile-binding-record.test.ts`, `hostile-binding-revision.test.ts` |
| `verify-truth` and `truth-repair` | first hostile pass over F06, F08 and F09 | `6e0ada9..c09cf19` (13) | `capability-record.test.ts`, `hostile-truth-build-identity.test.ts`, `hostile-truth-capability-record.test.ts`, `hostile-truth-documents.test.ts`, `hostile-truth-next-action.test.ts`, `hostile-truth-support-bundle.test.ts`, `release-assets.test.ts`, `support-bundle.test.ts` |
| `verify-adapters` and `adapters-repair` | first hostile pass over F02, F06 and F07 | `1906c30..8036c42` (9) | `claude-adapter.test.ts`, `cursor-adapter.test.ts`, `devin-adapter.test.ts`, `engine-process.test.ts`, `hostile-adapters-defects.test.ts`, `hostile-adapters-holds.test.ts`, `native-login-recheck.test.ts`, `omp-adapter.test.ts`, `opencode-adapter.test.ts` |
| `verify-final-server` and `server-final-fixes` | second hostile pass, server | `24c1629..d3d58b2` (7) | `engine-process.test.ts`, `final-server-binding-record.test.ts`, `final-server-failure-classification.test.ts`, `hostile-binding-record.test.ts` |
| `verify-final-client` and `client-final-fixes` | second hostile pass, client | `e7f17d4..9412d8b` (9) | `ai-engines-ui.spec.ts`, `ai-setup-states.test.ts`, `error-boundary.test.ts`, `final-client-release-readme.test.ts`, `final-client-setup-unions.test.ts`, `final-client-signin-settle.test.ts`, `final-client-support-bundle.test.ts`, `first-task-handoff.spec.ts`, `first-task-handoff.test.ts`, `hostile-truth-support-bundle.test.ts`, `release-assets.test.ts` |

Each row names what git holds and nothing a lane reported about itself. A lane's own
counts, where it gave any, were a run of its own files in its own worktree; they are not
suite results and none is repeated here.

Between the lanes, on this branch, the integrator made the changes no lane owned:
`ce6c20e` the failure stage in the API error and a changed binding as a conflict;
`443253e` the merge of `main`, and `5b7a4a2` the README and capability record at 0.1.5;
`2817eb8` two browser-spec repairs; `59f1697` test only the model a run would use;
`babf8a0` the support information shown before it is copied; `30efd4d` one code and one
stage for a wrong kind of account; `5ac862a` a saved project row this application could
not have written is refused; `3627945` the handoff spec joins the browser run; `1e0c33b`
the recheck after a sign-in waits for a running check; `be2dd0a` and `5e8dde1` the
redaction floor reads a Windows home path in any case and leaves a web route whole;
`cd43aa4` the sequence the host runs when a sign-in finishes during a check; `0ff41a9`
the OpenCode route gives the same answer as the other four when the host withdraws a run;
`40dd16e` a candidate record states the Windows it was written on. This record and the
regenerated capability record followed, and then the repairs the pull request's first CI
run asked for, below.

**Gates.** The full gates are taken on the branch tip and are reported in the pull
request. This record cannot cite a run on a commit that did not exist when it was written,
and one of the suite's own tests reads this file, so only the tip run proves the filled
record passes. The runs the integrator took on the way there, on the named commits:

- `cd43aa4`, all four gates: `npx tsc --noEmit` 0 errors; `npx vitest run` 172 files,
  3,584 passed, 4 failed, 1 skipped; `npx vite build` succeeded; the six browser specs
  (`ui`, `native-ui`, `field`, `readability`, `ai-engines-ui`, `first-task-handoff`) 57
  passed. Two of the four failures were this record's own unfilled cells. The other two
  were `tests/scoped-work.test.ts` answering `fetch failed` while the machine was loaded;
  the file passed 30 of 30 alone, twice, and nothing on this branch touches it.
- `0ff41a9`: the adapter and service test files that commit touched, 131 of 131.
- `9412d8b`: `npx tsc --noEmit` 0 errors, `npx vite build` succeeded, and
  `first-task-handoff.spec.ts` with `ai-engines-ui.spec.ts`, 24 of 24.

- `11cc2e6`, all four gates again: `npx tsc --noEmit` 0 errors; `npx vitest run` 180
  files, 3,642 passed, 1 skipped, 0 failed; `npx vite build` succeeded; `npx playwright
  test` 124 passed. A first unit run on that commit had 3 failures, the same
  `scoped-work` pair and an `EBUSY` removing a temporary folder in
  `tests/engine-process.test.ts`; both files passed alone, 43 of 43, and the second full
  run is the clean one.

Where a fix was written before the test that covers it, the fix was taken out again to
see the test fail, then put back.

**What CI found that this machine could not.** The pull request's first run on a GitHub
Windows runner failed 35 tests in four files, all green here. Two causes, both in the
tests and neither in the application. The runner's temporary folder is an 8.3 short path
(`RUNNER~1`); three binding test files keyed their fixture answers by that spelling while
the service resolves every file to its long real name before it asks about it, so 33
lookups missed. Reproduced here by pointing `TEMP` at a short path: 33 failed, the same
count. All six binding test files now build their folders from the real name and pass in
both spellings, 106 of 106. The other two failures were `commitPresent` answering
"cannot tell" in CI's shallow checkout, which is the answer it is meant to give; the
tests demanded yes or no. They now ask git whether the checkout is shallow and hold the
function to the matching answer. Reproduced in a real depth-1 clone: the old tests fail 2,
the new pass 23.

## Where the route sentences come from

Every sentence in `shared/engine-routes.ts` was checked against the adapter at the
inspected base `357fa7c`, and the line numbers below are that commit's. The adapters have
grown since and the lines have moved; the facts have not, with the one qualification F02
states for OpenCode.

| Route | Source |
| --- | --- |
| Claude Code | `server/engines/claude.ts:25` account route; `:121-125` requires a `claude.ai` sign-in and refuses API billing; `:38-43` empty tools, strict empty MCP config and no slash commands; `:47-48` no hooks and no plugins; `:36-37` no setting sources |
| OpenCode | `server/engines/opencode.ts:26` account route; `:84` only `opencode-go` enabled; `:218-223` a model id naming any other provider refused; `:80-82,85,90` no plugins, instructions or MCP, tools off, permissions denied; `:261,269` the native sign-in data location is preserved; `:264-268` fresh home, config, cache and state; `:271-272` project config and external skills off |
| oh-my-pi | `server/engines/omp.ts:24-25` the OpenAI route; `:38-45` no tools, extensions, skills, rules, LSP or session; `:31-32,131` retry and model fallback forced off; `:111-113,135` a separate profile directory; `server/engines/login.ts:90` and `server/engines/install.ts:40-41` the key is API billing, written by the person, and not read by Diomedes |
| Cursor | `server/engines/cursor.ts:48` account route; `:169-172` the sign-in it accepts; `:217-226` deny rules; `:241-244` fresh config and data, global rules not loaded; `:231` no MCP servers; `:246,263` ask mode |
| Devin | `server/engines/devin.ts:77` account route; `:13-17,265-274` ACP authenticates each process and never reuses the CLI credential; `:210-233` a fresh workspace with deny rules; `:38-39` no substitute model on refusal |
| Every route | `server/engines/process.ts:44-50` the environment allowlist; `server/engines/service.ts:260-262` the adapter's working directory; `:387-397` the capability and disclosure lines |

On this branch the OpenCode facts F02 relies on sit at `server/engines/opencode.ts:31`
(the account route), `:93` (`enabled_providers`), `:348-361` (what an empty `connected`
means, and the sentence a person gets), `:645-659` (the branch that cannot fire) and
`:688` (a request naming another account route is refused). The pruning itself is
OpenCode's, read at its tag `v1.18.4`: `packages/opencode/src/provider/provider.ts:1606-1611`.

The OpenCode billing sentence also rests on OpenCode's own Go documentation, recorded in
the audit's external research: an account-side "Use balance" setting can let usage
continue from Zen balance after Go limits are reached, so a client-side route pin cannot
promise subscription-only charges.

## The audit's evidence boundary

The audit read source at pinned commits, the published release records and two CI runs.
It did not have access to the reporting customer's machine, file or shortcut, and it says
so: their actual root cause is unconfirmed. It did not reproduce a failure in production,
and it could not fetch the live website in that session. The release manifest and the
installer proof are recorded evidence it read, not tests it performed.

That boundary does not weaken the findings. Each one is a defect in the inspected source
and stands whatever the customer's eventual diagnostic report says. It does mean no
sentence in this repair may attribute a cause to that person's installation, and that
nobody asks them for a credential file.

## The two application CI failures, already fixed on main

Both failures the audit recorded in workflow run `35427976380` were repaired on `main`
before this work started, by `375c0a8`, "Fix Windows CI shortcut identity and large-folder
fixture timing" (`docs/implementation/2026-09-20-windows-ci-repairs.md`).

`tests/backend.test.ts:1198`, the large-folder timeout: the commit raised that single
test's deadline to 120 seconds and added phase timings for fixture creation, project
creation, the explicit walk and the measured read. The cached read must still answer in
under 200 ms and still return all 3,000 rows; both assertions are unchanged.

`tests/windows-installer-registration.test.ts:213`, the shortcut restoration mismatch:
`scripts/windows-installer-registration.psm1` compared WScript's expanded shortcut target
with the literal install target, which differ on a profile path carrying an 8.3 name such
as `RUNNER~1`. The commit expands both sides through `GetLongPathNameW` before comparing.
A path that cannot be resolved still returns nothing and the foreign-change refusal still
fires, so ownership is never inferred from a failed resolution; the guard was widened in
spelling only, not in what it accepts.

## Decisions left with the owner

These were found, weighed and deliberately not decided by this work.

- **Detecting another account inside a person's OpenCode.** `opencode auth list` would do
  it, by reading the person's real credential store, with a network fetch and output this
  build cannot pin. Not built.
- **Proxy settings.** The child-process environment allowlist drops them, so a customer
  behind a required proxy cannot reach a provider through any route.
- **Whether a connection test counts toward usage.** It is a real request on the person's
  account, and nothing in this work counts it.
- **A roster fallback that still reads "found"** when `identify` cannot resolve an
  installation. The lane that tried removing it reported 31 fixtures breaking, and it was
  left.
- **Adoption beside a damaged row.** `adopt()` can write a record for one route while
  another route's row is damaged. Left on purpose: refusing would wedge the healthy route.
- **The record replacement wait** is bounded at 200 ms but synchronous in the main process.
- **Support bundle wording.** Tokens and API keys are removed by known shape; the bundle
  now says so rather than promising none can appear.
- **Release assets.** `scripts/write-release-assets.mjs`'s `main()` has not been executed
  for a real release since it was rewritten, and `scripts/write-candidate-record.ts` does
  not yet record the desktop smoke, installer or installed-runtime gates, so the next
  release README will print those as not verified until it does.
  *(Later that day: the record half is done. `--desktop-smoke`, `--installer-proof` and
  `--installed-runtime` record a real outcome from a real report —
  [`2026-09-20-release-gate-outcomes.md`](2026-09-20-release-gate-outcomes.md). The
  asset writer's `main()` is still unexercised by a real release.)*
- **Settings, About.** Its copy still says "Version 0.1." and describes a workbook.
- **`installGovernance` in `server/harness/lifecycle.ts`** is not wired; if it is, it
  must early-return for the host's own test project as the other three hooks do.

## Not proven by this work

- **A clean Windows standard-user install of the exact artifact.** Nothing here was
  packaged, installed or run from a published build.
- **A real consented provider result.** No account was contacted; no route produced a
  reviewed proposal as part of this work. Every adapter test runs against a fixture.
- **Restart and repeat.** The binding, receipt and readiness behaviour after a restart is
  covered by tests that reopen the binding store over the same folder, not by restarting
  an installed application.
- **The reporting customer's diagnosis.** Their root cause remains unconfirmed, and no
  repair here may be described as having fixed it.
- **Whether another provider is signed in inside the person's own OpenCode.** A Go-only
  session is not shown the others, so the adapter cannot report one at this commit.
- **The render-crash screen, the ten-minute sign-in bound and the five-minute handover
  window on a real host.** Each is unit-tested, the two bounds on a fake clock; none has
  been watched happen.
- **Drive roadmap canonical-versus-mirror reconciliation.** The audit recorded a newer
  mirror that says the canonical document could not be updated. That competing authority
  is untouched here and still needs reconciling by its owner.

All of this work first shipped in the published 0.1.6 installer, built from `4a06a45`. It
has still not been run on any machine but the one it was built on. The integrator took the
runs listed above and vouches for those; the four things at the head of this list need a
person, a clean computer and an account.

Until 0.1.6 was cut, this paragraph said the work was in source only, was not packaged, and
was not in the published 0.1.5 installer. Every word of that was true when it was written
and no word of it had to change to stop being true: 0.1.5 was simply the release that
happened to be published that day, so the sentence dated itself to a moment rather than to
the work, and went on reading as "unshipped" after the thing shipped. A reader arriving here
from the release would have been told the opposite of what they had just installed. The
claim that actually earns its place is the one about the build machine, because that one is
a statement about what has been proven and will stay false until someone proves otherwise.
