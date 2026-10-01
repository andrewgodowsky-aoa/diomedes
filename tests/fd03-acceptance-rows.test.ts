import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadProductKnowledge } from '../server/readiness/product-knowledge';
import { projectReadiness } from '../server/readiness/projection';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract';
import {
  READINESS_AXES,
  READINESS_CONTRACT_VERSION,
  type ProductKnowledgeBundle,
  type ReadinessProjection,
  type ReadinessRuntimeSnapshot,
  type ValidatedReadinessEvidence,
} from '../shared/readiness';

/**
 * FD03 acceptance rows A05, A06 and A07 — deterministic contract tier, run
 * against the production readiness projection and the production shipped-
 * knowledge loader. No provider, no discovery, no HTTP: the projection is a
 * pure function over cached facts and hashed resources, so these rows are the
 * deterministic half of the matrix; the live-model half stays recorded-not-run.
 *
 *   A05  Unsupported selected route — a missing tool/containment/control is
 *        shown and blocks the action; a route switch is explicit-only.
 *   A06  Grounded self-knowledge — availability resolves from build/runtime
 *        facts with cited sources, never roadmap aspirations.
 *   A07  Conflicting/stale knowledge — old docs/new build, new docs/old build,
 *        missing index and stale qualification produce scoped uncertainty and
 *        no overclaim.
 */

const NOW = '2026-10-01T12:00:00.000Z';
const BUILD = { version: '0.2.2', source: 'fd03-acceptance-fixture', digest: 'b'.repeat(64) };
const SHIPPED_KNOWLEDGE_ROOT = path.resolve('resources/product-knowledge');

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

const tmpdirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpdirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function snapshot(overrides: Partial<ReadinessRuntimeSnapshot> = {}): ReadinessRuntimeSnapshot {
  return {
    build: BUILD,
    settings: { services: {}, observedAt: NOW },
    engines: [],
    connectors: { manifests: [], instances: [], observations: [] },
    validatedEvidence: [],
    connectorAuthorizations: [],
    ...overrides,
  };
}

/** A schema-valid knowledge resource; overrides shape the row under test. */
function resource(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: READINESS_CONTRACT_VERSION,
    id: 'fd03-fixture',
    version: '1.0.0',
    buildVersion: BUILD.version,
    title: 'FD03 fixture knowledge',
    qualification: {
      status: 'unverified',
      evidenceId: null,
      source: null,
      qualifiedAt: null,
      staleAfterMs: null,
    },
    scopes: ['product'],
    routes: [],
    connectors: [],
    workflows: [],
    statements: [],
    ...overrides,
  };
}

/**
 * Write a knowledge root on real disk (index + resources, real sha256) and run
 * it through the production loader — the same path the shipped set takes.
 */
async function fixtureKnowledge(
  entries: { filename: string; body: Record<string, unknown> }[],
  indexBuildVersion = BUILD.version,
): Promise<{ root: string; bundle: ProductKnowledgeBundle }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd03-knowledge-'));
  tmpdirs.push(root);
  const written = [] as { path: string; sha256: string; scopes: string[] }[];
  for (const entry of entries) {
    const text = JSON.stringify(entry.body);
    await fs.writeFile(path.join(root, entry.filename), text);
    written.push({
      path: entry.filename,
      sha256: digest(text),
      scopes: (entry.body.scopes as string[]) ?? ['product'],
    });
  }
  await fs.writeFile(
    path.join(root, 'index.json'),
    JSON.stringify({
      schemaVersion: READINESS_CONTRACT_VERSION,
      version: 'fixture-index',
      buildVersion: indexBuildVersion,
      resources: written,
    }),
  );
  return {
    root,
    bundle: await loadProductKnowledge({ root, buildVersion: BUILD.version, now: NOW }),
  };
}

const emptyKnowledge: ProductKnowledgeBundle = {
  contractVersion: READINESS_CONTRACT_VERSION,
  indexVersion: null,
  buildVersion: BUILD.version,
  bundleSha256: null,
  resources: [],
  conflicts: [],
  loadedAt: NOW,
};

