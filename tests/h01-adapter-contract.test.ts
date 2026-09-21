/**
 * H01.I — the one versioned adapter contract.
 *
 * The contract pins what every route can honestly promise: the ten lifecycle
 * commands with an explicit support answer each, the engine identity and
 * version it was tested against, and which channel (transient preview vs.
 * durable run record) carries its output. Every real route must carry a
 * descriptor; an adapter without one is unregistered, not "probably fine".
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_COMMANDS,
  ADAPTER_CONTRACT_VERSION,
  adapterRouteContractSchema,
  COMMAND_FAMILY,
  isRunEventType,
  isTerminalEventType,
  RUN_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
} from '../shared/adapter-contract.js';
import { COMMAND_FAMILIES, commandIdentitySchema } from '../shared/contract-revision.js';
import { ROUTE_CONTRACTS, routeContractFor } from '../server/harness/route-contract.js';
import { ADAPTER_CAPABILITIES } from '../server/harness/adapters.js';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import { CursorAdapter, CURSOR_VERSION } from '../server/engines/cursor.js';
import { DevinAdapter, DEVIN_VERSION } from '../server/engines/devin.js';
import { ClaudeAdapter, CLAUDE_VERSION } from '../server/engines/claude.js';
import { OpenCodeAdapter } from '../server/engines/opencode.js';
import { OmpAdapter } from '../server/engines/omp.js';
import { TESTED_VERSIONS } from '../server/engines/service.js';

const DIGEST = `sha256:${'0'.repeat(64)}`;

describe('the contract version and command vocabulary', () => {
  it('is versioned', () => {
    expect(ADAPTER_CONTRACT_VERSION).toBe(1);
  });

  it('names the ten lifecycle commands, in order', () => {
    expect([...ADAPTER_COMMANDS]).toEqual([
      'start',
      'follow-up',
      'steer',
      'interrupt',
      'resume',
      'retry',
      'fork',
      'status',
      'reconcile',
      'close',
    ]);
  });

  it('binds every command to a durable command family', () => {
    for (const command of ADAPTER_COMMANDS) {
      const family = COMMAND_FAMILY[command];
      expect(COMMAND_FAMILIES, `${command} → ${family}`).toContain(family);
      const parsed = commandIdentitySchema.safeParse({
        protocolVersion: 1,
        commandId: `cmd_h01_${command}`,
        family,
        payloadDigest: DIGEST,
        expectedRevision: '2026-09-13.1',
      });
      expect(parsed.success, `${command} family ${family}`).toBe(true);
    }
  });
});

describe('the durable event vocabulary', () => {
  it('contains every event type the run service emits today', () => {
    for (const type of [
      'run.created',
      'run.recovered',
      'run.claimed',
      'run.lease_renewed',
      'run.cancelled',
      'run.completed',
      'run.failed',
      'run.forked',
      'step.started',
      'step.succeeded',
      'step.waiting_approval',
      'step.retry_wait',
      'step.reconcile_required',
      'approval.decided',
      'transcript.recorded',
    ])
      expect(RUN_EVENT_TYPES, type).toContain(type);
  });

  it('names exactly three terminal events, all run-level', () => {
    expect([...TERMINAL_EVENT_TYPES]).toEqual(['run.completed', 'run.failed', 'run.cancelled']);
    for (const type of TERMINAL_EVENT_TYPES) expect(isTerminalEventType(type)).toBe(true);
    for (const type of RUN_EVENT_TYPES.filter((t) => !(TERMINAL_EVENT_TYPES as readonly string[]).includes(t)))
      expect(isTerminalEventType(type), type).toBe(false);
  });

  it('treats an unknown event type as unknown, never as terminal or safe', () => {
    expect(isRunEventType('run.teleported')).toBe(false);
    expect(isRunEventType('step.happened')).toBe(false);
    expect(isTerminalEventType('run.maybe-done')).toBe(false);
  });
});

describe('the route contract registry', () => {
  it('covers every external engine plus the harness-side routes', () => {
    for (const engine of EXTERNAL_ENGINES)
      expect(ROUTE_CONTRACTS[engine], engine).toBeDefined();
    for (const route of ['sample', 'native-fixture', 'codex-report', 'harness-runtime'])
      expect(ROUTE_CONTRACTS[route], route).toBeDefined();
  });

  it('every descriptor validates against the contract schema', () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      const parsed = adapterRouteContractSchema.safeParse(contract);
      expect(parsed.success, routeId).toBe(true);
      expect(contract.contractVersion).toBe(ADAPTER_CONTRACT_VERSION);
      expect(contract.routeId).toBe(routeId);
    }
  });

  it('every descriptor answers all ten commands explicitly', () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS))
      for (const command of ADAPTER_COMMANDS) {
        const availability = contract.commands[command];
        expect(availability, `${routeId}.${command}`).toBeDefined();
        expect(['native', 'host', 'unsupported']).toContain(availability.support);
        expect(availability.note.length, `${routeId}.${command} note`).toBeGreaterThan(0);
      }
  });

  it('a schema without every command fails validation', () => {
    const contract = structuredClone(ROUTE_CONTRACTS.cursor);
    const commands = contract.commands as Record<string, unknown>;
    delete commands['steer'];
    expect(adapterRouteContractSchema.safeParse(contract).success).toBe(false);
  });

  it('unknown extra commands fail validation', () => {
    const contract = structuredClone(ROUTE_CONTRACTS.cursor);
    (contract.commands as Record<string, unknown>)['teleport'] = {
      support: 'native',
      note: 'not real',
    };
    expect(adapterRouteContractSchema.safeParse(contract).success).toBe(false);
  });

  it('text routes honestly declare the commands they do not have', () => {
    // A single-turn text route has no follow-up, steering, resume or fork.
    for (const route of ['cursor', 'devin', 'claude-code', 'opencode', 'oh-my-pi']) {
      const commands = ROUTE_CONTRACTS[route].commands;
      expect(commands['follow-up'].support, `${route} follow-up`).toBe('unsupported');
      expect(commands.steer.support, `${route} steer`).toBe('unsupported');
      expect(commands.resume.support, `${route} resume`).toBe('unsupported');
      expect(commands.fork.support, `${route} fork`).toBe('unsupported');
      expect(commands.start.support, `${route} start`).toBe('native');
      expect(commands.close.support, `${route} close`).toBe('native');
    }
  });

  it('the harness routes declare their real command surface', () => {
    const fixture = ROUTE_CONTRACTS['native-fixture'];
    expect(fixture.mode).toBe('harness-agent');
    for (const command of ['start', 'resume', 'retry', 'fork', 'status', 'reconcile', 'close'])
      expect(fixture.commands[command as keyof typeof fixture.commands].support, command).toBe(
        'native',
      );
    expect(fixture.streaming.durableEvents).toBe('run-record');
  });
});

describe('adapters bind the registry entry, not a private copy', () => {
  const cwd = process.cwd();
  it('each adapter exposes the contract for its route id', () => {
    expect(new CursorAdapter('cursor.exe', cwd).contract.routeId).toBe('cursor');
    expect(new DevinAdapter('devin.exe', cwd).contract.routeId).toBe('devin');
    expect(new ClaudeAdapter('claude', cwd).contract.routeId).toBe('claude-code');
    expect(new OpenCodeAdapter('opencode', cwd).contract.routeId).toBe('opencode');
    expect(new OmpAdapter('omp', cwd).contract.routeId).toBe('oh-my-pi');
  });

  it('adapter-bound descriptors are the registry objects', () => {
    expect(new CursorAdapter('cursor.exe', cwd).contract).toBe(ROUTE_CONTRACTS.cursor);
    expect(new DevinAdapter('devin.exe', cwd).contract).toBe(ROUTE_CONTRACTS.devin);
  });

  it('the contract records the version each adapter was tested against', () => {
    expect(ROUTE_CONTRACTS.cursor.testedWith).toBe(CURSOR_VERSION);
    expect(ROUTE_CONTRACTS.devin.testedWith).toBe(DEVIN_VERSION);
    expect(ROUTE_CONTRACTS['claude-code'].testedWith).toBe(CLAUDE_VERSION);
    for (const engine of EXTERNAL_ENGINES)
      expect(ROUTE_CONTRACTS[engine].testedWith, engine).toBe(TESTED_VERSIONS[engine]);
  });

  it('routeContractFor refuses a route that has no descriptor', () => {
    expect(() => routeContractFor('not-a-route')).toThrow(/no adapter contract/i);
  });
});

describe('the capability map covers every route, not only harness engines', () => {
  it('every external engine has an honest capability declaration', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const capabilities = ADAPTER_CAPABILITIES[engine as keyof typeof ADAPTER_CAPABILITIES];
      expect(capabilities, engine).toBeDefined();
      for (const key of [
        'modelCalls',
        'toolCalls',
        'filesystemWrites',
        'networkEgress',
        'approvals',
        'resumability',
        'cancellability',
      ] as const)
        expect(['enforced', 'observed', 'instructional', 'unsupported']).toContain(
          capabilities[key],
        );
      // A single-turn text route cannot resume inside the provider session.
      expect(capabilities.resumability, engine).toBe('unsupported');
      // File writes arrive only as recorded proposals — the engine's write
      // surface is engine-honored configuration, not Diomedes containment.
      expect(capabilities.filesystemWrites, engine).toBe('observed');
    }
  });
});
