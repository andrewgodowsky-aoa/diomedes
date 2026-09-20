# macOS Apple Silicon candidate and evidence boundary

FD01.I source candidate, 2026-09-19. This is an implementation and handoff
record, not FD01.R acceptance or a Mac release. Canonical versions read:
Pillars 2026-09-19.1; Roadmap and Project Memory 2026-09-19.2.

## Same packaging entry point

`scripts/package-desktop.mjs` accepts `DIOMEDES_DESKTOP_PLATFORM` and
`DIOMEDES_DESKTOP_ARCH`. Supported pairs are `win32/x64` and `darwin/arm64`.
Without overrides it uses the host platform and architecture. Windows x64
keeps its name, icon, metadata, three pinned Codex files, staging flow, bundle
entry, ASAR setting and output directory. No dependency or package script changed.

`DIOMEDES_ELECTRON_ZIP_DIR` selects an existing archive directory through
Electron Packager's offline archive option. The Mac target requires
`electron-v<installed-electron-version>-darwin-arm64.zip` there and refuses
before staging or downloading if it is absent. Windows can use the same option;
its default archive behavior remains unchanged.

Each successful output has `BUILD_INFO.json` inside its ASAR, a build-info
record under `evidence/windows-release/` or `evidence/macos-release/`, and an
adjacent `release/Diomedes-<platform>-<arch>.manifest.json`. The latter records
SHA256 for every regular output file and the exact target of each symlink.
Build info records the source snapshot/digest, base commit, target, Electron
version and bundled versus machine-provided runtime resources. Packaging rewrites
the historical Windows build-info path; archive the new record and restore that
tracked file before returning a source-only candidate.

The current Mac resource manifest deliberately bundles **no Codex executable**.
It names `codex`, `claude`, `opencode`, `omp`, `agent`, `devin` and `ollama` as
possible machine-provided tools, not as installed or supported claims. It never
carries `codex.exe` or the Windows sandbox helpers into a Mac package. Electron
arm64 provides the desktop host; no reviewed arm64 Codex distribution or Mac
isolation proof was available. Mac packaging currently uses the upstream icon.

## Current Tier 1 blockers

The available cache contains Electron 44.2.0 for Windows x64 and no Mac arm64
archive. The actual Mac-target command returned the exact missing filename.
No artifact was downloaded. A real Mac package has **not** been produced.

The installed Electron Packager also embeds ASAR integrity into the Framework
on macOS for Electron 41 and later, then calls `codesign` with `--sign -` through
its `resetFrameworkAdHocSignature` implementation. This is an upstream integrity
maintenance operation, not evidence of a Gatekeeper bypass. However this work
order authorizes no ad-hoc signing, so a Mac-host build reports that specific
policy conflict before bundling. It changes neither ASAR integrity settings nor
OS security policy. Independent review and an explicit resolution of that
build-policy boundary are needed before a Mac-host package run. Cross-packaging
on Windows does not establish actual Mac launch or signing correctness.

Resolve the archive and packaging-policy prerequisites, then use the same
entry point in an owned checkout with existing dependencies. Example environment
for an authorized Mac build after that gate is resolved:

```sh
export DIOMEDES_DESKTOP_PLATFORM=darwin
export DIOMEDES_DESKTOP_ARCH=arm64
export DIOMEDES_ELECTRON_ZIP_DIR=/absolute/path/to/approved-existing-archives
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vite build
node scripts/package-desktop.mjs
```

These commands are instructions, not a record of Mac execution. They do not
authorize an artifact download, signing, notarization or distribution. Retain
the full build log, source candidate manifest, Electron archive hash, output
manifest and BUILD_INFO. Do not replace an existing app.

## Discovery through the existing runtime paths

The existing disclosed connection check calls `server/discovery.ts`. A Mac
lookup checks its PATH and explicit locations such as `/opt/homebrew/bin`,
`/usr/local/bin` and the current user's `.local/bin`, `.bun/bin`, `.opencode/bin`
and `.npm-global/bin`. If those do not yield an executable file, it invokes
`/bin/zsh` or the explicitly supported `/bin/bash` with the fixed command
`command -v -- "$1"` and a roster-controlled positional name.

The lookup accepts one absolute executable filename, rejects alias/function
text, multiple lines, control characters, Windows paths and Windows suffixes,
and executes version probes with argv and `shell: false`. Nonzero exits and
timeouts do not establish a version. Output is bounded and raw diagnostics are
not retained. Probe environments omit provider keys and Node injection options.
Login-shell startup still runs the user's own shell configuration; discovery
is disclosed local execution, not an OS sandbox or a claim that shell startup
cannot access that user's files. Only already-supported shell paths are used.

Every discovery result includes observed, absent or unsupported with its method
in the existing disclosure. Absence means not observed in the checked locations.
Hermes/Ollama loopback observations remain separate from binary versions.
EngineService retains that disclosure and passes the discovered location to its
existing version and adapter checks. Copied Windows managed `.exe` resources
are not considered installations on macOS. The managed installer already
refuses unsupported platforms and is unchanged.

