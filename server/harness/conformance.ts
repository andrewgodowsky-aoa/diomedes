/**
 * The reusable adapter conformance surface.
 *
 * Two check families, both pure:
 *
 *   `contractChecks` — the invariants a route descriptor must keep: every
 *   lifecycle command answered explicitly, honesty between mode and
 *   streaming, and a recorded tested version wherever an external binary
 *   stands behind the route.
 *
 *   `streamChecks` — the invariants a durable run's event stream must keep:
 *   dense `seq` from 1, uniform run attribution, step events carrying their
 *   step and attempt, exactly one terminal event at the end or none while
 *   the run is parked. A stream that fails these is corrupt evidence, not
 *   data to repair.
 *
 * Outcomes reuse the revision's evidence vocabulary so a report reads the
 * same way as every other gate in the program.
 */
import { EVIDENCE_OUTCOMES } from '../../shared/contract-revision.js';
import {
  ADAPTER_COMMANDS,
  adapterRouteContractSchema,
  isRunEventType,
  isTerminalEventType,
  streamIntegrity,
  terminalEvent,
  type AdapterRouteContract,
  type RouteMode,
  type TerminalEventType,
} from '../../shared/adapter-contract.js';
import type { HarnessRun } from '../../shared/harness.js';

export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export interface ConformanceCheck {
  readonly id: string;
  readonly outcome: EvidenceOutcome;
  readonly detail: string;
}

const check = (id: string, ok: boolean, detail: string): ConformanceCheck => ({
  id,
  outcome: ok ? 'passed' : 'failed',
  detail,
});

// --- descriptor checks -----------------------------------------------------------------

