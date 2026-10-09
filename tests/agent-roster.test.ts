import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_CATALOG,
  AUTO_AGENT,
  AUTO_SUMMARY,
  DEFAULT_AGENT,
  listedAgents,
  runKindOf,
} from '../shared/agents.js';
import { AgentRegistry } from '../server/agents.js';
import { nectoviaAgentGap } from '../client/console/agent-gaps.js';
import { NECTOVIA_ROUTE } from '../shared/model-api.js';
import type { ProjectState } from '../shared/types.js';

/**
 * DIO-292: the Agents that replace the Ask, Plan, Build and Fix modes. Each one carries the kind
 * of run its mode did, its own read tools and its own limits; Auto picks one per message.
 */
const byId = (id: string) => AGENT_CATALOG.find((item) => item.id === id)!;
const FILES = ['list_files', 'read_file', 'search_files'];
let temp = '';
const project = (folder: string) =>
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
  temp = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'roster-'));
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe('the roster that replaces the modes', () => {
  test('eight agents in the menu, in order; the general worker stays for loops only', () => {
    expect(listedAgents(AGENT_CATALOG).map((item) => item.name)).toEqual([
      'Researcher',
      'Planner',
      'Builder',
      'Fixer',
      'Reviewer',
      'Explorer',
      'Analyst',
      'Writer',
    ]);
    expect(byId('diomedes.general').internal).toBe(true);
    expect(byId('diomedes.general').modes).toEqual(['ask', 'plan', 'build', 'fix']);
  });
  test('each listed agent does exactly one kind of run', () => {
    for (const item of listedAgents(AGENT_CATALOG)) expect(item.modes).toHaveLength(1);
    expect(runKindOf(byId('diomedes.researcher'))).toBe('ask');
    expect(runKindOf(byId('diomedes.architect'))).toBe('plan');
    expect(runKindOf(byId('diomedes.builder'))).toBe('build');
    expect(runKindOf(byId('diomedes.debugger'))).toBe('fix');
    expect(runKindOf(byId('diomedes.writer'))).toBe('build');
    for (const id of ['diomedes.reviewer', 'diomedes.explorer', 'diomedes.analyst'])
      expect(runKindOf(byId(id))).toBe('ask');
  });
  test('each kind has a default agent, and Auto is not an agent', () => {
    expect(DEFAULT_AGENT).toEqual({
      ask: 'diomedes.researcher',
      plan: 'diomedes.architect',
      build: 'diomedes.builder',
      fix: 'diomedes.debugger',
    });
    expect(AGENT_CATALOG.some((item) => item.id === AUTO_AGENT)).toBe(false);
    expect(AUTO_SUMMARY).toBe('Picks the right agent for each message.');
  });
  test('read tools differ by agent, and the agents that change files list none', () => {
    expect(byId('diomedes.researcher').tools).toEqual([...FILES, 'fetch_page', 'connector_read']);
    expect(byId('diomedes.architect').tools).toEqual([...FILES, 'fetch_page', 'connector_read']);
    expect(byId('diomedes.reviewer').tools).toEqual(FILES);
    expect(byId('diomedes.explorer').tools).toEqual(FILES);
    expect(byId('diomedes.analyst').tools).toEqual([...FILES, 'connector_read']);
    for (const id of ['diomedes.builder', 'diomedes.debugger', 'diomedes.writer'])
      expect(byId(id).tools).toEqual([]);
  });
  test('the agents that read are capped at review; the ones that change files only propose', () => {
    for (const id of [
      'diomedes.researcher',
      'diomedes.architect',
      'diomedes.reviewer',
      'diomedes.explorer',
      'diomedes.analyst',
    ])
      expect(byId(id).permissionCeiling).toBe('review');
    for (const id of ['diomedes.builder', 'diomedes.debugger', 'diomedes.writer'])
      expect(byId(id).requires).toEqual(['text-proposals', 'no-secret-access']);
  });
  test('menu lines are short and keep the app voice', () => {
    for (const item of listedAgents(AGENT_CATALOG)) {
      expect(item.summary.length).toBeLessThanOrEqual(80);
      expect(item.summary).not.toMatch(/[–—!]/);
    }
  });
  test('on Nectovia an agent that changes files is grayed by its own name', () => {
    expect(nectoviaAgentGap(byId('diomedes.builder'), NECTOVIA_ROUTE)).toBe("Builder isn't on Nectovia yet.");
    expect(nectoviaAgentGap(byId('diomedes.debugger'), NECTOVIA_ROUTE)).toBe("Fixer isn't on Nectovia yet.");
    expect(nectoviaAgentGap(byId('diomedes.writer'), NECTOVIA_ROUTE)).toBe("Writer isn't on Nectovia yet.");
    expect(nectoviaAgentGap(byId('diomedes.researcher'), NECTOVIA_ROUTE)).toBeNull();
    expect(nectoviaAgentGap(byId('diomedes.builder'), 'codex')).toBeNull();
  });
});

describe('Auto picks, a person chooses', () => {
  test("Auto's pick is recorded as automatic, under the Auto choice", async () => {
    const resolved = await new AgentRegistry(temp).resolve({
      requestedAgentId: AUTO_AGENT,
      picked: 'diomedes.writer',
      mode: 'build',
      routeId: 'codex',
      state: project(temp),
      taskId: 'T1',
    });
    expect(resolved).toMatchObject({
      agentId: 'diomedes.writer',
      agentName: 'Writer',
      agentSelection: 'automatic',
      requestedAgentId: AUTO_AGENT,
      mode: 'build',
    });
    expect(resolved.policy.grantsAuthority).toBe(false);
  });
  test('no pick falls back to the kind default, as Auto by mode did', async () => {
    const resolved = await new AgentRegistry(temp).resolve({
      requestedAgentId: AUTO_AGENT,
      mode: 'fix',
      routeId: 'codex',
      state: project(temp),
      taskId: 'T1',
    });
    expect(resolved.agentId).toBe('diomedes.debugger');
  });
  test('an agent never runs as a kind it does not do', async () => {
    await expect(
      new AgentRegistry(temp).resolve({
        requestedAgentId: 'diomedes.reviewer',
        mode: 'build',
        routeId: 'codex',
        state: project(temp),
        taskId: 'T1',
      }),
    ).rejects.toThrow("Reviewer doesn't do this kind of work.");
    await expect(
      new AgentRegistry(temp).resolve({
        requestedAgentId: AUTO_AGENT,
        picked: 'diomedes.writer',
        mode: 'fix',
        routeId: 'codex',
        state: project(temp),
        taskId: 'T1',
      }),
    ).rejects.toThrow("Writer doesn't do this kind of work.");
  });
  test('an added agent that lists two kinds still loads and runs as its first', async () => {
    const folder = path.join(temp, 'project');
    await fs.mkdir(path.join(folder, '.diomedes', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.diomedes', 'agents', 'menu.json'),
      JSON.stringify({
        protocolVersion: 1,
        id: 'acme.menu',
        version: '1.0.0',
        name: 'Menu Checker',
        summary: 'Checks the menu text.',
        modes: ['ask', 'plan'],
        role: 'Check the menu text.',
        requires: ['no-secret-access'],
        tools: [],
        ruleScopes: ['project'],
        permissionCeiling: 'review',
        models: [],
        handoff: { accepts: [], produces: ['answer.text'] },
        evidence: ['answer.text'],
      }),
    );
    const found = await new AgentRegistry(temp).find('acme.menu', folder);
    expect(found && runKindOf(found)).toBe('ask');
  });
});
