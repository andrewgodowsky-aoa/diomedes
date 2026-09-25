/**
 * The plain-writing checker, its code repairs and the facts a rewrite must keep
 * (shared/plain-writing.ts over shared/plain-writing-rules.json).
 */
import { describe, expect, test } from 'vitest';
import {
  WRITING_STANDARD,
  checkPlainWriting,
  fixDashes,
  fixInCode,
  protectedTokens,
  rewriteKeepsFacts,
} from '../shared/plain-writing';

const rules = (text: string, options = {}) => checkPlainWriting(text, options).map((hit) => hit.rule);

describe('each rule', () => {
  test('an em dash, a spaced en dash and a double hyphen used as a dash', () => {
    expect(rules('The soup is 9.50 — the bread is 4.')).toEqual(['em-dash']);
    expect(rules('The soup is 9.50—the bread is 4.')).toEqual(['em-dash']);
    expect(rules('The soup is 9.50 – the bread is 4.')).toEqual(['em-dash']);
    expect(rules('The soup is 9.50 -- the bread is 4.')).toEqual(['em-dash']);
  });

  test('a filler opener only at the start', () => {
    expect(rules('Great question! The soup is 9.50.')).toEqual(['filler-opener']);
    expect(rules("I'd be happy to help. The soup is 9.50.")).toEqual(['filler-opener']);
    expect(rules('Certainly, the soup is 9.50.')).toEqual(['filler-opener']);
    expect(rules('## Certainly, here it is\n\nThe soup is 9.50.')).toEqual(['filler-opener']);
    expect(rules('The soup is 9.50. It is certainly the best seller.')).toEqual([]);
    expect(rules('Surely the soup is fine.')).toEqual([]);
  });

  test('a closing offer only in the last paragraph', () => {
    expect(rules("The soup is 9.50.\n\nLet me know if you'd like the full menu.")).toEqual(['closing-offer']);
    expect(rules('The soup is 9.50. Feel free to ask about the bread.')).toEqual(['closing-offer']);
    expect(rules('Hope this helps!')).toEqual(['closing-offer']);
    expect(rules('Feel free to call first.\n\nThe soup is 9.50.')).toEqual([]);
  });

  test('contrast framing, and a plain correction left alone', () => {
    expect(rules("It's not a menu. It's a promise.")).toEqual(['contrast']);
    expect(rules("The oven isn't the problem. It's the timer.")).toEqual(['contrast']);
    expect(rules('This is not just soup but a meal.')).toEqual(['contrast']);
    expect(rules('Delivery is Friday, not Thursday.')).toEqual([]);
  });

  test('stacked hedges, and ordinary modals left alone', () => {
    expect(rules('It might possibly arrive Friday.')).toEqual(['stacked-hedge']);
    expect(rules('This could potentially help.')).toEqual(['stacked-hedge']);
    expect(rules('Perhaps it seems late.')).toEqual(['stacked-hedge']);
    expect(rules('You may want to check whether it could be late.')).toEqual([]);
    expect(rules('It will probably arrive in May.')).toEqual([]);
  });

  test('stock phrases, whole words only, and the owner’s own phrases', () => {
    expect(rules('We leverage a robust process.')).toEqual(['stock-phrase', 'stock-phrase']);
    expect(rules('Robustness matters.')).toEqual([]);
    expect(rules('The landscape crew starts at 7.')).toEqual([]);
    expect(rules('We touch base weekly.', { ownerPhrases: ['touch base'] })).toEqual(['owner-phrase']);
    expect(rules('We touch base weekly.')).toEqual([]);
  });
});

