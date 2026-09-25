/**
 * The repair pass over a finished answer (plain writing, Andrew 2026-09-25).
 *
 * One pass, never a loop:
 *
 * 1. Check (`checkPlainWriting`). Nothing found: the answer goes as it is.
 * 2. Fix in code what is unambiguous (`fixInCode`): an em dash between clauses, a filler opener,
 *    a closing offer that is the last sentence. Punctuation and whole filler sentences only.
 * 3. Where the route can take it, send **only the sentences still flagged**, once, for a short
 *    rewrite. A rewritten sentence is kept only when every number, name, date, quote, citation and
 *    file name it had is still there exactly (`rewriteKeepsFacts`) and it breaks fewer rules;
 *    otherwise the original sentence stays. The rewrite is asked at most once per answer.
 * 4. Whatever still trips the check is shown as it is, and the record says so.
 *
 * The record (`PlainWritingRecord`) goes on the run's own record for the answer, so the rate of
 * hits, fixes and rewrites can be counted from evidence. It names what changed, sentence by
 * sentence; the model's own text stays in the model step that produced it.
 */
import { createHash } from 'node:crypto';
import {
  PLAIN_WRITING_VERSION,
  checkPlainWriting,
  fixInCode,
  rewriteKeepsFacts,
  sentences,
  skipZones,
  type PlainWritingHit,
  type PlainWritingOptions,
  type PlainWritingRecord,
  type PlainWritingRule,
} from '../shared/plain-writing.js';

export type { PlainWritingRecord };

/** The most sentences one rewrite asks about: a bound on its cost, whatever the answer's length. */
export const REWRITE_MAX_SENTENCES = 12;
const CLIP = 300;
const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text);


/** One sentence sent for a rewrite, with the problems it has, in plain words. */
export interface RewriteItem {
  readonly id: string;
  readonly sentence: string;
  readonly problems: readonly string[];
}

/** What the route does with the items: one model call, answering JSON `{ id: sentence }`. */
export type Rewriter = (prompt: string) => Promise<string>;

export const REWRITE_INSTRUCTIONS =
  'You fix single sentences. For each numbered sentence, write it again so it no longer has the problem named after it, and keep its meaning. Keep every number, name, date, quoted phrase, citation and file name exactly as written. Use no em dashes, no opening pleasantries and no offers of more help. Reply with only a JSON object that maps each number to its new sentence, like {"1": "..."}.';

const PROBLEM: Record<PlainWritingRule, (match: string) => string> = {
  'em-dash': () => 'an em dash',
  'filler-opener': () => 'an opening pleasantry',
  'closing-offer': () => 'an offer of more help',
  contrast: () => 'contrast framing',
  'stacked-hedge': () => 'stacked hedges',
  'stock-phrase': (match) => `the stock phrase "${match}"`,
  'owner-phrase': (match) => `the phrase "${match}", which the owner asked to avoid`,
};

export function rewritePrompt(items: readonly RewriteItem[]): string {
  return items.map((item) => `${item.id}. [${item.problems.join('; ')}] ${item.sentence}`).join('\n');
}

/** The JSON object in a model's reply, or null. Tolerates a fence or words around it. */
export function parseRewrite(reply: string): Record<string, string> | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') out[key] = value.trim();
    return out;
  } catch {
    return null;
  }
}

const brief = (hits: readonly PlainWritingHit[]) => hits.slice(0, 40).map((hit) => ({ rule: hit.rule, match: clip(hit.match) }));

/**
 * Check, fix in code, and (when `rewrite` is given) ask once about the sentences still flagged.
 * Never throws for a rewrite that fails: the answer then goes with what code fixed.
 */
export async function repairWriting(input: {
  text: string;
  options?: PlainWritingOptions;
  rewrite?: Rewriter;
}): Promise<{ text: string; record: PlainWritingRecord }> {
  const options = input.options ?? {};
  const originalSha256 = createHash('sha256').update(input.text, 'utf8').digest('hex');
  const hits = checkPlainWriting(input.text, options);
  const base = { v: 1 as const, version: PLAIN_WRITING_VERSION, originalSha256, hits: brief(hits) };
  if (!hits.length) return { text: input.text, record: { ...base, fixed: [], rewrite: null, remaining: [] } };

  const coded = fixInCode(input.text, options);
  let text = coded.text;
  const fixed = coded.fixes.map((fix) => ({ rule: fix.rule, before: clip(fix.before), after: clip(fix.after) }));
  let left = checkPlainWriting(text, options);
  let rewrite: PlainWritingRecord['rewrite'] = null;

  if (left.length && input.rewrite) {
    const list = sentences(text, skipZones(text));
    const flagged = list
      .map((sentence) => ({
        sentence,
        hits: left.filter((hit) => hit.start >= sentence.start && hit.end <= sentence.end),
      }))
      .filter((item) => item.hits.length)
      .slice(0, REWRITE_MAX_SENTENCES);
    const items: RewriteItem[] = flagged.map((item, i) => ({
      id: String(i + 1),
      sentence: item.sentence.text,
      problems: [...new Set(item.hits.map((hit) => PROBLEM[hit.rule](hit.match)))],
    }));
    if (items.length) {
      const kept: { sentence: string; reason: 'facts-changed' | 'not-better' | 'no-answer' }[] = [];
      const changed: { before: string; after: string }[] = [];
      let error: string | undefined;
      let answers: Record<string, string> | null = null;
      try {
        answers = parseRewrite(await input.rewrite(rewritePrompt(items)));
        if (!answers) error = 'The rewrite did not answer with the JSON it was asked for.';
      } catch (failure) {
        error = failure instanceof Error ? clip(failure.message) : 'The rewrite failed.';
      }
      const edits: { start: number; end: number; after: string }[] = [];
      flagged.forEach((item, i) => {
        const candidate = answers?.[String(i + 1)]?.replace(/\s+/g, ' ').trim();
        const original = item.sentence.text;
        if (!candidate) return void kept.push({ sentence: clip(original), reason: 'no-answer' });
        if (!rewriteKeepsFacts(original, candidate))
          return void kept.push({ sentence: clip(original), reason: 'facts-changed' });
        if (checkPlainWriting(candidate, options).length >= item.hits.length || candidate.length > original.length * 2 + 40)
          return void kept.push({ sentence: clip(original), reason: 'not-better' });
        edits.push({ start: item.sentence.start, end: item.sentence.end, after: candidate });
        changed.push({ before: clip(original), after: clip(candidate) });
      });
      for (const edit of edits.sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.after + text.slice(edit.end);
      rewrite = { asked: items.length, accepted: edits.length, kept, changed, ...(error ? { error } : {}) };
      left = checkPlainWriting(text, options);
    }
  }
  return { text, record: { ...base, fixed, rewrite, remaining: brief(left) } };
}