const evidenceFor = (routeId: string, staleAfterMs = 60 * 60 * 1000): ValidatedReadinessEvidence => {
  const contract = ROUTE_CONTRACTS[routeId];
  return {
    kind: 'route',
    id: routeId,
    evidenceId: `ev-${routeId}`,
    source: 'fd03-acceptance-fixture',
    validatedAt: NOW,
    staleAfterMs,
    buildVersion: BUILD.version,
    contractVersion: contract.contractVersion,
    engineVersion: contract.engine.version,
  };
};

const axisList = (projection: ReadinessProjection) =>
  [...projection.routes, ...projection.connectors].flatMap((capability) =>
    READINESS_AXES.map((name) => ({ capability, name, axis: capability.axes[name] })),
  );

// A06 — deterministic tier: availability answers carry cited build/runtime
// facts; nothing is reported available from aspiration.
test('A06: every axis carries a named source and a freshness state', async () => {
  const bundle = await loadProductKnowledge({
    root: SHIPPED_KNOWLEDGE_ROOT,
    buildVersion: BUILD.version,
    now: NOW,
  });
  // The shipped index matches this build version — the baseline is conflict-free.
  expect(bundle.conflicts).toEqual([]);
  const projection = projectReadiness({ snapshot: snapshot(), knowledge: bundle, now: NOW });

  // The projection enumerates the real route registry — nothing invented.
  expect(projection.routes.map((route) => route.id).sort()).toEqual(
    Object.keys(ROUTE_CONTRACTS).sort(),
  );

  for (const { axis } of axisList(projection)) {
    expect(axis.source.kind).toMatch(
      /^(build|settings|engine-status|manifest|connection|observation|product-knowledge|validated-evidence)$/,
    );
    expect(axis.source.id.length).toBeGreaterThan(0);
    expect(axis.freshness.state).toMatch(/^(static|fresh|stale|unknown)$/);
    expect(axis.detail.length).toBeGreaterThan(0);
  }
  // `implemented` is a build fact: every declared route carries the build digest.
  for (const route of projection.routes) {
    expect(route.axes.implemented.value).toBe('yes');
    expect(route.axes.implemented.source.kind).toBe('build');
    expect(route.axes.implemented.source.digest).toBe(BUILD.digest);
  }
});

test('A06: ready is derived from five proven axes, never asserted', async () => {
  const projection = projectReadiness({
    snapshot: snapshot(),
    knowledge: emptyKnowledge,
    now: NOW,
  });
  for (const capability of [...projection.routes, ...projection.connectors]) {
    // ready is exactly "all five axes yes" — no other path to available.
    expect(capability.ready).toBe(
      READINESS_AXES.every((name) => capability.axes[name].value === 'yes'),
    );
    expect(capability.blockers).toHaveLength(
      READINESS_AXES.filter((name) => capability.axes[name].value !== 'yes').length,
    );
  }
  // With no evidence, nothing overclaims: no route reports ready, and the
  // verified axis is 'unknown' — not 'yes' — on every external route.
  const external = projection.routes.filter(
    (route) => !['sample', 'native-fixture', 'harness-runtime'].includes(route.id),
  );
  expect(external.length).toBeGreaterThan(0);
  for (const route of external) {
    expect(route.ready).toBe(false);
    expect(route.axes.verified.value).toBe('unknown');
    expect(route.axes.installed.value).toBe('unknown');
  }
});

test('A06: a route with matching fresh evidence reports ready; its sibling does not', async () => {
  const projection = projectReadiness({
    snapshot: snapshot({ validatedEvidence: [evidenceFor('sample')] }),
    knowledge: emptyKnowledge,
    now: NOW,
  });
  const sample = projection.routes.find((route) => route.id === 'sample')!;
  expect(sample.ready).toBe(true);
  expect(sample.axes.verified.value).toBe('yes');
  expect(sample.axes.verified.source.kind).toBe('validated-evidence');
  expect(sample.axes.verified.source.id).toBe('ev-sample');
  // native-fixture is the same static-local kind but has no evidence: its
  // verified axis stays unknown, so it is not ready.
  const sibling = projection.routes.find((route) => route.id === 'native-fixture')!;
  expect(sibling.axes.verified.value).toBe('unknown');
  expect(sibling.ready).toBe(false);
});

