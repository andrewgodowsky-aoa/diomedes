import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import {
  CONVERSATION_ENGINES,
  LOCAL_MODEL,
  LOCAL_OTHER,
  LOCAL_OTHER_FREE,
  LOCAL_STOPPED,
  LOCAL_STOPPED_FREE,
  NECTOVIA_LOCKED,
  NOT_RUNNING,
  START,
  contextAmount,
  contextGauge,
  contextLine,
  contextWindowLine,
  currentModel,
  currentTier,
  effortState,
  effortWord,
  engineEntries,
  engineLabel,
  localChoice,
  localModel,
  localProfileEntries,
  localProfileLine,
  localReady,
  localStoppedLine,
  offeredEngine,
  shownEngine,
  startingModel,
  tierEntries,
  tierLabel,
} from '../client/console/ask-row';
import { AskRow, ContextRing, type AskRowProps } from '../client/console/AskRow';
import type { ContextAccount } from '../shared/context-accounting';
import type { EngineConnection } from '../shared/engines';
import { NECTOVIA_ROUTE } from '../shared/model-api';
import type { Conversation, EngineCatalog, EngineModel, IntegrationStatus, Route, Settings, Turn } from '../shared/types';
import { WORK_STYLES, WORK_STYLE_LABELS } from '../shared/work-style';

const settings = (services: Record<string, boolean | string> = {}): Settings => {
  const base = defaults();
  return { ...base, services: { ...base.services, ...services } };
};
const thread = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'thread-ask',
  attachedTo: { kind: 'project', ref: 'project-ask' },
  name: 'Ask row',
  mode: 'ask',
  requested: null,
  turns: [],
  ...over,
});
const integration = (over: Partial<IntegrationStatus> & Pick<IntegrationStatus, 'id'>): IntegrationStatus => ({
  name: over.id,
  kind: 'online',
  found: true,
  available: true,
  enabled: true,
  status: 'Ready',
  detail: '',
  capabilities: [],
  signIn: 'not-needed',
  adapter: 'ready',
  disclosure: [],
  ...over,
});
const model = (slug: string, efforts: string[] = [], defaultEffort: string | null = null): EngineModel => ({
  slug,
  name: `${slug} name`,
  description: '',
  defaultEffort,
  efforts: efforts.map((id) => ({ id, description: '' })),
});
const found = (engine: EngineConnection['engine'], models: EngineModel[]): EngineConnection => ({
  engine,
  installation: 'found',
  compatibility: 'supported',
  authentication: 'signed-in',
  accountRoute: null,
  models,
  checkedAt: null,
  detail: '',
  usage: { state: 'unknown', checkedAt: null },
});

// The local model's route is whatever the host names, so any route id stands in for it: these
// tests hold the contract, not one model. The other local integrations only watch a service.
const LOCAL_ROUTE: Route = 'openrouter';
const shippedLocal = [
  integration({ id: 'localai', name: 'LocalAI supervisor', kind: 'local', adapter: 'none', found: false, available: false }),
  integration({ id: 'ollama', name: 'Ollama', kind: 'local', adapter: 'none' }),
];
const binding = (running: boolean, found = true, loaded: string | null = running ? 'p-one' : null) =>
  integration({ id: LOCAL_ROUTE, name: 'On this computer', kind: 'local', found, available: found && running, loaded });
/** A profile as a host catalogue lists it: its own name, levels, default and declared size. */
const profile = (slug: string, contextTokens: number, images: boolean, defaultEffort = 'medium'): EngineModel => ({
  slug,
  name: `${slug} name`,
  description: `${slug} description`,
  defaultEffort,
  efforts: ['medium', 'xhigh'].map((id) => ({ id, description: '' })),
  contextTokens,
  inputModalities: images ? ['text', 'image'] : ['text'],
});
const profiles = [profile('p-one', 16_384, false), profile('p-two', 131_072, true, 'xhigh')];
const catalog: Record<string, EngineCatalog> = {
  [LOCAL_ROUTE]: { engine: LOCAL_ROUTE, models: profiles, detail: '' },
};

