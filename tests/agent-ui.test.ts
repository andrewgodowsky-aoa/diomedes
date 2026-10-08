import { describe, expect, it } from 'vitest';
import { agentCaption, choiceView, confirmFor, lastPick, placeholderFor } from '../client/console/agent-ui';
import { AGENT_NAME } from '../shared/agent-name';
import type { Conversation, Turn } from '../shared/types';

// The Agent box as the Console shows it (DIO-292). Pure functions only: this repository has no
// jsdom, so what the composer, the picker and a reply's caption decide is proven here.

const thread = (patch: Partial<Conversation> = {}): Conversation => ({
  id: 'T1',
  attachedTo: { kind: 'project', ref: 'P1' },
  turns: [],
  mode: 'auto',
  ...patch,
});
const box = (agent: string) => ({ model: null, effort: null, agent });
const at = '2026-10-07T12:00:00.000Z';
const reply = (id: string, agent?: Turn['agent']): Turn => ({
  id,
  role: 'assistant',
  mode: 'ask',
  text: 'Six dozen.',
  at,
  sources: [],
  ...(agent ? { agent } : {}),
});

describe('choiceView', () => {
  it('reads Auto from the box, from a thread saved on Automatic before agents, and from a profile', () => {
    const auto = { id: 'auto', name: 'Auto', kind: 'auto' };
    expect(choiceView(thread({ requested: box('auto') }))).toEqual(auto);
    expect(choiceView(thread())).toEqual(auto);
    expect(choiceView(thread({ mode: 'ask', requested: { model: null, effort: null, profile: 'p1' } }))).toEqual(auto);
  });
  it("takes a built-in Agent's name and kind from the catalog, whatever mode the thread stored", () => {
    expect(choiceView(thread({ mode: 'ask', requested: box('diomedes.reviewer') }))).toEqual({
      id: 'diomedes.reviewer',
      name: 'Reviewer',
      kind: 'ask',
    });
    expect(choiceView(thread({ mode: 'ask', requested: box('diomedes.writer') }))).toEqual({
      id: 'diomedes.writer',
      name: 'Writer',
      kind: 'build',
    });
  });
  it("reads a thread saved on a mode before agents as that kind's own Agent", () => {
    expect(choiceView(thread({ mode: 'plan' }))).toEqual({ id: 'diomedes.architect', name: 'Planner', kind: 'plan' });
    expect(choiceView(thread({ mode: 'fix' }))).toEqual({ id: 'diomedes.debugger', name: 'Fixer', kind: 'fix' });
  });
  it('reads the general worker, now off the menu, as Auto', () => {
    expect(choiceView(thread({ mode: 'build', requested: box('diomedes.general') })).id).toBe('auto');
  });
  it('gives an Agent a project added its id, and the kind the thread stored when it was chosen', () => {
    expect(choiceView(thread({ mode: 'plan', requested: box('acme.menu-planner') }))).toEqual({
      id: 'acme.menu-planner',
      name: 'acme.menu-planner',
      kind: 'plan',
    });
  });
});

describe('placeholderFor', () => {
  it("asks Auto by the product's name, and each Agent for what it does", () => {
    expect(placeholderFor({ id: 'auto', name: 'Auto', kind: 'auto' })).toBe(`Ask ${AGENT_NAME}, or hand it something to do`);
    expect(placeholderFor({ id: 'diomedes.debugger', name: 'Fixer', kind: 'fix' })).toBe("What's broken?");
    expect(placeholderFor({ id: 'diomedes.analyst', name: 'Analyst', kind: 'ask' })).toBe('What numbers do you need?');
  });
  it('asks an Agent a project added by its name', () => {
    expect(placeholderFor({ id: 'acme.menu-planner', name: 'Menu planner', kind: 'plan' })).toBe('Message Menu planner');
  });
});

describe("a reply's Agent", () => {
  it('says Auto picked it only when Auto did', () => {
    expect(agentCaption({ id: 'diomedes.analyst', name: 'Analyst', picked: true })).toBe('Analyst, picked by Auto');
    expect(agentCaption({ id: 'diomedes.analyst', name: 'Analyst', picked: false })).toBe('Analyst');
  });
  it("names the Agent Auto picked for the latest reply, and nothing when Auto answered it itself", () => {
    const picked = { id: 'diomedes.analyst', name: 'Analyst', picked: true };
    expect(lastPick(thread({ turns: [reply('r1', picked)] }))).toBe('Analyst');
    expect(lastPick(thread({ turns: [reply('r1', picked), reply('r2')] }))).toBeNull();
    expect(lastPick(thread({ turns: [reply('r1', { ...picked, picked: false })] }))).toBeNull();
    expect(lastPick(thread())).toBeNull();
  });
  it("doesn't let a note the app wrote, or the person's own message, hide the pick", () => {
    const picked = { id: 'diomedes.reviewer', name: 'Reviewer', picked: true };
    const note: Turn = { id: 'n1', role: 'diomedes', mode: 'ask', text: 'This conversation moved to a new route.', at, sources: [] };
    const mine: Turn = { id: 'y1', role: 'you', mode: 'ask', text: 'And next week?', at, sources: [] };
    expect(lastPick(thread({ turns: [reply('r1', picked), note, mine] }))).toBe('Reviewer');
  });
});

describe('confirmFor', () => {
  it('confirms every message on an engine from another company, and a change on Codex or a provider account', () => {
    expect(confirmFor({ mode: 'build', route: 'codex' }, false)).toBe(true);
    expect(confirmFor({ mode: 'fix', route: 'aws-bedrock' }, false)).toBe(true);
    expect(confirmFor({ mode: 'ask', route: 'aws-bedrock' }, false)).toBe(false);
    expect(confirmFor({ mode: 'ask', route: 'cursor' }, false)).toBe(true);
  });
  it("reads the kind from the pick, so Auto picking Builder on a question's thread still asks", () => {
    expect(confirmFor({ mode: 'auto', route: 'codex' }, false)).toBe(false);
    expect(confirmFor({ mode: 'build', route: 'codex' }, false)).toBe(true);
  });
  it("follows the owner's confirm before sending on Codex", () => {
    expect(confirmFor({ mode: 'ask', route: 'codex' }, true)).toBe(true);
    expect(confirmFor({ mode: 'ask', route: 'codex' }, false)).toBe(false);
  });
});
