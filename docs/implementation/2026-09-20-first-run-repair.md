# First-run repair: route truth, setup instructions and what a proof proves

A hostile audit dated 2026-09-20 read installation, provider discovery and the path to a
first real result, and recorded nine findings. This record is the shared ledger for the
repair. It says what each finding is, what the repair changes, what the audit could not
see, and what this work still does not prove.

Feature: `first-run-repair`. This lane: `route-truth-docs`. Branch:
`feature/first-run-repair-route-truth-docs`. Worktree:
`F:/Diomedes/diomedes-wt/first-run-repair/route-truth-docs`. Base: `357fa7c`, the
committed first-run repair contract. This lane owns `shared/engine-routes.ts`,
`tests/engine-routes.test.ts`, `README.md` and this record; the other lanes own the
service, adapter, setup screen and diagnostics work described below.

## The findings and what the repair changes

**F01 — exact version compatibility has an unrecoverable normal-user path.** An engine
is supported only when its installed version equals `TESTED_VERSIONS[engine]`, discovery
takes the first found installation, a private managed copy is considered only when
nothing was found, and the setup screen offers Install only when an installation is
missing. A customer can install a current upstream tool and be left with neither a usable
connection nor a repair. The repair enumerates candidates instead of taking the first
hit, keeps an explicit binding that survives a restart, isolates a failing candidate so
one bad copy cannot hide the rest, and extends the existing guided installer to the
incompatible and corrupt cases without touching the person's own installation.

**F02 — OpenCode support is a specific Go route with limited capabilities.** The adapter
pins `opencode:opencode-go`, enables only that provider, and rejects any other
provider at selection. Its configuration also disables plugins, instructions and MCP,
disables tools and denies permissions. "I have OpenCode", "I pay for an OpenCode
service" and "I hold the account route this adapter accepts" are three different
statements. `shared/engine-routes.ts` now carries, per route, the exact account route the
adapter accepts and what a task through it can actually do, and the README repeats those
same two facts for a reader who is deciding whether to install anything at all. The
setup screen renders the same profiles, so the label a person chooses by is the label the
adapter enforces.

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
inheriting it. The README states the same boundary in its list of connection states:
only Ready can send, and the live checks run again at dispatch.

**F05 — remembered preferences, transient readiness and a five-minute TTL diverge.**
Connection observations are transient while settings retain an enabled engine and a
selected model, and the client freshness check and the server stale comparison differ at
the boundary. The repair shares one freshness helper across both surfaces, treats an
invalid or future timestamp as needing a refresh, deduplicates concurrent refreshes, and
keeps "last verified" visually separate from "can run now".

**F06 — useful diagnostics exist but do not identify enough of the failure.** The
scrubbed support bundle already reports version, host, paths, engine state and recent
errors. What it cannot say is where a failure happened. The repair adds the typed stages
already declared in `shared/engines.ts` — `discovery` through `cleanup` — so a 401 from
the owned loopback server is not reported as a missing subscription, and records build
identity, candidate source and account route as identifiers, never secrets.

**F07 — the stream parser accepts a narrower format than SSE allows.** The OpenCode event
reader splits on `\n\n` and takes the first `data:` line, while the specification permits
CR, LF and CRLF and concatenates multiple data fields. This characterises a
non-conformance; it is not evidence that the pinned version emits those forms today. The
repair replaces the framing with a conforming implementation and keeps session and model
attribution, cancellation and the existing refusal to retry after an ambiguous dispatch.

**F08 — setup instructions and roadmap authority disagree.** The README called the
application 0.1.0 and described OpenCode as having no adapter, while `package.json` said
0.1.4 and five adapters existed; the site's getting-started page mixed installer, loose
folder and source-development instructions and sent readers to a roadmap to learn which
accounts work. The existing README is repaired rather than joined by another guide: it
states the version once and a test fails when that literal disagrees with
`package.json`; it lists each adapter with its account route, task scope and reviewed
version; it separates installing the published build from running from source and from
design authoring, and the consumer path requires no Node, npm or Git; and it distinguishes
implemented in source, packaged in a release, and verified on a clean machine.

