import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_CATALOG,
  AGENT_REQUIREMENTS,
  AUTO_AGENT,
  AUTO_BY_MODE,
  agentCompatibility,
  narrowerPermission,
  type AgentDefinition,
} from '../shared/agents.js';
import { AgentRegistry, agentDigest, validateAgentResolutions } from '../server/agents.js';
import { ROUTE_CAPABILITIES } from '../shared/capabilities.js';
import type { Mode, ProjectState } from '../shared/types.js';

let temp = '';
const project = (folder: string): ProjectState =>
  ({
    project: { id: 'P1', name: 'Project', folder, createdAt: '', lastOpenedAt: '' },
    tasks: [],
    sessions: [],
    needs: [],
    history: [],
    changes: [],
    conversations: [],
    documents: [],
    scopeGrants: [],
  }) as unknown as ProjectState;

beforeEach(async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'agents-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe('the built-in Agent catalog', () => {
  test('every Agent is a job identity with a stable id, version and digest', () => {
    const ids = new Set<string>();
    for (const definition of AGENT_CATALOG) {
      expect(definition.protocolVersion).toBe(1);
      expect(definition.id.startsWith('diomedes.')).toBe(true);
      expect(ids.has(definition.id)).toBe(false);
      ids.add(definition.id);
      expect(definition.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(definition.origin).toBe('built-in');
      // A name a person recognises, not a system label.
      expect(definition.name).toMatch(/^[A-Z]/);
      expect(definition.name).not.toMatch(/agent|persona|prompt|skill/i);
      expect(definition.summary.length).toBeGreaterThan(10);
      expect(definition.modes.length).toBeGreaterThan(0);
      expect(definition.handoff.produces.length).toBeGreaterThan(0);
      expect(definition.evidence.length).toBeGreaterThan(0);
      expect(agentDigest(definition)).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(ids.has('diomedes.general')).toBe(true);
    expect(ids.has('diomedes.reviewer')).toBe(true);
    expect(AGENT_CATALOG.find((item) => item.id === 'diomedes.reviewer')!.name).toBe(
      'Code Reviewer',
    );
    expect(AGENT_CATALOG.find((item) => item.id === 'diomedes.researcher')!.name).toBe(
      'Documentation Researcher',
    );
    expect(AGENT_CATALOG.find((item) => item.id === 'diomedes.analyst')!.name).toBe(
      'Weekly Operations Analyst',
    );
  });
  test('the digest changes when the Agent changes, and not otherwise', () => {
    const [first] = AGENT_CATALOG;
    expect(agentDigest(first)).toBe(agentDigest({ ...first }));
    expect(agentDigest({ ...first, role: `${first.role} Also do more.` })).not.toBe(
      agentDigest(first),
    );
    expect(agentDigest({ ...first, permissionCeiling: 'full' })).not.toBe(agentDigest(first));
    expect(agentDigest({ ...first, version: '9.9.9' })).not.toBe(agentDigest(first));
  });
  test('an Agent references the existing systems instead of restating them', () => {
    for (const definition of AGENT_CATALOG) {
      // Requirements name capability facts, not free text.
      for (const requirement of definition.requires)
        expect(Object.keys(AGENT_REQUIREMENTS)).toContain(requirement);
      // No second permission, policy or rule framework hides inside an Agent.
      const text = JSON.stringify(definition);
      expect(text).not.toMatch(/"grant"|"receipt"|"approval"|"authorization"/i);
      expect(definition.ruleScopes.every((scope) => scope.length < 40)).toBe(true);
      // The role is guidance. It never claims authority.
      expect(definition.role).not.toMatch(/you may write|permission|approved|authorised|authorized/i);
    }
  });
  test('a reviewer identity can never be a writer', () => {
    const reviewer = AGENT_CATALOG.find((item) => item.id === 'diomedes.reviewer')!;
    expect(reviewer.permissionCeiling).toBe('review');
    expect(reviewer.requires).not.toContain('text-proposals');
    expect(reviewer.handoff.produces).toContain('review.verdict');
    expect(narrowerPermission(reviewer.permissionCeiling, 'auto-review')).toBe('review');
    expect(narrowerPermission('full', 'project')).toBe('project');
    expect(narrowerPermission('review', 'review')).toBe('review');
  });
});

describe('Agent and runtime compatibility', () => {
  test('a writer Agent is compatible with Codex and refuses an unknown route', () => {
    const builder = AGENT_CATALOG.find((item) => item.id === 'diomedes.builder')!;
    expect(agentCompatibility(builder, 'codex').ok).toBe(true);
    const unknown = agentCompatibility(builder, 'not-a-route');
    expect(unknown.ok).toBe(false);
    expect(unknown.unmet[0].detail).toContain('not a known execution route');
  });
  test('a writer Agent runs on any text route, because a scope is a Trust matter', () => {
    const builder = AGENT_CATALOG.find((item) => item.id === 'diomedes.builder')!;
    // Every one of these can propose a change set for exact review.
    for (const route of ['claude-code', 'opencode', 'oh-my-pi'])
      expect(agentCompatibility(builder, route).ok).toBe(true);
    // Compatibility deliberately does not restate what a scope grant requires:
    // those routes cannot revoke or prove an effect, and Trust is what refuses
    // them a scope. An Agent must not become a second policy layer.
    for (const route of ['claude-code', 'opencode', 'oh-my-pi'])
      expect(ROUTE_CAPABILITIES[route].revocationStopsFutureEffects.answer).not.toBe('yes');
    expect(builder.requires).not.toContain('revocable-effects');
  });
  test('an Agent requiring a shell or a sandbox is compatible with nothing today', () => {
    const impossible: AgentDefinition = {
      ...AGENT_CATALOG[0],
      id: 'test.shell',
      requires: ['shell-commands', 'isolated-environment'],
    };
    for (const route of ['codex', 'harness-runtime', 'sample', 'claude-code'])
      expect(agentCompatibility(impossible, route).ok).toBe(false);
  });
  test('read-only Agents run anywhere a text route exists', () => {
    for (const id of ['diomedes.reviewer', 'diomedes.researcher', 'diomedes.analyst']) {
      const definition = AGENT_CATALOG.find((item) => item.id === id)!;
      for (const route of ['codex', 'claude-code', 'opencode', 'oh-my-pi'])
        expect(agentCompatibility(definition, route).ok).toBe(true);
    }
  });
});

describe('the Agent registry', () => {
  test('built-ins are always present, with their digests', async () => {
    const registry = new AgentRegistry(temp);
    const { agents, skipped } = await registry.list(null);
    expect(agents).toHaveLength(AGENT_CATALOG.length);
    expect(skipped).toEqual([]);
    expect(await registry.find('diomedes.reviewer')).toMatchObject({ name: 'Code Reviewer' });
    expect(await registry.find('nope')).toBeUndefined();
  });
  test('a project Agent loads from the project folder with no service involved', async () => {
    const folder = path.join(temp, 'project');
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'ops.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.ops-brief',
        version: '0.2.0',
        name: 'Acme Ops Brief',
        summary: 'Writes the Monday operations brief for Acme.',
        modes: ['ask'],
        role: 'Summarise the week from the selected material only.',
        requires: ['no-secret-access'],
        tools: [],
        ruleScopes: ['project'],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['report.markdown'] },
        evidence: ['report.markdown'],
      }),
    );
    const registry = new AgentRegistry(temp);
    const { agents, skipped } = await registry.list(folder);
    expect(skipped).toEqual([]);
    const added = agents.find((item) => item.id === 'acme.ops-brief')!;
    expect(added).toMatchObject({ origin: 'project', source: 'project:ops.json', version: '0.2.0' });
    expect(added.digest).toMatch(/^sha256:/);
    // Built-ins are unaffected by an added definition.
    expect(agents.filter((item) => item.origin === 'built-in')).toHaveLength(AGENT_CATALOG.length);
  });
  test('a project Agent cannot raise its own ceiling or replace a built-in id', async () => {
    const folder = path.join(temp, 'project2');
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    const body = {
      protocolVersion: 1,
      version: '1.0.0',
      name: 'Sneaky Writer',
      summary: 'Tries to hold more authority than the built-in general Agent.',
      modes: ['build'],
      role: 'Write whatever is asked.',
      requires: ['text-proposals'],
      tools: [],
      ruleScopes: [],
      permissionCeiling: 'full',
      models: [],
      handoff: { accepts: [], produces: ['proposal.text'] },
      evidence: ['proposal.text'],
    };
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'a.json'),
      JSON.stringify({ ...body, id: 'acme.sneaky' }),
    );
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'b.json'),
      JSON.stringify({ ...body, id: 'diomedes.reviewer' }),
    );
    const { agents, skipped } = await new AgentRegistry(temp).list(folder);
    // Its stated ceiling is capped at the built-in general Agent's.
    expect(agents.find((item) => item.id === 'acme.sneaky')!.permissionCeiling).toBe('auto-review');
    // And it cannot take over a built-in identity.
    expect(agents.find((item) => item.id === 'diomedes.reviewer')!.origin).toBe('built-in');
    expect(skipped.map((item) => item.reason).join(' ')).toContain('already used');
  });
  test('a malformed definition is skipped with a reason, and never becomes an Agent', async () => {
    const folder = path.join(temp, 'project3');
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(path.join(folder, '.diomedes', 'agents', 'bad.json'), '{ not json');
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'partial.json'),
      JSON.stringify({ protocolVersion: 1, id: 'acme.partial' }),
    );
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'extra.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.extra',
        version: '1.0.0',
        name: 'Extra',
        summary: 'Carries a field the contract does not define.',
        modes: ['ask'],
        role: 'Do the thing.',
        requires: [],
        tools: [],
        ruleScopes: [],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['answer.text'] },
        evidence: ['answer.text'],
        grantsWriteAccess: true,
      }),
    );
    const { agents, skipped } = await new AgentRegistry(temp).list(folder);
    expect(agents).toHaveLength(AGENT_CATALOG.length);
    expect(skipped).toHaveLength(3);
    for (const item of skipped) expect(item.reason.length).toBeGreaterThan(10);
  });
});

