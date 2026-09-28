import { expect, test } from 'vitest';
import packageInfo from '../package.json' with { type: 'json' };
import { loadShippedProductKnowledge } from '../server/readiness/instructions.js';
import { projectReadiness } from '../server/readiness/projection.js';

test('runtime discovery keeps historical route evidence consistent without self-certifying readiness', async () => {
  const now = '2026-09-27T12:00:00.000Z';
  const knowledge = await loadShippedProductKnowledge({ buildVersion: packageInfo.version, now });
  const view = projectReadiness({
    now,
    knowledge,
    snapshot: {
      build: { version: packageInfo.version, source: 'package.json' },
      settings: { services: {}, observedAt: now },
      engines: [],
      connectors: { manifests: [], instances: [], observations: [] },
      validatedEvidence: [],
    },
  });
  expect(view.knowledge.conflicts.filter((item) => item.code === 'engine-version-mismatch')).toEqual([]);
  for (const id of ['codex', 'codex-report', 'codex-session']) {
    const route = view.routes.find((item) => item.id === id)!;
    expect(route).toBeDefined();
    expect(route.axes.verified.value).not.toBe('yes');
    expect(route.ready).toBe(false);
  }
});

test.each([
  { runtimeVersion: '99.0.0', evidenceVersion: '2.1.252', verified: 'unknown' },
  { runtimeVersion: '99.0.0', evidenceVersion: '99.0.0', verified: 'yes' },
  { runtimeVersion: '2.1.252', evidenceVersion: '2.1.252', verified: 'yes' },
  { runtimeVersion: undefined, evidenceVersion: '2.1.252', verified: 'unknown' },
])('readiness compares proof $evidenceVersion with observed build $runtimeVersion', async ({ runtimeVersion, evidenceVersion, verified }) => {
  const now = '2026-09-27T12:00:00.000Z';
  const knowledge = await loadShippedProductKnowledge({ buildVersion: packageInfo.version, now });
  const view = projectReadiness({
    now,
    knowledge,
    snapshot: {
      build: { version: packageInfo.version, source: 'package.json' },
      settings: { services: { 'claude-code': true }, observedAt: now },
      engines: [{
        engine: 'claude-code', installation: 'found', compatibility: 'supported',
        authentication: 'signed-in', accountRoute: 'native-account', checkedAt: now,
        detail: 'Fixture capability inspection passed.', version: runtimeVersion,
        usage: { state: 'unknown', checkedAt: null },
        models: [{ slug: 'fixture-current', name: 'Fixture', description: '', defaultEffort: null, efforts: [] }],
      }],
      connectors: { manifests: [], instances: [], observations: [] },
      validatedEvidence: [{
        kind: 'route', id: 'claude-code', evidenceId: 'fixture-proof', source: 'fixture',
        validatedAt: now, staleAfterMs: 60_000, buildVersion: packageInfo.version,
        contractVersion: 1, engineVersion: evidenceVersion,
      }],
    },
  });
  const route = view.routes.find((item) => item.id === 'claude-code')!;
  expect(route.axes.healthy.value).toBe('yes');
  expect(route.axes.verified.value).toBe(verified);
});
