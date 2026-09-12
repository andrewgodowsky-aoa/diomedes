# Release baseline: a green main, and two modules that install nothing

September 11, 2026. Brief 01 (REL-01, REL-06) and brief 04 (LOC-01) from the eight
execution briefs prepared September 10. This record states what landed on `main`, what
proved it, and what it does not claim.

## 1. Why main was red, and what fixed it

Every push to `main` since `7c22c88` had failed the unit gate on one test:
`tests/backend.test.ts › the data folder lock tells a live owner from a reused pid ›
this platform reports its own start time`. The probe behind it, `processStartedAt` in
`server/lock.ts`, shells out to Windows PowerShell 5.1 for a process start time. Three
findings, in the order they were made:

1. **The budget was not the variable.** Giving the test a fifteen-second leash
   (`a1a856f`) still timed out at 15200 ms on run `34664792501`. Locally the same probe
   answers in about 300 ms.
2. **The host was cold, not slow.** Every `run:` step on `windows-latest` executes under
   PowerShell 7. Windows PowerShell 5.1 is therefore never launched on the runner until
   vitest spawns it, and a cold 5.1 compiles itself on first start for longer than any
   budget a lock should wait. `server/lock.ts` now tries `pwsh.exe` first and falls back
   to `powershell.exe` inside the same budget, remembering which host answered
   (`282baf3`).
3. **Three workers starved each other.** The same run failed three
   `tests/harness-host.test.ts` child-process cases with `The fixture produced no Need`.
   CI now runs vitest with `--maxWorkers=2`.

Proof: run `34665085056` on `282baf3` passed all gates on `windows-latest`. Locally on the
same commit: tsc clean, 48 backend tests passed, the lock probe answering in 529 ms
through pwsh. `QUESTIONS.md` O6 is narrowed accordingly; the residual question is the 5.1
budget on a machine without pwsh, and whether an unanswered probe should refuse rather
than guess.

## 2. Contracts frozen for the parallel slices

`shared/capability-packs.ts` and `shared/work-control.ts` (`2862fa9`, `b6d26ec`) are
additive type modules with pure helpers and no behaviour. They exist so the slices that
implement them could branch from one shape rather than each invent it. The first commit
shipped with a type error because a shell pipe hid tsc's exit code; the second corrected
it two minutes later. Both are recorded here so the CI history reads truthfully.

## 3. `server/local/hardware.ts` (LOC-01)

Disclosed detection of what this computer has, behind the same consent sentence
`EngineService.discover` uses. Reports OS, CPU, total and immediately available memory
as two numbers, GPUs, disk free space and existing local runtimes. Every command it runs
is appended verbatim to `disclosure`. Only a GPU that `nvidia-smi` answered for is
`measured: true` with `backend: 'cuda'`; the Windows video-controller fallback is
`measured: false`, and AMD/Intel acceleration is named in `unsupported` as not verified.
It installs, starts and downloads nothing; the one command it runs against a found
runtime is `--version`. Written by GLM 5.3 Flash from a fixed one-file brief; seven tests
with a fake `capture`. **Not wired to a screen.** The setup UI is LOC-02 onward.

## 4. `server/support-bundle.ts` (REL-06, module)

A support bundle for a Copy button: app and protocol versions, host facts, data paths,
engine status, project counts, recent errors, and a list in words of what is excluded.
Every string passes `secretScrubber`; the profile directory becomes `~`; errors are
capped at 20 entries of 500 characters. The caller supplies everything, so the module is
deterministic given `now`. Written by Muse Spark 1.3 from a fixed one-file brief; six
tests. **Not yet reachable from the app.** The `/api/support/bundle` route and the
Settings › About button are the next action and are wired in the integration pass that
follows the other September 11 slices.

## 5. What this does not claim

No package was built, no release published, no live provider called, no cloud document
written. The eight briefs remain the open scope; this record covers REL-01, the module
half of REL-06, and LOC-01.

**PILLAR IMPACT.** Advances 05 (self-setup: hardware discovery with disclosure) and 11
(scale without the founder: a support bundle that excludes secrets). No conflict. Proof:
the tests named above and CI run `34665085056`.

**BUILD / PUBLICATION / DEPLOYMENT STATUS.** Source and CI only. Version stays 0.1.1.
