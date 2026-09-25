/**
 * Plain writing: Nectovia does not write like a typical AI (Andrew, 2026-09-25). This is a core
 * behaviour, not a style setting: the people who read these answers forward the briefs and send
 * the drafts under their own names.
 *
 * Three parts, all deterministic and pure (no model, no I/O, no clock):
 *
 * 1. `WRITING_STANDARD` is the compact instruction every model call that writes for a person is
 *    sent, through the rule path (`assembleInstructions` in server/harness/instruction-delivery.ts).
 * 2. `checkPlainWriting` scans finished text against the one rule list
 *    (`shared/plain-writing-rules.json`) plus the owner's own phrases. It skips what is not the
 *    model's prose: code blocks, inline code, file names and paths, links, quoted text, block
 *    quotes, table rows, and anything the person wrote (their message and their documents).
 * 3. `fixInCode` repairs the unambiguous cases without a model; `protectedTokens` and
 *    `rewriteKeepsFacts` are what a one-sentence rewrite must preserve exactly.
 *
 * Why not H16's stream evaluator (`server/stream-rules/evaluator.ts`): its pattern grammar refuses
 * anchors and word boundaries and allows one variable quantifier in a window of at most 512
 * characters, because it must be cheap per streamed chunk; this check needs the whole finished
 * text to know what is inside a code block, a quote or the person's own words. H16 also never
 * rewrites output, and it watches only the work loop. `NativeAgent`'s after-output `inspect` hook
 * asks the model to redo the whole answer on a correction, which the owner's repair rule forbids.
 */
import RULES from './plain-writing-rules.json' with { type: 'json' };

export const PLAIN_WRITING_VERSION: string = RULES.version;

export type PlainWritingRule =
  | 'em-dash'
  | 'filler-opener'
  | 'closing-offer'
  | 'contrast'
  | 'stacked-hedge'
  | 'stock-phrase'
  | 'owner-phrase';

export interface PlainWritingHit {
  readonly rule: PlainWritingRule;
  /** The text that matched, as written. */
  readonly match: string;
  readonly start: number;
  readonly end: number;
}

/** What one answer's check and repair did, kept on the answer's own record. */
export interface PlainWritingRecord {
  readonly v: 1;
  readonly version: string;
  /** The sha-256 of the text the model wrote, before any repair. */
  readonly originalSha256: string;
  /** What the check found in that text. */
  readonly hits: readonly { rule: PlainWritingRule; match: string }[];
  /** What code changed, in order. */
  readonly fixed: readonly { rule: PlainWritingRule; before: string; after: string }[];
  /** The one rewrite, when the route offered one and something was left to ask about. */
  readonly rewrite: {
    readonly asked: number;
    readonly accepted: number;
    readonly kept: readonly { sentence: string; reason: 'facts-changed' | 'not-better' | 'no-answer' }[];
    readonly changed: readonly { before: string; after: string }[];
    readonly error?: string;
  } | null;
  /** What still trips the check in the text that is shown. */
  readonly remaining: readonly { rule: PlainWritingRule; match: string }[];
}

export interface PlainWritingOptions {
  /** What the person wrote for this answer: their message and the documents it read. */
  readonly userTexts?: readonly string[];
  /** Phrases the owner added for this installation (Settings), matched like stock phrases. */
  readonly ownerPhrases?: readonly string[];
}

/**
 * The instruction. Compact because it is sent with every call; each rule carries its reason in
 * plain words. Measured in `tests/plain-writing.test.ts`.
 */
