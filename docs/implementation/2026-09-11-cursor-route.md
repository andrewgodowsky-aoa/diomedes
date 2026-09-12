# Cursor route (ENG-04, ENG-05) - 2026-09-11

## Implemented and proven

Implemented the fourth external-engine entry as a bounded ACP text adapter on
`astra/cursor-route-20260911`, base `b6d26ec0701f2d22cf1a94edf186f8422c689ec5`.
ACP worked non-interactively, so no print-mode fallback was implemented. The exact
initialize exchange is recorded at the top of `server/engines/cursor.ts`.
The installed `agent.cmd` resolves through `cursor-agent.ps1` to
`C:\Users\andre\AppData\Local\cursor-agent\versions\2026.08.11-e8db854\node.exe`
with adjacent `index.js`; adapter, version checks and login launch that pair directly.

Native status inspection, explicit ACP model selection, account attribution,
denial of permissions/questions/plans, unexpected-tool rejection, byte limits,
timeouts, cancellation ordering and late-output rejection have protocol fixtures.
Cursor has no no-tools advertisement: the adapter configures native deny rules,
sets ACP ask mode, advertises no filesystem/terminal capabilities, and rejects
tool events. Windows uses fresh configuration, data and home directories while
preserving native APPDATA for Cursor-owned authentication. No credential is copied.
The fourth setup row renders; installation is unavailable and points to cursor.com.
API fixtures prove Cursor text proposals retain exact approval and Store History.

Final seven-file Vitest run, started **21:54:40 on 2026-09-11**, Vitest **3.2.7**:
**97 passed, 17 failed, 114 total; 5 files passed, 2 failed; no skipped tests**.
All **38 Cursor adapter tests** passed. Source: terminal output of the exact seven
files in the brief with `--configLoader runner` appended. The unmodified command
was also attempted; it ran zero tests because Vite's bundled config loader tried
to write through the node_modules junction and received EPERM. The runner loader
avoids that write. `git diff --check` passed.

Live probe, installed CLI **2026.08.11-e8db854**: native status reported authenticated;
ACP advertised **38 catalogue entries**. `inspect()` reached the catalogue but
threw `CLEANUP_FAILED` after **5.426 s**. The one authorized generation used
`composer-2.5[fast=true]`, returned the text event **READY**, and ended with
`stopReason: end_turn`; `generate()` then threw `CLEANUP_FAILED` after **10.043 s**.
That model string was observed in the runtime catalogue and accepted by
`session/set_model`. No separate turn model was reported, so the adapter uses the
requested ID as specified; it does not infer identity from the answer.
No live cancellation acknowledgement was observed: this turn completed normally.
Fixtures prove cancel notification before the existing owned-process stop path.
The probe driver directly stopped its captured Cursor child processes after the
shared cleanup path failed; this is not proof of normal adapter cleanup.

## Partial or blocked

`./node_modules/.bin/tsc --noEmit` exits 1 with exactly two TS2741 diagnostics,
both in the out-of-scope `tests/ai-engines-ui.spec.ts` engine maps. The 17 regression
failures are six Claude and eleven OpenCode tests: the existing Windows
`killOwnedProcess` path cannot confirm process stop in this sandbox, followed by
EBUSY fixture-directory cleanup. That same path blocks successful live Cursor
adapter returns. No assertion or process guard was weakened to hide this.

Measured Cursor support is ACP metadata and one text turn, plus protocol/API
fixtures. Readiness, live cancellation, native tool containment, non-Windows
behavior and provider billing after dispatch remain unproven. This is not a claim
of four production-ready routes. No browser or packaged-app proof was run.

## Exact next action

The integrator should add the two UI-test map entries below, reconcile the Console
picker lists, and repeat the same TypeScript/seven-file checks in a verification
environment where the existing owned-process termination path works. Then repeat
native inspection and verify a cancelled Cursor turn before marking ENG-04/ENG-05
ready. Review the retained probe directories before cleanup; do not stage them.

## PILLAR IMPACT (07, 09) and BUILD / PUBLICATION / DEPLOYMENT STATUS

07: adds a Cursor account resource with engine/model identity kept distinct from
Diomedes supervision. 09: preserves native sign-in ownership, drops inherited API
keys/endpoints, declines blocking capabilities and keeps writes behind Store review.
The remaining native-process uncertainty is disclosed, not an authority expansion.
Protocol, attribution, environment and approval/History fixtures are the proof.

Mirrors read: Pillars **2026-09-10.1**, Roadmap **2026-09-10.8**, Project Memory
**2026-09-10.7**. ROADMAP IMPACT: implementation progress recorded here only;
no canonical status or product definition changed, and ENG-04/ENG-05 are not marked
complete. Cloud documents were not changed. Nothing built, packaged, published or
deployed. No version bump, commit, push or merge. All changes remain uncommitted.

Changed files: `shared/types.ts`, `shared/engines.ts`, `shared/capabilities.ts`,
`server/engines/cursor.ts`, `server/engines/service.ts`, `server/engines/install.ts`,
`server/engines/login.ts`, `server/discovery.ts`, `client/AISetup.tsx`,
`tests/cursor-adapter.test.ts`, `tests/engine-service.test.ts`,
`tests/ai-setup-api.test.ts`, `tests/discovery.test.ts`, `tests/capabilities.test.ts`,
and this report. `shared/types.ts` changes only the ExternalEngine line; Route
already includes ExternalEngine. The frozen capability-pack/work-control files
and all other worktrees were left unchanged.

## Needs the integrator

- `tests/ai-engines-ui.spec.ts:25`: add `cursor: '2026.08.11'` to `versions`;
  at line 30 add `cursor: 'Cursor'` to `names`. These are the two type-check blockers.
- `client/console/Picker.tsx:13` and `client/console/Shell.tsx:216` still enumerate
  three external engines. Integrate Cursor into those picker/catalogue paths.
  `shared/types.ts:432` separately enumerates team engines; reconcile that contract
  and its team tests before offering Cursor as a team engine.
- `ADAPTER_CAPABILITIES` lives in `server/harness/adapters.ts`, not
  `shared/harness.ts`. It currently has no Claude/OpenCode/OMP text entries either.
  No native-harness Cursor capability entry was invented in the shared type file;
  any such integration belongs to that file's owner.
- Investigate/reverify `server/integrations.ts:204` (`killOwnedProcess`) under the
  intended verification permissions. Existing Claude/OpenCode fixture cleanup is
  also affected; clean only processes/data identified as owned by these test runs.
- Four probe directories remain under this worktree:
  `.diomedes-cursor-8vl43t`, `.diomedes-cursor-ctBJTN`,
  `.diomedes-cursor-4gaIm3`, `.diomedes-cursor-xHmoVt`.
  Automatic approval review rejected both verified-path and explicit-literal
  cleanup commands with the stated reason **"blocked by policy"**. No cleanup
  workaround or deletion outside the approved worktree was attempted.
