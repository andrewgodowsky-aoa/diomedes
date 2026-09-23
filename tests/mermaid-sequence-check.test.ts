import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { NECTOVIA_TOKENS } from '../client/console/artifact-frame';
import {
  REFUSED_PARTICIPANT_DETAILS,
  isSequenceDiagram,
  mermaidConfig,
  preparedSource,
  refusal,
} from '../client/console/mermaid-render';

// The sequence diagram check in client/console/mermaid-render.ts, tried against Mermaid itself.
//
// Mermaid's own pipeline runs on every diagram below: mermaidAPI.getDiagramFromText does to a
// diagram's text what render does before it draws (its frontmatter, directive and comment passes,
// its type detector, its entity encoding) and then parses it. The sequence diagram's lexer is
// watched while it does. Its grammar has `properties` and `details` only where a statement starts,
// and its parser has no error recovery, so a `properties` or `details` token was taken exactly when
// the lexer is asked for another token after handing it over. Whenever Mermaid takes one, the check
// must refuse the diagram. Nothing is drawn and nothing reads the page: the handlers for those
// statements are replaced for the run, and Node has no document.
//
// It reads the Mermaid that is installed, so an upgrade that moves any of this makes it fail rather
// than pass quietly.

const CHUNKS = path.resolve('node_modules/mermaid/dist/chunks/mermaid.core');
/** The DOMPurify Mermaid imports under Node (the package's `import` export), so the same module. */
const PURIFY = path.resolve('node_modules/dompurify/dist/purify.es.mjs');

interface MermaidReading {
  /** Mermaid read the text as a sequence diagram: its sequence lexer ran. */
  sequence: boolean;
  /** Its parser took a `properties` or `details` statement. */
  taken: boolean;
}

async function mermaidReader(): Promise<(text: string) => Promise<MermaidReading>> {
  const mermaid = (await import('mermaid')).default;
  const chunk = fs.readdirSync(CHUNKS).find((name) => /^sequenceDiagram-\w+\.mjs$/.test(name));
  if (!chunk) throw new Error(`No sequence diagram chunk in ${CHUNKS}: read the installed Mermaid again.`);
  // The same file Mermaid imports when it meets a sequence diagram, so the same module.
  const { diagram } = await import(pathToFileURL(path.join(CHUNKS, chunk)).href);
  const parser = diagram.parser;
  const statements = new Set([parser.symbols_.properties, parser.symbols_.details]);
  if (statements.has(undefined)) throw new Error('The sequence grammar has no properties or details token: read it again.');
  let tokens: unknown[] = [];
  const next = parser.lexer.next;
  parser.lexer.next = function watched(this: unknown) {
    const token = next.call(this);
    if (token) tokens.push(token);
    return token;
  };
  const database = Object.getPrototypeOf(diagram.db);
  for (const name of ['addProperties', 'addDetails', 'addLinks', 'addALink']) database[name] = () => undefined;
  // Node has no DOM, so DOMPurify cannot sanitise here, and Mermaid's parser would throw at the
  // first title, accTitle or accDescr it reads, where a browser reads on. Sanitising a title
  // changes no statement, so here it passes the text through.
  const purify = (await import(pathToFileURL(PURIFY).href)).default;
  Object.assign(purify, {
    addHook: () => undefined,
    removeHook: () => undefined,
    removeAllHooks: () => undefined,
    sanitize: (text: unknown) => String(text),
  });
  mermaid.initialize(mermaidConfig(NECTOVIA_TOKENS) as Parameters<typeof mermaid.initialize>[0]);
  return async (text) => {
    tokens = [];
    try {
      await mermaid.mermaidAPI.getDiagramFromText(text);
    } catch {
      // A parse error after the statement does not undo taking it; one before it means none was.
    }
    return {
      sequence: tokens.length > 0,
      taken: tokens.some((token, index) => statements.has(token) && index < tokens.length - 1),
    };
  };
}

/** A small seeded generator (mulberry32), so a failure names the same diagram every time. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  return { next, pick };
}

const PICTURE = '{"icon": "/api/projects/p/documents/read?path=a.md"}';

/** What may come before the diagram's keyword: nothing, blank lines, comments, directives, frontmatter. */
const HEADS = [
  '',
  '\n\n',
  '   ',
  '%% who does what\n',
  '%%{wrap}%%\n',
  '%%{init: {"wrap": true}}%%\n',
  '---\ntitle: Parcels\n---\n',
  '---\ntitle: a\n---\n---\ntitle: b\n---\n',
];

/** Spellings of the keyword that Mermaid's detector (case-sensitive, no word boundary) or lexer does not take. */
const NEAR_KEYWORDS = ['SequenceDiagram', 'sequencediagram', 'sequenceDiagrams'];

/** The two statements the check refuses, written in either case. */
const REFUSED = [`properties S: ${PICTURE}`, 'PROPERTIES S: {"icon": "@root"}', 'details S: root', 'Details C: root'];