export const WRITING_STANDARD = [
  '--- NECTOVIA WRITING STANDARD ---',
  "For everything written for a person to read: answers, briefs, reports, drafted messages and summaries. Not for code, commit messages or text quoted from the person's files. The owner forwards this writing and sends drafts under their own name, so it must read like a careful person wrote it.",
  '- Answer first, in short direct sentences and plain words, so a busy reader gets it in one pass.',
  '- No em dashes. Use a comma, a colon, parentheses or a new sentence; readers take the dash as a sign of machine writing.',
  '- No opening pleasantries ("Great question", "Certainly", "I\'d be happy to") and no closing offers ("Let me know if you\'d like", "Feel free to"). They add length and say nothing.',
  '- No contrast flourishes ("It\'s not X. It\'s Y.", "not just X but Y"). State the point directly.',
  '- At most one hedge, and only where the source is uncertain. Stacked hedges hide the answer.',
  '- Skip stock words such as delve, robust, seamless, leverage, streamline, unlock and game-changer. They sound like marketing, not the owner.',
  '- Give numbers, names, dates and quotes exactly as the sources give them, because the reader acts on them.',
  '--- END NECTOVIA WRITING STANDARD ---',
].join('\n');

// --- skip zones ---------------------------------------------------------------------------

type Range = readonly [number, number];

/** A path, or a file name; a name may carry up to three capitalised words before it ("Fall menu.md"). */
const FILE_NAME =
  /(?:[\w.–—-]+[\\/])+[\w.–—-]+|(?:[\p{Lu}\d][\w-]*\s+){0,3}[\w–—-]+\.(?:md|txt|csv|tsv|json|pdf|docx?|xlsx?|pptx?|ts|tsx|js|mjs|py|rb|go|rs|java|svg|mmd|png|jpe?g|gif|html?|ya?ml|toml|log)\b/gu;
const URL = /\bhttps?:\/\/[^\s)>\]]+/g;

/**
 * Where the check does not look: text that is code, a name of a file, a link, somebody's quoted
 * words or a table's data. Returned sorted and merged.
 */
export function skipZones(text: string): Range[] {
  const zones: [number, number][] = [];
  // Fenced blocks (``` or ~~~), to their closing fence or the end of the text.
  const lines = text.split('\n');
  let offset = 0;
  let open: { at: number; fence: string } | null = null;
  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.fence[0] && fence[1].length >= open.fence.length) {
        zones.push([open.at, offset + line.length]);
        open = null;
      }
    } else if (fence) open = { at: offset, fence: fence[1] };
    else if (/^\s*>/.test(line) || /^\s*\|.*\|\s*$/.test(line)) zones.push([offset, offset + line.length]);
    offset += line.length + 1;
  }
  if (open) zones.push([open.at, text.length]);
  const add = (re: RegExp) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) zones.push([m.index, m.index + m[0].length]);
  };
  // Inline code may wrap onto the next line of its paragraph, never past a blank line.
  add(/`(?:[^`\n]|\n(?![ \t]*\n))+`/g);
  add(URL);
  add(FILE_NAME);
  // Quoted words: curly and straight double quotes within one line.
  add(/“[^”\n]{1,400}”/g);
  add(/"[^"\n]{1,400}"/g);
  zones.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const zone of zones) {
    const last = merged.at(-1);
    if (last && zone[0] <= last[1]) last[1] = Math.max(last[1], zone[1]);
    else merged.push([zone[0], zone[1]]);
  }
  return merged;
}

const inZones = (zones: readonly Range[], start: number, end: number) =>
  zones.some(([a, b]) => start < b && end > a);

/** Case, spacing and the punctuation around words do not decide whether words are the person's. */
const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/["“”'‘’()[\],.;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether a hit repeats what the person wrote: the match with the word on either side of it is
 * found in their message or one of their documents. A supplier's "Net 30 — due on receipt"
 * quoted back stays; the same dash in a sentence the model wrote does not.
 */
function fromUser(text: string, hit: { start: number; end: number }, users: readonly string[]): boolean {
  if (!users.length) return false;
  const lineStart = text.lastIndexOf('\n', hit.start - 1) + 1;
  const lineEnd = text.indexOf('\n', hit.end) === -1 ? text.length : text.indexOf('\n', hit.end);
  const before = text.slice(lineStart, hit.start).match(/\S+\s*$/)?.[0] ?? '';
  const after = text.slice(hit.end, lineEnd).match(/^\s*\S+/)?.[0] ?? '';
  const window = normal(`${before}${text.slice(hit.start, hit.end)}${after}`);
  if (window.length < 3) return false;
  return users.some((user) => normal(user).includes(window));
}

// --- matching -----------------------------------------------------------------------------

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]").replace(/ /g, '\\s+');
/** A phrase as a whole word or words, case-insensitive, with either apostrophe. */
const phrase = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}'’-])${escape(value)}(?![\\p{L}\\p{N}-])`, 'giu');