describe('skip zones', () => {
  test('code blocks and inline code', () => {
    expect(rules('Run this:\n\n```js\nconst a = b — c; // leverage\n```\n\nDone.')).toEqual([]);
    expect(rules('Set `mode — robust` and save.')).toEqual([]);
    // Inline code may wrap within its paragraph, but a blank line ends it.
    expect(rules('The line `- [S1] exports: POS\n  summary — Imports/pos.csv` changed.')).toEqual([]);
    expect(rules('An open ` tick.\n\nThe soup sold out — we made 40.')).toEqual(['em-dash']);
  });

  test('file names, paths and links', () => {
    expect(rules('Open robust—notes.md and reports/seamless-plan.txt.')).toEqual([]);
    expect(rules('See https://example.com/robust—page for the form.')).toEqual([]);
  });

  test('quoted text, block quotes and table rows', () => {
    expect(rules('The supplier wrote "Net 30 — due on receipt" on the invoice.')).toEqual([]);
    expect(rules('The note says:\n\n> Net 30 — due on receipt\n\nPay by the 30th.')).toEqual([]);
    expect(rules('| Item | Price |\n| --- | --- |\n| Soup | — |\n\nThe soup price is missing.')).toEqual([]);
  });

  test("anything the person wrote, even unquoted", () => {
    const invoice = 'Linen service — Friday delivery, 94 napkins';
    expect(rules('Your invoice says Linen service — Friday delivery, 94 napkins.', { userTexts: [invoice] })).toEqual([]);
    expect(rules('The linen service — as usual — was short.', { userTexts: [invoice] })).toEqual(['em-dash', 'em-dash']);
    expect(rules('You asked for a robust plan, so here it is.', { userTexts: ['I need a robust plan'] })).toEqual([]);
  });

  test('punctuation from other scripts that looks like a dash is not a dash', () => {
    expect(rules('コーヒーは500円です。')).toEqual([]); // katakana long vowel mark ー
    expect(rules('Open Mon–Fri, 9–5.')).toEqual([]); // unspaced en dash ranges
    expect(rules('ה־15 בחודש')).toEqual([]); // Hebrew maqaf
    expect(rules('Temperature −5 today.')).toEqual([]); // minus sign
    expect(rules('彼は―来なかった。')).toEqual([]); // horizontal bar
  });
});

describe('repairs in code', () => {
  test('em dashes become a colon, a new sentence, commas or parentheses', () => {
    expect(fixDashes('The soup is sold out — try the bread.')).toBe('The soup is sold out: try the bread.');
    expect(fixDashes('The soup sold out — we made 40.')).toBe('The soup sold out. We made 40.');
    expect(fixDashes('The order — all 100 napkins — arrived.')).toBe('The order, all 100 napkins, arrived.');
    expect(fixDashes('The order — napkins, cloths — arrived.')).toBe('The order (napkins, cloths) arrived.');
    // From the sample-business run: a short label before the dash takes a colon,
    expect(fixDashes('Brandt & Rowe crew — close out three punch items')).toBe(
      'Brandt & Rowe crew: close out three punch items',
    );
    // a clause after it ("no one" leads one) becomes its own sentence, not a comma splice,
    expect(
      fixDashes('Ben can do it today (Friday, through 4pm) or Saturday morning — no one else on the schedule is listed for bearings.'),
    ).toBe('Ben can do it today (Friday, through 4pm) or Saturday morning. No one else on the schedule is listed for bearings.');
    expect(fixDashes('The draft only carries Draw 3 — CO-07 isn’t on it.')).toBe('The draft only carries Draw 3. CO-07 isn’t on it.');
    expect(fixDashes('The packed_by field is blank — every earlier order in that log has a name.')).toBe(
      'The packed_by field is blank. Every earlier order in that log has a name.',
    );
    // and two dashes that each open a list are not a pair around an aside.
    expect(fixDashes('10 items: 4 still open — items 2, 3, 6, 9; 2 closed but unverified — items 4, 8.')).toBe(
      '10 items: 4 still open, items 2, 3, 6, 9; 2 closed but unverified: items 4, 8.',
    );
    expect(fixDashes('Open 9—5.')).toBe('Open 9–5.');
    expect(fixDashes('One: two — three.')).toBe('One: two, three.');
  });

  test('a filler opener and a closing offer are dropped; nothing else changes', () => {
    const answer = "Great question! The soup is 9.50 — the bread is 4.\n\nLet me know if you'd like the full menu.";
    const fixed = fixInCode(answer);
    expect(fixed.text).toBe('The soup is 9.50. The bread is 4.');
    expect(fixed.fixes.map((fix) => fix.rule)).toEqual(['em-dash', 'filler-opener', 'closing-offer']);
    expect(checkPlainWriting(fixed.text)).toEqual([]);
    expect(fixInCode('Certainly, the soup is 9.50.').text).toBe('The soup is 9.50.');
  });

  test('a dash that leads a line is a list marker', () => {
    expect(fixInCode('Two things:\n— soup\n— bread').text).toBe('Two things:\n- soup\n- bread');
  });

  test('what code cannot fix safely is left for the rewrite', () => {
    const text = 'We leverage a robust process.';
    expect(fixInCode(text)).toEqual({ text, fixes: [] });
  });

  test('a person’s own dash is never changed', () => {
    const invoice = 'Net 30 — due on receipt';
    const text = 'Your supplier wrote Net 30 — due on receipt.';
    expect(fixInCode(text, { userTexts: [invoice] }).text).toBe(text);
  });
});