export function contractChecks(contract: AdapterRouteContract): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];

  const parsed = adapterRouteContractSchema.safeParse(contract);
  checks.push(
    check(
      'descriptor-schema',
      parsed.success,
      parsed.success
        ? 'The descriptor validates against adapter-contract v1.'
        : `Descriptor failed validation: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
    ),
  );
  if (!parsed.success) return checks;

  const missing = ADAPTER_COMMANDS.filter((command) => !contract.commands?.[command]);
  checks.push(
    check(
      'all-commands-answered',
      missing.length === 0,
      missing.length
        ? `Commands with no declared support: ${missing.join(', ')}.`
        : 'All ten lifecycle commands carry an explicit support answer.',
    ),
  );

  const unsupportedWithoutNote = ADAPTER_COMMANDS.filter(
    (command) =>
      contract.commands?.[command]?.support === 'unsupported' &&
      !contract.commands[command].note.trim(),
  );
  checks.push(
    check(
      'unsupported-is-declared',
      unsupportedWithoutNote.length === 0,
      unsupportedWithoutNote.length
        ? `Unsupported without a reason: ${unsupportedWithoutNote.join(', ')}.`
        : 'Every unsupported command says why.',
    ),
  );

  // Native workers and direct Codex sessions persist host outcomes. Only
  // routes actually driven by RunService may advertise a durable run stream.
  const RUN_DRIVEN_MODES: readonly RouteMode[] = [
    'harness-agent',
    'single-turn-text',
  ];
  // This external-session profile is driven by ClaudeSessionRuns/RunService.
  // Do not grant every external-session descriptor a durable stream merely
  // because this one now has a tested host integration.
  const nativeRunBacked =
    contract.routeId === 'claude-code-session' &&
    contract.mode === 'external-session' &&
    contract.engine.id === 'claude-code' &&
    contract.engine.version === '2.1.252' &&
    contract.engine.protocolVersion === 'stream-json' &&
    contract.testedWith === '2.1.252' &&
    contract.authentication === 'native-sign-in' &&
    contract.models.source === 'runtime-reported' &&
    contract.streaming.transientPreview === 'text-delta' &&
    contract.streaming.durableEvents === 'run-record' &&
    (['start', 'follow-up', 'interrupt', 'resume', 'fork', 'close'] as const)
      .every(command => contract.commands[command].support === 'native') &&
    contract.commands.retry.support === 'host' &&
    contract.commands.status.support === 'host' &&
    // H03: its steering is the host's queue, never a claimed native channel.
    contract.commands.steer.support === 'host' &&
    contract.commands.reconcile.support === 'unsupported';
  if (contract.routeId === 'claude-code-session')
    checks.push(check(
      'native-session-run-backing', nativeRunBacked,
      'The opt-in Claude native profile must match the versioned RunService lifecycle integration; live provider acceptance is separate.',
    ));
  // The kept OpenCode session (H04) is driven by the same RunService lifecycle.
  // Its steering is the host's queue, never a claimed native channel.
  const openCodeRunBacked =
    contract.routeId === 'opencode-session' &&
    contract.mode === 'external-session' &&
    contract.engine.id === 'opencode' &&
    contract.engine.version === '1.18.4' &&
    contract.engine.protocolVersion === 'http+sse' &&
    contract.testedWith === '1.18.4' &&
    contract.authentication === 'native-sign-in' &&
    contract.models.source === 'runtime-reported' &&
    contract.streaming.transientPreview === 'text-delta' &&
    contract.streaming.durableEvents === 'run-record' &&
    (['start', 'follow-up', 'interrupt', 'resume', 'fork', 'close'] as const)
      .every(command => contract.commands[command].support === 'native') &&
    contract.commands.retry.support === 'host' &&
    contract.commands.status.support === 'host' &&
    contract.commands.steer.support === 'host' &&
    contract.commands.reconcile.support === 'unsupported';
  if (contract.routeId === 'opencode-session')
    checks.push(check(
      'native-session-run-backing', openCodeRunBacked,
      'The opt-in OpenCode session profile must match the versioned RunService lifecycle integration; live provider acceptance is separate.',
    ));
  // The kept ACP conversations (H05) are driven by the same RunService lifecycle.
  // No steering and no fork are claimed; restart reconciliation is the host's.
  const ACP_SESSIONS: Record<string, { engine: string; version: string }> = {
    'cursor-session': { engine: 'cursor', version: '2026.08.11' },
    'devin-session': { engine: 'devin', version: '3000.10.23' },
  };
  const acpProfile = ACP_SESSIONS[contract.routeId];
  const acpRunBacked =
    acpProfile !== undefined &&
    contract.mode === 'external-session' &&
    contract.engine.id === acpProfile.engine &&
    contract.engine.version === acpProfile.version &&
    contract.engine.protocolVersion === 'acp/1' &&
    contract.testedWith === acpProfile.version &&
    contract.authentication === 'native-sign-in' &&
    contract.models.source === 'runtime-reported' &&
    contract.streaming.transientPreview === 'text-delta' &&
    contract.streaming.durableEvents === 'run-record' &&
    (['start', 'follow-up', 'interrupt', 'resume', 'close'] as const)
      .every(command => contract.commands[command].support === 'native') &&
    contract.commands.retry.support === 'host' &&
    contract.commands.status.support === 'host' &&
    contract.commands.reconcile.support === 'host' &&
    contract.commands.steer.support === 'unsupported' &&
    contract.commands.fork.support === 'unsupported';
  if (acpProfile)
    checks.push(check(
      'native-session-run-backing', acpRunBacked,
      'The opt-in ACP session profile must match the versioned RunService lifecycle integration; live provider acceptance is separate.',
    ));
  checks.push(
    check(
      'streaming-matches-mode',
      contract.streaming.durableEvents === 'run-record'
        ? RUN_DRIVEN_MODES.includes(contract.mode) || nativeRunBacked || openCodeRunBacked || acpRunBacked
        : contract.mode !== 'harness-agent',
      contract.mode === 'harness-agent'
        ? 'Harness routes persist through the run record.'
        : 'Only a run-driven route may claim run-record events.',
    ),
  );

  checks.push(
    check(
      'tested-version-recorded',
      contract.mode === 'harness-agent' || contract.mode === 'native-worker'
        ? true
        : contract.testedWith !== null,
      contract.testedWith === null
        ? 'No external binary version is pinned for this route.'
        : `Conformance evidence covers ${contract.testedWith}; a version change invalidates it.`,
    ),
  );

  // Proof is versioned: evidence gathered against one build does not stretch
  // to the next. A descriptor whose engine moved past its tested build is
  // stale proof, not a working route.
  checks.push(
    check(
      'tested-version-current',
      contract.testedWith === null || contract.testedWith === contract.engine?.version,
      contract.testedWith === null
        ? 'No external binary stands behind this route.'
        : contract.testedWith === contract.engine?.version
          ? `The descriptor's engine is the build conformance covered (${contract.testedWith}).`
          : `The descriptor declares ${contract.engine?.version} but conformance evidence covers ${contract.testedWith}; the proof is stale.`,
    ),
  );

  checks.push(
    check(
      'engine-identity-present',
      Boolean(contract.engine?.id && contract.engine?.version),
      'The engine id and version are the attribution anchor.',
    ),
  );

  return checks;
}

// --- durable-stream checks --------------------------------------------------------------

