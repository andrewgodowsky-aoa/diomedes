/**
 * The route contract registry: one descriptor per route, bound to the
 * versioned vocabulary in `shared/adapter-contract.ts`.
 *
 * Every entry is a declaration of what the route can honestly do — the
 * commands it answers natively, the ones the host composes, and the ones it
 * does not have at all. A descriptor is evidence-shaped: `testedWith` is the
 * version the adapter was verified against, and a version drift invalidates
 * the proof rather than stretching it.
 *
 * This registry is the single source for adapter route contracts. The
 * `TextEngineAdapter` implementations expose their entry as `.contract`;
 * harness-side routes (`native-fixture`, `codex-report`, `harness-runtime`,
 * `sample`) are declared here directly because their mechanism is the run
 * service itself.
 */
import type {
  AdapterCommand,
  AdapterRouteContract,
  CommandAvailability,
  CommandSupportMap,
} from '../../shared/adapter-contract.js';
import { ADAPTER_CONTRACT_VERSION } from '../../shared/adapter-contract.js';

const native = (note: string): CommandAvailability => ({ support: 'native', note });
const host = (note: string): CommandAvailability => ({ support: 'host', note });
const unsupported = (note: string): CommandAvailability => ({ support: 'unsupported', note });

/** Every command must be answered; there is no implicit default. */
function commands(map: Record<AdapterCommand, CommandAvailability>): CommandSupportMap {
  return map;
}

/** The commands every single-turn text route answers the same way. */
const TEXT_ROUTE_COMMANDS = (engine: string): CommandSupportMap =>
  commands({
    start: native(`A fresh ${engine} process or session per request; the request is the unit.`),
    'follow-up': unsupported(
      'Each request is one turn over a fresh session; a follow-up is a new request.',
    ),
    steer: unsupported('The text route has no in-band steering channel.'),
    interrupt: native(
      'Abort plus owned-process termination; the engine-side stop is reported back.',
    ),
    resume: unsupported(
      'Nothing outlives the request process; there is no provider session to reattach.',
    ),
    retry: host(
      'An explicit re-dispatch composes a new request; a replayed one resolves from the recorded run. Ambiguous outcomes are marked uncertain rather than retried silently.',
    ),
    fork: unsupported('A single request has no lineage to fork.'),
    status: host(
      'The run record tracks the dispatched request; a dead process is observed, not queried.',
    ),
    reconcile: unsupported(
      'The process is the session; when it exits mid-turn the dispatch is uncertain, and reconciliation means the provider was never asked again.',
    ),
    close: native('Owned-process termination closes the route; nothing persists to reopen.'),
  });

/** The commands a run-service-driven route answers the same way. */
const HARNESS_COMMANDS = (note: string): CommandSupportMap =>
  commands({
    start: native(`RunService.start writes the run and its first event. ${note}`),
    'follow-up': host(
      'A follow-up is a new run for the same task; the run record stays the authority.',
    ),
    steer: unsupported('No steering channel is proven on this route.'),
    interrupt: unsupported(
      'There is no in-band interrupt; run-level cancel is the only stop, and it parks non-idempotent work for reconciliation.',
    ),
    resume: native(
      'The run service replays persisted steps and continues at the first unresolved one.',
    ),
    retry: native('A step retries under its maxAttempts against the same intent hash.'),
    fork: native('RunService.fork starts a child run at a recorded pure-prefix step.'),
    status: native('The run record is the status; no transport read substitutes for it.'),
    reconcile: native(
      'RunService.recover parks in-flight non-idempotent steps as reconcile_required.',
    ),
    close: native('Run cancellation ends the run and fences its lease.'),
  });

const contract = (
  routeId: string,
  mode: AdapterRouteContract['mode'],
  engine: AdapterRouteContract['engine'],
  commandsMap: CommandSupportMap,
  streaming: AdapterRouteContract['streaming'],
  models: AdapterRouteContract['models'],
  authentication: AdapterRouteContract['authentication'],
  testedWith: string | null,
): AdapterRouteContract => ({
  contractVersion: ADAPTER_CONTRACT_VERSION,
  routeId,
  mode,
  engine,
  commands: commandsMap,
  streaming,
  models,
  authentication,
  testedWith,
});

