import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalStatus, Notice, OriginLine, SessionStatus } from '../client/components';
import { Ledger } from '../client/console/Ledger';
import { TeamView } from '../client/console/TeamView';
import { directOrigin } from '../shared/attribution.js';
import type {
  HistoryEntry,
  MailboxMessage,
  Need,
  Project,
  ProjectState,
  Session,
  Task,
  TeamMember,
} from '../shared/types.js';

const at = '2026-09-10T12:00:00.000Z';
const noAction = () => {};
const noAsync = async () => {};

function baseNeed(over: Partial<Need> = {}): Need {
  return {
    id: 'need-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    what: 'update two files',
    why: 'To fix the bug.',
    consequence: 'Files change.',
    files: [],
    state: 'open',
    createdAt: at,
    decidedAt: null,
    decidedFrom: '',
    allowForTask: false,
    ...over,
  };
}

function baseSession(over: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    state: 'working',
    startedAt: at,
    endedAt: null,
    sample: false,
    log: [],
    entryIds: [],
    needId: null,
    engine: {
      name: 'Codex',
      model: 's-model',
      worker: 1,
      branch: null,
      context: null,
      events: 3,
      version: '1.0',
      verified: true,
    },
    ...over,
  };
}

function baseProject(): Project {
  return {
    id: 'project-1',
    name: 'Harbor',
    folder: '/tmp/harbor',
    createdAt: at,
    lastOpenedAt: at,
    plans: [],
    references: [],
    repository: { present: false },
    leftOff: null,
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
  };
}

function baseTask(): Task {
  return {
    id: 'task-1',
    name: 'Fix the list',
    description: '',
    from: null,
    owner: 'diomedes',
    state: 'working',
    reason: null,
    needId: null,
    sessionIds: [],
    changeIds: [],
    createdBy: 'diomedes',
    createdAt: at,
    moves: [],
  };
}