test('A06: a stale engine observation is carried, not refreshed or hidden', async () => {
  const tenMinutesAgo = new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString();
  const projection = projectReadiness({
    snapshot: snapshot({
      engines: [
        {
          engine: 'claude-code',
          installation: 'found',
          compatibility: 'supported',
          authentication: 'signed-in',
          accountRoute: 'claude-code:claude.ai',
          models: [{ slug: 'fixture', name: 'Fixture', description: '', efforts: [], defaultEffort: null }],
          checkedAt: tenMinutesAgo,
          detail: 'Cached observation past its freshness window.',
          version: '2.1.252',
          usage: { state: 'unknown', checkedAt: null },
        },
      ],
      settings: { services: { 'claude-code': true }, observedAt: NOW },
      validatedEvidence: [evidenceFor('claude-code')],
    }),
    knowledge: emptyKnowledge,
    now: NOW,
  });
  const route = projection.routes.find((item) => item.id === 'claude-code')!;
  // Observed installed, but stale — the axis reports the fact and its age.
  expect(route.axes.installed.value).toBe('yes');
  expect(route.axes.installed.freshness.state).toBe('stale');
  // Health cannot be claimed from a stale observation, so the route is not ready.
  expect(route.axes.healthy.value).toBe('unknown');
  expect(route.ready).toBe(false);
});

// A05 — an unsupported requirement is shown and blocks the workflow; switching
// routes is never implicit.
test('A05: missing tool, containment and capability block the action, each named', async () => {
  const { bundle } = await fixtureKnowledge([
    {
      filename: 'workflows.json',
      body: resource({
        id: 'fd03-workflows',
        scopes: ['product', 'workflow:needs-steer', 'workflow:needs-absent', 'workflow:needs-claude'],
        workflows: [
          {
            id: 'needs-steer',
            title: 'Requires an unsupported command',
            requirements: [
              { kind: 'route', id: 'sample', commands: ['steer'], operations: [], controls: {} },
            ],
          },
          {
            id: 'needs-absent',
            title: 'Requires a capability that does not exist',
            requirements: [
              { kind: 'connector', id: 'no-such-connector', commands: [], operations: [], controls: {} },
            ],
          },
          {
            id: 'needs-claude',
            title: 'Requires a route with unproven axes',
            requirements: [
              {
                kind: 'route',
                id: 'claude-code',
                commands: ['start', 'status', 'close'],
                operations: [],
                controls: {},
              },
            ],
          },
        ],
      }),
    },
  ]);
  const projection = projectReadiness({
    snapshot: snapshot({ validatedEvidence: [evidenceFor('sample')] }),
    knowledge: bundle,
    now: NOW,
  });

  const steer = projection.workflows.find((workflow) => workflow.id === 'needs-steer')!;
  expect(steer.ready).toBe(false);
  expect(steer.blockers.map((blocker) => blocker.code)).toContain('command-unsupported');

  const absent = projection.workflows.find((workflow) => workflow.id === 'needs-absent')!;
  expect(absent.ready).toBe(false);
  expect(absent.blockers.map((blocker) => blocker.code)).toContain('capability-missing');

  const claude = projection.workflows.find((workflow) => workflow.id === 'needs-claude')!;
  expect(claude.ready).toBe(false);
  const axisBlockers = claude.blockers.filter((blocker) => blocker.code === 'axis-missing');
  expect(axisBlockers.length).toBeGreaterThan(0);
  // The blocker names the axis and carries the axis's own detail.
  expect(axisBlockers[0].requirement).toMatch(/^route:claude-code:(installed|authorized|verified|healthy)$/);

  // Route switching is never implicit anywhere in the projection.
  for (const workflow of projection.workflows) {
    expect(workflow.routeSwitch).toBe('explicit-only');
    expect(workflow.selectedAlternatives).toEqual([]);
  }
});