const STOCK = RULES.stockPhrases.map((value) => ({ value, re: phrase(value) }));
const OPENERS = RULES.fillerOpeners.map((value) => ({ value, re: new RegExp(`^${escape(value)}(?=[\\s,.!:;—-]|$)`, 'iu') }));
const OFFERS = RULES.closingOffers.map((value) => ({ value, re: phrase(value) }));
const CONTRAST = RULES.contrastPatterns.map((item) => ({ ...item, re: new RegExp(item.re, 'giu') }));
const HEDGE_ADVERBS = RULES.hedges.adverbs.map((value) => phrase(value));
const HEDGE_PHRASES = RULES.hedges.phrases.map((value) => phrase(value));
const HEDGE_MODALS = RULES.hedges.modals.map((value) => new RegExp(`(?<![\\p{L}])${value}(?![\\p{L}])`, 'gu'));

/** The prose the model wrote, as sentences with their offsets. Code and tables are not prose. */
export function sentences(text: string, zones: readonly Range[] = skipZones(text)): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    // A line wholly inside a fence, a table or a block quote holds no prose.
    if (zones.some(([a, b]) => a <= lineStart && b >= lineStart + line.length)) continue;
    // A point inside a number or a name ("9.50", "menu.md") does not end a sentence.
    const re = /(?:[^.!?]|[.!?](?![.!?]*(?:\s|$)))+(?:[.!?]+(?=\s|$))?/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (!m[0]) {
        re.lastIndex += 1;
        continue;
      }
      const lead = m[0].length - m[0].trimStart().length;
      const body = m[0].trim();
      if (body) out.push({ start: lineStart + m.index + lead, end: lineStart + m.index + lead + body.length, text: body });
    }
  }
  return out;
}

/** The first line of prose, with its markdown list or heading marker set aside. */
function firstProse(text: string, zones: readonly Range[]) {
  const first = sentences(text, zones)[0];
  if (!first) return null;
  const marker = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.exec(first.text)?.[0] ?? '';
  return { start: first.start + marker.length, text: first.text.slice(marker.length) };
}

/** The last paragraph of prose (a run of non-empty lines outside every skip zone). */
function lastParagraph(text: string, zones: readonly Range[]) {
  const list = sentences(text, zones);
  if (!list.length) return null;
  const last = list.at(-1)!;
  const blank = text.lastIndexOf('\n\n', last.start);
  const start = blank === -1 ? 0 : blank + 2;
  return { start, end: last.end };
}

/**
 * Every place `text` breaks the plain-writing rules, in order. Nothing in a skip zone and nothing
 * the person wrote is reported.
 */