describe('the Local model option (DIO-201)', () => {
  it('is hidden until a binding that can send exists', () => {
    expect(localModel([])).toBeNull();
    expect(localModel(shippedLocal)).toBeNull();
    expect(tierEntries(null, null, true).map((entry) => entry.name)).not.toContain(LOCAL_MODEL);
  });

  it('is hidden while the binding reports nothing set up, unless the thread is already on it', () => {
    const local = localModel([binding(false, false)]);
    expect(local).toEqual({ route: LOCAL_ROUTE, found: false, running: false, loaded: null });
    expect(tierEntries(local, null, true).map((entry) => entry.id)).toEqual([...WORK_STYLES]);
    expect(tierEntries(local, null, true, true).at(-1)).toMatchObject({ id: 'local', sub: NOT_RUNNING, disabled: true });
    const input = { integrations: [binding(false, false)], settings: settings(), connections: {}, free: true, local };
    expect(engineEntries({ ...input, route: NECTOVIA_ROUTE }).map((entry) => entry.id)).not.toContain(LOCAL_ROUTE);
    expect(engineEntries({ ...input, route: LOCAL_ROUTE }).find((entry) => entry.id === LOCAL_ROUTE)).toMatchObject({
      name: LOCAL_MODEL,
      disabled: true,
    });
  });

  it('is grayed with one short line when set up but not running', () => {
    const local = localModel([...shippedLocal, binding(false)]);
    expect(local).toEqual({ route: LOCAL_ROUTE, found: true, running: false, loaded: null });
    const entry = tierEntries(local, 'Some model', true).at(-1)!;
    expect(entry).toMatchObject({ id: 'local', name: LOCAL_MODEL, sub: NOT_RUNNING, disabled: true });
  });

  it('follows the three tiers, and names its model only where names are allowed', () => {
    const local = localModel([binding(true)]);
    const entries = tierEntries(local, 'Served name', true);
    expect(entries.map((entry) => entry.id)).toEqual([...WORK_STYLES, 'local']);
    expect(entries.at(-1)).toMatchObject({ sub: 'Served name', disabled: false });
    expect(tierEntries(local, 'Served name', false).at(-1)!.sub).toBe('Runs on this computer');
    expect(tierEntries(local, null, true).at(-1)!.sub).toBe('Runs on this computer');
  });

  it('is never the default: a thread is on it only when its route says so', () => {
    const local = localModel([binding(true)]);
    expect(currentTier(thread(), settings(), NECTOVIA_ROUTE, local)).toBe('efficient');
    expect(currentTier(thread({ workStyle: 'thorough' }), settings(), NECTOVIA_ROUTE, local)).toBe('thorough');
    expect(currentTier(thread(), settings(), LOCAL_ROUTE, local)).toBe('local');
    expect(tierLabel('local')).toBe(LOCAL_MODEL);
  });

  it('reads as a Nectovia option on a paid plan and as an engine of its own on the free version', () => {
    const local = localModel([binding(true)]);
    expect(shownEngine(LOCAL_ROUTE, local, false)).toBe(NECTOVIA_ROUTE);
    expect(shownEngine(LOCAL_ROUTE, local, true)).toBe(LOCAL_ROUTE);
    expect(engineLabel(LOCAL_ROUTE, { integrations: [], local, free: false })).toBe('Nectovia');
    expect(engineLabel(LOCAL_ROUTE, { integrations: [], local, free: true })).toBe(LOCAL_MODEL);
    const input = { integrations: [binding(true)], settings: settings(), connections: {}, route: NECTOVIA_ROUTE, local };
    expect(engineEntries({ ...input, free: false }).map((entry) => entry.id)).not.toContain(LOCAL_ROUTE);
    expect(engineEntries({ ...input, free: true }).find((entry) => entry.id === LOCAL_ROUTE)).toMatchObject({
      name: LOCAL_MODEL,
      disabled: false,
    });
  });
});

