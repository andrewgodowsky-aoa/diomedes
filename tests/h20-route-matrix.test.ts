/**
 * H20: the matrix is derived from the route contracts and the runner's
 * results, never written by hand. These pin the derivation rules: a
 * declaration alone never reads proven, an unsupported declaration reads
 * unsupported, and anything a check contradicts reads mismatch.
 */
import { describe, expect, test } from 'vitest';
import type { AdapterRouteContract } from '../shared/adapter-contract.js';
import { ROUTES } from '../shared/engines.js';
import { CONTROL_FIXTURE_CONTRACT } from '../server/durable-controls-fixture.js';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract.js';
import { advertisedContracts } from '../server/evaluation/route-inventory.js';
import {
  MATRIX_CAPABILITIES,
  declaredCapabilities,
  deriveCell,
  deriveMatrix,
  renderMatrixMarkdown,
  type ScenarioCheck,
  type ScenarioResult,
} from '../server/evaluation/route-matrix.js';

const environment = { platform: 'test', node: 'test', commit: null };
const result = (checks: Omit<ScenarioCheck, 'detail'>[], id = 'scenario-1'): ScenarioResult => ({
  id,
  title: id,
  fixture: 'a test fixture',
  outcome: checks.every((check) => check.passed) ? 'passed' : 'failed',
  durationMs: 1,
  checks: checks.map((check) => ({ ...check, detail: `${check.capability} was observed` })),
  assertions: [],
  evidence: {},
});
/** The H08 control fixture is a real contract that declares native steer. */
const steering: AdapterRouteContract = CONTROL_FIXTURE_CONTRACT;