export function checkPlainWriting(text: string, options: PlainWritingOptions = {}): PlainWritingHit[] {
  const zones = skipZones(text);
  const users = (options.userTexts ?? []).filter((user) => user && user.trim());
  const hits: PlainWritingHit[] = [];
  const push = (rule: PlainWritingRule, start: number, end: number) => {
    if (inZones(zones, start, end)) return;
    if (fromUser(text, { start, end }, users)) return;
    if (hits.some((hit) => hit.rule === rule && hit.start === start)) return;
    hits.push({ rule, match: text.slice(start, end), start, end });
  };
  const scan = (rule: PlainWritingRule, re: RegExp, within?: { start: number; end: number }) => {
    re.lastIndex = 0;
    const slice = within ? text.slice(within.start, within.end) : text;
    const base = within?.start ?? 0;
    for (let m = re.exec(slice); m; m = re.exec(slice)) {
      push(rule, base + m.index, base + m.index + m[0].length);
      if (!re.global) break;
    }
  };

  // Em dashes, a spaced en dash or a double hyphen used as a dash. An unspaced en dash is a range
  // ("9–5", "Mon–Fri") and stays; so do look-alikes from other scripts (ー, ―, ־, −).
  scan('em-dash', /\u2014| \u2013 | -- /g);

  // An opener is filler only in front of an answer: "Sure." as the whole reply is the answer.
  const lone = sentences(text, zones).length === 1;
  const opener = firstProse(text, zones);
  if (opener)
    for (const item of OPENERS) {
      const m = item.re.exec(opener.text);
      if (m && lone && /^[\s,.!:;]*$/.test(opener.text.slice(m.index + m[0].length))) break;
      if (m) {
        push('filler-opener', opener.start, opener.start + m[0].length);
        break;
      }
    }

  const closing = lastParagraph(text, zones);
  if (closing) for (const item of OFFERS) scan('closing-offer', item.re, closing);

  for (const item of CONTRAST) scan('contrast', item.re);

  for (const sentence of sentences(text, zones)) {
    let soft = 0;
    let modal = 0;
    for (const re of [...HEDGE_ADVERBS, ...HEDGE_PHRASES]) {
      re.lastIndex = 0;
      soft += sentence.text.match(re)?.length ?? 0;
    }
    for (const re of HEDGE_MODALS) {
      re.lastIndex = 0;
      modal += sentence.text.match(re)?.length ?? 0;
    }
    if (soft >= 1 && soft + modal >= 2) push('stacked-hedge', sentence.start, sentence.end);
  }

  for (const item of STOCK) scan('stock-phrase', item.re);
  for (const value of options.ownerPhrases ?? []) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length >= 2) scan('owner-phrase', phrase(trimmed));
  }
  return hits.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
}

// --- the facts a rewrite must keep --------------------------------------------------------

const COMMON = new Set(
  'the a an this that these those it its we you i he she they our your their if when for to in on at and but so please here there next then also yes no as by of or with from after before while because since until once each every all some most many few both either neither however still yet today tomorrow'.split(
    ' ',
  ),
);

/**
 * What a rewrite may not change: numbers (with their units and signs), capitalised names that are
 * not ordinary sentence words, quoted text, citations, file names and links. Compared as a
 * multiset, so a rewrite may reorder them and may never add, drop or alter one.
 */
