/**
 * H20: the headless runner itself, in vitest, on the scripted routes. It starts
 * the real Core, drives scenarios over HTTP, and the matrix is derived from
 * what they observed. A deliberately broken Codex fixture — one that answers
 * with something that is not a proposal — must read as a mismatch, never as
 * proven and never as a quiet pass.
 */
import { describe, expect, test } from 'vitest';
import { matrixFrom, runScenarios } from '../scripts/eval-matrix/runner.js';
import { SCENARIOS } from '../scripts/eval-matrix/scenarios.js';
import { renderMatrixMarkdown } from '../server/evaluation/route-matrix.js';

describe('the headless runner on the scripted routes', () => {
  test('the scenario set covers the required journeys', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    for (const id of [
      'aws-ask-answer-stream',
      'sample-proposal-approve-decline',
      'codex-stop-mid-turn',
      'h13-loop-restart-verified',
      'codex-retry-after-failure',
      'h12-uncertain-effect-blocks-retry',
      'h15-drift-escalation',
      'h17-verification-evidence',
    ])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test(
    'runs the sample, Codex and loop scenarios through the real Core and proves what they exercised',
    async () => {
      const results = await runScenarios({
        only: ['sample-controls-refused', 'codex-stop-mid-turn', 'codex-retry-after-failure', 'h13-loop-restart-verified'],
      });
      for (const result of results) expect(result, JSON.stringify(result, null, 2)).toMatchObject({ outcome: 'passed' });
      const matrix = matrixFrom(results, '2026-09-24T00:00:00.000Z');
      const cell = (route: string, capability: string) =>
        matrix.rows.find((row) => row.routeId === route)!.cells[capability as 'turn'];
      expect(cell('codex', 'retry')).toMatchObject({ state: 'proven', scenarios: ['codex-retry-after-failure'] });
      expect(cell('codex', 'stop')).toMatchObject({ state: 'proven', scenarios: ['codex-stop-mid-turn'] });
      expect(cell('codex', 'verification').state).toBe('proven');
      expect(cell('native-fixture', 'resume').state).toBe('proven');
      expect(cell('native-fixture', 'verification').state).toBe('proven');
      // Refused as declared: unsupported, with the refusal named.
      expect(cell('sample', 'steer')).toMatchObject({ state: 'unsupported' });
      expect(cell('sample', 'steer').reason).toContain('refusal was observed');
      // Nothing ran for these here, so nothing is claimed.
      expect(cell('devin-session', 'turn').state).toBe('declared-not-proven');
      expect(cell('google-vertex', 'turn').state).toBe('declared-not-proven');
      expect(matrix.mismatches).toEqual([]);
      expect(renderMatrixMarkdown(matrix)).toContain('| `codex` | proven |');
    },
    120_000,
  );

  test(
    'a deliberately broken Codex fixture reads as a mismatch on the cells it breaks',
    async () => {
      const results = await runScenarios({
        only: ['codex-retry-after-failure'],
        fixtures: { codexProposal: () => ({ text: 'Sure! I updated the menu for you.', model: 'broken-fixture' }) },
      });
      expect(results[0].outcome).toBe('failed');
      const matrix = matrixFrom(results, '2026-09-24T00:00:00.000Z');
      const codex = matrix.rows.find((row) => row.routeId === 'codex')!;
      expect(codex.cells.turn.state).toBe('mismatch');
      expect(codex.cells['tool-proposal'].state).toBe('mismatch');
      expect(matrix.mismatches.map((item) => `${item.routeId}:${item.capability}`)).toEqual(
        expect.arrayContaining(['codex:turn', 'codex:tool-proposal']),
      );
      expect(matrix.failedScenarios.map((item) => item.id)).toEqual(['codex-retry-after-failure']);
    },
    120_000,
  );
});
