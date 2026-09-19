import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AgentRegistry } from '../server/agents.js';
import { ConfigurationService } from '../server/configuration.js';
import {
  compileProspectProposal,
  type ProspectConfigurationSnapshot,
} from '../server/rehearsal/prospect-configuration.js';
import { loadIndustryVariantRegistry } from '../server/rehearsal/industry-registry.js';
import { Store } from '../server/store.js';
import { WorkspaceService, answersDigest } from '../server/workspaces.js';
import type { AnswerMap, AnswerValue, BusinessAnswer } from '../shared/business-setup.js';

const AT = '2026-09-19T07:00:00.000Z';
let root = '';
let snapshot: ProspectConfigurationSnapshot;
let service: ConfigurationService;
let agents: AgentRegistry;
let store: Store;
let workspaces: WorkspaceService;

const answers = (): AnswerMap => {
  const rows: Record<string, AnswerValue> = {
    name: 'Harbor Street Kitchen',
    industry: 'restaurant',
    job: 'recurring-report',
    result: 'A synthetic weekly brief.',
    sources: ['files'],
    people: 'just-me',
    locations: 'one',
    'human-required': ['everything'],
    'data-leaving': 'no',
    host: 'Local demo',
    'spend-cap': 0,
    'first-run': 'manual',
  };
  return Object.fromEntries(
    Object.entries(rows).map(([questionId, value]) => [
      questionId,
      {
        questionId,
        value,
        unknown: false,
        origin: 'person',
        at: AT,
        by: 'operator-test',
      } satisfies BusinessAnswer,
    ]),
  );
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'fd04-prospect-config-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  workspaces = new WorkspaceService(store);
  await workspaces.init();
  agents = new AgentRegistry(store.dataDir);
  const projected = answers();
  snapshot = {
    owner: {
      kind: 'prospect',
      prospectId: 'prospect_550e8400-e29b-41d4-a716-446655440000',
      operatorId: 'operator-test',
    },
    name: 'Harbor Street Kitchen',
    answers: projected,
    answersDigest: answersDigest(projected),
    recordId: 'discovery-record-1',
    recordDigest: `sha256:${'a'.repeat(64)}`,
    recordUpdatedAt: AT,
    overlay: {
      prospectId: 'prospect_550e8400-e29b-41d4-a716-446655440000',
      variantId: 'restaurant-operations',
      revision: 1,
      business: { name: 'Harbor Street Kitchen' },
      locations: [],
      terminology: {},
      selection: [],
      policy: 'drafts-only',
    },
  };
  service = new ConfigurationService(store, workspaces, agents, {
    resolve: async () => structuredClone(snapshot),
  });
  await service.init();
});

afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe('FD04 prospect configuration namespace', () => {
  test('stages and activates in a null Business namespace, then refuses a moved FD02 record', async () => {
    const registry = await loadIndustryVariantRegistry({
      bundledRoot: path.join(process.cwd(), 'resources', 'industry-variants'),
    });
    const variant = registry.variants.get('restaurant-operations')!;
    const context = await service.context(snapshot.owner);
    const proposal = compileProspectProposal({
      snapshot,
      variant,
      variants: registry.variants,
      previousConfigurationDigest: null,
      agents: context.knownAgents,
      at: AT,
    });

    const staged = await service.stage(snapshot.owner, proposal);
    expect(staged.owner).toEqual(snapshot.owner);
    expect(staged.organizationId).toBeNull();
    expect(staged.tenantId).toBeNull();
    expect(staged.readiness.ready).toBe(true);
    const active = await service.activate(snapshot.owner, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'prospect-activate-1',
    });
    expect(active.state).toBe('active');
    const restarted = new ConfigurationService(store, workspaces, agents, {
      resolve: async () => structuredClone(snapshot),
    });
    await restarted.init();
    expect(restarted.active(snapshot.owner)?.revision).toBe(1);

    const next = compileProspectProposal({
      snapshot,
      variant,
      variants: registry.variants,
      previousConfigurationDigest: active.digest,
      agents: context.knownAgents,
      at: AT,
    });
    await service.stage(snapshot.owner, next);
    snapshot = { ...snapshot, recordDigest: `sha256:${'b'.repeat(64)}` };
    await expect(
      service.activate(snapshot.owner, {
        revision: 2,
        expectedActiveRevision: 1,
        activationId: 'moved',
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_source_moved' } });
  });

  test('visibly refuses live connections and nonlocal routes', async () => {
    const registry = await loadIndustryVariantRegistry({
      bundledRoot: path.join(process.cwd(), 'resources', 'industry-variants'),
    });
    const variant = registry.variants.get('restaurant-operations')!;
    const context = await service.context(snapshot.owner);
    const base = compileProspectProposal({
      snapshot,
      variant,
      variants: registry.variants,
      previousConfigurationDigest: null,
      agents: context.knownAgents,
      at: AT,
    });
    await expect(
      service.stage(snapshot.owner, {
        ...base,
        modelPolicy: { ...base.modelPolicy, routes: ['claude-code'] },
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_unsupported_route' } });
    await expect(
      service.stage(snapshot.owner, {
        ...base,
        requiredConnections: [
          {
            catalogueId: 'live',
            label: 'Live',
            status: 'connected',
            required: true,
            fallback: null,
            provenance: { source: 'template', why: 'test' },
          },
        ],
      }),
    ).rejects.toMatchObject({ details: { code: 'prospect_live_authority' } });
  });

  test('does not persist a stage when the active FD02 record is revoked during validation', async () => {
    const registry = await loadIndustryVariantRegistry({
      bundledRoot: path.join(process.cwd(), 'resources', 'industry-variants'),
    });
    const variant = registry.variants.get('restaurant-operations')!;
    const context = await service.context(snapshot.owner);
    const proposal = compileProspectProposal({
      snapshot,
      variant,
      variants: registry.variants,
      previousConfigurationDigest: null,
      agents: context.knownAgents,
      at: AT,
    });
    let resolves = 0;
    const racing = new ConfigurationService(store, workspaces, agents, {
      resolve: async () => {
        resolves += 1;
        return resolves < 3
          ? structuredClone(snapshot)
          : { ...structuredClone(snapshot), recordDigest: `sha256:${'d'.repeat(64)}` };
      },
    });
    await racing.init();
    await expect(racing.stage(snapshot.owner, proposal)).rejects.toMatchObject({
      details: { code: 'prospect_source_moved' },
    });
    expect(racing.staged(snapshot.owner)).toBeNull();
  });
});