export function protectedTokens(sentence: string): string[] {
  const tokens: string[] = [];
  const take = (re: RegExp) => {
    for (const m of sentence.matchAll(re)) tokens.push(m[0]);
  };
  take(/[$€£¥]?\d(?:[\d,.:/]*\d)?%?(?:\s?(?:am|pm|kg|g|lb|lbs|oz|km|mi|h|hrs?|mins?)\b)?/giu);
  take(/“[^”]*”|"[^"]*"/g);
  take(/\[\d+\]|\[[^\]]{1,80}\]\([^)]+\)/g);
  take(URL);
  take(FILE_NAME);
  for (const m of sentence.matchAll(/\b\p{Lu}[\p{L}'’-]*/gu))
    if (!COMMON.has(m[0].toLowerCase())) tokens.push(m[0]);
  return tokens.map((token) => token.trim()).sort();
}

/** True when `after` keeps every protected token of `before`, exactly and no more. */
export function rewriteKeepsFacts(before: string, after: string): boolean {
  const a = protectedTokens(before);
  const b = protectedTokens(after);
  return a.length === b.length && a.every((token, i) => token === b[i]);
}

// --- repairs in code ----------------------------------------------------------------------

export interface CodeFix {
  readonly rule: PlainWritingRule;
  readonly before: string;
  readonly after: string;
}

/** What follows a dash reads as its own clause: a subject pronoun ("no one" too), or a verb within five words. */
/** A finite verb: what makes the words before a dash a clause rather than a label. */
const CLAUSE_VERB =
  /\b(?:(?:is|are|was|were|has|have|had|does|do|did|wo|ca|could|should|would)n['’]t|is|are|was|were|has|have|had|will|would|can|could|should|must|does|did|costs?|sells?|sold|opens?|closes?|arrives?|arrived)\b/i;
const PRONOUN_LEAD =/^(?:i|you|we|they|he|she|it|there|no one|nobody|nothing|everyone|someone)\s/i;
const INDEPENDENT =
  /^(?:(?:i|you|we|they|he|she|it|this|that|these|those|there|here|no one|nobody|nothing|none|everyone|someone)\b|(?:\S+\s+){0,6}(?:(?:is|are|was|were|has|have|had|does|do|did|wo|ca|could|should|would)n['’]t|is|are|was|were|has|have|had|will|would|can|could|should|must|does|did|costs?|sells?|opens?|closes?|arrives?|arrived)\b)/i;

/**
 * Fix what is unambiguous without a model, and only that: an em dash between two clauses, a
 * filler opener that is a sentence of its own or leads one, and a closing offer that is the last
 * sentence. Punctuation and whole filler sentences only, so no number, name or quote can change.
 * Everything else is left for the one-sentence rewrite.
 */
export function fixInCode(text: string, options: PlainWritingOptions = {}): { text: string; fixes: CodeFix[] } {
  let current = text;
  const fixes: CodeFix[] = [];

  // 1. Em dashes, one sentence at a time, outside every skip zone and never in the person's words.
  const dashHits = checkPlainWriting(current, options).filter((hit) => hit.rule === 'em-dash');
  if (dashHits.length) {
    const zones = skipZones(current);
    const edits: { start: number; end: number; after: string; before: string }[] = [];
    for (const sentence of sentences(current, zones)) {
      const inside = dashHits.filter((hit) => hit.start >= sentence.start && hit.end <= sentence.end);
      if (!inside.length) continue;
      const fixed = fixDashes(sentence.text);
      if (fixed && fixed !== sentence.text)
        edits.push({ start: sentence.start, end: sentence.end, before: sentence.text, after: fixed });
    }
    // A dash that leads a line is a list marker.
    for (const hit of dashHits) {
      const lineStart = current.lastIndexOf('\n', hit.start - 1) + 1;
      if (current.slice(lineStart, hit.start).trim() === '' && !edits.some((edit) => hit.start >= edit.start && hit.start < edit.end))
        edits.push({ start: hit.start, end: hit.end, before: hit.match, after: '-' });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      current = current.slice(0, edit.start) + edit.after + current.slice(edit.end);
      fixes.unshift({ rule: 'em-dash', before: edit.before, after: edit.after });
    }
  }

  // 2. A filler opener: drop it when it is its own sentence, or when a comma or "!" ends it.
  const opener = checkPlainWriting(current, options).find((hit) => hit.rule === 'filler-opener');
  if (opener) {
    const first = sentences(current, skipZones(current)).find(
      (sentence) => sentence.start <= opener.start && sentence.end >= opener.end,
    );
    if (first) {
      const remainder = current.slice(opener.end, first.end);
      let cut: [number, number] | null = null;
      // The whole sentence is filler: "Great question!", "I'd be happy to help."
      if (/^[\s,.!:;]*$/.test(remainder) || /^\s+(?:to )?help(?: you)?(?: with (?:that|this))?[.!]?$/i.test(remainder))
        cut = [opener.start, first.end];
      // The opener leads a real sentence: "Certainly, the soup is 9.50."
      else if (/^\s*[,!:]\s+/.test(remainder)) cut = [opener.start, opener.end + /^\s*[,!:]\s+/.exec(remainder)![0].length];
      if (cut) {
        const after = current.slice(cut[1]).replace(/^[ \t]+/, '');
        const next = cut[1] === first.end ? after.replace(/^\s+/, '') : after.charAt(0).toUpperCase() + after.slice(1);
        const fixed = current.slice(0, cut[0]) + next;
        if (fixed.trim()) {
          fixes.push({ rule: 'filler-opener', before: current.slice(cut[0], cut[1]).trim(), after: '' });
          current = fixed;
        }
      }
    }
  }

  // 3. A closing offer that is the final sentence: drop that sentence.
  const offer = checkPlainWriting(current, options).filter((hit) => hit.rule === 'closing-offer').at(-1);
  if (offer) {
    const list = sentences(current, skipZones(current));
    const last = list.at(-1);
    if (last && offer.start >= last.start && offer.end <= last.end && list.length > 1 && /^[^.!?]*[.!?]?$/.test(last.text)) {
      const lead = current.slice(last.start, offer.start).trim();
      // Only a sentence that is the offer: nothing before it but a short connective.
      if (!lead || /^(?:and|so|also|please|just)$/i.test(lead)) {
        fixes.push({ rule: 'closing-offer', before: last.text, after: '' });
        current = (current.slice(0, last.start).replace(/[ \t]+$/, '') + current.slice(last.end)).replace(/\n{3,}/g, '\n\n').trimEnd();
      }
    }
  }
  return { text: current, fixes };
}

/**
 * One sentence's em dashes, or null when no rule here is clearly safe.
 *
 * - digit–digit: a range, written with an en dash;
 * - a pair: an aside, set off with commas (parentheses when the aside has its own comma);
 * - one: a new sentence when what follows starts like a clause ("— we", "— it"), else a colon,
 *   or a comma when the sentence already has a colon.
 */
export function fixDashes(sentence: string): string | null {
  const DASH = /\s*(?:—| – | -- )\s*/g;
  const text = sentence.replace(/(\d)\s*—\s*(\d)/g, '$1–$2');
  const parts = text.split(DASH);
  if (parts.length === 1) return text;
  if (parts.some((part, i) => !part.trim() && i > 0 && i < parts.length - 1)) return null;
  // A pair around a short aside: commas, or parentheses when the aside has its own commas. Two
  // dashes that each start a list ("4 open — items 2, 3; 2 unverified — items 4, 8") are no pair.
  if (parts.length === 3 && parts[1]!.trim() && parts[2]!.trim()) {
    const aside = parts[1]!.trim();
    if (!/[;:]/.test(aside) && aside.split(/\s+/).length <= 12)
      return aside.includes(',')
        ? `${parts[0]!.trimEnd()} (${aside}) ${parts[2]!.trimStart()}`
        : `${parts[0]!.trimEnd()}, ${aside}, ${parts[2]!.trimStart()}`;
  }
  let out = parts[0]!;
  for (const part of parts.slice(1)) {
    const joined = joinAtDash(out, part);
    if (joined === null) return null;
    out = joined;
  }
  return out;
}

/** One dash between `left` and `right`, replaced by what the two sides need. */
function joinAtDash(leftRaw: string, rightRaw: string): string | null {
  const [left, right] = [leftRaw.trimEnd(), rightRaw.trimStart()];
  if (!left) return null;
  if (!right || /^[.!?]/.test(right)) return `${left}${right}`;
  if (/[,;:]$/.test(left)) return null;
  // The clause the dash ends, from the last full stop or semicolon.
  const clause = left.split(/[;.!?]\s+/).pop()!;
  const colon = () => (clause.includes(':') ? `${left}, ${right}` : `${left}: ${right}`);
  const sentence = () => `${left}. ${right.charAt(0).toUpperCase()}${right.slice(1)}`;
  if (PRONOUN_LEAD.test(right)) return sentence();
  // A short label before the dash ("Brandt & Rowe crew — close out three items") takes a colon.
  const label = clause.replace(/[*_#>`]+/g, ' ').replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').trim();
  if (label.split(/\s+/).length <= 5 && !CLAUSE_VERB.test(label)) return colon();
  if (INDEPENDENT.test(right)) return sentence();
  return colon();
}
