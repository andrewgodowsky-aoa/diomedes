import { describe, expect, it } from 'vitest';
import { selectedEngine, selectedModel } from '../shared/ai-selection.js';
import type { Conversation, Project, Settings } from '../shared/types.js';

function settings(services: Record<string, boolean | string>): Settings {
  return {
    version: 1,
    detail: 'technical',
    onboarding: {
      work: null,
      detail: null,
      familiarity: null,
      resumeAt: 'done',
      completedAt: null,
    },
    permissions: {
      changingFiles: false,
      deleting: false,
      sending: false,
      workingOutside: false,
      spending: false,
    },
    explanations: 'persistent',
    appearance: { package: 'default', motion: 'normal' },
    seen: { onlineServiceNotice: false, guidedDescriptors: {}, firstUse: [] },
    openProjects: [],
    lastPage: {},
    tasksView: {},
    services,
  };
}

function project(ai?: Project['ai']): Project {
  return {
    id: 'p1',
    name: 'Project',
    folder: 'F:/project',
    createdAt: '2026-09-10T00:00:00.000Z',
    lastOpenedAt: '2026-09-10T00:00:00.000Z',
    plans: [],
    references: [],
    repository: { present: false },
    leftOff: null,
    counts: { running: 0, changesWaiting: 0, waitingForYou: 0, historyToday: 0 },
    status: { needsYou: 0, working: 0, tasksDone: 0, tasksTotal: 0 },
    ...(ai ? { ai } : {}),
  };
}

function thread(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    attachedTo: { kind: 'project', ref: 'p1' },
    turns: [],
    mode: 'ask',
    ...overrides,
  };
}

describe('AI route and model selection', () => {
  it('keeps an explicit thread route and model when the global default changes', () => {
    const saved = settings({
      defaultEngine: 'codex',
      codexModel: 'gpt-default',
      'claude-codeModel': 'claude-global',
    });
    const chosen = thread({
      engine: 'claude-code',
      requested: { model: 'claude-thread', effort: null },
    });

    expect(
      selectedEngine(saved, project({ engine: 'opencode', model: 'open-project' }), chosen),
    ).toBe('claude-code');
    expect(selectedModel('claude-code', saved, undefined, chosen)).toBe('claude-thread');

    saved.services = {
      defaultEngine: 'oh-my-pi',
      'oh-my-piModel': 'openai/new-global',
      'claude-codeModel': 'claude-replaced',
    };
    expect(
      selectedEngine(saved, project({ engine: 'opencode', model: 'open-project' }), chosen),
    ).toBe('claude-code');
    expect(selectedModel('claude-code', saved, undefined, chosen)).toBe('claude-thread');
  });

  it('keeps a project route and model when the global default changes', () => {
    const saved = settings({
      defaultEngine: 'codex',
      codexModel: 'gpt-default',
      opencodeModel: 'open-global',
    });
    const chosen = project({ engine: 'opencode', model: 'open-project' });

    expect(selectedEngine(saved, chosen, thread())).toBe('opencode');
    expect(selectedModel('opencode', saved, chosen, thread())).toBe('open-project');

    saved.services = {
      defaultEngine: 'claude-code',
      'claude-codeModel': 'claude-global',
      opencodeModel: 'open-replaced',
    };
    expect(selectedEngine(saved, chosen, thread())).toBe('opencode');
    expect(selectedModel('opencode', saved, chosen, thread())).toBe('open-project');
  });

  it.each(['diomedes', 'assistant'] as const)('keeps the route of the prior %s turn through an upgrade', (role) => {
    const legacy = thread({
      turns: [
        {
          id: 'a1',
          role,
          mode: 'ask',
          text: 'Prior answer',
          at: '2026-09-10T00:00:00.000Z',
          sources: [],
          route: 'claude-code',
        },
      ],
    });
    const saved = settings({ defaultEngine: 'oh-my-pi', 'oh-my-piModel': 'openai/global' });

    expect(selectedEngine(saved, project({ engine: 'codex', model: 'gpt-project' }), legacy)).toBe(
      'claude-code',
    );
  });

  it('does not confuse a runtime helper identity with a selected route on an empty thread', () => {
    const saved = settings({
      defaultEngine: 'codex',
      codexModel: 'gpt-global',
      'claude-codeModel': 'claude-runtime',
    });
    const empty = thread({ helper: { engine: 'claude-code', model: 'claude-runtime' } });

    expect(selectedEngine(saved, project(), empty)).toBe('codex');
    expect(selectedModel('codex', saved, project(), empty)).toBe('gpt-global');
  });

  it('does not let a selected thread model cross an explicit engine switch', () => {
    const saved = settings({
      defaultEngine: 'codex',
      codexModel: 'gpt-global',
      opencodeModel: 'open-global',
      'claude-codeModel': 'claude-global',
    });
    const chosen = thread({
      engine: 'claude-code',
      requested: { model: 'claude-thread', effort: null },
    });

    expect(selectedModel('opencode', saved, undefined, chosen)).toBe('open-global');
    chosen.engine = 'opencode';
    chosen.requested = null;
    expect(selectedEngine(saved, undefined, chosen)).toBe('opencode');
    expect(selectedModel('opencode', saved, undefined, chosen)).toBe('open-global');
  });

  it('uses valid saved preferences for unowned, upgraded threads and rejects retired defaults', () => {
    const upgraded = settings({ defaultEngine: 'codex', codexModel: 'gpt-5.5' });
    expect(selectedEngine(upgraded, project(), thread())).toBe('codex');
    expect(selectedModel('codex', upgraded, project(), thread())).toBe('gpt-5.5');

    const retired = settings({ defaultEngine: 'retired-engine', codexModel: 'gpt-5.5' });
    expect(selectedEngine(retired, project(), thread())).toBe('sample');
    expect(selectedModel('sample', retired, project(), thread())).toBeUndefined();
  });
});
