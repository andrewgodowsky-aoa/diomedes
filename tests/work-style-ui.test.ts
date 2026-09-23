import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import {
  ThreadModelControls,
  WorkStylePicker,
  resolvedDetail,
  styleButtonLabel,
  type WorkStyleView,
} from '../client/console/WorkStylePicker';
import { ThreadView } from '../client/console/ThreadView';
import { Diomedes } from '../client/console/Diomedes';
import type { Conversation, Settings } from '../shared/types';
import { WORK_STYLES, WORK_STYLE_DESCRIPTIONS, WORK_STYLE_LABELS } from '../shared/work-style';

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
      onStyle: noAction,
      initialOpen: true,
      ...props,
    }),
  );
}

describe('the style picker', () => {
  it('offers the three styles with one plain line each, and nothing else to choose', () => {
    const html = picker({ thread: thread({ workStyle: 'focused' }) });
    for (const style of WORK_STYLES) {
      expect(html).toContain(`<span>${WORK_STYLE_LABELS[style]}</span>`);
      expect(html).toContain(WORK_STYLE_DESCRIPTIONS[style]);
    }
    expect(html).toMatch(
      new RegExp(`class="m on"[^>]*aria-checked="true"[^>]*><span>${WORK_STYLE_LABELS.focused}</span>`),
    );
    // The only choices are the three tiers: no route, no model, no Advanced, no default-model row.
    const choices = [...html.matchAll(/role="menuitem(?:radio)?"[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(choices).toEqual(WORK_STYLES.map((style) => WORK_STYLE_LABELS[style]));
    for (const word of ['Advanced', 'Default model', 'gpt-', 'gemini', 'AWS', 'Bedrock', 'Azure', 'OpenRouter', 'Vertex', 'Claude', 'ChatGPT'])
      expect(html).not.toContain(word);
  });

  it('names a pinned model as a choice, and says picking a style clears it', () => {
    const pinned = thread({ workStyle: 'efficient', requested: { model: 'gpt-6-astra', effort: 'high' } });
    expect(styleButtonLabel(pinned, settings())).toBe('Chosen model');
    const html = picker({ thread: pinned });
    expect(html).toContain('Picking a style clears the pin');
    expect(html).not.toContain('gpt-6-astra');
    expect(html).not.toMatch(/class="m on"/);
  });

  it('says when the tier needs setup, with the reason', () => {
    const html = picker({
      thread: thread({ workStyle: 'focused' }),
      view: view({ outcome: 'ask', model: null, effort: null, reason: 'Focused runs on Google Vertex AI, which is not connected.' }),
    });
    expect(html).toContain('needs setup');
    expect(html).toContain('Focused runs on Google Vertex AI');
  });

  it('follows the Settings default, and asks for a style when there is none', () => {
    const s = settings({ services: { workStyle: 'thorough' } });
    expect(styleButtonLabel(thread(), s)).toBe(WORK_STYLE_LABELS.thorough);
    expect(styleButtonLabel(thread(), settings())).toBe('Choose a style');
  });

  it('renders the header control as the style picker alone, at every detail level', () => {
    for (const detail of ['guided', 'technical'] as const) {
      const html = renderToStaticMarkup(
        createElement(ThreadModelControls, {
          projectId: 'project-style',
          thread: thread({ workStyle: 'efficient', requested: { model: 'gpt-6-astra', effort: 'high' } }),
          mode: 'ask',
          route: 'codex',
          live: false,
          integrations: [],
          settings: settings({ detail }),
          busy: false,
          onPick: noAction,
          onStyle: noAction,
        }),
      );
      expect(html).toContain('style-picker');
      expect(html).not.toContain('model-picker');
    }
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
        restriction: 'automatic', onRestriction: noAction, onSend: async () => true, onStop: noAction,
        route: 'aws-bedrock',
        workStyle, onWorkStyle: noAction,
        unavailable: null, card: null, cardBusy: false, onCardAction: noAction, unconfirmed: null,
        onResend: noAction, onDiscard: noAction, notice: null, onReadAgain: null, results: [],
        onOpenResult: noAction, destinations: [], pinned: [], onDestination: noAction,
        onTogglePin: noAction, onNewProject: noAction,
      }),
    );
  }

  it('offers the style beside Mode once there is a thread, and no Route', () => {
    const html = home('focused');
    expect(html).toContain('aria-label="Style"');
    expect(html).toMatch(/<option value="focused" [^>]*selected=""/);
    expect(html).toContain('aria-label="Mode"');
    expect(html).not.toContain('aria-label="Route"');
    expect(home(undefined)).not.toContain('aria-label="Style"');
  });
});
