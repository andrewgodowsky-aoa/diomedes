/**
 * The durable half of governed configuration, proven directly.
 *
 * These tests drive a real Store, a real WorkspaceService and the real Agent
 * registry over a temporary directory: staging stays inactive, activation is
 * a compare-and-set against live authority, replays change nothing, moved
 * answers and stale Agents stop activation, and everything survives a
 * restart. Membership is the only authority, so revocation is simulated by
 * editing the stored registry the way a second host would leave it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../server/store.js';
import { WorkspaceService, answersDigest } from '../server/workspaces.js';
import { AgentRegistry } from '../server/agents.js';
import { ConfigurationService } from '../server/configuration.js';
import { readJson } from '../server/store.js';
import { ApiError } from '../server/paths.js';
import {
  ACTIVATION_CONFLICT,
  ANSWERS_MOVED,
  ROLLBACK_LIMITS,
  type ConfigurationProposal,
  type ValidationProblem,
} from '../shared/configuration.js';
import { BUSINESS_SETUP_SCHEMA_REVISION, type BusinessAnswer } from '../shared/business-setup.js';
import type { Organization } from '../shared/workspaces.js';

let root = '';
let store: Store;
let workspaces: WorkspaceService;
let agents: AgentRegistry;
let service: ConfigurationService;

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'configuration-'));
  store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  workspaces = new WorkspaceService(store);
  await workspaces.init();
  agents = new AgentRegistry(store.dataDir);
  service = new ConfigurationService(store, workspaces, agents);
  await service.init();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function createOrg(name = 'Ridge Cabinetry'): Promise<Organization> {
  await workspaces.createOrganization({ name });
  const found = workspaces.view().organizations.find((item) => item.organization.name === name);
  if (!found) throw new Error('The test organization was not created.');
  return found.organization;
}

/** The intake's current answers digest, read the way the service reads it. */
async function answersNow(organizationId: string): Promise<string> {
  const setup = await readJson<{ answers?: Record<string, BusinessAnswer> } | null>(
    path.join(root, 'data', 'workspaces', 'setup', `${organizationId}.json`),
    () => null,
  );
  return answersDigest(setup?.answers ?? {});
}

/** A proposal that passes validation against the live registries. */
async function makeProposal(
  org: Organization,
  overrides: Partial<ConfigurationProposal> = {},
): Promise<ConfigurationProposal> {
  const { agents: listed } = await agents.list();
  const general = listed.find((item) => item.id === 'diomedes.general');
  if (!general) throw new Error('The built-in general Agent is missing.');
  return {
    v: 1,
    organizationId: org.id,
    tenantId: org.tenantId,
    questionnaireRevision: BUSINESS_SETUP_SCHEMA_REVISION,
    answersDigest: await answersNow(org.id),
    previousConfigurationDigest: null,
    template: { id: 'diomedes.weekly-brief', version: '1.0.0', variantId: 'restaurant-operations' },
    agents: [
      {
        agentId: general.id,
        agentVersion: general.version,
        agentDigest: general.digest,
        label: 'General Assistant',
        roleOverride: null,
        ceiling: 'review',
        provenance: { source: 'answer', why: 'Chosen from the intake answers.' },
      },
    ],
    team: null,
    rules: [],
    requiredConnections: [],
    contextScopes: [],
    modelPolicy: {
      routes: ['harness-runtime'],
      processing: 'may-leave',
      fallbackAllowed: false,
      provenance: { source: 'template', why: 'Runs on the local harness route.' },
    },
    budget: {
      monthlyCapUsd: null,
      sharesParentBudget: true,
      changeableBy: 'owner',
      provenance: { source: 'default', why: 'No spending limit was named.' },
    },
    approvers: {
      proposedApprovers: [],
      humanRequired: ['sending'],
      everythingStops: false,
      provenance: { source: 'answer', why: 'Sending waits for a person.' },
    },
    expectedOutputs: [],
    unresolved: [],
    createdAt: new Date().toISOString(),
    createdBy: workspaces.currentPerson().id,
    candidateOrigin: 'deterministic',
    ...overrides,
  };
}

