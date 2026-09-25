/**
 * H20: the headless runner. Runs the scenario set against the production Core
 * and derives the all-route acceptance matrix from the route contracts and
 * what the scenarios observed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { advertisedContracts } from '../../server/evaluation/route-inventory.js';
import { deriveMatrix, type RouteMatrix, type ScenarioResult } from '../../server/evaluation/route-matrix.js';
import { Core } from './core.js';
import { REPO, SCENARIOS, type Scenario, type ScenarioContext, type ScenarioFixtures } from './scenarios.js';

export interface RunnerOptions {
  /** Where each scenario's Core keeps its folder; removed afterwards unless `keep`. */
  workDir?: string;
  keep?: boolean;
  /** Run only these scenario ids. */
  only?: readonly string[];
  fixtures?: ScenarioFixtures;
  log?: (line: string) => void;
}

export async function runScenario(scenario: Scenario, root: string, fixtures: ScenarioFixtures = {}): Promise<ScenarioResult> {
  const cores: Core[] = [];
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    fixture: scenario.fixture,
    outcome: 'passed',
    durationMs: 0,
    checks: [],
    assertions: [],
    evidence: {},
  };
  const context: ScenarioContext = {
    root,
    fixtures,
    evidence: result.evidence,
    check: (route, capability, expect, passed, detail) => result.checks.push({ route, capability, expect, passed, detail }),
    assert: (name, passed, detail) => result.assertions.push({ name, passed, detail }),
    async core(options = () => ({})) {
      const core = new Core(root, options);
      cores.push(core);
      await core.open();
      return core;
    },
  };
  const started = performance.now();
  try {
    await fs.mkdir(root, { recursive: true });
    await scenario.run(context);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const core of cores) await core.close().catch(() => undefined);
    result.durationMs = Math.round(performance.now() - started);
  }
  if (result.error || result.checks.some((check) => !check.passed) || result.assertions.some((assertion) => !assertion.passed))
    result.outcome = 'failed';
  return result;
}

export async function runScenarios(options: RunnerOptions = {}): Promise<ScenarioResult[]> {
  const workDir = options.workDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-eval-matrix-')));
  const selected = SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.id));
  if (options.only) {
    const unknown = options.only.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
    if (unknown.length) throw new Error(`Unknown scenarios: ${unknown.join(', ')}.`);
  }
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of selected) {
      options.log?.(`… ${scenario.id}`);
      const result = await runScenario(scenario, path.join(workDir, scenario.id), options.fixtures);
      options.log?.(
        `${result.outcome === 'passed' ? 'ok' : 'FAILED'} ${scenario.id} (${result.durationMs} ms)${result.error ? `: ${result.error}` : ''}`,
      );
      results.push(result);
    }
  } finally {
    if (!options.keep) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return results;
}

function commit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function matrixFrom(results: readonly ScenarioResult[], generatedAt = new Date().toISOString()): RouteMatrix {
  return deriveMatrix({
    contracts: advertisedContracts(),
    results,
    generatedAt,
    environment: { platform: `${process.platform}-${process.arch}`, node: process.versions.node, commit: commit() },
  });
}
