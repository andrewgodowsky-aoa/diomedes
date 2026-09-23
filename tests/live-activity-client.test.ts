import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { defaults } from '../server/store';
import {
  MAX_RUN_ACTIVITY,
  MAX_TOOL_LINES,
  acceptActivity,
  activityTarget,
  rememberRunActivity,
  toolRunning,
  toolSentence,
  type ActivityState,
} from '../client/console/engine-activity';
import { stepLiveReply, type LiveBinding, type LiveReply } from '../client/console/live-reply';
import { ToolActivityList } from '../client/console/ToolActivity';
import { ThreadView } from '../client/console/ThreadView';
import { Diomedes, type DiomedesPageProps } from '../client/console/Diomedes';
import type { Conversation, Session } from '../shared/types';

const identity = {
  projectId: 'P1',
  threadId: 'T1',
  requestId: 'R1',
  runId: 'run-1',
  stepId: 'text:dispatch',
  attempt: 1,
  fence: 1,
};
const tool = (
  seq: number,
  callId: string,
  phase: 'started' | 'finished' | 'failed',
  summary: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: 'tool-activity',
  ...identity,
  seq,
  callId,
  phase,
  tool: 'read_file',
  summary,
  ...extra,
});
const text = (kind: 'started' | 'delta' | 'ended', extra: Record<string, unknown> = {}) => ({
  projectId: identity.projectId,
  threadId: identity.threadId,
  requestId: identity.requestId,
  runId: identity.runId,
  kind,
  ...(kind === 'delta'
    ? { stepId: identity.stepId, attempt: 1, fence: 1, seq: 1, text: 'Hello ' }
    : {}),
  ...extra,
});
const apply = (frames: unknown[], start: ActivityState | null = null) =>
  frames.reduce<ActivityState | null>((state, frame) => acceptActivity(state, frame), start);

describe('acceptActivity', () => {
  test('pairs a start with its finish by callId and keeps the order calls began in', () => {
    const state = apply([
      tool(1, 'a', 'started', 'Reading menu.md'),
      tool(2, 'b', 'started', 'Searching the web for opening hours'),
      tool(3, 'a', 'finished', 'Read menu.md', { detail: '42 lines' }),
      tool(4, 'b', 'failed', 'Searching the web for opening hours'),
    ])!;
    expect(state.lines.map((l) => [l.callId, l.phase, l.summary, l.detail])).toEqual([
      ['a', 'finished', 'Read menu.md', '42 lines'],
      ['b', 'failed', 'Searching the web for opening hours', undefined],
    ]);
    expect(state.seq).toBe(4);
    expect(toolRunning(state.lines)).toBe(false);
  });

  test('drops duplicate, late, malformed and older-attempt frames without poisoning', () => {
    const first = apply([tool(1, 'a', 'started', 'Reading menu.md'), tool(2, 'a', 'finished', 'Read')])!;
    expect(acceptActivity(first, tool(2, 'a', 'finished', 'Read again'))).toBe(first);
    expect(acceptActivity(first, tool(1, 'a', 'started', 'Reading'))).toBe(first);
    expect(acceptActivity(first, { ...tool(3, 'c', 'started', 'x'), kind: 'text-delta' })).toBe(first);
    expect(acceptActivity(first, { ...tool(3, 'c', 'started', 'x'), secret: 'extra' })).toBe(first);
    expect(acceptActivity(first, { ...tool(3, 'c', 'started', 'x'), stepId: 'other' })).toBe(first);
    // A gap is tolerated: tool lines are narration, not the answer.
    const gapped = acceptActivity(first, tool(9, 'c', 'started', 'Listing files'))!;
    expect(gapped.lines.map((l) => l.callId)).toEqual(['a', 'c']);
  });

  test('a finished call never reverts to running when its start arrives late', () => {
    const done = apply([tool(1, 'a', 'finished', 'Read menu.md')])!;
    const after = acceptActivity(done, tool(2, 'a', 'started', 'Reading menu.md'))!;
    expect(after.lines[0].phase).toBe('finished');
  });

  test('a retried attempt replaces the lines of the attempt it superseded', () => {
    const first = apply([tool(1, 'a', 'started', 'Reading menu.md')])!;
    const retried = acceptActivity(first, { ...tool(1, 'z', 'started', 'Reading again'), attempt: 2 })!;
    expect(retried.lines.map((l) => l.callId)).toEqual(['z']);
    // And the old attempt cannot come back.
    expect(acceptActivity(retried, tool(2, 'a', 'finished', 'Read'))).toBe(retried);
  });

  test('keeps only the newest calls', () => {
    const frames = Array.from({ length: MAX_TOOL_LINES + 5 }, (_, i) =>
      tool(i + 1, `c${i}`, 'finished', `Step ${i}`),
    );
    const state = apply(frames)!;
    expect(state.lines).toHaveLength(MAX_TOOL_LINES);
    expect(state.lines.at(-1)!.callId).toBe(`c${MAX_TOOL_LINES + 4}`);
  });
});

