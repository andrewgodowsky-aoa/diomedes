import { describe, expect, it } from 'vitest';
import type { EngineModel, Mode } from '../shared/types';
import {
  WORK_STYLES,
  WORK_STYLE_DESCRIPTIONS,
  WORK_STYLE_LABELS,
  chooseWorkStyleSentence,
  classifyTask,
  isWorkStyle,
  resolveWorkStyle,
  type WorkStyleInput,
} from '../shared/work-style';
import { EFFORT_ORDER } from '../shared/effort';

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function model(slug: string, name = slug, efforts = LADDER, description = ''): EngineModel {
  return {
    slug,
    name,
    description,
    defaultEffort: efforts[0] ?? null,
    efforts: efforts.map((id) => ({ id, description: '' })),
  };
}

/** Route catalogue shapes as each route reports them. */
const CATALOGS: Record<string, EngineModel[]> = {
  // ChatGPT, in the runtime's own priority order.
  codex: [
    model('gpt-6-astra', 'GPT-6-Astra'),
    model('gpt-6-sol', 'GPT-6-Sol'),
    model('gpt-6-luna', 'GPT-6-Luna', LADDER.slice(0, 5)),
    model('gpt-5.6-sol', 'GPT-5.6-Sol'),
    model('gpt-5.6-terra', 'GPT-5.6-Terra'),
    model('gpt-5.6-luna', 'GPT-5.6-Luna', LADDER.slice(0, 5)),
    model('gpt-5.5', 'GPT-5.5', LADDER.slice(0, 4)),
  ],
  // Claude Code: shorthand slugs, no reasoning ladder, version only in prose.
  'claude-code': [
    model('sonnet', 'Sonnet', [], 'Sonnet 5 for everyday tasks'),
    model('opus', 'Opus', [], 'Opus 5.5 for complex work'),
    model('haiku', 'Haiku', [], 'Haiku for quick answers'),
  ],
  // OpenCode: provider/id slugs, including a Contributor tier that must never be chosen.
  opencode: [
    model('opencode-go/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', []),
    model('opencode-go/muse-spark-1.3', 'Muse Spark 1.3', []),
    model('opencode-go/glm-5.2', 'GLM 5.2', []),
  ],
  // AWS Bedrock: the connection's one model with the adapter's three levels.
  'aws-bedrock': [model('us.openai.gpt-5.6-luna', 'us.openai.gpt-5.6-luna', ['low', 'medium', 'high'])],
  // A route id this module has never heard of, reporting OpenRouter-style ids.
  openrouter: [
    model('openai/gpt-5.6-luna', 'GPT-5.6 Luna', ['low', 'medium', 'high']),
    model('openai/gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'medium', 'high']),
    model('anthropic/claude-opus-5.5', 'Claude Opus 5.5', []),
  ],
  // Azure deployments named by the customer, not by model.
  'azure-openai': [model('prod-chat-deployment', 'prod-chat-deployment', ['low', 'medium', 'high'])],
  cursor: [],
};
const MODES: Mode[] = ['ask', 'plan', 'auto', 'build', 'fix'];

function resolve(overrides: Partial<WorkStyleInput> & Pick<WorkStyleInput, 'route'>) {
  return resolveWorkStyle({
    style: 'efficient',
    mode: 'ask',
    availableModels: CATALOGS[overrides.route] ?? [],
    ...overrides,
  });
}

describe('the WorkStyle vocabulary', () => {
  it('has three styles, each with one label and one plain line', () => {
    expect(WORK_STYLES).toEqual(['efficient', 'focused', 'thorough']);
    // Labels are the owner's to rename; each style has exactly one, and they are distinct.
    expect(new Set(WORK_STYLES.map((style) => WORK_STYLE_LABELS[style])).size).toBe(3);
    const sentence = chooseWorkStyleSentence();
    for (const style of WORK_STYLES) expect(sentence).toContain(WORK_STYLE_LABELS[style]);
    for (const style of WORK_STYLES) {
      expect(WORK_STYLE_DESCRIPTIONS[style].length).toBeGreaterThan(10);
      expect(WORK_STYLE_DESCRIPTIONS[style]).not.toContain('\n');
    }
    expect(isWorkStyle('focused')).toBe(true);
    expect(isWorkStyle('build')).toBe(false);
    expect(isWorkStyle('gpt-6-sol')).toBe(false);
  });

  it('classifies greetings, ordinary and demanding messages', () => {
    for (const text of ['hi', 'Hello!', 'thanks', 'Good morning', 'hey there', 'ok.'])
      expect(classifyTask(text)).toBe('greeting');
    expect(classifyTask('hi, can you refactor the billing module?')).toBe('ordinary');
    expect(classifyTask('What changed in the brief?')).toBe('ordinary');
    expect(classifyTask('x'.repeat(1500))).toBe('demanding');
    expect(classifyTask(Array.from({ length: 14 }, (_, i) => `step ${i}`).join('\n'))).toBe('demanding');
  });
});

describe('every style × mode × route catalogue', () => {
  for (const route of Object.keys(CATALOGS))
    for (const style of WORK_STYLES)
      for (const mode of MODES)
        it(`${style} / ${mode} / ${route} never invents a model and never touches the mode`, () => {
          const result = resolve({ route, style, mode, hints: { text: 'Summarise the brief.' } });
          const slugs = CATALOGS[route].map((m) => m.slug);
          if (result.outcome === 'run') {
            if (result.model !== null) expect(slugs).toContain(result.model);
            const listed = CATALOGS[route].find((m) => m.slug === result.model);
            if (result.effort !== null) {
              expect(listed?.efforts.map((e) => e.id)).toContain(result.effort);
              if (mode === 'fix')
                expect(EFFORT_ORDER.indexOf(result.effort as never)).toBeLessThanOrEqual(1);
            }
            if (listed && listed.efforts.length === 0) expect(result.effort).toBeNull();
          } else {
            expect(result.model).toBeNull();
            expect(result.reason).toMatch(/choose/i);
          }
          // A style result is about models only: it names no mode, permission or tool.
          for (const key of Object.keys(result))
            expect(['mode', 'permission', 'tools', 'route', 'payer']).not.toContain(key);
          expect(result.style).toBe(style);
          expect(result.pinScope).toBeNull();
        });
});

describe('the owner mapping', () => {
  it('Efficient leads with Luna, taking the Luna the route ranks first', () => {
    const r = resolve({ route: 'codex', style: 'efficient', hints: { text: 'Brainstorm names.' } });
    expect(r).toMatchObject({ outcome: 'run', model: 'gpt-6-luna', effort: 'low', substituted: false, logical: 'luna', selection: 'automatic' });
    expect(resolve({ route: 'aws-bedrock', style: 'efficient' }).model).toBe('us.openai.gpt-5.6-luna');
    expect(resolve({ route: 'openrouter', style: 'efficient' }).model).toBe('openai/gpt-5.6-luna');
  });

  it('Focused leads with Sol at a medium level', () => {
    const r = resolve({ route: 'codex', style: 'focused', hints: { text: 'Review this plan.' } });
    expect(r).toMatchObject({ outcome: 'run', model: 'gpt-6-sol', effort: 'medium', substituted: false });
  });

  it('Thorough leads with Opus 5.5 where the route offers it', () => {
    expect(resolve({ route: 'claude-code', style: 'thorough' })).toMatchObject({ model: 'opus', effort: null, substituted: false });
    expect(resolve({ route: 'openrouter', style: 'thorough' })).toMatchObject({ model: 'anthropic/claude-opus-5.5', substituted: false });
  });

  it('Thorough on ChatGPT uses a qualified alternative and says it substituted', () => {
    const r = resolve({ route: 'codex', style: 'thorough', hints: { text: 'Check this proof.' } });
    expect(r).toMatchObject({ outcome: 'run', model: 'gpt-6-astra', effort: 'high', substituted: true, logical: 'astra' });
    expect(r.reason).toContain('Opus 5.5');
  });

  it('an Opus of another version is not Opus 5.5', () => {
    const r = resolve({
      route: 'claude-code',
      style: 'thorough',
      availableModels: [model('claude-opus-4-7', 'Opus 4.7', [])],
    });
    expect(r.outcome).toBe('ask');
  });

  it('Muse Standard never resolves to the Contributor tier', () => {
    const r = resolve({ route: 'opencode', style: 'efficient' });
    expect(r.model).toBe('opencode-go/muse-spark-1.3');
    expect(r.substituted).toBe(true);
    const onlyContributor = resolve({
      route: 'opencode',
      style: 'efficient',
      availableModels: [model('opencode-go/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', [])],
    });
    expect(onlyContributor.outcome).toBe('ask');
  });

  it('Focused takes Muse Standard only as an explicit lower-cost preference or approved backup', () => {
    expect(resolve({ route: 'opencode', style: 'focused' }).outcome).toBe('ask');
    expect(resolve({ route: 'opencode', style: 'focused', backupApproved: true })).toMatchObject({
      model: 'opencode-go/muse-spark-1.3',
      substituted: true,
    });
    const both = [...CATALOGS.codex, model('opencode-go/muse-spark-1.3', 'Muse Spark 1.3', [])];
    expect(resolve({ route: 'x', style: 'focused', availableModels: both, preferLowerCost: true })).toMatchObject({
      model: 'opencode-go/muse-spark-1.3',
      substituted: false,
    });
    expect(resolve({ route: 'x', style: 'focused', availableModels: both }).model).toBe('gpt-6-sol');
  });
});

describe('reasoning level', () => {
  it('keeps an ordinary greeting cheap even in Thorough', () => {
    const r = resolve({ route: 'codex', style: 'thorough', hints: { text: 'hi' } });
    expect(r).toMatchObject({ model: 'gpt-6-luna', effort: 'low', kind: 'greeting', substituted: false });
    expect(r.reason).toContain('greeting');
    // Where no cheap model is offered, the lead answers at its lowest level.
    const claude = resolve({ route: 'claude-code', style: 'thorough', hints: { text: 'thanks!' } });
    expect(claude.model).toBe('opus');
  });

  it('holds Fix to its ceiling in every style', () => {
    for (const style of WORK_STYLES) {
      const r = resolve({ route: 'codex', style, mode: 'fix', hints: { text: 'x'.repeat(2000) } });
      expect(['low', 'medium']).toContain(r.effort);
    }
    expect(resolve({ route: 'codex', style: 'thorough', mode: 'fix' }).effort).toBe('medium');
  });

  it('plans one level deeper and a demanding task one more', () => {
    expect(resolve({ route: 'codex', style: 'focused', mode: 'plan' }).effort).toBe('high');
    expect(resolve({ route: 'codex', style: 'thorough', mode: 'plan', hints: { kind: 'demanding' } }).effort).toBe('max');
  });

  it('fits the level to what the model lists', () => {
    // Luna stops at max; Bedrock's adapter takes three levels.
    expect(resolve({ route: 'aws-bedrock', style: 'efficient', mode: 'plan', hints: { kind: 'demanding' } }).effort).toBe('high');
  });

  it('stable effort ignores the message, for a model-API lineage', () => {
    const a = resolve({ route: 'aws-bedrock', style: 'efficient', hints: { text: 'hi' }, stableEffort: true });
    const b = resolve({ route: 'aws-bedrock', style: 'efficient', hints: { kind: 'demanding' }, stableEffort: true });
    expect(a.effort).toBe(b.effort);
  });

  it('a demanding Efficient task escalates to Sol only when approved', () => {
    const asked = resolve({ route: 'codex', style: 'efficient', hints: { kind: 'demanding' } });
    expect(asked).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', escalation: 'needs-approval' });
    const approved = resolve({ route: 'codex', style: 'efficient', hints: { kind: 'demanding' }, escalationApproved: true });
    expect(approved).toMatchObject({ model: 'gpt-6-sol', escalation: 'applied', substituted: false });
  });
});

describe('pins and missing models', () => {
  it('an explicit pin always wins and is labelled as all calls', () => {
    for (const style of WORK_STYLES) {
      const r = resolve({ route: 'codex', style, pin: { model: 'gpt-5.5', effort: 'xhigh' }, hints: { text: 'hi' } });
      expect(r).toMatchObject({ outcome: 'run', model: 'gpt-5.5', effort: 'xhigh', pinScope: 'all-calls', selection: 'manual', substituted: false });
    }
    // Fix's ceiling still applies to a pin.
    expect(resolve({ route: 'codex', mode: 'fix', pin: { model: 'gpt-5.5', effort: 'xhigh' } }).effort).toBe('medium');
  });

  it('a pin the route no longer offers asks instead of substituting', () => {
    const r = resolve({ route: 'codex', pin: { model: 'gpt-4-retired' } });
    expect(r).toMatchObject({ outcome: 'ask', model: null, substituted: false, pinScope: 'all-calls' });
  });

  it('asks rather than downgrading when nothing qualified is offered', () => {
    const focused = resolve({ route: 'claude-code', style: 'focused', savedModel: 'haiku' });
    expect(focused).toMatchObject({ outcome: 'ask', model: null });
    expect(focused.reason).toContain('Sol');
    const thorough = resolve({ route: 'aws-bedrock', style: 'thorough', hints: { text: 'Audit this.' } });
    expect(thorough.outcome).toBe('ask');
    expect(resolve({ route: 'azure-openai', style: 'focused' }).outcome).toBe('ask');
  });

  it('Efficient, the floor, may run the model already saved for the route', () => {
    const r = resolve({ route: 'claude-code', style: 'efficient', savedModel: 'sonnet' });
    expect(r).toMatchObject({ outcome: 'run', model: 'sonnet', substituted: true, selection: 'automatic' });
    const azure = resolve({ route: 'azure-openai', style: 'efficient', savedModel: 'prod-chat-deployment' });
    expect(azure).toMatchObject({ model: 'prod-chat-deployment', effort: 'low', substituted: true });
    // A saved model the route does not list is not used.
    expect(resolve({ route: 'claude-code', style: 'efficient', savedModel: 'gone' }).outcome).toBe('ask');
  });

  it('only ChatGPT runs its own default before it has listed anything', () => {
    expect(resolve({ route: 'codex', style: 'thorough', availableModels: [], routeDefaultAllowed: true })).toMatchObject({
      outcome: 'run',
      model: null,
      selection: 'runtime-default',
      substituted: true,
    });
    const unchecked = resolve({ route: 'cursor', style: 'thorough' });
    expect(unchecked.outcome).toBe('ask');
    expect(unchecked.reason).toContain('has not reported its models');
  });

  it('no style keeps the route’s own default', () => {
    expect(resolve({ route: 'codex', style: null, savedModel: 'gpt-6-astra' })).toMatchObject({
      model: 'gpt-6-astra',
      selection: 'manual',
      pinScope: null,
    });
    expect(resolve({ route: 'codex', style: null })).toMatchObject({ model: null, selection: 'runtime-default' });
  });
});
