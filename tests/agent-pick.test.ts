import { describe, expect, test } from 'vitest';
import { candidatesFor, isQuestion, pickAgent, ruleFor, type PickCandidate } from '../server/agent-pick.js';
import { AGENT_CATALOG } from '../shared/agents.js';

/** DIO-292: Auto picks one agent for each message, before anything is sent. */
const say = (text: string, attachments: string[] = [], attachedDocument = false) => ({ text, attachments, attachedDocument });
const all = (context: Partial<Parameters<typeof candidatesFor>[1]> = {}) =>
  candidatesFor(AGENT_CATALOG, { compatible: () => true, conversationOnly: false, documents: true, images: false, ...context });
const ids = (items: readonly PickCandidate[]) => items.map((item) => item.id);

describe('what the words say', () => {
  test.each([
    ['The Friday sales total is off by a day.', ['sales_day.py'], 'diomedes.debugger'],
    ['Why is the Friday total off by a day?', ['sales_day.py'], 'diomedes.researcher'],
    ['The site is broken.', [], null],
    ['Can you add a contact page?', ['site/index.html'], 'diomedes.builder'],
    ['Add a contact page.', [], null],
    ['Write an email to the landlord about the leak.', [], 'diomedes.writer'],
    ['Draft a reply to the review about the broken heater.', [], 'diomedes.writer'],
    ['Make a plan for the spring menu.', [], 'diomedes.architect'],
    ['Plan the steps to move the shop online.', [], 'diomedes.architect'],
    ['Can you plan the reopening?', [], 'diomedes.architect'],
    ['How should we price the new menu?', [], 'diomedes.architect'],
    // "The plan" names a document to change, which no plan answers.
    ['Tidy the plan.', [], null],
    ['Review my changes to the menu page.', [], 'diomedes.reviewer'],
    ['Where is the delivery fee set?', [], 'diomedes.explorer'],
    ['How does the booking form connect to the calendar?', [], 'diomedes.explorer'],
    ["Chart last month's sales by day.", [], 'diomedes.analyst'],
    ['What were total sales last week?', [], 'diomedes.analyst'],
    ['Look at this.', ['march.csv'], 'diomedes.analyst'],
    ["What's our refund policy?", [], 'diomedes.researcher'],
    ['hi', [], 'auto'],
    ['Thanks!', [], 'auto'],
    ['Review the plan and chart the sales.', [], null],
  ])('%s', (text, attachments, expected) => {
    expect(ruleFor(say(text, attachments))).toBe(expected);
  });
  test('a file the thread is attached to counts as a file for the message', () => {
    expect(ruleFor(say('The total is off by a day.', [], true))).toBe('diomedes.debugger');
  });
  test('a request phrased as a question is still a request', () => {
    expect(isQuestion('Could you update the prices?')).toBe(false);
    expect(isQuestion('Are the prices right?')).toBe(true);
  });
});

describe('who Auto may pick here', () => {
  test('everyone listed, General Assistant never', () => {
    expect(ids(all())).toEqual([
      'diomedes.researcher', 'diomedes.architect', 'diomedes.builder', 'diomedes.debugger',
      'diomedes.reviewer', 'diomedes.explorer', 'diomedes.analyst', 'diomedes.writer',
    ]);
  });
  test('no agent that changes files at Home, in the Agent view, on Nectovia or with an image', () => {
    for (const context of [{ conversationOnly: true }, { images: true }])
      expect(ids(all(context)).some((id) => ['diomedes.builder', 'diomedes.debugger', 'diomedes.writer'].includes(id))).toBe(false);
  });
  test('Builder and Fixer only when a file comes with the message; Writer any time', () => {
    const none = ids(all({ documents: false }));
    expect(none).not.toContain('diomedes.builder');
    expect(none).not.toContain('diomedes.debugger');
    expect(none).toContain('diomedes.writer');
  });
  test('an agent this route cannot run is left out', () => {
    expect(ids(all({ compatible: (id) => id !== 'diomedes.analyst' }))).not.toContain('diomedes.analyst');
  });
  test('an agent a project added is never picked', () => {
    const added = { id: 'acme.drafter', summary: 'Drafts menu changes.', modes: ['build' as const], origin: 'project' };
    expect(ids(candidatesFor([...AGENT_CATALOG, added], { compatible: () => true, conversationOnly: false, documents: true, images: false })))
      .not.toContain('acme.drafter');
  });
});

describe('the pick', () => {
  test('a clear rule decides', async () => {
    expect(await pickAgent({ message: say('Where is the delivery fee set?'), candidates: all(), autoItself: true }))
      .toEqual({ agent: 'diomedes.explorer', by: 'rule' });
  });
  test('a rule that points at an agent not allowed here falls through to the default', async () => {
    const pick = await pickAgent({ message: say('Write an email to the landlord.'), candidates: all({ conversationOnly: true }), autoItself: true });
    expect(pick).toEqual({ agent: 'auto', by: 'default' });
  });
  test('Jev chooses from the shortlist when the words do not say', async () => {
    const offered: string[][] = [];
    const pick = await pickAgent({
      message: say('Review the plan and chart the sales.'),
      candidates: all(),
      autoItself: true,
      advise: async (shortlist) => {
        offered.push(shortlist.map((item) => item.id));
        return 'diomedes.analyst';
      },
    });
    expect(pick).toEqual({ agent: 'diomedes.analyst', by: 'jev' });
    expect(offered[0]).toContain('diomedes.researcher');
  });
  test('a Jev answer outside the shortlist is ignored', async () => {
    const pick = await pickAgent({ message: say('The site is broken.'), candidates: all({ conversationOnly: true }), autoItself: false, advise: async () => 'diomedes.builder' });
    expect(pick).toEqual({ agent: 'diomedes.researcher', by: 'default' });
  });
  test('small talk is Auto itself where Auto has a conversation, Researcher where it has none', async () => {
    expect((await pickAgent({ message: say('hi'), candidates: all(), autoItself: true })).agent).toBe('auto');
    expect((await pickAgent({ message: say('hi'), candidates: all(), autoItself: false })).agent).toBe('diomedes.researcher');
  });
});