describe('a thread on the local model (PR #214 reconciled with the row)', () => {
  it('knows which profile the running worker has, and a profile is ready only when it is that one', () => {
    const local = localModel([binding(true, true, 'p-two')]);
    expect(local).toEqual({ route: LOCAL_ROUTE, found: true, running: true, loaded: 'p-two' });
    expect(localReady(local, 'p-two')).toBe(true);
    expect(localReady(local, 'p-one')).toBe(false);
    expect(localReady(local, null)).toBe(false);
    expect(localReady(localModel([binding(false)]), 'p-one')).toBe(false);
    expect(localReady(null, 'p-one')).toBe(false);
    // A stopped worker has nothing loaded, whatever the entry still carries.
    const stale = integration({ id: LOCAL_ROUTE, kind: 'local', available: false, loaded: 'p-one' });
    expect(localModel([stale])?.loaded).toBeNull();
  });

  it('lands on the loaded profile while it runs, else the saved default, else the first listed', () => {
    expect(localChoice(localModel([binding(true, true, 'p-two')]), profiles, 'p-one')?.slug).toBe('p-two');
    const stopped = localModel([binding(false)]);
    expect(localChoice(stopped, profiles, 'p-two')?.slug).toBe('p-two');
    expect(localChoice(stopped, profiles, 'gone')?.slug).toBe('p-one');
    expect(localChoice(stopped, [], 'p-one')).toBeNull();
    expect(localChoice(null, profiles, null)).toBeNull();
  });

  it('lists the profiles in the catalogue own words, and names them only where names may show', () => {
    const local = localModel([binding(true, true, 'p-two')])!;
    expect(localProfileEntries(local, profiles, true)).toEqual([
      { slug: 'p-one', name: 'p-one name', sub: 'Text only, 16k context', running: false },
      { slug: 'p-two', name: 'p-two name', sub: 'Text and images, 131k context', running: true },
    ]);
    expect(localProfileEntries(local, profiles, false).map((entry) => entry.name)).toEqual([LOCAL_MODEL, LOCAL_MODEL]);
    // A size the host did not declare is not invented.
    expect(localProfileLine({ ...profiles[0], contextTokens: undefined, inputModalities: undefined })).toBe('Text only');
  });

  it('takes Effort from the profile own levels and default, with Fix capped', () => {
    expect(effortState(profiles[1], null, null, 'ask')).toMatchObject({
      levels: [{ id: 'medium' }, { id: 'xhigh' }],
      wanted: 'xhigh',
      runs: 'xhigh',
    });
    expect(effortState(profiles[1], 'xhigh', null, 'fix')).toMatchObject({ runs: 'medium', capped: true });
    expect(effortState(profiles[0], null, null, 'ask').wanted).toBe('medium');
  });

  it('withdraws a profile that is not loaded and says so, offering a tier or another engine, never a cloud model', () => {
    const stopped = localModel([binding(false)]);
    expect(localStoppedLine(stopped, 'p-one', false)).toBe(LOCAL_STOPPED);
    expect(localStoppedLine(stopped, 'p-one', true)).toBe(LOCAL_STOPPED_FREE);
    const other = localModel([binding(true, true, 'p-two')]);
    expect(localStoppedLine(other, 'p-one', false)).toBe(LOCAL_OTHER);
    expect(localStoppedLine(other, 'p-one', true)).toBe(LOCAL_OTHER_FREE);
    expect(localStoppedLine(other, 'p-two', false)).toBeNull();
    // The thread keeps its route while it is withdrawn: the tier box would still say Local model.
    expect(currentTier(thread({ workStyle: 'thorough' }), settings(), LOCAL_ROUTE, stopped)).toBe('local');
  });
});