/** Move the intake answers under a staged proposal by editing the stored setup. */
async function moveAnswers(organizationId: string) {
  const setupPath = path.join(root, 'data', 'workspaces', 'setup', `${organizationId}.json`);
  const existing = await readJson<{ answers?: Record<string, BusinessAnswer> }>(setupPath, () => ({
    answers: {},
  }));
  const answer: BusinessAnswer = {
    questionId: 'industry',
    value: 'cabinetry',
    unknown: false,
    origin: 'person',
    at: new Date().toISOString(),
    by: workspaces.currentPerson().id,
  };
  await fs.mkdir(path.dirname(setupPath), { recursive: true });
  await fs.writeFile(
    setupPath,
    JSON.stringify({ ...existing, answers: { ...existing.answers, industry: answer } }, null, 2),
    'utf8',
  );
}

const errorCode = (error: unknown): string | undefined =>
  (error as ApiError).details?.code as string | undefined;

async function fails(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('Expected the call to fail, but it succeeded.');
}

const configPath = (organizationId: string) =>
  path.join(root, 'data', 'workspaces', 'configuration', `${organizationId}.json`);

describe('staging', () => {
  test('a staged manifest is inactive, and nothing is active yet', async () => {
    const org = await createOrg();
    const staged = await service.stage(org.id, await makeProposal(org));
    expect(staged.state).toBe('staged');
    expect(staged.revision).toBe(1);
    expect(staged.readiness.ready).toBe(true);
    expect(service.active(org.id)).toBeNull();
    expect(service.staged(org.id)?.revision).toBe(1);
    const view = service.view(org.id);
    expect(view.expectedActiveRevision).toBeNull();
    expect(view.canActivate).toBe(true);
    expect(view.whyNot).toBeNull();
  });

  test('staging twice supersedes the first staged manifest, never holding two', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    const second = await service.stage(org.id, await makeProposal(org));
    expect(second.revision).toBe(2);
    const staged = service.history(org.id).filter((item) => item.state === 'staged');
    expect(staged).toHaveLength(1);
    expect(staged[0].revision).toBe(2);
    expect(service.history(org.id).find((item) => item.revision === 1)?.state).toBe('superseded');
    expect(service.staged(org.id)?.revision).toBe(2);
  });
});

describe('activation', () => {
  test('the wrong expected revision conflicts and leaves the active setup unchanged', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    const before = service.active(org.id);
    await service.stage(org.id, await makeProposal(org));
    const error = await fails(
      service.activate(org.id, { revision: 2, expectedActiveRevision: 999, activationId: 'act-2' }),
    );
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe('stale_configuration');
    expect(error.message).toBe(ACTIVATION_CONFLICT);
    expect(service.active(org.id)).toEqual(before);
    expect(service.staged(org.id)?.revision).toBe(2);
  });

  test('replaying an activation id returns the identical manifest and writes nothing', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    const first = await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    const listBefore = service.history(org.id);
    const again = await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    expect(again).toEqual(first);
    expect(service.history(org.id)).toEqual(listBefore);
  });

  test('moved answers stop activation and nothing is written', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    const listBefore = service.history(org.id);
    await moveAnswers(org.id);
    const error = await fails(
      service.activate(org.id, {
        revision: 1,
        expectedActiveRevision: null,
        activationId: 'act-1',
      }),
    );
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe('answers_moved');
    expect(error.message).toBe(ANSWERS_MOVED);
    expect(service.active(org.id)).toBeNull();
    expect(service.history(org.id)).toEqual(listBefore);
  });

  test('a changed Agent digest stops activation and the previous setup survives', async () => {
    const org = await createOrg();
    const { agents: listed } = await agents.list();
    const general = listed.find((item) => item.id === 'diomedes.general');
    if (!general) throw new Error('The built-in general Agent is missing.');
    let digestNow = general.digest;
    const stub = {
      list: async () => ({
        at: Date.now(),
        agents: listed.map((item) =>
          item.id === general.id ? { ...item, digest: digestNow } : item,
        ),
        skipped: [],
      }),
      find: async (id: string) => (await stub.list()).agents.find((item) => item.id === id),
    } as unknown as AgentRegistry;
    const governed = new ConfigurationService(store, workspaces, stub);
    await governed.init();
    const first = await makeProposal(org);
    await governed.stage(org.id, first);
    const active = await governed.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    await governed.stage(org.id, await makeProposal(org));
    // The Agent definition changes after staging, so the staged digest is stale.
    digestNow = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const error = await fails(
      governed.activate(org.id, { revision: 2, expectedActiveRevision: 1, activationId: 'act-2' }),
    );
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe('not_ready');
    const blocking = (error.details?.blocking ?? []) as ValidationProblem[];
    expect(blocking.some((item) => item.code === 'stale-agent')).toBe(true);
    expect(governed.active(org.id)).toEqual(active);
  });
});

