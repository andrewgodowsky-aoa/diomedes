import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defaults } from '../server/store';
import {
  directAskBody,
  pickForMessage,
  planThreadSend,
  readThreadRoute,
  stopThreadMessage,
  type ThreadRouteView,
} from '../client/console/thread-send';
import { ThreadView } from '../client/console/ThreadView';
import { choiceView } from '../client/console/agent-ui';
import type { Conversation } from '../shared/types';

// Which path a project-thread message takes. The host's answer decides it; see
// tests/thread-conversation-model-api.test.ts for the same module against the real host.

const on = (route: string, refusal: string | null = null): ThreadRouteView => ({ route, refusal });

describe('planThreadSend', () => {
  test('Ask, Plan and Automatic on a model-API route or a kept-session engine go through the conversation', () => {
    for (const route of ['aws-bedrock', 'azure-openai', 'openrouter', 'codex', 'opencode', 'cursor', 'devin'] as const)
      for (const mode of ['ask', 'plan', 'auto'] as const)
        expect(planThreadSend(on(route), mode)).toEqual({ kind: 'conversation', route, mode });
  });
  test('Build and Fix keep the direct request path on a model-API route and on a kept-session engine', () => {
    for (const route of ['aws-bedrock', 'codex', 'opencode', 'cursor', 'devin'] as const)
      for (const mode of ['build', 'fix'] as const)
        expect(planThreadSend(on(route), mode)).toEqual({ kind: 'direct', route });
  });
  test('Claude Code project threads (O38), oh-my-pi and the sample keep the direct path for every mode', () => {
    for (const route of ['claude-code', 'oh-my-pi', 'sample'] as const)
      for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
        expect(planThreadSend(on(route), mode)).toEqual({ kind: 'direct', route });
  });
  test("the host's refusal wins, in its own words, for every mode", () => {
    const reason =
      'AWS Bedrock is unavailable right now. Please contact support and check that your account is connected and has credits remaining.';
    for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
      expect(planThreadSend(on('aws-bedrock', reason), mode)).toEqual({ kind: 'refuse', reason });
  });
  test('a playbook is refused on a model-API conversation rather than dropped', () => {
    const planned = planThreadSend(on('openrouter'), 'ask', 'weekly-brief');
    expect(planned).toMatchObject({ kind: 'refuse' });
    if (planned.kind === 'refuse') expect(planned.reason).toMatch(/^Playbooks do not run in OpenRouter/);
    // A kept-session engine ran playbooks on the direct request path before its conversation
    // existed. The conversation takes no playbook yet, so that message keeps the direct path
    // rather than being refused.
    for (const route of ['codex', 'opencode', 'cursor', 'devin'] as const)
      expect(planThreadSend(on(route), 'plan', 'weekly-brief')).toEqual({ kind: 'direct', route });
    // Elsewhere the playbook rides the direct path as before.
    expect(planThreadSend(on('claude-code'), 'ask', 'weekly-brief')).toEqual({ kind: 'direct', route: 'claude-code' });
  });
  test('a route this build does not know is refused, never guessed at', () => {
    expect(planThreadSend(on('mistral-cloud'), 'build')).toMatchObject({ kind: 'refuse' });
  });
});

describe('directAskBody', () => {
  const thread = { id: 'T1', attachedTo: { kind: 'project' as const, ref: 'P1' } };
  test('is the body the thread composer always posted', () => {
    expect(directAskBody({ thread, mode: 'ask', text: 'Hi', route: 'codex' })).toEqual({
      mode: 'ask',
      text: 'Hi',
      route: 'codex',
      consent: true,
      threadId: 'T1',
      attachedTo: thread.attachedTo,
    });
    expect(
      directAskBody({
        thread,
        mode: 'fix',
        agent: 'diomedes.debugger',
        text: 'Fix it',
        route: 'aws-bedrock',
        sources: ['a.md'],
        skill: 's',
      }),
    ).toEqual({
      mode: 'fix',
      text: 'Fix it',
      route: 'aws-bedrock',
      consent: true,
      threadId: 'T1',
      attachedTo: thread.attachedTo,
      sources: ['a.md'],
      agent: 'diomedes.debugger',
      skill: 's',
    });
  });
  test("carries the Agent the pick named, and no Fix fields, which the message itself replaces (DIO-292)", () => {
    const body = directAskBody({ thread, mode: 'fix', agent: 'diomedes.debugger', text: 'The invoice total is wrong', route: 'codex' });
    expect(body).toMatchObject({ mode: 'fix', agent: 'diomedes.debugger' });
    expect(body).not.toHaveProperty('failing');
    expect(directAskBody({ thread, mode: 'build', text: 'B', route: 'codex' })).not.toHaveProperty('agent');
  });
});