describe('the Engine box', () => {
  it('lists Nectovia first and always online, grayed with the way to use it on the free version', () => {
    const input = { integrations: [], settings: settings(), connections: {}, route: NECTOVIA_ROUTE, local: null };
    const paid = engineEntries({ ...input, free: false });
    expect(paid[0]).toMatchObject({ id: NECTOVIA_ROUTE, online: true, disabled: false, locked: false });
    const free = engineEntries({ ...input, free: true });
    expect(free[0]).toMatchObject({ id: NECTOVIA_ROUTE, online: true, disabled: true, locked: true, sub: NECTOVIA_LOCKED });
  });

  it('offers an engine Settings turned on and found, and grays one that has not passed its check', () => {
    const connections = { 'claude-code': found('claude-code', [model('cc-1')]) };
    const on = settings({ 'claude-code': true, opencode: true });
    expect(offeredEngine('claude-code', { integrations: [], settings: on, connections })).toBe(true);
    expect(offeredEngine('claude-code', { integrations: [], settings: settings(), connections })).toBe(false);
    const entries = engineEntries({ integrations: [], settings: on, connections, free: false, route: NECTOVIA_ROUTE, local: null });
    expect(entries.find((entry) => entry.id === 'claude-code')).toMatchObject({ disabled: false });
    expect(entries.find((entry) => entry.id === 'opencode')).toMatchObject({ disabled: true });
    expect(entries.map((entry) => entry.id)).not.toContain('cursor');
  });

  it('keeps a row for the thread own route even when the list would not offer it', () => {
    const entries = engineEntries({
      integrations: [integration({ id: 'sample', name: 'Sample work', kind: 'sample' })],
      settings: settings(),
      connections: {},
      free: false,
      route: 'codex',
      local: null,
    });
    expect(entries.map((entry) => entry.id)).toContain('codex');
  });

  it('names Sample work once, with nothing under the name', () => {
    const entries = engineEntries({
      integrations: [integration({ id: 'sample', name: 'Sample work', kind: 'sample' })],
      settings: settings(),
      connections: {},
      free: false,
      route: 'sample',
      local: null,
    });
    expect(entries.find((entry) => entry.id === 'sample')).toMatchObject({ name: 'Sample work', sub: '' });
  });
});

describe('the Model and Effort boxes', () => {
  it('start an engine on the saved default when it is still listed, else the first model', () => {
    const models = [model('a'), model('b')];
    expect(startingModel(models, 'b')?.slug).toBe('b');
    expect(startingModel(models, 'gone')?.slug).toBe('a');
    expect(startingModel([], 'b')).toBeNull();
  });

  it('name the pin first, then the model the host resolved', () => {
    const models = [model('a'), model('b')];
    expect(currentModel(models, 'b', 'a')).toEqual({ slug: 'b', model: models[1] });
    expect(currentModel(models, null, 'a')?.slug).toBe('a');
    expect(currentModel([], 'unlisted', null)).toEqual({ slug: 'unlisted', model: null });
    expect(currentModel(models, null, null)).toBeNull();
  });

  it('use the model own levels, and Fix runs at its ceiling while the choice stands', () => {
    const levels = model('m', ['low', 'medium', 'high', 'xhigh'], 'medium');
    expect(effortState(levels, 'xhigh', null, 'ask')).toMatchObject({ wanted: 'xhigh', runs: 'xhigh', capped: false });
    expect(effortState(levels, 'xhigh', null, 'fix')).toMatchObject({
      wanted: 'xhigh',
      runs: 'medium',
      capped: true,
      ceiling: 'medium',
    });
    // A level the model does not list gives way to the saved choice, then the model default.
    expect(effortState(levels, 'ultra', 'high', 'ask').wanted).toBe('high');
    expect(effortState(levels, 'ultra', null, 'ask').wanted).toBe('medium');
    // Before the engine lists the model, the thread choice is shown as saved.
    expect(effortState(null, 'high', null, 'ask')).toMatchObject({ wanted: 'high', levels: [] });
    expect(effortState(model('flat'), null, null, 'ask')).toMatchObject({ wanted: null, runs: null });
  });

  it('say each level in words, and an unknown one as itself', () => {
    expect(effortWord('xhigh')).toBe('Extra high');
    expect(effortWord('turbo')).toBe('Turbo');
  });
});