describe('the inventory', () => {
  test('lists every registered contract and every Work route a person can pick', () => {
    const ids = advertisedContracts().map((contract) => contract.routeId);
    for (const route of ROUTES) expect(ids).toContain(route);
    for (const route of Object.keys(ROUTE_CONTRACTS)) expect(ids).toContain(route);
    expect(ids).not.toContain('control-fixture');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the derivation', () => {
  test('a contract that declares steer with no passing scenario reads declared, not proven — never proven', () => {
    expect(steering.commands.steer.support).toBe('native');
    const cell = deriveCell(steering, 'steer', []);
    expect(cell.state).toBe('declared-not-proven');
    expect(cell.scenarios).toEqual([]);
    // A passing check for another capability, or another route, proves nothing here.
    const elsewhere = [
      result([{ route: steering.routeId, capability: 'turn', expect: 'performs', passed: true }]),
      result([{ route: 'sample', capability: 'steer', expect: 'performs', passed: true }], 'scenario-2'),
    ];
    expect(deriveCell(steering, 'steer', elsewhere).state).toBe('declared-not-proven');
  });

  test('a passing performs check on a declared capability reads proven, with the scenario and fixture named', () => {
    const cell = deriveCell(steering, 'steer', [
      result([{ route: steering.routeId, capability: 'steer', expect: 'performs', passed: true }]),
    ]);
    expect(cell).toMatchObject({ state: 'proven', scenarios: ['scenario-1'], fixtures: ['a test fixture'] });
  });

  test('a deliberately broken fixture — a declared capability whose check fails — reads mismatch', () => {
    const cell = deriveCell(steering, 'steer', [
      result([{ route: steering.routeId, capability: 'steer', expect: 'performs', passed: true }], 'good'),
      result([{ route: steering.routeId, capability: 'steer', expect: 'performs', passed: false }], 'broken'),
    ]);
    expect(cell.state).toBe('mismatch');
    expect(cell.scenarios).toEqual(['broken']);
  });

  test('a declared capability the route refused reads mismatch, not unsupported', () => {
    const cell = deriveCell(steering, 'steer', [
      result([{ route: steering.routeId, capability: 'steer', expect: 'refuses', passed: true }]),
    ]);
    expect(cell.state).toBe('mismatch');
  });

  test('an unsupported declaration reads unsupported; an observed refusal is named; performing it is a mismatch', () => {
    const sample = ROUTE_CONTRACTS.sample;
    expect(sample.commands.steer.support).toBe('unsupported');
    expect(deriveCell(sample, 'steer', []).state).toBe('unsupported');
    const refused = deriveCell(sample, 'steer', [
      result([{ route: 'sample', capability: 'steer', expect: 'refuses', passed: true }]),
    ]);
    expect(refused.state).toBe('unsupported');
    expect(refused.reason).toContain('refusal was observed');
    expect(
      deriveCell(sample, 'steer', [result([{ route: 'sample', capability: 'steer', expect: 'performs', passed: true }])])
        .state,
    ).toBe('mismatch');
    expect(
      deriveCell(sample, 'steer', [result([{ route: 'sample', capability: 'steer', expect: 'refuses', passed: false }])])
        .state,
    ).toBe('mismatch');
  });

  test('the not-proven reason comes from the contract: a signed-in binary or a live credential', () => {
    expect(deriveCell(ROUTE_CONTRACTS['claude-code-session'], 'resume', []).reason).toContain(
      'Needs the real claude-code 2.1.252 binary',
    );
    const vertex = advertisedContracts().find((contract) => contract.routeId === 'google-vertex')!;
    expect(deriveCell(vertex, 'turn', []).reason).toContain('Needs a live google-vertex credential');
  });

  test('every column is declared for every advertised contract, and the lifecycle columns echo the contract', () => {
    for (const contract of advertisedContracts()) {
      const declared = declaredCapabilities(contract);
      expect(Object.keys(declared).sort()).toEqual([...MATRIX_CAPABILITIES].sort());
      expect(declared.turn.support).toBe(contract.commands.start.support);
      expect(declared.queue.support).toBe(contract.commands['follow-up'].support);
      expect(declared.stop.support).toBe(contract.commands.interrupt.support);
      expect(declared.fork.support).toBe(contract.commands.fork.support);
      expect(declared.stream.support === 'unsupported').toBe(contract.streaming.transientPreview === 'none');
    }
  });

  test('changing a contract changes its cells: nothing is cached or hand-written', () => {
    const narrowed: AdapterRouteContract = {
      ...steering,
      routeId: 'narrowed',
      commands: { ...steering.commands, steer: { support: 'unsupported', note: 'Withdrawn.' } },
    };
    const matrix = deriveMatrix({ contracts: [steering, narrowed], results: [], generatedAt: '2026-09-24T00:00:00Z', environment });
    expect(matrix.rows.map((row) => row.cells.steer.state)).toEqual(['declared-not-proven', 'unsupported']);
  });

  test('the matrix refuses an invalid descriptor and a duplicate route, and keeps checks for unknown routes visible', () => {
    const broken = { ...steering, commands: { ...steering.commands, steer: undefined } } as unknown as AdapterRouteContract;
    expect(() => deriveMatrix({ contracts: [broken], results: [], generatedAt: 'x', environment })).toThrow(/not a valid/);
    expect(() => deriveMatrix({ contracts: [steering, steering], results: [], generatedAt: 'x', environment })).toThrow(/twice/);
    const matrix = deriveMatrix({
      contracts: [steering],
      results: [result([{ route: 'nobody', capability: 'turn', expect: 'performs', passed: true }])],
      generatedAt: '2026-09-24T00:00:00Z',
      environment,
    });
    expect(matrix.orphanChecks).toHaveLength(1);
  });

  test('counts and mismatches add up, and the summary lists each mismatch', () => {
    const matrix = deriveMatrix({
      contracts: advertisedContracts(),
      results: [result([{ route: 'sample', capability: 'turn', expect: 'performs', passed: false }], 'broken-sample')],
      generatedAt: '2026-09-24T00:00:00Z',
      environment,
    });
    const total = Object.values(matrix.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(matrix.rows.length * MATRIX_CAPABILITIES.length);
    expect(matrix.mismatches).toEqual([
      expect.objectContaining({ routeId: 'sample', capability: 'turn', scenarios: ['broken-sample'] }),
    ]);
    const markdown = renderMatrixMarkdown(matrix);
    expect(markdown).toContain('`sample` · turn');
    expect(markdown).toContain('**MISMATCH**');
  });
});