describe('the facts a rewrite must keep', () => {
  test('numbers, names, dates, quotes, citations and file names', () => {
    const before = 'Maria at Juniper Street Bakery paid $1,240.50 on 12/09 for "rush order" [2], see Invoices.md.';
    expect(protectedTokens(before)).toEqual(
      expect.arrayContaining(['$1,240.50', '12/09', '"rush order"', '[2]', 'Maria', 'Juniper', 'Street', 'Bakery']),
    );
    expect(rewriteKeepsFacts(before, 'On 12/09, Maria at Juniper Street Bakery paid $1,240.50 for "rush order" [2], see Invoices.md.')).toBe(true);
    expect(rewriteKeepsFacts(before, 'Maria at Juniper Street Bakery paid $1,240 on 12/09 for "rush order" [2], see Invoices.md.')).toBe(false);
    expect(rewriteKeepsFacts(before, 'Maria paid $1,240.50 on 12/09 for "rush order" [2], see Invoices.md.')).toBe(false);
    expect(rewriteKeepsFacts('It is 9.50.', 'It costs 9.50.')).toBe(true);
    expect(rewriteKeepsFacts('It is 9.50.', 'It costs about 10.')).toBe(false);
  });
});

test('the instruction is compact and names every rule with its reason', () => {
  expect(Buffer.byteLength(WRITING_STANDARD)).toBeLessThan(1_400);
  for (const phrase of ['em dashes', 'Great question', 'Let me know', "It's not X", 'hedge', 'delve', 'exactly as the sources'])
    expect(WRITING_STANDARD).toContain(phrase);
  // It follows its own rules, once its quoted examples and its list of stock words are set aside.
  const own = WRITING_STANDARD.split('\n')
    .filter((line) => !line.startsWith('- Skip stock words'))
    .join('\n')
    .replace(/\([^)]*\)|"[^"]*"/g, '');
  expect(checkPlainWriting(own)).toEqual([]);
});

