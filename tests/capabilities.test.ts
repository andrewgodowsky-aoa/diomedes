import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FULL_ACCESS_PREREQUISITES,
  fullAccessEligibility,
  ROUTE_CAPABILITIES,
  type IsolatedEnvironment,
} from '../shared/capabilities.js';
import { describePermissionChoices } from '../shared/permissions.js';
import {
  listIsolatedEnvironments,
  NO_ENVIRONMENT_REASON,
  selectedIsolatedEnvironment,
} from '../server/trust/environments.js';

const ROUTES = Object.keys(ROUTE_CAPABILITIES);

describe('honest route capability model', () => {
  test('every route answers each Full access question with a recorded basis', () => {
    for (const routeId of ROUTES) {
      const route = ROUTE_CAPABILITIES[routeId];
      const facts = [
        route.storeOnlyWrites,
        route.spawnsProcesses,
        route.runsShellCommands,
        route.arbitraryFilesystem,
        route.network,
        route.receivesSecrets,
        route.preExecutionInterception,
        route.revocationStopsFutureEffects,
        route.effectProof,
        route.osSandbox,
        route.disposableEnvironment,
        route.hostRootBoundary,
      ];
      for (const item of facts) {
        expect(['yes', 'no', 'unknown']).toContain(item.answer);
        expect(item.evidence.length).toBeGreaterThan(20);
      }
      expect(route.uncertaintyAfterDispatch.length).toBeGreaterThan(10);
    }
  });
  test('no route claims an isolation boundary Diomedes owns', () => {
    for (const routeId of ROUTES) {
      const route = ROUTE_CAPABILITIES[routeId];
      expect(route.osSandbox.answer).toBe('no');
      expect(route.disposableEnvironment.answer).toBe('no');
      expect(route.hostRootBoundary.answer).toBe('no');
      expect(route.osSandbox.basis).toBe('not-implemented');
    }
  });
  test('an imported text adapter does not claim the shell answer a flag cannot prove', () => {
    for (const routeId of ['claude-code', 'opencode', 'oh-my-pi', 'cursor']) {
      const route = ROUTE_CAPABILITIES[routeId];
      expect(route.runsShellCommands.answer).toBe('unknown');
      expect(route.arbitraryFilesystem.answer).toBe('unknown');
      // A no-tool flag bounds one request; the route must say so, not claim containment.
      expect(route.spawnsProcesses.basis).not.toBe('diomedes-enforced');
    }
  });
  test('Codex file writes are Diomedes-enforced while its sandbox stays engine-reported', () => {
    const codex = ROUTE_CAPABILITIES.codex;
    expect(codex.storeOnlyWrites).toMatchObject({ answer: 'yes', basis: 'diomedes-enforced' });
    expect(codex.runsShellCommands.basis).toBe('engine-reported');
    expect(codex.network.answer).toBe('unknown');
  });
});