describe('activity routing in a project view', () => {
  const ask = { requestId: 'R1', runId: 'run-1', threadId: 'T1' };
  test('the ask on screen owns only frames with its exact request, run and thread', () => {
    const frame = tool(1, 'a', 'started', 'Reading');
    expect(activityTarget(frame, { projectId: 'P1', ask })).toEqual({ kind: 'ask', requestId: 'R1' });
    expect(activityTarget({ ...frame, runId: 'other' }, { projectId: 'P1', ask }).kind).toBe('drop');
    expect(activityTarget({ ...frame, threadId: 'T2' }, { projectId: 'P1', ask }).kind).toBe('drop');
    expect(activityTarget(frame, { projectId: 'P2', ask }).kind).toBe('drop');
    expect(activityTarget({ ...frame, requestId: 'S-run' }, { projectId: 'P1', ask })).toEqual({
      kind: 'run',
      requestId: 'S-run',
    });
    expect(activityTarget(frame, { projectId: 'P1', ask: null }).kind).toBe('run');
    expect(activityTarget('nonsense', { projectId: 'P1', ask }).kind).toBe('drop');
  });
  test('work runs are remembered by request id, newest runs only', () => {
    let runs: Record<string, ActivityState> = {};
    for (let i = 0; i < MAX_RUN_ACTIVITY + 3; i += 1)
      runs = rememberRunActivity(runs, { ...tool(1, 'a', 'started', 'Reading'), requestId: `S${i}` });
    expect(Object.keys(runs)).toHaveLength(MAX_RUN_ACTIVITY);
    expect(runs[`S${MAX_RUN_ACTIVITY + 2}`].lines[0].summary).toBe('Reading');
    expect(runs.S0).toBeUndefined();
    const same = rememberRunActivity(runs, { ...tool(1, 'a', 'started', 'Reading'), requestId: 'S5' });
    expect(same).toBe(runs);
    const proto = rememberRunActivity({}, { ...tool(1, 'a', 'started', 'x'), requestId: '__proto__' });
    expect(Object.hasOwn(proto, '__proto__')).toBe(true);
  });
});