describe('the repair pass', () => {
  // Imported here so the pure checker's tests above do not load the server module.
  const load = () => import('../server/plain-writing');

  test('a rewrite that changes a number keeps the original sentence', async () => {
    const { repairWriting } = await load();
    const prompts: string[] = [];
    const result = await repairWriting({
      text: 'The soup costs 9.50. We leverage a robust supplier for it.',
      rewrite: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ '1': 'We use a steady supplier that charges 12 for it.' });
      },
    });
    expect(prompts).toHaveLength(1);
    // Only the flagged sentence went, never the whole answer.
    expect(prompts[0]).toContain('We leverage a robust supplier for it.');
    expect(prompts[0]).not.toContain('The soup costs 9.50.');
    expect(result.text).toBe('The soup costs 9.50. We leverage a robust supplier for it.');
    expect(result.record.rewrite).toMatchObject({ asked: 1, accepted: 0, kept: [{ reason: 'facts-changed' }] });
    expect(result.record.remaining.map((hit) => hit.rule)).toEqual(['stock-phrase', 'stock-phrase']);
  });

  test('a draft email with three flagged phrases: code fixes two, one rewrite fixes the third, once', async () => {
    const { repairWriting } = await load();
    const draft = [
      "Great question! Here's a draft for Maria:",
      '',
      'Hi Maria, thanks for the order of 40 loaves. We can deliver on Friday at 7am. Our turnkey service covers the drop-off.',
      '',
      "Let me know if you'd like any changes.",
    ].join('\n');
    const prompts: string[] = [];
    const result = await repairWriting({
      text: draft,
      options: { userTexts: ['Draft a reply to Maria about her order of 40 loaves.'] },
      rewrite: async (prompt) => {
        prompts.push(prompt);
        return '```json\n{"1": "Our delivery service covers the drop-off."}\n```';
      },
    });
    expect(result.record.hits.map((hit) => hit.rule).sort()).toEqual(['closing-offer', 'filler-opener', 'stock-phrase']);
    expect(result.record.fixed.map((fix) => fix.rule)).toEqual(['filler-opener', 'closing-offer']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe('1. [the stock phrase "turnkey"] Our turnkey service covers the drop-off.');
    expect(result.text).toBe(
      "Here's a draft for Maria:\n\nHi Maria, thanks for the order of 40 loaves. We can deliver on Friday at 7am. Our delivery service covers the drop-off.",
    );
    expect(result.record.remaining).toEqual([]);
    expect(result.record.rewrite).toMatchObject({ asked: 1, accepted: 1 });
  });

  test('one pass at most: a rewrite that still fails is shown as it is, and asked about once', async () => {
    const { repairWriting } = await load();
    let calls = 0;
    const result = await repairWriting({
      text: 'We leverage the oven.',
      rewrite: async () => {
        calls += 1;
        return JSON.stringify({ '1': 'We leverage the oven well.' });
      },
    });
    expect(calls).toBe(1);
    expect(result.text).toBe('We leverage the oven.');
    expect(result.record.rewrite?.kept).toEqual([{ sentence: 'We leverage the oven.', reason: 'not-better' }]);
    expect(result.record.remaining).toEqual([{ rule: 'stock-phrase', match: 'leverage' }]);
  });

  test('a rewrite that fails or answers nonsense leaves the code fixes standing', async () => {
    const { repairWriting } = await load();
    const text = 'The soup sold out — we leverage the oven.';
    const failed = await repairWriting({ text, rewrite: async () => Promise.reject(new Error('provider down')) });
    expect(failed.text).toBe('The soup sold out. We leverage the oven.');
    expect(failed.record.rewrite?.error).toBe('provider down');
    const nonsense = await repairWriting({ text, rewrite: async () => 'I cannot do that.' });
    expect(nonsense.text).toBe('The soup sold out. We leverage the oven.');
    expect(nonsense.record.rewrite?.error).toMatch(/JSON/);
  });

  test('a clean answer is not touched and costs nothing', async () => {
    const { repairWriting } = await load();
    let calls = 0;
    const result = await repairWriting({ text: 'The soup is 9.50.', rewrite: async () => (calls++, '{}') });
    expect(result).toMatchObject({ text: 'The soup is 9.50.', record: { hits: [], fixed: [], rewrite: null, remaining: [] } });
    expect(calls).toBe(0);
  });
});

test('a one-sentence reply such as "Sure." is the answer, not an opener', () => {
  expect(rules('Sure.')).toEqual([]);
  expect(rules('Sure.\n\n```diomedes-decision\n{"kind":"none"}\n```')).toEqual([]);
  expect(fixInCode('Sure.').text).toBe('Sure.');
});