describe('the host is asked, and Stop names the command', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("readThreadRoute reads the work-style resolution and keeps only the route and the refusal", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { route: 'aws-bedrock', style: 'efficient', refusal: null, resolution: {} }));
    expect(await readThreadRoute('P 1', 'T1')).toEqual({ route: 'aws-bedrock', refusal: null });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/P%201/threads/T1/work-style');
    fetchMock.mockResolvedValueOnce(reply(200, { style: null }));
    await expect(readThreadRoute('P1', 'T1')).rejects.toThrow(/Nothing was sent/);
  });
  test('readThreadRoute asks for the route of the kind of run a pick takes', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { route: 'claude-code', refusal: null }));
    expect(await readThreadRoute('P1', 'T1', undefined, 'build')).toEqual({ route: 'claude-code', refusal: null });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/P1/threads/T1/work-style?mode=build');
  });
  test("pickForMessage asks the host for one message's Agent and hands its answer back as it is", async () => {
    const picked = {
      agent: { id: 'diomedes.analyst', name: 'Analyst' },
      mode: 'ask',
      by: 'rule',
      route: 'aws-bedrock',
      refusal: null,
    };
    fetchMock.mockResolvedValueOnce(reply(200, picked));
    const input = { text: 'How did March go?', attachments: ['sales.csv'], conversationOnly: true };
    expect(await pickForMessage('P 1', 'T1', input)).toEqual(picked);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/P%201/threads/T1/agent-pick');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
  });

  const issued = { projectId: 'P1', threadId: 'T1', commandId: 'cmd-1' };
  test('an acknowledged interrupt leaves the request open, so it returns the stopped turn', async () => {
    for (const state of ['requested', 'settled']) {
      fetchMock.mockResolvedValueOnce(reply(200, { commandId: 'cmd-1', runId: 'model-r', state }));
      const abandon = vi.fn();
      expect(await stopThreadMessage(issued, abandon)).toBe('interrupted');
      expect(abandon).not.toHaveBeenCalled();
    }
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/P1/threads/T1/messages/cmd-1/interrupt');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });
  test('an interrupt the host cannot confirm, or nothing issued yet, abandons the request', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { commandId: 'cmd-1', runId: null, state: 'idle' }));
    const first = vi.fn();
    expect(await stopThreadMessage(issued, first)).toBe('abandoned');
    expect(first).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(reply(404, { error: { message: 'This message was not found.' } }));
    const second = vi.fn();
    expect(await stopThreadMessage(issued, second)).toBe('abandoned');
    expect(second).toHaveBeenCalledOnce();
    const third = vi.fn();
    expect(await stopThreadMessage(null, third)).toBe('abandoned');
    expect(third).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ThreadView', () => {
  const noAction = () => {};
  const thread: Conversation = {
    id: 'T1',
    attachedTo: { kind: 'project', ref: 'P1' },
    name: 'Linen',
    mode: 'ask',
    turns: [],
  };
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ThreadView, {
        thread,
        title: 'Linen',
        task: null,
        sessions: [],
        mail: [],
        members: [],
        member: null,
        needs: [],
        settings: defaults(),
        choice: choiceView(thread),
        route: 'aws-bedrock',
        busy: false,
        online: true,
        onPermission: noAction,
        onRename: noAction,
        pick: () => Promise.reject(new Error('Nothing is sent in a render.')),
        prepareSources: async () => [],
        onSend: noAction,
        onResolve: noAction,
        onPreview: noAction,
        onStopSession: noAction,
        onOpenBoard: noAction,
        ...extra,
      }),
    );
  test('offers an unconfirmed conversation message back, to send again or discard', () => {
    const html = render({ unconfirmed: { text: 'How many napkins?', onResend: noAction, onDiscard: noAction } });
    expect(html).toContain('could not confirm your last message');
    expect(html).toContain('How many napkins?');
    expect(html).toContain('Send again');
    expect(html).toContain('Discard');
  });
  test('says nothing about it while a reply is streaming, or when there is none', () => {
    expect(render({})).not.toContain('Send again');
    expect(
      render({
        unconfirmed: { text: 'How many napkins?', onResend: noAction, onDiscard: noAction },
        streaming: { requestId: 'R1', text: 'Six', engine: 'aws-bedrock' },
      }),
    ).not.toContain('Send again');
  });
});