describe('resolution records authority and never confers it', () => {
  const registry = () => new AgentRegistry(temp);
  test('Auto resolves deterministically by mode and is recorded as automatic', async () => {
    for (const mode of ['ask', 'plan', 'build', 'fix'] as Mode[]) {
      const resolution = await registry().resolve({
        requestedAgentId: AUTO_AGENT,
        mode,
        routeId: 'codex',
        state: project(temp),
        taskId: 'T1',
      });
      expect(resolution.agentId).toBe(AUTO_BY_MODE[mode]);
      expect(resolution.agentSelection).toBe('automatic');
      expect(resolution.requestedAgentId).toBe(AUTO_AGENT);
    }
    // An omitted choice is automatic too, and says which Agent it landed on.
    const omitted = await registry().resolve({
      mode: 'build',
      routeId: 'codex',
      state: project(temp),
      taskId: 'T1',
    });
    expect(omitted.agentSelection).toBe('automatic');
    expect(omitted.requestedAgentId).toBeNull();
    expect(omitted.agentId).toBe('diomedes.builder');
  });
  test('a named Agent is recorded as a manual selection, independently of the model', async () => {
    const resolution = await registry().resolve({
      requestedAgentId: 'diomedes.analyst',
      mode: 'ask',
      routeId: 'codex',
      requestedModel: 'some-model',
      modelSelection: 'manual',
      state: project(temp),
      taskId: 'T1',
    });
    expect(resolution.agentId).toBe('diomedes.analyst');
    expect(resolution.agentName).toBe('Weekly Operations Analyst');
    expect(resolution.agentSelection).toBe('manual');
    expect(resolution.requestedModel).toBe('some-model');
    expect(resolution.modelSelection).toBe('manual');
    // The same Agent through a different model keeps its identity and digest.
    const other = await registry().resolve({
      requestedAgentId: 'diomedes.analyst',
      mode: 'ask',
      routeId: 'claude-code',
      requestedModel: 'another-model',
      modelSelection: 'manual',
      state: project(temp),
      taskId: 'T1',
    });
    expect(other.agentId).toBe(resolution.agentId);
    expect(other.agentDigest).toBe(resolution.agentDigest);
    expect(other.routeId).toBe('claude-code');
  });
  test('with nothing granted, every Agent resolves to Review changes', async () => {
    for (const id of AGENT_CATALOG.map((item) => item.id)) {
      const definition = AGENT_CATALOG.find((item) => item.id === id)!;
      const resolution = await registry().resolve({
        requestedAgentId: id,
        mode: definition.modes[0],
        routeId: 'codex',
        state: project(temp),
        taskId: 'T1',
      });
      expect(resolution.policy.granted).toBe('review');
      expect(resolution.policy.effective).toBe('review');
      expect(resolution.policy.grantId).toBeNull();
      expect(resolution.policy.grantsAuthority).toBe(false);
    }
  });
  test('the effective permission is the narrower of the Agent ceiling and the grant', async () => {
    const state = project(temp);
    const grant = (review: 'human' | 'model-reviewer') => {
      state.scopeGrants = [
        {
          generation: 0,
          revokedAt: null,
          grant: { taskId: 'T1', id: 'G1', review } as never,
        },
      ];
    };
    grant('human');
    const builder = await registry().resolve({
      requestedAgentId: 'diomedes.builder',
      mode: 'build',
      routeId: 'codex',
      state,
      taskId: 'T1',
    });
    expect(builder.policy.granted).toBe('project');
    expect(builder.policy.effective).toBe('project');
    expect(builder.policy.grantId).toBe('G1');
    // A review-only Agent stays review-only under the same grant.
    const reviewer = await registry().resolve({
      requestedAgentId: 'diomedes.reviewer',
      mode: 'ask',
      routeId: 'codex',
      state,
      taskId: 'T1',
    });
    expect(reviewer.policy.granted).toBe('project');
    expect(reviewer.policy.agentCeiling).toBe('review');
    expect(reviewer.policy.effective).toBe('review');
    // A reviewer-routed grant reads as auto-review, and still cannot exceed a ceiling.
    grant('model-reviewer');
    const auto = await registry().resolve({
      requestedAgentId: 'diomedes.builder',
      mode: 'build',
      routeId: 'codex',
      state,
      taskId: 'T1',
    });
    expect(auto.policy.granted).toBe('auto-review');
    expect(auto.policy.effective).toBe('auto-review');
    const held = await registry().resolve({
      requestedAgentId: 'diomedes.architect',
      mode: 'plan',
      routeId: 'codex',
      state,
      taskId: 'T1',
    });
    expect(held.policy.effective).toBe('review');
  });
  test('a revoked or foreign-task grant confers nothing on a resolution', async () => {
    const state = project(temp);
    state.scopeGrants = [
      { generation: 1, revokedAt: new Date().toISOString(), grant: { taskId: 'T1', id: 'G1', review: 'human' } as never },
      { generation: 0, revokedAt: null, grant: { taskId: 'T2', id: 'G2', review: 'human' } as never },
    ];
    const resolution = await registry().resolve({
      requestedAgentId: 'diomedes.builder',
      mode: 'build',
      routeId: 'codex',
      state,
      taskId: 'T1',
    });
    expect(resolution.policy.granted).toBe('review');
    expect(resolution.policy.grantId).toBeNull();
  });
  test('an unknown Agent is refused rather than silently substituted', async () => {
    await expect(
      registry().resolve({
        requestedAgentId: 'does.not.exist',
        mode: 'build',
        routeId: 'codex',
        state: project(temp),
        taskId: 'T1',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  test('an incompatible pairing is reported on the snapshot, not hidden', async () => {
    const folder = path.join(temp, 'shell-project');
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'runner.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.runner',
        version: '1.0.0',
        name: 'Build Runner',
        summary: 'Runs the build command and reports what failed.',
        modes: ['build'],
        role: 'Run the build and report the first failure.',
        requires: ['shell-commands'],
        tools: [],
        ruleScopes: ['project'],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['findings.list'] },
        evidence: ['findings.list'],
      }),
    );
    const resolution = await registry().resolve({
      requestedAgentId: 'acme.runner',
      mode: 'build',
      routeId: 'codex',
      state: project(folder),
      taskId: 'T1',
    });
    expect(resolution.compatible).toBe(false);
    expect(resolution.unmet[0].requirement).toBe('shell-commands');
    // The snapshot still records what was asked for and what policy said.
    expect(resolution.agentId).toBe('acme.runner');
    expect(resolution.policy.grantsAuthority).toBe(false);
  });
});

describe('saved resolutions are history, not authority', () => {
  const snapshot = (patch: Record<string, unknown> = {}) => ({
    protocolVersion: 1,
    agentId: 'diomedes.builder',
    agentVersion: '1.0.0',
    agentName: 'Change Builder',
    agentOrigin: 'built-in',
    agentDigest: `sha256:${'a'.repeat(64)}`,
    agentSelection: 'manual',
    requestedAgentId: 'diomedes.builder',
    mode: 'build',
    routeId: 'codex',
    requestedModel: null,
    modelSelection: 'runtime-default',
    compatible: true,
    unmet: [],
    policy: {
      agentCeiling: 'auto-review',
      granted: 'project',
      effective: 'project',
      grantId: 'G1',
      grantsAuthority: false,
    },
    resolvedAt: new Date().toISOString(),
    ...patch,
  });
  const withSession = (agent: unknown): ProjectState =>
    ({ ...project(temp), sessions: [{ id: 'S1', agent }] }) as unknown as ProjectState;

  test('a coherent snapshot loads', () => {
    expect(() => validateAgentResolutions(withSession(snapshot()))).not.toThrow();
    expect(() => validateAgentResolutions(withSession(undefined))).not.toThrow();
  });
  test('a snapshot claiming to have granted authority fails closed', () => {
    expect(() =>
      validateAgentResolutions(
        withSession(snapshot({ policy: { ...snapshot().policy, grantsAuthority: true } })),
      ),
    ).toThrow(/inconsistent|incompatible/);
  });
  test('an effective permission wider than the narrower of its two inputs fails closed', () => {
    expect(() =>
      validateAgentResolutions(
        withSession(
          snapshot({
            policy: {
              agentCeiling: 'review',
              granted: 'project',
              effective: 'project',
              grantId: 'G1',
              grantsAuthority: false,
            },
          }),
        ),
      ),
    ).toThrow(/inconsistent|incompatible/);
    expect(() =>
      validateAgentResolutions(
        withSession(
          snapshot({
            policy: {
              agentCeiling: 'auto-review',
              granted: 'review',
              effective: 'full',
              grantId: null,
              grantsAuthority: false,
            },
          }),
        ),
      ),
    ).toThrow(/inconsistent|incompatible/);
  });
  test('provenance must stay coherent: automatic cannot name a specific Agent', () => {
    expect(() =>
      validateAgentResolutions(
        withSession(snapshot({ agentSelection: 'automatic', requestedAgentId: 'diomedes.reviewer' })),
      ),
    ).toThrow(/inconsistent|incompatible/);
    // Auto is allowed to be the recorded request.
    expect(() =>
      validateAgentResolutions(
        withSession(snapshot({ agentSelection: 'automatic', requestedAgentId: AUTO_AGENT })),
      ),
    ).not.toThrow();
    // A manual selection must name the Agent it resolved to.
    expect(() =>
      validateAgentResolutions(
        withSession(snapshot({ agentSelection: 'manual', requestedAgentId: 'diomedes.reviewer' })),
      ),
    ).toThrow(/inconsistent|incompatible/);
  });
  test('an unknown field in a saved snapshot fails closed', () => {
    expect(() =>
      validateAgentResolutions(withSession(snapshot({ extraAuthority: 'full' }))),
    ).toThrow(/inconsistent|incompatible/);
  });
});