export function streamChecks(run: HarnessRun): ConformanceCheck[] {
  const events = run.events;
  const checks: ConformanceCheck[] = [];

  checks.push(check(
    'events-belong-to-run',
    events.every((event) => event.runId === run.id),
    'Every event must name the run whose durable record contains it.',
  ));

  const integrity = streamIntegrity(events);
  checks.push(
    check(
      'dense-in-order-seq',
      integrity.ok,
      integrity.ok
        ? 'Events sequence 1..N with no gap, duplicate or foreign run.'
        : `${integrity.reason} (at index ${integrity.at})`,
    ),
  );

  const terminals = events.filter((event) => isTerminalEventType(event.type));
  const terminal = terminalEvent(events);
  checks.push(
    check(
      'single-terminal-event',
      terminals.length <= 1,
      terminal
        ? `One terminal event: ${terminal.type} at seq ${terminal.seq}.`
        : 'No terminal event — the run is live or parked, and neither reads as finished.',
    ),
  );
  checks.push(
    check(
      'terminal-only-at-end',
      terminal ? terminal.seq === run.lastSeq : true,
      terminal
        ? terminal.seq === run.lastSeq
          ? 'Nothing is recorded after the terminal event.'
          : 'Events exist after the terminal event — the stream is corrupt.'
        : 'No terminal event exists to check position against.',
    ),
  );

  const untyped = events.filter((event) => !isRunEventType(event.type));
  checks.push(
    check(
      'all-types-in-vocabulary',
      untyped.length === 0,
      untyped.length
        ? `Unknown event types: ${[...new Set(untyped.map((e) => e.type))].join(', ')}.`
        : 'Every event type belongs to the closed vocabulary.',
    ),
  );

  const misattributed = events.filter(
    (event) =>
      event.type.startsWith('step.') &&
      (typeof event.stepId !== 'string' || typeof event.attempt !== 'number'),
  );
  checks.push(
    check(
      'step-events-attributed',
      misattributed.length === 0,
      misattributed.length
        ? `${misattributed.length} step events lack stepId or attempt.`
        : 'Every step event names its step and attempt.',
    ),
  );

  const parked = run.steps.filter((step) => step.state === 'reconcile_required');
  checks.push(
    check(
      'parked-is-not-terminal',
      !(parked.length > 0 && terminal !== undefined && terminal.type !== 'run.cancelled'),
      parked.length
        ? terminal?.type === 'run.cancelled'
          ? `${parked.length} step(s) parked for reconciliation under a cancelled run — the request ended, the effect stays uncertain.`
          : `${parked.length} step(s) parked for reconciliation; the run is not terminal.`
        : 'No step is parked for reconciliation.',
    ),
  );

  // State and stream are two records of one truth. A persisted terminal state
  // without its terminal event is a completed checkbox with no evidence; a
  // terminal event saying the opposite is corruption either way. Parked and
  // live states agree with the stream only when no terminal event exists.
  const TERMINAL_STATE_EVENT: Record<string, TerminalEventType> = {
    completed: 'run.completed',
    failed: 'run.failed',
    cancelled: 'run.cancelled',
  };
  const expectedTerminal = TERMINAL_STATE_EVENT[run.state];
  const stateAgrees =
    expectedTerminal === undefined
      ? terminal === undefined
      : terminal?.type === expectedTerminal;
  checks.push(
    check(
      'terminal-state-agrees',
      stateAgrees,
      expectedTerminal === undefined
        ? terminal === undefined
          ? `The run is ${run.state} and the stream records no terminal event.`
          : `The run is ${run.state} but the stream records ${terminal?.type} — the stream disagrees.`
        : terminal === undefined
          ? `The run is persisted ${run.state} but no ${expectedTerminal} event exists — completion without evidence.`
          : terminal.type === expectedTerminal
            ? `The persisted state and the terminal event agree on ${run.state}.`
            : `The run is persisted ${run.state} but the terminal event is ${terminal.type}.`,
    ),
  );

  // `lastSeq` is the service's own counter; the stream is what was written.
  // A counter ahead of the record means events were lost or skipped, and a
  // counter behind means something wrote outside the service.
  const lastWritten = events.length ? events[events.length - 1].seq : 0;
  checks.push(
    check(
      'lastseq-matches-stream',
      run.lastSeq === lastWritten,
      run.lastSeq === lastWritten
        ? `lastSeq ${run.lastSeq} matches the ${events.length} recorded event(s).`
        : `lastSeq ${run.lastSeq} does not match the stream's last written seq ${lastWritten}.`,
    ),
  );

  return checks;
}

/** A route's full conformance picture: descriptor plus (when given) its stream. */
export function conformanceReport(
  contract: AdapterRouteContract,
  run?: HarnessRun,
): { routeId: string; contractVersion: number; checks: ConformanceCheck[] } {
  return {
    routeId: contract.routeId,
    contractVersion: contract.contractVersion,
    checks: [...contractChecks(contract), ...(run ? streamChecks(run) : [])],
  };
}
