# Windows 0.1.1 verification

This is local evidence for the exact unsigned candidate described in RELEASE_HANDOFF.md.
It is not CI, public-download verification, authenticated business tenancy or live Toast proof.

## Source and integration

The isolated branch is `codex/windows-release-20260909`, based on remote main
`11829e1962b448360d3fc7aaba7c38fda6833a84`. Runtime's completed 143-file snapshot
was imported with hashes; Trust files were preserved verbatim. The separate
Connections task froze a 28-file import. Compiler/MCP work was completed by the
primary and Sol. Original checkouts and the last good M1 package were preserved.

The application build embeds `BUILD_INFO.json`. Its build-input digest is
`09e551958dfab590f12dc4678664a32c9244f88ef1982723d8fe97b35b292803`.
The manifest hashes application sources, compiled client, fixtures, package metadata,
licenses and the desktop package script before and after bundling. It also records
the native binary pins. Later verification scripts/docs are not compiled app inputs.

## Commands and results

All commands ran from the owned Windows release checkout, with separate profiles,
project roots and ports. Existing shared node_modules was read-only.

| Check | Command or driver | Result / evidence |
| --- | --- | --- |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | PASS; `evidence/windows-release/final-typecheck.log` |
| Full unit/security/runtime suite | `node node_modules/vitest/vitest.mjs run --no-file-parallelism --reporter=json --outputFile=evidence/windows-release/final-unit-tests.json` | 615/615 PASS, 91 reported suites; JSON includes exact cases |
| Existing browser suite | `node node_modules/@playwright/test/cli.js test` with unique client/service/native ports | 24 ordinary tests passed; three native tests initially lacked dist. Those three passed after a build; retained `app-regression-browser.log`, `native-built-browser-2.log` |
| Added built-client Connections | `DIOMEDES_BUILT_CLIENT=1` and `playwright.connections.config.ts` | PASS; `connections-built-browser-2.log`, `connections-browser.json` |
| Client compilation | `node node_modules/vite/bin/vite.js build` | PASS; `final-client-build.log` |
| Real native model | `scripts/connections-provider-smoke.ts --send-synthetic` with the explicit Sol route and a new root | PASS, one provider entry; `provider-smoke-sol-1/proof.json` |
| Desktop build | `node --use-system-ca scripts/package-desktop.mjs` | PASS; `package-build-final.log`, embedded/evidence build info |
| Actual desktop Connections | `node scripts/connections-desktop-smoke.mjs <exact Diomedes.exe> <new proof root>` | 11 PASS; `test-results/package-connections-final/proof.json` |
| Relocated legacy/runtime regression | `node scripts/harness-desktop-smoke.mjs <relocated exe> <new root> --source-unavailable` | 10 named checks PASS; `test-results/package-relocated-final/proof.json` |
| Installer construction | `node scripts/build-windows-installer.mjs --no-download` | Official pinned NSIS 3.12, `/WX`, final real 76-file payload; `installer-build-final.log` |
| Install/launch/repair/uninstall | `scripts/verify-windows-installer.ps1` with explicit final installer, payload and new proof root | PASS; `test-results/installer-final-3/proof.json` plus its 11-scenario installed runtime proof |
| ZIP integrity | .NET ZipFile create/extract, all 76 files compared by SHA-256 | PASS; `package-files.json`, `portable-zip-hash.json` |
| Actual version upgrade from ZIP | `node scripts/upgrade-desktop-smoke.mjs <preserved 0.1.0 exe> <ZIP-extracted 0.1.1 exe> <new root>` | PASS; `test-results/archive-upgrade-final-2/proof.json` |

The source-unavailable run temporarily renamed only this checkout's `server`,
`client`, `fixtures` and `dist`, with absolute target checks and restoration in
PowerShell `finally`. The application ran from the relocated full package using
an independent working directory. All four source directories were restored.

The installer test used a unique experimental product ID, fresh empty installation
directory, current-user registration and isolated profile. Every installed file
matched the packaged payload. Same-version repair retained an unknown app-directory
file and an isolated profile marker. Uninstall removed the exact owned files,
registration and shortcut while retaining those markers. The separate actual
0.1.0-to-0.1.1 application upgrade retained project data, preferences, History and an
exact waiting Need, then approved one recorded write without repeating its read.
No live installation was replaced. A Windows account without this machine's caches
and antivirus reputation has not been tested; upgrade from other versions is unproven.

## Business and authority proof

The actual executable presents incomplete-intent questions before activation,
then an exact synthetic connection proposal with three approved locations. Typed
reads preserve numeric, unknown and untracked availability. The role/connector
context is scoped, bounded and frozen as a durable context step before dispatch.

A deliberately bad SCRIPTED model answer claims a numeric count for untracked
stock. Final-output inspection records the original answer and a rule-versioned
correction. A distinct model step supplies the corrected answer. This is an injected
model test, not a claim that the real provider made or corrected that mistake.