describe('the home live reply', () => {
  const binding: LiveBinding = { projectId: 'P1', threadId: 'T1', requestId: 'R1' };
  const run = (events: Parameters<typeof stepLiveReply>[2][], bound: LiveBinding | null = binding) =>
    events.reduce<LiveReply | null>((state, event) => stepLiveReply(state, bound, event), null);

  test('streams text and tool lines for the bound command and run', () => {
    const state = run([
      { type: 'engine-text', data: text('started') },
      { type: 'engine-activity', data: tool(1, 'a', 'started', 'Reading menu.md') },
      { type: 'engine-text', data: text('delta') },
      { type: 'engine-text', data: text('delta', { seq: 2, text: 'there.' }) },
      { type: 'engine-activity', data: tool(2, 'a', 'finished', 'Read menu.md') },
      { type: 'engine-text', data: text('ended') },
    ])!;
    expect(state.runId).toBe('run-1');
    expect(state.text).toBe('Hello there.');
    expect(state.activity!.lines.map((l) => l.phase)).toEqual(['finished']);
  });

  test('ignores frames for another command, thread, project or run', () => {
    const started = run([{ type: 'engine-text', data: text('started') }])!;
    for (const foreign of [
      { requestId: 'R2' },
      { threadId: 'T2' },
      { projectId: 'P2' },
      { runId: 'run-2' },
    ]) {
      expect(stepLiveReply(started, binding, { type: 'engine-text', data: text('delta', foreign) })).toBe(started);
      expect(
        stepLiveReply(started, binding, { type: 'engine-activity', data: tool(1, 'a', 'started', 'x', foreign) }),
      ).toBe(started);
    }
    // Nothing starts for a command the page is not waiting on.
    expect(run([{ type: 'engine-text', data: text('started', { requestId: 'R2' }) }])).toBe(null);
    // Activity before the started frame has no run to belong to.
    expect(run([{ type: 'engine-activity', data: tool(1, 'a', 'started', 'x') }])).toBe(null);
  });

  test('drops what was showing when the page moves to another thread or scope', () => {
    const streaming = run([
      { type: 'engine-text', data: text('started') },
      { type: 'engine-text', data: text('delta') },
    ])!;
    expect(streaming.text).toBe('Hello ');
    // Waiting on nothing: every late frame is dropped with the reply.
    expect(stepLiveReply(streaming, null, { type: 'engine-text', data: text('delta', { seq: 2 }) })).toBe(null);
    // Waiting on a new message in another thread: the old reply is not carried over.
    const other: LiveBinding = { projectId: 'P1', threadId: 'T9', requestId: 'R9' };
    expect(stepLiveReply(streaming, other, { type: 'engine-text', data: text('delta', { seq: 2 }) })).toBe(null);
  });

  test('a missed or out-of-order text frame loses the preview but not the tool lines', () => {
    const started = run([
      { type: 'engine-text', data: text('started') },
      { type: 'engine-activity', data: tool(1, 'a', 'started', 'Reading') },
      { type: 'engine-text', data: text('delta') },
    ])!;
    const gapped = stepLiveReply(started, binding, {
      type: 'engine-text',
      data: text('delta', { seq: 3, text: 'GAP' }),
    })!;
    expect(gapped.position).toBe('lost');
    expect(gapped.text).toBe('');
    const later = stepLiveReply(gapped, binding, { type: 'engine-text', data: text('delta', { seq: 4 }) })!;
    expect(later.text).toBe('');
    const tooled = stepLiveReply(later, binding, {
      type: 'engine-activity',
      data: tool(2, 'a', 'finished', 'Read'),
    })!;
    expect(tooled.activity!.lines[0].phase).toBe('finished');
    const lost = stepLiveReply(started, binding, { type: 'lost' })!;
    expect(lost.position).toBe('lost');
    expect(lost.text).toBe('');
  });
});

describe('rendered tool lines', () => {
  const lines = [
    { callId: 'a', tool: 'read_file', phase: 'finished' as const, summary: 'Read menu.md', detail: '{"path":"menu.md"}' },
    { callId: 'b', tool: 'web_search', phase: 'started' as const, summary: 'Searching the web for opening hours' },
  ];
  test('a person reads one plain sentence per call, with no technical detail', () => {
    const html = renderToStaticMarkup(createElement(ToolActivityList, { lines, technical: false }));
    expect(html).toContain('<ul aria-label="Tool calls">');
    expect(html).toContain('Read menu.md');
    expect(html).toContain('Searching the web for opening hours…');
    expect(html).not.toContain('read_file');
    expect(html).not.toContain('menu.md&quot;');
    expect(html).not.toContain('<details');
    // One polite status names only the call still running.
    expect(html).toMatch(/role="status"[^>]*>Searching the web for opening hours…</);
  });
  test('the Technical level names each tool and opens to its detail from a keyboard summary', () => {
    const html = renderToStaticMarkup(createElement(ToolActivityList, { lines, technical: true }));
    expect(html).toContain('<details><summary>');
    expect(html).toContain('read_file');
    expect(html).toContain('web_search');
    expect(html).toContain('{&quot;path&quot;:&quot;menu.md&quot;}');
    // A call with no detail stays a plain line: there is nothing to open.
    expect(html.match(/<details>/g)).toHaveLength(1);
  });
  test('the list is not itself a live region, and renders nothing with no calls', () => {
    const html = renderToStaticMarkup(createElement(ToolActivityList, { lines, technical: false }));
    expect(html).not.toMatch(/<ul[^>]*aria-live/);
    expect(renderToStaticMarkup(createElement(ToolActivityList, { lines: [], technical: true }))).toBe('');
  });
  test('sentences say whether a call is running, done or failed', () => {
    expect(toolSentence({ ...lines[1], summary: 'Reading menu.md…' })).toBe('Reading menu.md…');
    expect(toolSentence({ ...lines[0], phase: 'failed' })).toBe('Read menu.md (did not finish)');
  });
});

const noAction = () => {};
const thread: Conversation = {
  id: 'T1',
  attachedTo: { kind: 'project', ref: 'P1' },
  name: 'Menu',
  mode: 'ask',
  turns: [],
};
function renderThread(extra: Record<string, unknown>, detail: 'standard' | 'technical' = 'standard') {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      thread,
      title: 'Menu',
      task: null,
      sessions: [],
      mail: [],
      members: [],
      member: null,
      needs: [],
      settings: { ...defaults(), detail },
      mode: 'ask',
      route: 'claude-code',
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
}