// A07 — the four named conflict fixtures, each through the production loader.
test('A07: a missing index degrades the whole set to scoped uncertainty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd03-empty-'));
  tmpdirs.push(root);
  const bundle = await loadProductKnowledge({ root, buildVersion: BUILD.version, now: NOW });
  expect(bundle.conflicts.map((conflict) => conflict.code)).toEqual(['missing-index']);
  expect(bundle.resources).toEqual([]);
  expect(bundle.bundleSha256).toBeNull();

  const projection = projectReadiness({ snapshot: snapshot(), knowledge: bundle, now: NOW });
  expect(projection.knowledge.conflicts).toHaveLength(1);
  // A product-scoped conflict touches every route's verified axis — and
  // uncertainty, not availability, is what shows.
  for (const route of projection.routes) {
    expect(route.axes.verified.value).toBe('unknown');
    expect(route.axes.verified.freshness.state).toBe('stale');
    expect(route.ready).toBe(false);
  }
  expect(projection.workflows).toEqual([]);
});

test('A07: knowledge older than the build is a conflict, named with both versions', async () => {
  const { bundle } = await fixtureKnowledge(
    [{ filename: 'core.json', body: resource() }],
    '0.2.1', // index written for the previous build
  );
  const conflict = bundle.conflicts.find((item) => item.code === 'build-version')!;
  expect(conflict.detail).toContain('0.2.1');
  expect(conflict.detail).toContain(BUILD.version);
  expect(conflict.scopes).toContain('product');
});

test('A07: knowledge newer than the build is the same refusal, other direction', async () => {
  const { bundle } = await fixtureKnowledge(
    [{ filename: 'core.json', body: resource({ buildVersion: '0.3.0' }) }],
    '0.3.0', // index describes a build ahead of the installed one
  );
  const conflicts = bundle.conflicts.filter((item) => item.code === 'build-version');
  // Both the index and the resource disagree with the installed build.
  expect(conflicts.length).toBeGreaterThanOrEqual(2);
  for (const conflict of conflicts) {
    expect(conflict.detail).toContain('0.3.0');
    expect(conflict.detail).toContain(BUILD.version);
  }
});

test('A07: stale qualification is scoped uncertainty, not a hard stop', async () => {
  const { bundle } = await fixtureKnowledge([
    {
      filename: 'qualified.json',
      body: resource({
        qualification: {
          status: 'verified',
          evidenceId: 'ev-old-proof',
          source: 'tests/old-run',
          qualifiedAt: '2020-01-01T00:00:00.000Z',
          staleAfterMs: 60_000,
        },
      }),
    },
  ]);
  expect(bundle.conflicts.map((conflict) => conflict.code)).toContain('stale-qualification');
  // The resource still loads — the conflict bounds what it may claim.
  expect(bundle.resources).toHaveLength(1);
});

test('A07: a conflict scoped to one route never overclaims its sibling', async () => {
  const { bundle } = await fixtureKnowledge([
    {
      filename: 'claims.json',
      body: resource({
        scopes: ['product', 'route:sample', 'route:native-fixture'],
        routes: [
          // The claim names a contract version this build does not have.
          { routeId: 'sample', contractVersion: 99, engineVersion: '0.1.0' },
          { routeId: 'native-fixture', contractVersion: 1, engineVersion: '1' },
        ],
      }),
    },
  ]);
  const projection = projectReadiness({
    snapshot: snapshot({ validatedEvidence: [evidenceFor('sample'), evidenceFor('native-fixture')] }),
    knowledge: bundle,
    now: NOW,
  });

  const conflict = projection.knowledge.conflicts.find(
    (item) => item.code === 'contract-mismatch',
  )!;
  expect(conflict.scopes).toEqual(['route:sample']);

  // Scoped uncertainty: the conflicted route's verified axis degrades, the
  // unaffected sibling's does not — same evidence, different scope.
  const sample = projection.routes.find((route) => route.id === 'sample')!;
  expect(sample.axes.verified.value).toBe('unknown');
  expect(sample.axes.verified.source.kind).toBe('product-knowledge');
  expect(sample.ready).toBe(false);

  const sibling = projection.routes.find((route) => route.id === 'native-fixture')!;
  expect(sibling.axes.verified.value).toBe('yes');
  expect(sibling.ready).toBe(true);
});
