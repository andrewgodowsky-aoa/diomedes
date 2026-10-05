# Optional Bonsai profiles in the native Agent

Implementation branch: `feature/bonsai-agent-integration`.
Worktree: `F:/Diomedes/diomedes-wt/bonsai-agent-integration`.
Current base: `cb4c49059687e859d827c77d280806657b919f7e` (main, PR #213).
The original base was `04e2d88118cd2fc47dc161877d94a5ea79738717`; the branch
fast-forwarded without overlapping the upstream files or discarding local work.
Pillars, roadmap and project memory mirrors: `2026-09-27.2`.

This is a local implementation, not a shipped or installed desktop feature.
Andrew explicitly authorized the small UI hooks in this isolated branch and
later reconciliation with the reskin. The reskin worktrees and their claims
were preserved. No subagents or additional chats were created.

## Behavior

- The optional catalogue is available only when the Bonsai installation exists.
  Opening the controls checks status without starting a model. A first Home
  conversation is created only after the person chooses the local-model entry
  point or sends a message.
- The controls keep engine, profile, reasoning and Agent separate:
  `Nectovia | Bonsai Gaming | Extra | Auto`, or Bonsai Full. Labels and profile
  capabilities come from the host. The existing Agent picker and Fix reasoning
  ceiling remain authoritative.
- Selecting a profile first saves the thread choice, then requests loading.
  Memory/startup failures remain visible and permit an explicit retry. Returning
  online is an explicit separate action. A missing local profile never selects
  a cloud tier or provider.
- Gaming declares 16,384 context tokens, text input and up to 4,096 output tokens.
  Full declares 131,072 context tokens, text/image input and up to 32,768 output
  tokens. Medium and Extra (`xhigh`) are selectable. Gaming defaults to Medium;
  Full defaults to Extra. These are allowances, not demonstrated quality gains.
- Full uses an enforced 15-minute model-call deadline and a 30-minute native
  conversation-turn deadline. Its existing parent lease is 35 minutes; its
  child lease lasts one minute beyond the turn. The Work text lease lasts one
  minute beyond the Full call deadline. Explicit host lease overrides and
  narrower call limits still apply. Gaming and other routes keep their prior
  deadlines. Full's limits are visible in the controls because Extra can spend
  several minutes thinking before a tool call.
- The native conversation loop still permits at most eight model calls and
  sixteen tool calls per turn. Runtime, Trust, source scope, approval, recorded
  writes, Agent entitlement, cancellation and command identities retain control.
  The model is a provider, with no SDK tool executors or provider-hosted effects.
- Full sends exact selected PNG, JPEG or WebP project versions as image bytes:
  at most four images, each at most 4 MiB. Gaming refuses images. Changed hashes,
  external image URLs and unsupported media are refused. The existing version
  store keeps the bytes; private model transcripts keep image identities without
  duplicating base64 data. Build/Fix retain their text-proposal contract.
- Each request uses the fixed loopback model alias, with redirects and fallback
  refused. The actual chat template is tokenized before inference, reserving the
  output allowance and the launcher's 1,024-token maximum per image. Existing
  text request-byte bounds still apply (200,000 for conversations, 400,000 for
  Work); declaring a 128K model window does not remove those separate limits.
  Provider usage reconciles the context display. Local inference has zero
  provider charge and creates no paid inference reservation.

## Worker lifecycle

The Windows helper uses the existing `F:/Bonsai-2` installation, fixed launcher
and runtime binary. Optional host environment settings can name a different
installation root or an installed PowerShell 7.4+ executable. The desktop
packager already copies `resources/`, which contains this helper; no package,
dependency, version or native-runtime hash changed.

One native queue serializes selection and inference. An exclusive `delegate.lock`
handle coordinates with the existing MCP bridge. Cancellation can stop waiting
for startup without launching a second worker; the queued startup still settles
and releases its lease. Readiness requires the expected listener PID, process
start time, binary, model alias, context and projector mode.

An already-running matching worker may be reused. A profile switch stops only a
worker whose saved ownership identity matches, and only while its slot is idle.
A newly started process is recorded as owned only if its parent PID is this
helper; a separately launched worker that races discovery is not adopted.
Closing the helper releases the lease without stopping the model.

The helper's process exit, not output-pipe EOF, releases the Node-side wait and
signals a lost lease. Two regression tests first failed on the old behavior and
then passed with the process-exit fix. A lease lost after inference dispatch is
not described as a request that was never sent.

## Verification

The test host uses real Store, Runtime, Agent, HTTP routes and UI with scripted
inference and worker lifecycle. It does not call the live model. The Build
fixture proves that no proposed file exists before exact approval, and that
the recorded writer applies it afterward. Image tests inspect the actual wire
bytes and saved source versions. Browser coverage uses the current built UI.

Final-source TypeScript verification passed (`tsc --noEmit`). The complete
Vitest rerun on current main used eight workers and passed 9,692 tests, failed
zero and skipped five across 572 files. Source:
`test-results/bonsai-vitest-final.json` and `test-results/bonsai-typecheck.log`.
The five existing skips cover one Devin sign-in case, two process-table cases,
one Windows short-path case and one unsupported-platform sign-in case.
The helper passed PowerShell parsing, and `git diff --check` passed.

The final production build passed (`vite build`). Its output retained the
existing Rollup annotation and chunk-size warnings. The rebuilt UI passed all
36 standard Playwright tests and the one Bonsai browser scenario: 37 passed,
zero failed and zero skipped. Sources: `test-results/bonsai-build-final.log`,
`test-results/bonsai-playwright-final.log` and `test-results/bonsai-ui-final.log`.
The Bonsai scenario covers first-use selection, reload, memory failure/retry,
image availability and explicit online selection.

The first full run, before registry fixes and the main refresh, recorded 9,672
passed, 13 failed and 5 skipped tests. Ten failures were missing Bonsai contract,
route-list, name or browser-config registrations; all six affected files then
passed 80 tests. Three failures in unchanged ACP/automatic Team cases were a
question-cancellation timeout/EBUSY cleanup and Team timing/history assertions.
Their unchanged focused rerun passed 68 tests. This earlier intermittent
evidence is retained; a later passing run does not establish its root cause.

## Acceptance boundaries

- No installed application was replaced, packaged or launched for this work.
- This chat did not start, stop or edit the standalone Bonsai installation.
  Its runtime chat retained the live worker for retrieval and editing tests.
- Standalone runtime evidence does not establish Nectovia app acceptance.
  In particular, larger Extra budgets do not establish better editing quality;
  the separate runtime chat reported an xhigh edit job that exceeded 20 minutes
  without producing files. The native app uses structured proposals and Store
  approval, but live app quality has not been measured here.
- Team member routing is not added by this patch; ordinary native conversation
  and Build/Fix paths are covered. Local selection grants no additional tools,
  shell access, account rights or permissions.
- No roadmap prompt is marked DONE. Main merge, reskin reconciliation, independent
  review, packaging and installed-app acceptance remain separate work.

## Files

Controls and hooks: `client/console/LocalModelControls.tsx`, `local-models.css`,
`attachments.ts`, `Composer.tsx`, `Diomedes.tsx`, `DiomedesHome.tsx`, `Shell.tsx`,
`WorkStylePicker.tsx`, `thread-send.ts`.

Provider/lifecycle: `shared/bonsai.ts`, `server/bonsai/{images,routes,runtime,windows-host}.ts`,
`resources/bonsai-host.ps1`, `server/engines/{bonsai,contract,service}.ts`.

Native wiring: `server/app.ts`, `server/native-work.ts`, `server/store.ts`,
`server/durable-controls.ts`, `server/evaluation/route-inventory.ts`,
`server/harness/{model-api-adapter,model-session-run,text-route,context-assembly}.ts`,
`server/harness/capabilities/conversation-sources.ts`,
`shared/{capabilities,context-accounting,engines,model-api}.ts`.

Verification: `tests/bonsai-{controls,integration,provider,runtime,windows-host}.test.ts`,
`tests/bonsai-ui.spec.ts`, `playwright.bonsai.config.ts`,
`tests/{google-vertex-model-api,model-api-thinking,spec-coverage,thread-build-fix-model-api}.test.ts`.

Proposed commit: `Add optional Bonsai profiles to the native Agent`.
