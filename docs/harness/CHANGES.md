# Harness host integration changes, 2026-09-09

Continuation: [NR-02/NR-03 changes and proof](NR02_NR03_VERIFICATION_2026-09-09.md).
The descriptions below apply to the earlier packet, not every subsequent source change.

This integrates the runtime packet against committed main `86ee91d` and harness
boundary `c777c41`. Main already contains the approval/foundation integration at
`0ad3951`; the old Codex worktrees were not used as uncommitted sources.

`HARNESS_CONTRACT_VERSION` remains 1. `shared/harness.ts` is unchanged. The file
reader still refuses every run-file `v` other than 1. The host additionally
validates the structure and event sequence before attempting recovery.

## Necessary host seams

- `Need.harness?: { runId, intent }` is an optional binding in `shared/types.ts`.
  Existing Need, Session and text-approval records retain their shapes. A harness
  Need uses `preview: []` and `approval.actionDigest === step.intentHash`. Its
  stored intent allows the existing receipt validator and prepared-write journal
  to verify the exact text, destination, expected hash, project and run without
  loading run files during Store recovery. It is not a second approval record.
- Harness action hashes are bare SHA-256, as defined by the boundary. Proposal,
  base and command-payload hashes retain the existing `sha256:` format. The
  server and existing client decision helper understand the action-hash variant;
  text approvals still require their original identities.
- `Decision.expiresAt` is an optional absolute cap alongside `ttlMs`. The bridge
  passes the Need deadline as well as its remaining life, so queue or disk latency
  cannot extend the saved harness approval beyond the person's approval window.
- `Store.recordApprovalDecision`, `approvalId` links and `Store.writeRecorded`
  remain in use. A harness write settles its execution receipt in the existing
  journal, but only `presentRun` may finish the Session. Store startup preserves
  harness Sessions and pending Needs until the host has read their run records.
- `RunService.recover(runId, principal)` is an additive startup-only method. The
  caller must already own the data-folder lock, have completed Store recovery,
  and have dispatched no work. It invalidates the dead owner's lease, makes safe
  interrupted steps retryable and parks unknown non-idempotent effects. There is
  no HTTP recovery action or second scheduler. The CLI and desktop already claim
  the data-folder lock before calling `createApp`; tests use exclusive temp data.
- `server/app.ts` needs initialization, close, Work-start, service-selection and
  Need-resolution seams in addition to the route mount and imports. Its existing
  resolution branch sends every exact Need to `NativeWorkService`; one mount
  line alone cannot connect harness receipts without intercepting that route.
- The native token replacement function is shared with the harness. Error names,
  error messages, cancellation reasons, Session event lines and route responses
  use the scrubber. The fixture leases no credentials. Opaque transcript
  references are returned through the scrubber; no transcript content is loaded.
- The fixture adapter's filesystem label now describes its recorded local write.
  This is a trusted in-process adapter, not a security sandbox or a real model.
- Atomic run-file replacement has a bounded Windows sharing-error retry (six
  attempts, at most 300 ms of delay). It retries the same rename, preserves the
  previous record on permanent failure and never repeats a tool handler. The
  host itself starts no timer or poller.

## Recovery and rollback

Store replays a prepared document journal first. The harness then reclaims the
run and replays completed observations. `propose_write` uses the step's stable
idempotency key as the History label; a matching applied receipt returns the
existing observation without calling the document writer again.

Expired unanswered Needs stay waiting and are refused. Stop the run and start a
new fixture for a new approval window; the host does not silently renew consent.
Runs already requiring reconciliation never restart automatically. Unknown
versions, malformed records, duplicate run IDs and unavailable capabilities are
skipped; the corresponding active Session reports that its saved run could not
be read. Other projects can still open.

Runs live only under `projects/<projectId>/harness/runs/`. Removing that directory
does not remove project files, History, Sessions or decision receipts. A code
downgrade to the earlier exact-text-only reader requires the matching pre-run
data snapshot, since that reader cannot interpret an empty-preview harness Need.
No live data was migrated or removed by this work.