describe('the context ring', () => {
  const answered = (window: number | null, sections: [string, number][]): Pick<Turn, 'role' | 'context'> => ({
    role: 'diomedes',
    context: {
      window: { tokens: window, source: 'test' },
      estimatedTokens: sections.reduce((sum, [, tokens]) => sum + tokens, 0),
      sections: sections.map(([id, tokens]) => ({ id, bytes: tokens * 4, estimatedTokens: tokens })),
    } as unknown as ContextAccount,
  });

  it('is empty before any answer and never invents a percentage without a declared window', () => {
    expect(contextLine(contextGauge([]))).toBe('No context used yet');
    const gauge = contextGauge([{ role: 'you', context: undefined }, answered(null, [['message', 1234]])]);
    expect(gauge.percent).toBeNull();
    expect(contextLine(gauge)).toBe('Context used: ~1.2k estimated');
    expect(gauge.rows.map(contextAmount)).toEqual(['~1.2k']);
  });

  it('reads the newest answer and lists what filled it against a declared window', () => {
    const gauge = contextGauge([answered(1000, [['message', 10]]), answered(1000, [['history', 300], ['message', 200], ['tools', 0]])]);
    expect(gauge.percent).toBe(50);
    expect(contextLine(gauge)).toBe('Context 50% full');
    expect(gauge.rows).toEqual([
      { label: 'Conversation history', tokens: 300, percent: 30 },
      { label: 'Your message', tokens: 200, percent: 20 },
    ]);
    expect(gauge.rows.map(contextAmount)).toEqual(['30%', '20%']);
  });

  it('renders named, with nothing open', () => {
    const html = renderToStaticMarkup(createElement(ContextRing, { turns: [] }));
    expect(html).toContain('aria-label="No context used yet"');
    expect(html).not.toContain('role="dialog"');
  });

  it('measures against the window the thread model declares, which outranks the answer own', () => {
    const turns = [answered(1000, [['message', 500]])];
    expect(contextGauge(turns).percent).toBe(50);
    const declared = contextGauge(turns, 2000);
    expect(declared).toMatchObject({ percent: 25, window: 2000 });
    expect(contextWindowLine(declared)).toBe('2k token window');
    expect(contextWindowLine(contextGauge([answered(null, [['message', 5]])]))).toBeNull();
    // Before any answer the declared window is still named, and nothing is measured.
    const empty = contextGauge([], 16_384);
    expect(empty).toMatchObject({ percent: null, tokens: null, window: 16_384 });
    const html = renderToStaticMarkup(createElement(ContextRing, { turns: [], window: 16_384 }));
    expect(html).toContain('aria-label="No context used yet"');
    expect(html).toContain('title="No context used yet. 16k token window"');
  });
});