export const ROUTE_CONTRACTS: Record<string, AdapterRouteContract> = Object.freeze({
  'claude-code-session': contract(
    'claude-code-session',
    'external-session',
    { id: 'claude-code', version: '2.1.252', protocolVersion: 'stream-json' },
    commands({
      start: native(
        'Opt-in persistent stream-json process; each turn has a fenced RunService step.',
      ),
      'follow-up': native('Sequential user messages reuse the live process after a known result.'),
      steer: unsupported('Active-turn steering has not been proven and is refused.'),
      interrupt: native(
        'Native control interrupt acknowledgment is distinct from turn completion.',
      ),
      resume: native(
        'Explicit --resume after validated idle metadata; uncertain turns are never replayed.',
      ),
      retry: host(
        'Duplicate command IDs replay durable outcomes; unknown dispatches refuse redispatch.',
      ),
      fork: native(
        'Explicit --resume plus --fork-session starts a child run with no copied hidden state.',
      ),
      status: host('Durable run state and transport presence; no provider status is invented.'),
      reconcile: unsupported(
        'Unknown outcomes remain parked; no provider reconciliation API is proven.',
      ),
      close: native(
        'Ends the owned transport; only a known idle session may later be explicitly resumed.',
      ),
    }),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '2.1.252',
  ),
  'opencode-session': contract(
    'opencode-session',
    'external-session',
    { id: 'opencode', version: '1.18.4', protocolVersion: 'http+sse' },
    commands({
      start: native(
        'Opt-in kept `opencode serve` process and OpenCode session; each turn has a fenced RunService step.',
      ),
      'follow-up': native('Sequential messages go to the same OpenCode session after a known idle.'),
      steer: host(
        'Queued by Diomedes while a turn runs and sent as the next turn once it finishes; never injected mid-turn, and dropped with a stated reason if the turn stops.',
      ),
      interrupt: native(
        'POST /session/:id/abort, then idle is confirmed from /session/status; only a confirmed idle session stays resumable.',
      ),
      resume: native(
        'A later server finds the saved session id in OpenCode’s own store; a session OpenCode no longer has starts fresh and the record says so.',
      ),
      retry: host(
        'Duplicate command IDs replay durable outcomes; unknown dispatches refuse redispatch.',
      ),
      fork: native(
        'POST /session/:id/fork from a saved idle session starts a child run; no hidden state is copied into the run record.',
      ),
      status: host('Durable run state and transport presence; no provider status is invented.'),
      reconcile: unsupported(
        'Unknown outcomes remain parked; no provider reconciliation is attempted.',
      ),
      close: native(
        'Ends the owned server; the OpenCode session stays in OpenCode’s store for an explicit resume.',
      ),
    }),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '1.18.4',
  ),
  // --- the harness-side routes: the run service is the mechanism ------------
  'native-fixture': contract(
    'native-fixture',
    'harness-agent',
    { id: 'native-fixture', version: '1', protocolVersion: 'harness-v1' },
    HARNESS_COMMANDS('The scripted fixture model drives the loop.'),
    { transientPreview: 'none', durableEvents: 'run-record' },
    { source: 'fixed' },
    'development-fixture',
    null,
  ),
  'codex-report': contract(
    'codex-report',
    'harness-agent',
    { id: 'codex', version: '0.153.4', protocolVersion: 'codex app-server 0.153.4' },
    HARNESS_COMMANDS('The Codex app-server session is the model adapter.'),
    { transientPreview: 'none', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '0.153.4',
  ),
  'harness-runtime': contract(
    'harness-runtime',
    'harness-agent',
    { id: 'diomedes-harness', version: '1', protocolVersion: 'harness-v1' },
    HARNESS_COMMANDS('The in-process run service itself.'),
    { transientPreview: 'none', durableEvents: 'run-record' },
    { source: 'none' },
    'none',
    null,
  ),
  // --- the staged worker -----------------------------------------------------
  sample: contract(
    'sample',
    'native-worker',
    { id: 'sample', version: '0.1.0', protocolVersion: 'in-process' },
    commands({
      start: native('The staged worker starts a deterministic run.'),
      'follow-up': unsupported('A staged run has no follow-up channel.'),
      steer: unsupported('A staged run has no steering channel.'),
      interrupt: unsupported('Stop is the only interruption.'),
      resume: unsupported('A stopped staged run restarts from the beginning.'),
      retry: unsupported('A staged run has no mid-run retry.'),
      fork: unsupported('A staged run has no lineage.'),
      status: native('The host tracks the worker run directly.'),
      reconcile: unsupported('Nothing external can outlive the worker.'),
      close: native('Stopping the worker ends it.'),
    }),
    { transientPreview: 'none', durableEvents: 'host-record' },
    { source: 'none' },
    'none',
    null,
  ),
  // --- the external-session route --------------------------------------------
  codex: contract(
    'codex',
    'external-session',
    { id: 'codex', version: '0.153.4', protocolVersion: 'codex app-server 0.153.4' },
    commands({
      start: native('askCodex dispatches a turn over the app-server session.'),
      'follow-up': unsupported(
        'Each ask is a fresh turn; the route does not expose continuing the same one.',
      ),
      steer: unsupported('The ask route has no in-band steering channel.'),
      interrupt: native('interruptTurn plus process end; the engine reports the interruption.'),
      resume: unsupported('A turn does not outlive its dispatch.'),
      retry: host(
        'An explicit re-dispatch is a fresh call; an unknown outcome is never resent silently.',
      ),
      fork: unsupported('The ask route has no lineage.'),
      status: host('Thread status is read from the app-server, not assumed.'),
      reconcile: host('On reconnect the thread state is re-read; nothing is regenerated.'),
      close: native('The owned app-server process is terminated.'),
    }),
    { transientPreview: 'none', durableEvents: 'host-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '0.153.4',
  ),
  // --- the five single-turn text routes --------------------------------------
  'claude-code': contract(
    'claude-code',
    'single-turn-text',
    { id: 'claude-code', version: '2.1.252', protocolVersion: 'stream-json' },
    TEXT_ROUTE_COMMANDS('Claude Code'),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '2.1.252',
  ),
  opencode: contract(
    'opencode',
    'single-turn-text',
    { id: 'opencode', version: '1.18.4', protocolVersion: 'http+sse' },
    TEXT_ROUTE_COMMANDS('OpenCode'),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '1.18.4',
  ),
  'oh-my-pi': contract(
    'oh-my-pi',
    'single-turn-text',
    { id: 'oh-my-pi', version: '18.0.6', protocolVersion: 'stream-json' },
    TEXT_ROUTE_COMMANDS('oh-my-pi'),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '18.0.6',
  ),
  cursor: contract(
    'cursor',
    'single-turn-text',
    { id: 'cursor', version: '2026.08.11', protocolVersion: 'acp/1' },
    TEXT_ROUTE_COMMANDS('Cursor'),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '2026.08.11',
  ),
  devin: contract(
    'devin',
    'single-turn-text',
    { id: 'devin', version: '3000.10.23', protocolVersion: 'acp/1' },
    TEXT_ROUTE_COMMANDS('Devin'),
    { transientPreview: 'text-delta', durableEvents: 'run-record' },
    { source: 'runtime-reported' },
    'native-sign-in',
    '3000.10.23',
  ),
});

/** The descriptor for a route — or a loud refusal. Unregistered is not "probably fine". */
export function routeContractFor(routeId: string): AdapterRouteContract {
  const contract = ROUTE_CONTRACTS[routeId];
  if (!contract)
    throw new Error(`No adapter contract is registered for route ${JSON.stringify(routeId)}.`);
  return contract;
}
