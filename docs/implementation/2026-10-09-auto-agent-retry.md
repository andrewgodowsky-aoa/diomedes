# Auto agent retry repair

## Work order

- Feature: auto-agent-retry
- Prompt: owner request, post-merge PR #258 regression (not a reopened DIO-292)
- Owner: Codex, chat 01a12055-6171-7a81-b328-6b9b62330ca1
- Branch: feature/auto-agent-retry
- Worktree: F:/Diomedes/diomedes-wt/auto-agent-retry
- Base: origin/main 92bc57bd678865390f17291beb382642769e73e5
- Scope: effective worker persistence and ordinary Retry/Resume admission; no provider-picker work or deployment.
- Coordination: Codex uses the integrator seat for the owner's explicitly requested repair to native Work and its admission path. This is a role label, not model attribution.
- Canonical mirrors: Pillars, Roadmap and Project Memory version 2026-10-06.1. No product definition or roadmap completion changes.

## Investigation

Auto's picker chooses Writer for an email. The direct send passes the thread's
`auto` request plus transient `pickedAgentId` to NativeWorkService. AgentRegistry
resolves Writer and Native Work frames and attributes the run as Writer, but
WorkInputs originally saved only `agentId: auto`. DurableControls reconstructed
Retry/Resume from that field and lost Writer.

The direct `/ask` path does not save a Work consent receipt. DurableControls
requires a recorded consent for the task and route before restarting. Regression
fixtures establish it through an ordinary Work start; missing consent must still
refuse. This is a source-backed regression reproduced locally, not evidence of a
production incident.

## Verification

- RED on unchanged base: 5 failed, 5 passed. Writer became Builder on Retry,
  native Resume and fresh-session Resume; the durable field was missing.
- Focused repair run: 19 passed, 0 failed, 0 skipped. Real HTTP, Store reload,
  AgentRegistry, native Work and Codex controls; the engine is the existing
  disk-backed JSON-RPC fixture. No real provider calls.
- TypeScript: passed (`tsc --noEmit`, exit 0).
- Full unit suite: 623 files passed; 10,538 tests passed, 0 failed, 5 skipped
  (`vitest run --maxWorkers=4`, exit 0, 711.55 seconds).
- Client build: passed (`vite build`, exit 0). Vite reported its large-chunk warning.
- Required browser gate: 37 passed, 0 failed, 0 skipped
  (`playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts`,
  exit 0, 1.8 minutes). Other browser suites and configurations were not run.
- `git diff --check`: passed. Remote main still matched the base after the full
  unit gate and before publication.
- Setup failures before collection were missing packages in the initial local
  dependency junctions. Both links now use the existing populated install;
  package manifests and lockfiles are unchanged.

Logs are in this worktree's ignored `test-results/auto-agent-retry-*.log` files.

## Repair and review

1. `server/agent-pick.ts` and the direct send in `server/app.ts` already select and
   frame Writer correctly. They remain the source of the initial choice.
2. `server/native-work.ts` now saves the resolved worker in optional
   `WorkInputs.pickedAgentId`, alongside the requested choice. Explicit agents
   retain manual attribution; Auto retains automatic attribution.
3. `server/durable-controls.ts` restores that identity. For sessions written by
   earlier builds it reads the existing agent resolution, without rewriting the
   original session. It binds the effective identity into the normal Work command
   digest and passes requested selection and work mode as internal restart context.
4. `server/app.ts` sends the restored selection through ordinary Work admission.
   This context is not part of the public request schema. Current service,
   sharing, consent, task and permission checks still apply. Fixer retains its
   recorded work mode rather than being retried as Build.
5. Native Work resolves the agent's current definition, compatibility and grant
   again. It refuses if routing would substitute a different agent. It never
   restores the old agent policy or grant. Origin attribution and proposal framing
   are generated from the new resolution through the existing path.

Review covered the effective agent's flow, the separation of identity from
authorization, legacy records, profiles that change the worker, and public request
isolation. Regression coverage includes repeated Retry, receipt replay, native
Resume and its fresh-session fallback, explicit Writer/Builder/Fixer, older
sessions with and without agent snapshots, missing inputs, missing consent,
revoked sharing, narrowed permissions, widened Resume permission and revoked
grants. This is local implementation and review evidence, not installed-app or
production acceptance.

## Boundaries

- Sessions older than agent snapshots and without an effective selection retain
  their existing default behavior. There is no evidence from which to reconstruct
  an unrecorded historical worker.
- GitHub Actions is disabled (live readback); no CI run was triggered.
- No provider-picker, account policy, migration, package, release, deployment or
  installed application change. DIO-292 and DIO-300 statuses are unchanged.
- Installed-app, live provider and customer acceptance were not run.
