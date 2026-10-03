/** Console selection is a start command, never admission, permissions or a spending grant. */
import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  loopStartCommand, retainLoopStartCommand, LOOP_START_CHANGED_CHOICES,
} from '../client/console/loop-start-model';
import { TeamView } from '../client/console/TeamView';
import type { ProjectState, TeamMember, TeamRun } from '../shared/types';
import type { AgentReviewSelection } from '../shared/agent-review';

const base = () => ({
  commandId: 'console-owned-inventory',
  taskId: 'inventory-task',
  goal: ' Reconcile inventory.txt and propose Harness report.md. ',
  route: 'aws-bedrock',
  sources: ['inventory.txt'],
  consent: true,
  maxTurns: 12,
});

const selections = () => ({
  persistentTeam: { leadSlotId: 'inventory-lead', memberSlotId: 'inventory-member' },
  team: { scope: ['inventory.txt'], worker: { profileId: 'inventory-helper-sol' }, advisor: null },
  review: { profileId: 'agent.inventory-reconciliation' as const, connectionId: 'inventory-review-openrouter' },
});

describe('Agent collaboration Console start command', () => {
  test('forwards persistent Team slots, a distinct H14 helper and the exact Jev review selection', () => {
    const selected = selections();
    const command = loopStartCommand({ ...base(), ...selected });
    expect(command).toEqual({
      protocolVersion: 1,
      commandId: 'console-owned-inventory',
      taskId: 'inventory-task',
      goal: 'Reconcile inventory.txt and propose Harness report.md.',
      route: 'aws-bedrock',
      sources: ['inventory.txt'],
      consent: true,
      maxTurns: 12,
      composition: true,
      ...selected,
    });
  });

  test('keeps the same command and selections when a start is clicked again or retried after a lost response', () => {
    const input = { ...base(), ...selections() };
    const first = loopStartCommand(input);
    const retried = loopStartCommand(input);
    expect(retried).toEqual(first);
    expect(first.commandId).toBe('console-owned-inventory');
  });

  test('detaches all selected IDs and read scopes from mutable dialog state', () => {
    const input = { ...base(), ...selections() };
    const command = loopStartCommand(input);
    input.sources.push('unselected.txt');
    input.persistentTeam.memberSlotId = 'unrelated-member';
    input.team.scope.push('unselected.txt');
    input.team.worker.profileId = 'unrelated-helper';
    input.review.connectionId = 'unrelated-payer';
    expect(command).toMatchObject({ sources: ['inventory.txt'], ...selections() });
  });

  test('forwards only selection identifiers while the host derives authority, routes, accounts and caps', () => {
    const selected = selections();
    const input = {
      ...base(),
      persistentTeam: { ...selected.persistentTeam, rootRunId: 'forged-root', permissions: ['write-any-file'] },
      team: {
        ...selected.team,
        worker: { ...selected.team.worker, capabilities: ['write-project-file'], maxModelCalls: 100 },
        limits: { workersPerRun: 100 },
      },
      review: { ...selected.review, grantId: 'forged-grant', maxCalls: 100, accountRoute: 'unadmitted-payer' },
      maxDollars: 100,
      permissions: ['evaluate-anything'],
    };
    expect(loopStartCommand(input)).toEqual({
      protocolVersion: 1,
      commandId: input.commandId,
      taskId: input.taskId,
      goal: input.goal.trim(),
      route: input.route,
      sources: ['inventory.txt'],
      consent: true,
      maxTurns: 12,
      composition: true,
      ...selected,
    });
  });

  test('leaves cleared optional choices out of an ordinary loop start', () => {
    const command = loopStartCommand({ ...base(), persistentTeam: null, team: null, review: null });
    expect(Object.keys(command).sort()).toEqual([
      'commandId', 'consent', 'goal', 'maxTurns', 'protocolVersion', 'route', 'sources', 'taskId',
    ]);
  });

  test.each([
    ['Team', { persistentTeam: selections().persistentTeam }],
    ['helper', { team: selections().team }],
    ['review', { review: selections().review }],
  ] as const)('marks standalone %s selection as bounded composition', (_label, selected) => {
    expect(loopStartCommand({ ...base(), ...selected })).toMatchObject({ composition: true });
  });

  test('a lost-response retry returns the original command object and exact serialized bytes', () => {
    const input = { ...base(), ...selections() };
    const first = loopStartCommand(input);
    const sent = retainLoopStartCommand(null, first);
    const retried = retainLoopStartCommand(sent, loopStartCommand(input));
    expect(retried).toBe(sent);
    expect(JSON.stringify(retried)).toBe(JSON.stringify(first));
  });

  const changedChoices: [string, Partial<Parameters<typeof loopStartCommand>[0]>][] = [
    ['goal', { goal: 'A different outcome' }],
    ['lead route', { route: 'google-vertex' }],
    ['selected files', { sources: ['inventory.txt', 'unselected.txt'] }],
    ['consent', { consent: false }],
    ['turn ceiling', { maxTurns: 6 }],
    ['persistent Team member', { persistentTeam: { leadSlotId: 'inventory-lead', memberSlotId: 'different-member' } }],
    ['helper scope', { team: { scope: ['unselected.txt'], worker: { profileId: 'inventory-helper-sol' }, advisor: null } }],
    ['helper profile', { team: { scope: ['inventory.txt'], worker: { profileId: 'different-helper' }, advisor: null } }],
    ['review connection', { review: { profileId: 'agent.inventory-reconciliation' as const, connectionId: 'different-review-payer' } }],
  ];
  test.each(changedChoices)('refuses a changed %s under an already submitted command', (_label, change) => {
    const input = { ...base(), ...selections() };
    const sent = loopStartCommand(input);
    expect(() => retainLoopStartCommand(sent, loopStartCommand({ ...input, ...change })))
      .toThrow(LOOP_START_CHANGED_CHOICES);
  });

  test('cannot replace the fixed inventory review with an arbitrary profile', () => {
    const review = { profileId: 'forged-review-profile', connectionId: 'inventory-review-openrouter' } as unknown as AgentReviewSelection;
    expect(() => loopStartCommand({ ...base(), review })).toThrow('Only the inventory reconciliation review');
  });
});