describe('Full access eligibility', () => {
  test('this installation offers no isolated environment, and says why', () => {
    expect(listIsolatedEnvironments()).toEqual([]);
    expect(selectedIsolatedEnvironment('anything')).toBeNull();
    expect(selectedIsolatedEnvironment(null)).toBeNull();
    expect(NO_ENVIRONMENT_REASON).toMatch(/worktree is edit isolation, not containment/);
  });
  test('Full access is unavailable on every route the app can select', () => {
    for (const routeId of [...ROUTES, 'unknown-route']) {
      const eligibility = fullAccessEligibility(routeId, listIsolatedEnvironments()[0] ?? null);
      expect(eligibility.available).toBe(false);
      expect(eligibility.unmet.length).toBeGreaterThan(0);
      expect(eligibility.environmentId).toBeNull();
      expect(eligibility.summary).toContain('unavailable');
    }
  });
  test('the unmet list names the real prerequisites, not a generic refusal', () => {
    const eligibility = fullAccessEligibility('codex', null);
    const ids = eligibility.unmet.map((item) => item.id);
    expect(ids).toContain('isolated-environment');
    expect(ids).toContain('attested-boundary');
    expect(ids).toContain('disposable');
    expect(ids).toContain('host-root-boundary');
    expect(ids).toContain('revocation-stops-effects');
    expect(ids).toContain('effect-ledger');
    for (const id of ids)
      expect(FULL_ACCESS_PREREQUISITES.map((item) => item.id)).toContain(id);
    expect(eligibility.unsupportedEffects).toContain('arbitrary command execution');
  });
  test('a partly satisfying environment still fails on the prerequisite it misses', () => {
    const base: IsolatedEnvironment = {
      id: 'vm-1',
      name: 'Disposable virtual machine',
      kind: 'virtual-machine',
      disposable: true,
      hostRoot: 'D:/isolated',
      interceptsEffects: true,
      revocable: true,
      effectLedger: true,
      attestation: { method: 'boundary-probe', checkedAt: new Date().toISOString() },
    };
    // The complete shape passes for a route that can prove its own effects.
    expect(fullAccessEligibility('codex', base).available).toBe(true);
    const cases: [Partial<IsolatedEnvironment>, string][] = [
      [{ attestation: null }, 'attested-boundary'],
      [{ disposable: false }, 'disposable'],
      [{ hostRoot: null }, 'host-root-boundary'],
      [{ interceptsEffects: false }, 'pre-execution-interception'],
      [{ revocable: false }, 'revocation-stops-effects'],
      [{ effectLedger: false }, 'effect-ledger'],
      [{ kind: 'container' }, 'isolated-environment'],
    ];
    for (const [patch, expected] of cases) {
      const eligibility = fullAccessEligibility('codex', { ...base, ...patch });
      expect(eligibility.available).toBe(false);
      expect(eligibility.unmet.map((item) => item.id)).toContain(expected);
    }
  });
  test('no source of an environment exists, so no setting can turn Full access on', () => {
    // The predicate takes an environment value and nothing else: there is no
    // flag, preference or request field it could read. The only producer of an
    // environment in the server is the empty list above.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'server', 'trust', 'environments.ts'),
      'utf8',
    );
    expect(source).toMatch(/return \[\];/);
    const users = ['server/permission-routes.ts', 'shared/permissions.ts'];
    for (const file of users) {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      // Nothing constructs an IsolatedEnvironment literal outside the tests.
      expect(text).not.toMatch(/interceptsEffects:\s*true/);
      expect(text).not.toMatch(/effectLedger:\s*true/);
    }
  });
});

describe('permission choices are capability-driven', () => {
  const codexInput = {
    routeId: 'codex',
    scopedWritesSupported: true,
    reviewerAvailable: true,
    reviewerReason: '',
    environment: null,
  };
  test('all four conceptual choices are always present', () => {
    const { choices } = describePermissionChoices(codexInput);
    expect(choices.map((item) => item.id)).toEqual(['review', 'project', 'auto-review', 'full']);
    expect(choices.map((item) => item.name)).toEqual([
      'Review changes',
      'Work in this project',
      'Approve for me',
      'Full access',
    ]);
  });
  test('Full access is never available and explains itself outside a tooltip', () => {
    const { choices } = describePermissionChoices(codexInput);
    const full = choices.find((item) => item.id === 'full')!;
    expect(full.available).toBe(false);
    expect(full.unavailableReason).toContain('unavailable');
    expect(full.points.join(' ')).toContain('not containment');
    expect(full.points.join(' ')).toContain('arbitrary command execution');
  });
  test('Approve for me states that it adds a check and adds no access', () => {
    const { choices } = describePermissionChoices(codexInput);
    const auto = choices.find((item) => item.id === 'auto-review')!;
    expect(auto.available).toBe(true);
    const text = auto.points.join(' ');
    expect(text).toContain('never widen what is allowed');
    expect(text).toContain('does not increase file, tool, command or network permission');
    expect(text).toContain('waits for you');
    expect(text).toContain('never recorded as your approval');
  });
  test('Approve for me is unavailable with its actual reason when no reviewer exists', () => {
    const { choices } = describePermissionChoices({
      ...codexInput,
      reviewerAvailable: false,
      reviewerReason: 'No separate reviewer route is connected on this installation.',
    });
    const auto = choices.find((item) => item.id === 'auto-review')!;
    expect(auto.available).toBe(false);
    expect(auto.unavailableReason).toBe(
      'No separate reviewer route is connected on this installation.',
    );
  });
  test('a route without scoped writes offers neither scope nor a reviewer over it', () => {
    const { choices } = describePermissionChoices({
      routeId: 'claude-code',
      scopedWritesSupported: false,
      reviewerAvailable: true,
      reviewerReason: '',
      environment: null,
    });
    expect(choices.find((item) => item.id === 'project')!.available).toBe(false);
    const auto = choices.find((item) => item.id === 'auto-review')!;
    expect(auto.available).toBe(false);
    expect(auto.unavailableReason).toBe('This route has no scope for a reviewer to gate.');
    expect(choices.find((item) => item.id === 'review')!.available).toBe(true);
  });
});