Signed raw HTTP ingress persists its receipt before returning 202. Service hours
AND reported numeric threshold create one internal manager Task. Duplicate and
conflicting IDs, current authority, generation, stale/superseded observations and
recovery are checked. The package was forcibly terminated after acknowledgment
and before triage; an explicit new-session authorization recovered the accepted
receipt once. Source tests also cover the Task-commit crash boundary.

The registered write probe uses an actual write-capable registry entry. The
Runtime denied it before the handler; dispatch count remained zero. It is available
only under the explicit isolated test-mode environment, and never writes to Toast.

Two unrelated OpenAPI services (library/helpdesk) are separately reviewed, compiled
and invoked by the official SDK MCP client over in-memory transport. Native calls
and MCP use the same ConnectionsService and Runtime; the MCP projection adds no
permission source, listener or credential store.

Exact Need expiry, changed base/payload, replay, lost response and authority-loss
invariants are covered by the full unit suite. The relocated executable exercises
exact preview in both surfaces, one-write lost-response retry, decline, Stop,
waiting approval restart, cursors, History, restore and the controlled Usage race.
Additional packaged negative checks are reported separately in PACKAGE_NEGATIVE_PROOF.md.
Those four checks passed on the final executable: reordered event/replay, a strict
privilege-expansion refusal, changed-base protection and expired approval refusal.
Expiry used controlled valid-state aging while the owned app was stopped, with
the canonical v1 identities recomputed; it did not change the Windows clock or
wait one wall-clock hour. That fixture method and before/after hashes are explicit.

The offline improvement replay calls pure deterministic evaluation on frozen local
cases. It compares preserved numeric/workflow outcomes and coverage of the new
unknown-quantity instruction. Adoption checks current base, expiry and full scope;
rollback is a new version. This does not establish model compliance, quality,
latency or cost improvement. No replay path has a network/model dispatch function.

## Real provider and direct-agent coverage

The fresh synthetic report used `gpt-5.6-sol` through the existing native ChatGPT
sign-in and pinned Codex integration. The driver never reads/copies credentials,
changes CODEX_HOME configuration or chooses an API billing fallback. It froze the
synthetic connector observations and guidance before issuing the existing expiring
egress grant, recorded one actual provider call, reviewed the exact output bytes,
performed one Store-recorded write and denied stale authority after recreation.

This is the bounded host-only codex-report route. It does not expose general
Connections tools to a live model or implement ordinary authenticated-user starts.
There is no second independently ready adapter in this app composition. An external
agent's own internal tools/stream are not intercepted by NativeAgent's optional
hooks. Frozen initial egress, final-result acceptance, exact local write and current
Trust checks are separate enforceable boundaries; provider sandbox claims are not
an OS/network containment proof.

## Measured behavior and limits

The final Connections package run recorded startup-ready times of 30,887 ms for
the first observed launch and 1,660 / 1,538 / 1,600 ms for subsequent launches.
These are Playwright-to-window/API timings on a busy Windows 11 Home build 26200
machine, not a cold-start benchmark. The first-launch outlier remains disclosed;
its antivirus/cache contribution was not isolated. Later installed runs have their
own timestamps in their proof files. Local event acknowledgment was 217 ms in the
named final run; this is not a Toast production delivery SLA.

Four-second Electron idle samples, including per-process CPU, working set and
private bytes, are in the final proof. Summing process working sets double-counts
shared memory; the manifest therefore labels the summed values as process totals,
not unique system RAM. Every recorded owned loopback port closed after shutdown.
No renderer page errors were observed. Primary visually inspected the actual
packaged Console and narrow Connections screenshots; no horizontal overflow was
reported at 760 px. This is bounded visual proof, not an accessibility audit.

## Failures retained and repaired

- Initial npm reporter forwarding was rejected as configuration; direct Vitest CLI ran the suite.
- Native browser tests initially lacked built assets; rebuilding exposed and fixed missing JSON import attributes.
- A built Connections test exposed incorrect run ordering; snapshots now sort by creation time and ID.
- Review found missing restart event recovery, transcript replay advancement and prepared-tool narrowing; app changes and targeted regressions preceded the final build.
- The first package driver assumed a particular rule array position; the driver now finds the actual create-issue rule.
- The first installer driver accidentally concatenated two PowerShell registry paths; its owned test installation was uninstalled, the assertion corrected, and a fresh full run passed.
- The first upgrade driver treated fetch response.ok as a function; corrected and rerun from a new root.

Historical failure logs and final successes are retained. Test-driver repairs did
not change final app bytes. No tests were weakened to accept application failures.

## ROADMAP IMPACT

The local .7 checkpoint reconciles .6 product decisions with this narrower delivered
proof. Runtime/Trust integration and local Windows delivery advanced; source/CI/public
release, live vendor transport, authenticated business authority, complete native
dependency notice inventory and the combined live-model workflow remain separate.