describe('authority', () => {
  test('a stranger and a revoked member are refused at both stage and activate', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    const identityPath = path.join(root, 'data', 'workspaces', 'identity.json');
    const me = JSON.parse(await fs.readFile(identityPath, 'utf8'));

    // Absent membership: someone else on the same install.
    await fs.writeFile(
      identityPath,
      JSON.stringify({ ...me, id: 'person_stranger', name: 'Stranger' }, null, 2),
      'utf8',
    );
    const strangerWorkspaces = new WorkspaceService(store);
    await strangerWorkspaces.init();
    const stranger = new ConfigurationService(store, strangerWorkspaces, agents);
    await stranger.init();
    expect(errorCode(await fails(stranger.stage(org.id, await makeProposal(org))))).toBe(
      'not_a_configurer',
    );
    expect(
      errorCode(
        await fails(
          stranger.activate(org.id, {
            revision: 1,
            expectedActiveRevision: null,
            activationId: 'act-x',
          }),
        ),
      ),
    ).toBe('not_a_configurer');

    // Revoked membership: the owner is back, but their membership was removed.
    await fs.writeFile(identityPath, JSON.stringify(me, null, 2), 'utf8');
    const registryPath = path.join(root, 'data', 'workspaces', 'registry.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    for (const membership of registry.memberships)
      if (membership.organizationId === org.id) {
        membership.state = 'revoked';
        membership.revokedAt = new Date().toISOString();
        membership.revokedReason = 'test revocation';
      }
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    const revokedWorkspaces = new WorkspaceService(store);
    await revokedWorkspaces.init();
    const revoked = new ConfigurationService(store, revokedWorkspaces, agents);
    await revoked.init();
    expect(errorCode(await fails(revoked.stage(org.id, await makeProposal(org))))).toBe(
      'not_a_configurer',
    );
    expect(
      errorCode(
        await fails(
          revoked.activate(org.id, {
            revision: 1,
            expectedActiveRevision: null,
            activationId: 'act-y',
          }),
        ),
      ),
    ).toBe('not_a_configurer');
  });
});

describe('readiness and recovery', () => {
  test('an invalid proposal is still staged and readable, but cannot be activated', async () => {
    const org = await createOrg();
    const invalid = await makeProposal(org, {
      modelPolicy: {
        routes: [],
        processing: 'may-leave',
        fallbackAllowed: false,
        provenance: { source: 'template', why: 'No route was chosen.' },
      },
    });
    const staged = await service.stage(org.id, invalid);
    expect(staged.readiness.ready).toBe(false);
    expect(staged.readiness.blocking.length).toBeGreaterThan(0);
    expect(service.staged(org.id)?.revision).toBe(staged.revision);
    const view = service.view(org.id);
    expect(view.canActivate).toBe(false);
    expect(typeof view.whyNot).toBe('string');
    const error = await fails(
      service.activate(org.id, {
        revision: 1,
        expectedActiveRevision: null,
        activationId: 'act-bad',
      }),
    );
    expect(error.status).toBe(409);
    expect(errorCode(error)).toBe('not_ready');
  });

  test('active, staged and history survive a restart over the same directory', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    await service.stage(org.id, await makeProposal(org));
    const store2 = new Store(path.join(root, 'data'), path.join(root, 'projects'));
    await store2.init();
    const workspaces2 = new WorkspaceService(store2);
    await workspaces2.init();
    const service2 = new ConfigurationService(
      store2,
      workspaces2,
      new AgentRegistry(store2.dataDir),
    );
    await service2.init();
    expect(service2.active(org.id)).toEqual(service.active(org.id));
    expect(service2.staged(org.id)).toEqual(service.staged(org.id));
    expect(service2.history(org.id)).toEqual(service.history(org.id));
  });

  test('rollback restores the earlier revision and states its limits', async () => {
    const org = await createOrg();
    await service.stage(org.id, await makeProposal(org));
    await service.activate(org.id, {
      revision: 1,
      expectedActiveRevision: null,
      activationId: 'act-1',
    });
    await service.stage(org.id, await makeProposal(org));
    await service.activate(org.id, {
      revision: 2,
      expectedActiveRevision: 1,
      activationId: 'act-2',
    });
    const restored = await service.rollback(org.id, {
      toRevision: 1,
      expectedActiveRevision: 2,
      activationId: 'back-1',
    });
    expect(restored.revision).toBe(1);
    expect(restored.state).toBe('active');
    expect(restored.readiness.degradedPlan).toContain(ROLLBACK_LIMITS);
    expect(service.active(org.id)?.revision).toBe(1);
    expect(service.history(org.id).find((item) => item.revision === 2)?.state).toBe('superseded');
  });

  test('an unsafe candidate is refused and leaves no file on disk', async () => {
    const org = await createOrg();
    const unsafe = await makeProposal(org, {
      rules: [
        {
          id: 'house-style',
          text: 'Follow the style at https://example.com/style in every reply.',
          category: 'guidance',
          scope: { projectId: 'ridge' },
          provenance: { source: 'answer', why: 'House style.' },
        },
      ],
    });
    const error = await fails(service.stage(org.id, unsafe));
    expect(error.status).toBe(400);
    expect(errorCode(error)).toBe('unsafe_candidate');
    expect(service.history(org.id)).toEqual([]);
    await expect(fs.stat(configPath(org.id))).rejects.toThrow();
  });
});

