import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import { resolvedDetail, type WorkStyleView } from '../client/console/WorkStylePicker';
import { ThreadView } from '../client/console/ThreadView';
import { choiceView } from '../client/console/agent-ui';
import { Diomedes } from '../client/console/Diomedes';
import type { Conversation, Settings } from '../shared/types';
import { WORK_STYLE_LABELS } from '../shared/work-style';

const noAction = () => {};
const thread = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'thread-style',
  attachedTo: { kind: 'project', ref: 'project-style' },
  name: 'Styles',
  mode: 'ask',
  requested: null,
  turns: [],
  ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaults(), ...over });
const view = (over: Partial<WorkStyleView['resolution'] & object> = {}): WorkStyleView => ({
  route: 'codex',
  style: 'efficient',
  source: 'thread',
  resolution: {
    outcome: 'run',
    model: 'gpt-6-luna',
    effort: 'low',
    reason: 'Efficient with Luna.',
    pinScope: null,
    substituted: false,
    selection: 'automatic',
    style: 'efficient',
    logical: 'luna',
    kind: 'ordinary',
    escalation: null,
    ...over,
  },
});

describe('the details line', () => {
  it('writes the resolved model and level for the details line, level only where it is read', () => {
    expect(resolvedDetail(view())).toBe('gpt-6-luna low · Codex');
    expect(resolvedDetail({ ...view({ model: 'opus', effort: null }), route: 'claude-code' })).toBe('opus · Claude Code');
    expect(resolvedDetail({ ...view({ effort: 'high' }), route: 'opencode' })).toBe('gpt-6-luna · OpenCode');
    expect(resolvedDetail(null)).toBe('');
  });
});

function instruments(t: Conversation, s: Settings) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      thread: t, title: 'Styles', task: null, sessions: [], mail: [], members: [], member: null,
      needs: [], settings: s, choice: choiceView(t), route: 'codex', busy: false, online: true,
      onPermission: noAction, onRename: noAction, prepareSources: async () => [],
      pick: () => Promise.reject(new Error('Nothing is sent in a render.')),
      onSend: noAction, onResolve: noAction, onPreview: noAction, onStopSession: noAction,
      onOpenBoard: noAction,
    }),
  );
}

describe('the instrument line', () => {
  it('names the style for a plain user and keeps the model behind details', () => {
    const html = instruments(thread({ workStyle: 'thorough' }), settings({ detail: 'guided' }));
    expect(html).toContain(`<span class="lc">${WORK_STYLE_LABELS.thorough}</span>`);
    expect(html).toContain('>details</button>');
    expect(html).not.toContain('engine default');
  });

  it('keeps the model line for a thread with no style or with a pin', () => {
    expect(instruments(thread(), settings())).toContain('engine default');
    const pinned = instruments(thread({ workStyle: 'efficient', requested: { model: 'gpt-6-astra', effort: 'high' } }), settings());
    expect(pinned).toContain('gpt-6-astra');
    expect(pinned).not.toContain(`>${WORK_STYLE_LABELS.efficient}<`);
  });
});

describe('the Home composer', () => {
  function home(workStyle: Parameters<typeof Diomedes>[0]['workStyle']) {
    return renderToStaticMarkup(
      createElement(Diomedes, {
        projects: [], scopeId: null, onScope: noAction, turns: [], pending: false,
        agent: 'auto', onAgent: noAction, onSend: async () => true, onStop: noAction,
        route: 'aws-bedrock',
        workStyle, onWorkStyle: noAction,
        unavailable: null, card: null, cardBusy: false, onCardAction: noAction, unconfirmed: null,
        onResend: noAction, onDiscard: noAction, notice: null, onReadAgain: null, results: [],
        onOpenResult: noAction, destinations: [], pinned: [], onDestination: noAction,
        onTogglePin: noAction, onNewProject: noAction,
      }),
    );
  }

  it('offers the style beside the Agent once there is a thread, and no Route', () => {
    const html = home('focused');
    expect(html).toContain('aria-label="Style"');
    expect(html).toMatch(/<option value="focused" [^>]*selected=""/);
    expect(html).toContain('aria-label="Agent"');
    expect(html).not.toContain('aria-label="Mode"');
    expect(html).not.toContain('aria-label="Route"');
    expect(home(undefined)).not.toContain('aria-label="Style"');
  });
});
