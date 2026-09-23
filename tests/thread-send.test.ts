import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defaults } from '../server/store';
import {
  directAskBody,
  planThreadSend,
  readThreadRoute,
  stopThreadMessage,
  type ThreadRouteView,
} from '../client/console/thread-send';
import { ThreadView } from '../client/console/ThreadView';
import type { Conversation } from '../shared/types';

// Which path a project-thread message takes. The host's answer decides it; see
// tests/thread-conversation-model-api.test.ts for the same module against the real host.

const on = (route: string, refusal: string | null = null): ThreadRouteView => ({ route, refusal });

describe('planThreadSend', () => {
  test('Ask, Plan and Automatic on a model-API route go through the conversation', () => {
    for (const route of ['aws-bedrock', 'azure-openai', 'openrouter'] as const)
      for (const mode of ['ask', 'plan', 'auto'] as const)
        expect(planThreadSend(on(route), mode)).toEqual({ kind: 'conversation', route, mode });
  });
  test('Build and Fix on a model-API route keep the direct request path', () => {
    for (const mode of ['build', 'fix'] as const)
      expect(planThreadSend(on('aws-bedrock'), mode)).toEqual({ kind: 'direct', route: 'aws-bedrock' });
  });
  test('Claude Code, Codex, the external engines and the sample keep the direct path for every mode', () => {
    for (const route of ['claude-code', 'codex', 'opencode', 'cursor', 'devin', 'sample'] as const)
      for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
        expect(planThreadSend(on(route), mode)).toEqual({ kind: 'direct', route });
  });
  test("the host's refusal wins, in its own words, for every mode", () => {
    const reason = 'Efficient runs on AWS Bedrock, which is not connected and turned on.';
    for (const mode of ['ask', 'plan', 'build', 'fix'] as const)
      expect(planThreadSend(on('aws-bedrock', reason), mode)).toEqual({ kind: 'refuse', reason });
  });
  test('a playbook is refused on a model-API conversation rather than dropped', () => {
    const planned = planThreadSend(on('openrouter'), 'ask', 'weekly-brief');
    expect(planned).toMatchObject({ kind: 'refuse' });
    if (planned.kind === 'refuse') expect(planned.reason).toMatch(/^Playbooks do not run in OpenRouter/);
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
        text: 'Fix it',
        route: 'aws-bedrock',
        failing: { document: 'a.md' },
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
      failing: { document: 'a.md' },
      skill: 's',
    });
    // `failing` is Fix's alone.
    expect(directAskBody({ thread, mode: 'build', text: 'B', route: 'codex', failing: { text: 'x' } })).not.toHaveProperty(
      'failing',
    );
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
        mode: 'ask',
        route: 'aws-bedrock',
        busy: false,
        online: true,
        onMode: noAction,
        onPermission: noAction,
        onRename: noAction,
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