**F09 — installer proof is not first-customer proof.** The v0.1.4 manifest records unit
and browser test counts, and the installer proof records payload hashes, repair, uninstall
retention, restoration of a previous registration and a desktop restart smoke. That work
is real and is kept. It was performed on the development machine with an isolated profile:
it is not evidence that a clean customer PC, a fresh account or the reporting customer's
existing OpenCode route produced a result. The installer is unsigned, and a matching
SHA-256 checks bytes against a published value without authenticating the publisher. The
README now says exactly that, in one place, and tells nobody to lower Windows protection.

## Lanes and their evidence

One line per lane. The integrator fills every cell marked `TO BE FILLED`; nothing here
may be filled from a summary rather than a run.

| Lane | Findings it answers | Commits | Gate results |
| --- | --- | --- | --- |
| `route-truth-docs` | F02 labels, F03 disclosure, F08, and this record for F09 | `db2d41f`, `ff3d23d`, plus this record | `npx tsc --noEmit` passed; `npx vitest run tests/engine-routes.test.ts` ran 8 tests, 8 passed, 0 failed |
| `candidate-binding` | TO BE FILLED | TO BE FILLED | TO BE FILLED |
| `opencode-adapter` | TO BE FILLED | TO BE FILLED | TO BE FILLED |
| `setup-ui` | TO BE FILLED | TO BE FILLED | TO BE FILLED |
| `support-diagnostics` | TO BE FILLED | TO BE FILLED | TO BE FILLED |
| Integration of all lanes | — | TO BE FILLED | TO BE FILLED: all four gates on the merge commit |

This lane's counts are from its own run in this worktree and cover its own test file
only. They are not a suite result and must not be reported as one.

## Where the route sentences come from

Every sentence in `shared/engine-routes.ts` is checked against the adapter, at the
inspected base `357fa7c`.

| Route | Source |
| --- | --- |
| Claude Code | `server/engines/claude.ts:25` account route; `:121-125` requires a `claude.ai` sign-in and refuses API billing; `:38-43` empty tools, strict empty MCP config and no slash commands; `:47-48` no hooks and no plugins; `:36-37` no setting sources |
| OpenCode | `server/engines/opencode.ts:26` account route; `:84` only `opencode-go` enabled; `:218-223` any other provider refused; `:80-82,85,90` no plugins, instructions or MCP, tools off, permissions denied; `:261,269` the native sign-in data location is preserved; `:264-268` fresh home, config, cache and state; `:271-272` project config and external skills off |
| oh-my-pi | `server/engines/omp.ts:24-25` the OpenAI route; `:38-45` no tools, extensions, skills, rules, LSP or session; `:31-32,131` retry and model fallback forced off; `:111-113,135` a separate profile directory; `server/engines/login.ts:90` and `server/engines/install.ts:40-41` the key is API billing, written by the person, and not read by Diomedes |
| Cursor | `server/engines/cursor.ts:48` account route; `:169-172` the sign-in it accepts; `:217-226` deny rules; `:241-244` fresh config and data, global rules not loaded; `:231` no MCP servers; `:246,263` ask mode |
| Devin | `server/engines/devin.ts:77` account route; `:13-17,265-274` ACP authenticates each process and never reuses the CLI credential; `:210-233` a fresh workspace with deny rules; `:38-39` no substitute model on refusal |
| Every route | `server/engines/process.ts:44-50` the environment allowlist; `server/engines/service.ts:260-262` the adapter's working directory; `:387-397` the capability and disclosure lines |

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

## Not proven by this work

- **A clean Windows standard-user install of the exact artifact.** Nothing here was
  packaged, installed or run from a published build.
- **A real consented provider result.** No account was contacted; no route produced a
  reviewed proposal as part of this work.
- **Restart and repeat.** The binding, receipt and readiness behaviour after a restart is
  a claim for the lanes that implement it, proven by their own runs.
- **The reporting customer's diagnosis.** Their root cause remains unconfirmed, and no
  repair here may be described as having fixed it.
- **Drive roadmap canonical-versus-mirror reconciliation.** The audit recorded a newer
  mirror that says the canonical document could not be updated. That competing authority
  is untouched here and still needs reconciling by its owner.

Everything in this record is in source. None of it is packaged, and none of it has been
verified on a machine other than the one it was written on.