describe('the row as drawn', () => {
  const draw = (over: Partial<AskRowProps> = {}) =>
    renderToStaticMarkup(
      createElement(AskRow, {
        thread: thread(),
        mode: 'ask',
        route: NECTOVIA_ROUTE,
        integrations: [],
        settings: settings(),
        styleView: null,
        free: false,
        names: true,
        locked: false,
        onChoose: () => {},
        ...over,
      }),
    );

  it('on Nectovia: the engine and its tier, and no effort box', () => {
    const html = draw({ thread: thread({ workStyle: 'focused' }) });
    expect(html).toContain('aria-label="Engine: Nectovia"');
    expect(html).toContain(`aria-label="How much care: ${WORK_STYLE_LABELS.focused}"`);
    expect(html).not.toContain('ask-effort');
    expect(html).not.toContain(LOCAL_MODEL);
  });

  it('on the free version the tier box is grayed with the way to use Nectovia', () => {
    const html = draw({ free: true });
    expect(html).toMatch(new RegExp(`title="${NECTOVIA_LOCKED}"[^>]*disabled=""`));
  });

  it('on another engine: its model and the effort it runs at', () => {
    const html = draw({
      route: 'codex',
      mode: 'fix',
      thread: thread({ engine: 'codex', requested: { model: 'unlisted-model', effort: 'high' } }),
    });
    expect(html).toContain('aria-label="Model: unlisted-model"');
    expect(html).toContain('aria-label="Effort: Medium"');
    expect(html).toContain('ask-effort capped');
    expect(html).not.toContain('How much care');
  });

  it('on Sample work: no model or effort box, since it has no choices', () => {
    const html = draw({ route: 'sample' });
    expect(html).not.toContain('ask-model');
    expect(html).not.toContain('ask-effort');
  });

  it('on a stopped local model: Nectovia, the Local model box, and one line saying what to do', () => {
    const html = draw({ route: LOCAL_ROUTE, integrations: [binding(false)] });
    expect(html).toContain('aria-label="Engine: Nectovia"');
    expect(html).toContain(`aria-label="Model: ${LOCAL_MODEL}"`);
    // React writes the apostrophe as an entity.
    expect(html).toContain(LOCAL_STOPPED.replaceAll("'", '&#x27;'));
    // No profile is chosen yet, so there is nothing for Start to load.
    expect(html).not.toContain('class="ask-start"');
  });

  const onLocal = (over: Partial<AskRowProps> = {}, requested: Conversation['requested'] = { model: 'p-two', effort: null }) =>
    draw({
      route: LOCAL_ROUTE,
      thread: thread({ engine: LOCAL_ROUTE, requested }),
      initialCatalogs: catalog,
      ...over,
    });

  it('on the local model: its profile and that profile own effort, from the catalogue, and nothing to start', () => {
    const html = onLocal({ integrations: [binding(true, true, 'p-two')] });
    expect(html).toContain('aria-label="Engine: Nectovia"');
    expect(html).toContain('aria-label="Model: p-two name"');
    expect(html).toContain(`aria-label="Effort: ${effortWord('xhigh')}"`);
    expect(html).not.toContain('How much care:');
    expect(html).not.toContain('ask-local');
  });

  it('where names may not show, the profile reads as the Local model', () => {
    const html = onLocal({ integrations: [binding(true, true, 'p-two')], names: false });
    expect(html).toContain(`aria-label="Model: ${LOCAL_MODEL}"`);
    expect(html).not.toContain('p-two name');
  });

  it('a stopped local model keeps the thread on it, says so, and offers Start beside the line', () => {
    const html = onLocal({ integrations: [binding(false)] });
    expect(html).toContain('aria-label="Model: p-two name"');
    expect(html).toContain(LOCAL_STOPPED.replaceAll("'", '&#x27;'));
    expect(html).toMatch(new RegExp(`class="ask-start"[^>]*>${START}</button>`));
    expect(html).not.toContain('How much care:');
  });

  it('another profile loaded: says so and offers Start for this one', () => {
    const html = onLocal({ integrations: [binding(true, true, 'p-one')] });
    expect(html).toContain(LOCAL_OTHER);
    expect(html).toMatch(new RegExp(`class="ask-start"[^>]*>${START}</button>`));
  });

  it('on the free version the local model is an engine of its own, with another engine as the way out', () => {
    const html = onLocal({ integrations: [binding(false)], free: true });
    expect(html).toContain(`aria-label="Engine: ${LOCAL_MODEL}"`);
    expect(html).toContain(LOCAL_STOPPED_FREE.replaceAll("'", '&#x27;'));
  });

  it('waits for a live run: Start is disabled too', () => {
    const html = onLocal({ integrations: [binding(false)], locked: true });
    expect(html).toMatch(new RegExp(`class="ask-start"[^>]*disabled=""[^>]*>${START}</button>`));
  });

  it('waits for a live run: every box is disabled', () => {
    const html = draw({ locked: true, route: 'codex', thread: thread({ requested: { model: 'm', effort: null } }) });
    const boxes = html.match(/class="ask-pick"[^>]*>/g) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toContain('disabled=""');
  });
});

// Slice 2 of the round 2 reskin: the Nectovia conversation gets the ask row, and its engine list
// is the conversation routes, not the project engines.
describe('the ask row on the Nectovia conversation', () => {
  const on = { 'claude-code': true, codex: true, 'oh-my-pi': true } as const;
  const input = {
    integrations: [integration({ id: 'codex', name: 'Codex' })],
    settings: settings(on),
    connections: {
      'claude-code': found('claude-code', [model('opus')]),
      'oh-my-pi': found('oh-my-pi', [model('pi')]),
    },
    free: false,
    route: NECTOVIA_ROUTE as Route,
    local: null,
  };

  it('lists the conversation routes this computer offers, after Nectovia', () => {
    const ids = engineEntries({ ...input, engines: CONVERSATION_ENGINES }).map((entry) => entry.id);
    expect(ids[0]).toBe(NECTOVIA_ROUTE);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('codex');
    // oh-my-pi works on projects but holds no conversation, so the conversation never lists it.
    expect(ids).not.toContain('oh-my-pi');
  });

  it('never lists Nectovia or the local model twice, since each has its own place in the row', () => {
    expect(CONVERSATION_ENGINES).not.toContain(NECTOVIA_ROUTE);
    expect(CONVERSATION_ENGINES).not.toContain('bonsai');
  });

  it('leaves the project row as it was', () => {
    expect(engineEntries(input).map((entry) => entry.id)).toContain('oh-my-pi');
  });
});
