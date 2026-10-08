import { describe, expect, test } from 'vitest';
import { agentFraming, framedText, framesRun, withoutFraming } from '../server/agent-framing.js';
import { AGENT_CATALOG } from '../shared/agents.js';
import { commandBinding } from '../server/interaction-turn.js';

/** DIO-292: an agent's role rides in the message, never in the lane's instructions. */
const byId = (id: string) => AGENT_CATALOG.find((item) => item.id === id)!;

describe("an agent's role rides in the message", () => {
  test('the default agent of a kind sends the text as typed, and so does Auto answering itself', () => {
    expect(framesRun('diomedes.researcher', 'ask')).toBe(false);
    expect(framesRun('diomedes.debugger', 'fix')).toBe(false);
    expect(framesRun('auto', 'auto')).toBe(false);
    expect(framedText(byId('diomedes.researcher'), 'ask', 'What sells best?')).toBe('What sells best?');
  });
  test("on Auto's own lane every agent frames, since that lane's instructions are Auto's", () => {
    expect(framesRun('diomedes.researcher', 'auto')).toBe(true);
    expect(framesRun('diomedes.architect', 'auto')).toBe(true);
    expect(framedText(byId('diomedes.researcher'), 'auto', 'What sells best?')).toBe(
      `[[diomedes agent=Researcher]] ${byId('diomedes.researcher').role}\n\nWhat sells best?`,
    );
  });
  test("any other agent puts its role first, marked as the host's", () => {
    const framed = framedText(byId('diomedes.reviewer'), 'ask', 'Look at the menu change.');
    expect(framed).toBe(`[[diomedes agent=Reviewer]] ${byId('diomedes.reviewer').role}\n\nLook at the menu change.`);
    expect(agentFraming(byId('diomedes.writer'), 'build')).toBe(`Writer: ${byId('diomedes.writer').role}`);
    expect(agentFraming(byId('diomedes.builder'), 'build')).toBeNull();
  });
  test('a name cannot close the marker early', () => {
    const odd = { id: 'acme.odd', name: 'Odd]] Name', role: 'Be odd.' };
    expect(framedText(odd, 'ask', 'hi').startsWith('[[diomedes agent=Odd Name]] Be odd.')).toBe(true);
  });
  test('a role written across lines is one line, so the marker comes off whole', () => {
    const added = { id: 'acme.multi', name: 'Multi', role: 'Reads the books.\n\n  Never writes.' };
    const framed = framedText(added, 'ask', 'How did March go?');
    expect(framed).toBe('[[diomedes agent=Multi]] Reads the books. Never writes.\n\nHow did March go?');
    expect(withoutFraming(framed)).toBe('How did March go?');
    expect(withoutFraming('How did March go?')).toBe('How did March go?');
  });
});

describe('a non-default agent is part of what a message binds', () => {
  const message = { text: 'Look at the menu change.', mode: 'ask' as const, sources: [] };
  test('the default agent and no agent bind the same, so earlier commands keep their digest', () => {
    expect(commandBinding('message', { ...message, agent: 'diomedes.researcher' })).toBe(commandBinding('message', message));
  });
  test("an agent riding Auto's lane is bound; Auto answering itself is not", () => {
    const auto = { ...message, mode: 'auto' as const };
    expect(commandBinding('message', { ...auto, agent: 'diomedes.researcher' })).not.toBe(commandBinding('message', auto));
    expect(commandBinding('message', { ...auto, agent: 'diomedes.researcher' })).not.toBe(
      commandBinding('message', { ...message, agent: 'diomedes.researcher' }),
    );
  });
  test('another agent is another command', () => {
    expect(commandBinding('message', { ...message, agent: 'diomedes.reviewer' })).not.toBe(commandBinding('message', message));
    expect(commandBinding('message', { ...message, agent: 'diomedes.reviewer' })).not.toBe(
      commandBinding('message', { ...message, agent: 'diomedes.explorer' }),
    );
  });
});