describe('ThreadView live reply', () => {
  const running = [{ callId: 'a', tool: 'read_file', phase: 'started' as const, summary: 'Reading menu.md', detail: 'menu.md' }];
  test('shows tool lines under the streaming reply, and the waiting line steps aside for them', () => {
    const html = renderThread({ streaming: { requestId: 'R1', text: '', engine: 'claude-code', activity: running } });
    expect(html).toContain('Reading menu.md…');
    expect(html).not.toContain('Nectovia is');
    expect(html).not.toContain('read_file');
  });
  test('keeps the waiting line while nothing has streamed and no call is running', () => {
    const html = renderThread({ streaming: { requestId: 'R1', text: '', engine: 'claude-code' } });
    expect(html).toContain('Nectovia is');
    const done = renderThread({
      streaming: { requestId: 'R1', text: '', engine: 'claude-code', activity: [{ ...running[0], phase: 'finished' }] },
    });
    expect(done).toContain('Nectovia is');
  });
  test('the Technical level shows the tool and its detail', () => {
    const html = renderThread(
      { streaming: { requestId: 'R1', text: 'Partial', engine: 'claude-code', activity: running } },
      'technical',
    );
    expect(html).toContain('read_file');
    expect(html).toContain('<details>');
    expect(html).toContain('Partial');
  });
  test('a live run card shows the tool calls streamed for its session', () => {
    const session: Session = {
      id: 'S1',
      taskId: 'task-1',
      threadId: 'T1',
      state: 'working',
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: null,
      sample: false,
      log: [],
      entryIds: [],
      needId: null,
      engine: { name: 'Claude Code', model: 'sonnet' },
    } as unknown as Session;
    const html = renderThread({ sessions: [session], runActivity: { S1: running, S2: [{ ...running[0], summary: 'Elsewhere' }] } });
    expect(html).toContain('Reading menu.md…');
    expect(html).not.toContain('Elsewhere');
  });
});

describe('Diomedes home live reply', () => {
  const props = (extra: Partial<DiomedesPageProps>): DiomedesPageProps => ({
    projects: [],
    scopeId: null,
    onScope: noAction,
    turns: [],
    pending: true,
    restriction: 'automatic',
    onRestriction: noAction,
    onSend: async () => true,
    onStop: noAction,
    route: 'claude-code',
    unavailable: null,
    card: null,
    cardBusy: false,
    onCardAction: noAction,
    unconfirmed: null,
    onResend: noAction,
    onDiscard: noAction,
    notice: null,
    onReadAgain: null,
    results: [],
    onOpenResult: noAction,
    destinations: [],
    pinned: [],
    onDestination: noAction,
    onTogglePin: noAction,
    onNewProject: noAction,
    ...extra,
  });
  const render = (extra: Partial<DiomedesPageProps>) =>
    renderToStaticMarkup(createElement(Diomedes, props(extra)));
  const running = [{ callId: 'a', tool: 'web_search', phase: 'started' as const, summary: 'Searching the web for hours', detail: 'q=hours' }];

  test('the waiting line shows while nothing has streamed', () => {
    const html = render({ live: null });
    expect(html).toMatch(/class="mono dio-pending" role="status" aria-label="Working">/);
    expect(html).not.toContain('dio-live');
  });
  test('streamed text and tool lines show under the conversation, and are not a recorded turn', () => {
    const html = render({ live: { text: 'Open until nine.', activity: running } });
    expect(html).toContain('class="dio-live"');
    expect(html).toContain('Open until nine.');
    expect(html).toContain('Searching the web for hours…');
    expect(html).not.toContain('web_search');
    expect(html).not.toMatch(/class="turn dio/);
    // The status stays in place but steps aside once text has streamed.
    expect(html).toMatch(/class="mono dio-pending" role="status" aria-label="Working" hidden="">/);
  });
  test('technical detail on the home page', () => {
    const html = render({ live: { text: '', activity: running }, technical: true });
    expect(html).toContain('web_search');
    expect(html).toContain('q=hours');
  });
  test('nothing live shows once the message is no longer pending', () => {
    const html = render({ pending: false, live: { text: 'Stale', activity: running } });
    expect(html).not.toContain('Stale');
    expect(html).not.toContain('dio-pending');
  });
});