Discovery does not grant readiness. Version, account and existing route-policy
checks remain in place. Finder-launched scripts that need an unavailable Node,
Bun or another interpreter can be observed but fail their version check; this
candidate does not copy the login shell's environment into later launches.

Desktop main already sets `DIOMEDES_RUNTIME_DIR` to `resources/native-runtime`.
Native Codex now selects `codex.exe` on Windows and `codex` on other platforms,
and refuses an unproved native platform before app-server/account RPC. An
installed Mac Codex is reported as observed while its route remains unsupported.
There is no fallback to a different binary, account, provider or payer. The
Windows runtime and sandbox proof remain pinned and unchanged.

## Mac-installed evidence required: A02, A23 and A25

Use an exact independently reviewed source/package candidate, an isolated
demonstration profile and approved synthetic data. Record machine model,
Apple Silicon architecture, macOS version, display/scaling, build/source digest,
artifact hashes, route versions and observation time. No credential stores or
raw native diagnostics belong in the evidence bundle.

1. A02: launch normally from Finder, without a developer terminal PATH. Capture
   a launch log and screenshots of the first-run route state before and after
   the disclosed connection check. Save the observed locations/methods and
   scoped absent/unsupported results. Verify the selected supported external
   engine is the same executable the route checks. Actual sign-in or provider
   calls require their own existing authority; a fixture is not that proof.
2. A23: exercise one owned synthetic task across app restart and one laptop
   sleep/wake cycle. Record restored task/history, uncertainty handling and
   owned-process cleanup. Never redispatch an uncertain external effect merely
   to make the demonstration finish.
3. A25: capture the actual laptop and external display at their normal scaling
   and text settings, with long paths and labels visible. Record clipping,
   keyboard and focus results. Browser viewport fixtures cannot pass this row.
4. Hash the retained logs, screenshots and discovery report on the Mac and
   hand back the manifest with the exact candidate identity. Keep unsigned
   founder-local evaluation distinct from signed/notarized customer delivery.

If Gatekeeper prevents normal launch, stop and record the result. This document
does not authorize an override, remove quarantine, ad-hoc sign, disable security
or give customer workaround instructions. Signing/notarization and paid Apple
enrollment remain the separate O10 owner decision.

## Evidence from this Windows lane

Run evidence lives in the Windows machine's coordination root, at
`<git common dir>/diomedes-coordination/unified-20260913/runs/mi-demo-20260919/macos-runtime-discovery/`.
It is local to that machine. A clone does not carry it and a Mac checkout cannot
read it. The frozen manifest is authoritative for the exact source bytes and counts.

- Behavioral RED: discovery 13 failures; packaging 7 failures and 1 existing
  Windows hash-gate pass. Additional copied-Windows-runtime regression failed
  once, then passed. The filtered RED run's 16 unselected tests were skipped.
- Final focused verification: 128 passed, 0 failed, 0 skipped across five files.
  TypeScript exited 0. Vite exited 0 with its existing large-chunk advisory.
- Actual offline Windows package: exit 0, PE x64, 76 manifest entries checked
  with zero hash mismatches; the three original Codex SHA256 pins match.
  Packaged main still sets the resource directory; the bundled service contains
  the discovery changes and the harness fixture is present.
- Not run: full application suite, browser gates for this candidate, Windows
  application launch, real providers, real Mac build, Finder, sleep/wake or
  display/scaling. The Mac package-boundary test substitutes the bundler and
  packager and is only source/configuration proof.

Unchanged input runtime hashes were verified. Whole-archive reproducibility is
not claimed: source has changed and existing BUILD_INFO contains builtAt.
Independent FD01.R rebuild and broader Windows runtime regression remain gates.
The first independent Windows rebuild passed. Its298 inputs were identical;
74 of76 output files matched exactly. The remaining ASAR and executable differed
only through BUILD_INFO.builtAt and its resulting ASAR integrity resource.
This is explained build metadata variation, not reproducible whole-archive bytes.

That review found stale absent-discovery wording after a verified Windows
managed fallback. The repair replaces that wording with an observed managed-
installation method only after checksum and version checks succeed. The original
independent regression is retained, and a failed-checksum case confirms that
verification failure cannot become an observed installation. The repaired
candidate requires fresh independent acceptance; the Mac gates above stay open.
The repaired focused suite passes167 tests across6 files,0 failures or skips;
TypeScript exits0. Packaging source and resources are unchanged by this narrow
repair. A fresh package of the repaired service remains an independent gate.
No install, commit, push, merge, release or deployment occurred.

PILLAR IMPACT: advances P05/P09 through truthful discovery and scoped refusal;
no new Trust authority or product definition. ROADMAP IMPACT: an uncommitted
FD01 source subset is ready for review; FD01, A02, A23 and A25 stay OPEN.