describe('Team ended-run projection', () => {
  test.each([
    ['completed', false, 'finished'],
    ['failed', false, 'failed'],
    ['cancelled', false, 'stopped'],
    ['completed', true, 'outcome unknown'],
    ['cancelled', true, 'outcome unknown'],
    ['running', false, 'outcome unknown'],
  ] as const)('%s with unknown=%s projects %s without asserting verification', (status, unknownOutcome, label) => {
    const at = '2026-10-01T05:00:00.000Z';
    const state: ProjectState = {
      project: {
        id: 'inventory-project', name: 'Inventory', folder: '/owned-scripted-inventory',
        createdAt: at, lastOpenedAt: at, plans: [], references: [], repository: { present: false },
        counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
        status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
      },
      documents: [], tasks: [], needs: [], sessions: [], history: [], changes: [], conversations: [],
    };
    const member: TeamMember = {
      slotId: 'inventory-member', name: 'Inventory member', role: 'member',
      engine: 'google-vertex', model: 'requested-model-only', status: 'idle', threadId: null,
      createdAt: at, lastSeenAt: null,
    };
    const run: TeamRun & { unknownOutcome: boolean } = {
      id: 'terminal-team-run', slotId: member.slotId, sessionId: null, status,
      startedAt: at, endedAt: '2026-10-01T05:01:00.000Z', summary: null, unknownOutcome,
    };
    const html = renderToStaticMarkup(createElement(TeamView, {
      project: state.project, state, members: [member], runs: [run], mail: [], usage: [], busy: false,
      onMessage: async () => {}, onStop: async () => {}, onWake: async () => {}, onOpenThread: () => {},
    }));
    const endRow = html.match(/<li[^>]*data-team-run="terminal-team-run"[^>]*>.*?<\/li>/s)?.[0];
    expect(endRow).toContain(`>${label}</span>`);
    if (label !== 'finished') expect(endRow).not.toContain('>finished</span>');
    expect(html).not.toContain('Verified');
    expect(html).toContain('model not recorded');
    expect(html).not.toContain('requested-model-only');
  });
});