describe('an activation id is an idempotency key, not a capability', () => {
  /**
   * Replay is checked early so a retried request cannot activate twice. That
   * ordering once let an activation id act as a bearer token: the lookup
   * searched every stored organization, and replay ran before the membership
   * check, so quoting an id recorded under one business returned that
   * business's manifest to someone who had no part in it.
   */
  test('an id recorded under another business does not return its manifest', async () => {
    const mine = await createOrg('Ridge Cabinetry');
    const theirs = await createOrg('Harbour Consulting');

    const staged = await service.stage(theirs.id, await makeProposal(theirs));
    const activationId = 'shared-looking-id';
    const activated = await service.activate(theirs.id, {
      revision: staged.revision,
      expectedActiveRevision: null,
      activationId,
    });
    expect(activated.state).toBe('active');

    // The same id, quoted against a different business. It must mean nothing
    // here — not a replay, and certainly not the other business's manifest.
    await expect(
      service.activate(mine.id, {
        revision: 1,
        expectedActiveRevision: null,
        activationId,
      }),
    ).rejects.toThrow(ApiError);

    let leaked: unknown = null;
    try {
      await service.activate(mine.id, {
        revision: 1,
        expectedActiveRevision: null,
        activationId,
      });
    } catch (error) {
      leaked = error;
    }
    expect((leaked as ApiError).status).not.toBe(200);
    // Nothing of the other business crossed over.
    expect(service.active(mine.id)).toBeNull();
    expect(service.history(mine.id)).toHaveLength(0);
    // And the other business is exactly as it was.
    expect(service.active(theirs.id)?.revision).toBe(staged.revision);
    expect(service.history(theirs.id)).toHaveLength(1);
  });

  test('a replay is refused once the person may no longer configure the business', async () => {
    const org = await createOrg();
    const staged = await service.stage(org.id, await makeProposal(org));
    const activationId = 'retried-once';
    await service.activate(org.id, {
      revision: staged.revision,
      expectedActiveRevision: null,
      activationId,
    });

    // Revoke the membership the way a second host would leave it, then restart
    // so the service reads the registry rather than a warm copy.
    const registryPath = path.join(root, 'data', 'workspaces', 'registry.json');
    const registry = await readJson<{ memberships: { state: string }[] }>(registryPath, () => ({
      memberships: [],
    }));
    for (const membership of registry.memberships) membership.state = 'revoked';
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    const after = new WorkspaceService(store);
    await after.init();
    const reopened = new ConfigurationService(store, after, agents);
    await reopened.init();

    await expect(
      reopened.activate(org.id, {
        revision: staged.revision,
        expectedActiveRevision: null,
        activationId,
      }),
    ).rejects.toThrow(ApiError);
  });
});