describe('shared attribution presentation', () => {
  it('shows the runtime-reported model primary with the engine secondary', () => {
    const html = renderToStaticMarkup(
      createElement(OriginLine, {
        origin: directOrigin({ engine: 'codex', reportedModel: 's-model' }),
      }),
    );
    expect(html).toContain('<b>s-model</b>');
    expect(html).toContain('via Codex');
  });

  it('renders externally supplied model names as text', () => {
    const html = renderToStaticMarkup(
      createElement(OriginLine, {
        origin: directOrigin({ engine: 'codex', reportedModel: '<img src=x onerror=alert(1)>' }),
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('attributes a need to its recorded origin and identifies missing legacy metadata honestly', () => {
    const owned = renderToStaticMarkup(
      createElement(Notice, {
        need: baseNeed({
          origin: directOrigin({ engine: 'opencode', reportedModel: 'muse-reported' }),
        }),
        decide: noAction,
        show: noAction,
      }),
    );
    expect(owned).toContain('muse-reported');
    expect(owned).toContain('wants to');
    const legacy = renderToStaticMarkup(
      createElement(Notice, { need: baseNeed(), decide: noAction, show: noAction }),
    );
    expect(legacy).toContain('<b>Assistant</b>');
    expect(legacy).toContain('model not recorded');
    expect(legacy).toContain('wants to');
  });

  it.each(['pending', 'applied', 'conflicted', 'not-applied'] as const)(
    'shows the actual %s scope outcome without claiming exact human review',
    (state) => {
      const html = renderToStaticMarkup(
        createElement(ApprovalStatus, {
          need: baseNeed({
            approval: {
              protocolVersion: 1,
              proposalDigest: 'p',
              actionDigest: 'a',
              baseDigest: 'b',
              expiresAt: at,
              sources: [],
            },
            authorization: {
              protocolVersion: 2,
              kind: 'scope-grant',
              id: 'auth-1',
              grantId: 'grant-1',
              grantDigest: 'g',
              grantGeneration: 1,
              projectId: 'project-1',
              taskId: 'task-1',
              sessionId: 'session-1',
              approvalId: 'need-1',
              proposalDigest: 'p',
              actionDigest: 'a',
              baseDigest: 'b',
              engine: 'codex',
              accountRoute: 'codex:chatgpt',
              writes: 1,
              bytes: 10,
              authorizedAt: at,
              eventId: 'event-1',
            },
            execution: {
              state,
              eventId: 'event-1',
              completedAt: state === 'pending' ? null : at,
              reason: null,
              conflicts: [],
            },
          }),
        }),
      );
      expect(html).toContain('Matched the task scope');
      expect(html).toContain('grant-1');
      expect(html).not.toContain('reviewed');
      expect(html).toContain(`approval-status is-${state}`);
      expect(html).toContain('Source versions');
      expect(html).not.toContain('<dt>Expires</dt>');
      if (state === 'applied') expect(html).toContain('Scope-matched changes applied');
      if (state === 'not-applied') expect(html).toContain('No scoped write was confirmed');
    },
  );

  it('preserves exact v1 receipt labels and hashes without inventing scope authority', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalStatus, {
        need: baseNeed({
          approval: {
            protocolVersion: 1,
            proposalDigest: 'proposal-hash',
            actionDigest: 'action-hash',
            baseDigest: 'base-hash',
            expiresAt: at,
            sources: [],
          },
          approvalReceipt: {
            protocolVersion: 1,
            commandId: 'command-1',
            payloadDigest: 'payload-hash',
            projectId: 'project-1',
            approvalId: 'need-1',
            taskId: 'task-1',
            sessionId: 'session-1',
            actor: 'local-client',
            scope: 'local-prototype',
            proposalDigest: 'proposal-hash',
            actionDigest: 'action-hash',
            baseDigest: 'base-hash',
            createdAt: at,
            expiresAt: at,
            decision: 'go-ahead',
            decidedAt: at,
            eventId: 'event-1',
          },
          execution: {
            state: 'applied',
            eventId: 'event-2',
            completedAt: at,
            reason: null,
            conflicts: [],
          },
        }),
      }),
    );
    for (const hash of ['command-1', 'proposal-hash', 'action-hash', 'base-hash'])
      expect(html).toContain(hash);
    expect(html).toContain('local-client');
    expect(html).not.toContain('scope grant');
  });

  it('shows the session origin instead of picker prose', () => {
    const html = renderToStaticMarkup(
      createElement(SessionStatus, { session: baseSession(), detail: 'standard' }),
    );
    expect(html).toContain('<b>s-model</b>');
    expect(html).not.toContain('new-picker-model');
  });

  it('keeps scripted example sessions on Diomedes application copy', () => {
    const html = renderToStaticMarkup(
      createElement(SessionStatus, {
        session: baseSession({ sample: true }),
        detail: 'standard',
      }),
    );
    expect(html).toContain('Diomedes');
    expect(html).toContain('Scripted example.');
  });

  it('ledger recent history carries the recorded actor', () => {
    const session = baseSession();
    const entry: HistoryEntry = {
      id: 'history-1',
      time: at,
      actor: 'diomedes',
      kind: 'write',
      sentence: 'Wrote notes.',
      sessionId: session.id,
      taskId: 'task-1',
      sample: false,
      files: [],
      label: null,
      restoreOf: null,
      replaced: null,
      versionId: 'version-1',
      commit: null,
    };
    const state: ProjectState = {
      project: baseProject(),
      documents: [],
      tasks: [baseTask()],
      needs: [],
      sessions: [session],
      history: [entry],
      changes: [],
      conversations: [],
    };
    const html = renderToStaticMarkup(
      createElement(Ledger, {
        project: state.project,
        state,
        task: state.tasks[0],
        taskWorker: 'Codex',
        mode: 'build',
        running: true,
        latest: session,
        openNeeds: [],
        onBoard: noAction,
        onTeam: noAction,
        onReviewNeed: noAction,
      }),
    );
    expect(html).toContain('Wrote notes.');
    expect(html).toContain('s-model');
  });

  it.each(['waiting', 'done'] as const)(
    'ledger uses recorded %s execution instead of a stale task mirror',
    (sessionState) => {
      const session = baseSession({ state: sessionState });
      const task = baseTask();
      const state: ProjectState = {
        project: baseProject(),
        documents: [],
        tasks: [task],
        needs: sessionState === 'waiting' ? [baseNeed()] : [],
        sessions: [session],
        history: [],
        changes: [],
        conversations: [],
      };
      const html = renderToStaticMarkup(
        createElement(Ledger, {
          project: state.project,
          state,
          task,
          taskWorker: 'new-picker-model',
          mode: 'build',
          running: true,
          latest: session,
          openNeeds: state.needs,
          onBoard: noAction,
          onTeam: noAction,
          onReviewNeed: noAction,
        }),
      );
      expect(html).toContain('s-model');
      expect(html).not.toContain('new-picker-model');
      expect(html).not.toContain('>running</span>');
      expect(html).toContain(sessionState === 'waiting' ? 'Needs your decision' : 'Run finished');
      if (sessionState === 'waiting') {
        const work = html.split('id="secWork"')[1].split('</section>')[0];
        expect(work).toContain('s-model');
        expect(work).not.toContain('Diomedes');
        expect(html).toContain('>waiting</span>');
      } else expect(html).toContain('0 open');
    },
  );

  it('team lanes name the owner as the user and never invent a model', () => {
    const member: TeamMember = {
      slotId: 'a',
      name: 'Ann',
      role: 'lead',
      engine: 'codex',
      model: null,
      status: 'idle',
      threadId: null,
      createdAt: at,
      lastSeenAt: null,
    };
    const mail: MailboxMessage[] = [
      {
        id: 'mail-1',
        to: 'a',
        from: 'owner',
        type: 'message',
        content: 'hello team',
        read: false,
        createdAt: at,
        threadId: null,
        runId: null,
        approvalId: null,
      },
    ];
    const state: ProjectState = {
      project: baseProject(),
      documents: [],
      tasks: [],
      needs: [],
      sessions: [],
      history: [],
      changes: [],
      conversations: [],
    };
    const html = renderToStaticMarkup(
      createElement(TeamView, {
        project: state.project,
        state,
        members: [member],
        mail,
        runs: [],
        usage: [],
        busy: false,
        onMessage: noAsync,
        onStop: noAsync,
        onWake: noAsync,
        onOpenThread: noAction,
      }),
    );
    expect(html).toContain('from You');
    expect(html).not.toContain('from Diomedes');
    expect(html).toContain('model not recorded');
  });
});
