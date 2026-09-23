import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import {
  WorkStylePicker,
  resolvedDetail,
  showAdvanced,
  styleButtonLabel,
  type WorkStyleView,
} from '../client/console/WorkStylePicker';
import { ThreadView } from '../client/console/ThreadView';
import { Diomedes } from '../client/console/Diomedes';
import type { Conversation, Settings } from '../shared/types';

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

function picker(props: Partial<Parameters<typeof WorkStylePicker>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(WorkStylePicker, {
      thread: thread(),
      settings: settings(),
      live: false,
      busy: false,
      view: null,
      advanced: false,
      onStyle: noAction,
      onAdvanced: noAction,
      initialOpen: true,
      ...props,
    }),
  );
}

describe('the style picker', () => {
  it('offers the three styles with one plain line each, and Advanced', () => {
    const html = picker({ thread: thread({ workStyle: 'focused' }) });
    for (const label of ['Efficient', 'Focused', 'Thorough']) expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('Everyday conversation, brainstorming and intake.');
    expect(html).toContain('Advanced: choose model');
    expect(html).toMatch(/class="m on"[^>]*aria-checked="true"[^>]*><span>Focused<\/span>/);
    // No model id is shown to a plain user.
    expect(html).not.toContain('gpt-');
  });

  it('names a pinned model as a choice, and says it covers every call', () => {
    const pinned = thread({ workStyle: 'efficient', requested: { model: 'gpt-6-astra', effort: 'high' } });
    expect(styleButtonLabel(pinned, settings())).toBe('Chosen model');
    const html = picker({ thread: pinned, advanced: true });
    expect(html).toContain('runs every call in this thread');
    expect(html).not.toContain('Advanced: choose model');
    expect(html).not.toMatch(/class="m on"/);
  });

  it('says when the style needs a choice, with the reason', () => {
    const html = picker({
      thread: thread({ workStyle: 'focused' }),
      view: view({ outcome: 'ask', model: null, effort: null, reason: 'Focused needs Sol, which Claude Code does not offer.' }),
    });
    expect(html).toContain('needs a choice');
    expect(html).toContain('Focused needs Sol');
  });

  it('follows the Settings default and offers no separate default-model row then', () => {
    const s = settings({ services: { workStyle: 'thorough' } });
    expect(styleButtonLabel(thread(), s)).toBe('Thorough');
    expect(picker({ settings: s })).not.toContain('Default model');
    expect(styleButtonLabel(thread(), settings())).toBe('Default model');
  });

  it('shows the model picker at technical detail, on a pin, or when opened', () => {
    expect(showAdvanced(settings({ detail: 'guided' }), thread(), false)).toBe(false);
    expect(showAdvanced(settings({ detail: 'technical' }), thread(), false)).toBe(true);
    expect(showAdvanced(settings({ detail: 'guided' }), thread({ requested: { model: 'x', effort: null } }), false)).toBe(true);
    expect(showAdvanced(settings({ detail: 'guided' }), thread(), true)).toBe(true);
  });

  it('writes the resolved model and level for the details line, level only where it is read', () => {
    expect(resolvedDetail(view())).toBe('gpt-6-luna low · ChatGPT');
    expect(resolvedDetail({ ...view({ model: 'opus', effort: null }), route: 'claude-code' })).toBe('opus · Claude Code');
    expect(resolvedDetail({ ...view({ effort: 'high' }), route: 'opencode' })).toBe('gpt-6-luna · OpenCode');
    expect(resolvedDetail(null)).toBe('');
  });
});

function instruments(t: Conversation, s: Settings) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      thread: t, title: 'Styles', task: null, sessions: [], mail: [], members: [], member: null,
      needs: [], settings: s, mode: 'ask', route: 'codex', busy: false, online: true,
      onMode: noAction, onPermission: noAction, onRename: noAction, prepareSources: async () => [],
      onSend: noAction, onResolve: noAction, onPreview: noAction, onStopSession: noAction,
      onOpenBoard: noAction,
    }),
  );
}

describe('the instrument line', () => {
  it('names the style for a plain user and keeps the model behind details', () => {
    const html = instruments(thread({ workStyle: 'thorough' }), settings({ detail: 'guided' }));
    expect(html).toContain('<span class="lc">Thorough</span>');
    expect(html).toContain('>details</button>');
    expect(html).not.toContain('engine default');
  });

  it('keeps the model line for a thread with no style or with a pin', () => {
    expect(instruments(thread(), settings())).toContain('engine default');
    const pinned = instruments(thread({ workStyle: 'efficient', requested: { model: 'gpt-6-astra', effort: 'high' } }), settings());
    expect(pinned).toContain('gpt-6-astra');
    expect(pinned).not.toContain('>Efficient<');
  });
});

describe('the Home composer', () => {
  function home(workStyle: Parameters<typeof Diomedes>[0]['workStyle']) {
    return renderToStaticMarkup(
      createElement(Diomedes, {
        projects: [], scopeId: null, onScope: noAction, turns: [], pending: false,
        restriction: 'automatic', onRestriction: noAction, onSend: async () => true, onStop: noAction,
        route: 'aws-bedrock', routeChoices: ['claude-code', 'aws-bedrock'], onRoute: noAction,
        workStyle, onWorkStyle: noAction,
        unavailable: null, card: null, cardBusy: false, onCardAction: noAction, unconfirmed: null,
        onResend: noAction, onDiscard: noAction, notice: null, onReadAgain: null, results: [],
        onOpenResult: noAction, destinations: [], pinned: [], onDestination: noAction,
        onTogglePin: noAction, onNewProject: noAction,
      }),
    );
  }

  it('offers the style beside Mode and Route once there is a thread', () => {
    const html = home('focused');
    expect(html).toContain('aria-label="Style"');
    expect(html).toMatch(/<option value="focused" [^>]*selected=""/);
    expect(html).toContain('aria-label="Mode"');
    expect(home(undefined)).not.toContain('aria-label="Style"');
  });
});