/** Other statements a sequence diagram holds, several with those words where no statement starts. */
const OTHERS = [
  'S->>C: Parcel ready',
  'C-->>S: details of it',
  'S->>C: properties; then more',
  'participant S as Shop',
  'participant C',
  'actor K as Customer',
  'participant Q@{ "type": "queue" }',
  'participant P as properties list',
  'Order details->>C: hand over',
  'loop every hour',
  'alt paid',
  'else unpaid',
  'opt gift',
  'par first',
  'and second',
  'critical check',
  'option ok',
  'break stop',
  'rect rgb(20, 20, 26)',
  'box Aqua Shop side',
  'end',
  'end',
  'create participant D',
  'destroy D',
  'activate S',
  'deactivate S',
  'autonumber',
  'title Order details',
  'accTitle: properties',
  'accDescr: details',
  'Note over S: details',
  'Note right of C: properties',
  'links S: {"Orders": "https://example.com/orders"}',
  'link S: Orders @ https://example.com/orders',
];

/**
 * What may come before a statement on its line: space; what Mermaid reads as a line or a statement
 * of its own; the tokens that could be mistaken for one (an arrow, `+`, `-`, `,`, `()`, a number);
 * and directives nested deeper than one pass takes out.
 */
const BEFORE = [
  ' ',
  '\t',
  ')',
  '(',
  '<',
  '>',
  '/',
  '\\',
  '=',
  ':',
  '}',
  'x',
  '+',
  '-',
  ',',
  '()',
  '->>',
  '//-',
  '<<->>',
  '5 ',
  '@',
  'end ',
  'END\t',
  'end',
  'sequenceDiagram ',
  'accDescr { a; b } ',
  'accDescr {\n  a\n}',
  '%%{wrap}%%',
  '%%{%%{wrap}%%wrap}%%',
  '%%{%%{%%{wrap}%%wrap}%%wrap}%%',
  '#c',
  '%%c',
  '#amp;',
  'style:#a;',
];

/** What ends a statement, or looks as if it might. */
const JOINS = ['\n', '\n', '\n', ';', ' ; ', '\n\n  ', ' ', '%% note\n', ' # note\n', '#59;'];

describe('the sequence diagram check, against Mermaid', () => {
  let read: (text: string) => Promise<MermaidReading>;

  beforeAll(async () => {
    read = await mermaidReader();
  });

  it("sees what Mermaid's parser takes, and only that", async () => {
    expect(await read(`sequenceDiagram\n  properties S: ${PICTURE}`)).toEqual({ sequence: true, taken: true });
    expect(await read(`sequenceDiagram properties S: ${PICTURE}`)).toEqual({ sequence: true, taken: true });
    expect(await read('sequenceDiagram\n  details S: root')).toEqual({ sequence: true, taken: true });
    // After a title and an accessible description, as in a browser.
    expect(await read(`sequenceDiagram\n  title Parcels\n  properties S: ${PICTURE}`)).toEqual({ sequence: true, taken: true });
    expect(await read(`sequenceDiagram\n  accDescr { who; what } properties S: ${PICTURE}`)).toEqual({ sequence: true, taken: true });
    // The words where no statement starts, and a statement Mermaid refuses to take.
    expect(await read('sequenceDiagram\n  S->>C: details, properties')).toEqual({ sequence: true, taken: false });
    expect(await read('sequenceDiagram\n  S->>properties: x')).toEqual({ sequence: true, taken: false });
    expect(await read(`sequenceDiagram\n  =properties S: ${PICTURE}`)).toEqual({ sequence: true, taken: false });
    expect(await read('flowchart TD\n  details --> properties')).toEqual({ sequence: false, taken: false });
  });

  it('refuses every diagram in which Mermaid would take a properties or details statement', async () => {
    const { next, pick } = generator(20260923);
    const cases = 6000;
    let taken = 0;
    for (let index = 0; index < cases; index += 1) {
      let source = pick(HEADS) + (next() < 0.7 ? 'sequenceDiagram' : pick(NEAR_KEYWORDS));
      const lines = 1 + Math.floor(next() * 6);
      for (let line = 0; line < lines; line += 1) {
        source += pick(JOINS);
        const before = Math.max(0, Math.floor(next() * 4) - 1);
        for (let mark = 0; mark < before; mark += 1) source += pick(BEFORE);
        source += next() < 0.3 ? pick(REFUSED) : pick(OTHERS);
      }
      const text = preparedSource(source);
      const mermaid = await read(text);
      // Read as a sequence diagram exactly where Mermaid reads one.
      expect(isSequenceDiagram(text), JSON.stringify(source)).toBe(mermaid.sequence);
      if (!mermaid.taken) continue;
      taken += 1;
      expect(refusal(text), JSON.stringify(source)).toBe(REFUSED_PARTICIPANT_DETAILS);
    }
    // Enough of them hold a statement Mermaid takes for this to mean something.
    expect(taken).toBeGreaterThan(cases / 10);
  });
});
