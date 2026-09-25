/**
 * H16: incremental matching over a model's streamed text.
 *
 * A stream arrives in chunks of any size, and a phrase can straddle two of
 * them. The evaluator keeps only the last `window - 1` characters between
 * chunks — the longest text a rule can still need from before — and looks at
 * that carry plus the new text, reporting a match only when it ends in the new
 * text, so no match is reported twice and none is missed across a boundary.
 * Nothing else of the stream is kept.
 *
 * Cost per chunk is bounded: a chunk is evaluated in slices of at most
 * `STREAM_RULE_LIMITS.slice` characters, each against at most
 * `slice + window - 1` characters, once per rule that has not fired yet. A rule
 * fires at most once per stream. After `end()` the evaluator is inert: a late
 * chunk is ignored and the carry is dropped without being matched again, so
 * nothing fires after the stream has ended.
 */
import { STREAM_RULE_LIMITS, type StreamRule } from '../../shared/stream-rules.js';

export interface StreamHit {
  /** Index of the rule in the list the evaluator was built with. */
  readonly rule: number;
  /** Offsets in the whole stream, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Compiled {
  readonly index: number;
  readonly window: number;
  find(hay: string, from: number): { at: number; length: number } | null;
}

function compile(rule: StreamRule, index: number): Compiled | null {
  const match = rule.match;
  if (match.kind === 'text') {
    const needle = match.phrase;
    if (match.caseSensitive === true)
      return {
        index,
        window: needle.length,
        find(hay, from) {
          const at = hay.indexOf(needle, from);
          return at === -1 ? null : { at, length: needle.length };
        },
      };
    // Folded by the regex engine, one code unit for one, so offsets are the text's own:
    // `toLowerCase` can lengthen a string (İ becomes two), which moved every later span.
    const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return {
      index,
      window: needle.length,
      find(hay, from) {
        expression.lastIndex = from;
        const found = expression.exec(hay);
        return found ? { at: found.index, length: found[0].length } : null;
      },
    };
  }
  if (match.kind === 'pattern') {
    const expression = new RegExp(match.pattern, match.caseSensitive === true ? 'g' : 'gi');
    return {
      index,
      window: match.window,
      find(hay, from) {
        expression.lastIndex = from;
        for (;;) {
          const found = expression.exec(hay);
          if (!found) return null;
          // An empty match says nothing; step past it.
          if (found[0].length > 0) return { at: found.index, length: found[0].length };
          expression.lastIndex = found.index + 1;
          if (expression.lastIndex > hay.length) return null;
        }
      },
    };
  }
  return null;
}

export class StreamEvaluator {
  private readonly rules: Compiled[];
  private readonly keep: number;
  private carry = '';
  /** Offset of the carry's first character in the whole stream. */
  private offset = 0;
  private readonly fired = new Set<number>();
  private done = false;
  private received = 0;

  constructor(
    rules: readonly StreamRule[],
    private readonly onHit: (hit: StreamHit) => void,
  ) {
    this.rules = rules.flatMap((rule, index) => compile(rule, index) ?? []);
    this.keep = Math.max(0, ...this.rules.map((rule) => rule.window - 1));
  }

  /** Characters held between chunks. Never more than the longest window less one. */
  get buffered(): number {
    return this.carry.length;
  }
  get ended(): boolean {
    return this.done;
  }
  /** Characters the stream carried, whether or not any rule was watching. */
  get length(): number {
    return this.received;
  }

  push(chunk: string): void {
    if (this.done || typeof chunk !== 'string' || !chunk) return;
    this.received += chunk.length;
    if (!this.rules.length) return;
    for (let from = 0; from < chunk.length; from += STREAM_RULE_LIMITS.slice)
      this.scan(chunk.slice(from, from + STREAM_RULE_LIMITS.slice));
  }

  private scan(piece: string) {
    const hay = this.carry + piece;
    const boundary = this.carry.length;
    for (const rule of this.rules) {
      if (this.fired.has(rule.index)) continue;
      // A match ending inside the carry was already looked for; start where one could end after it.
      let from = Math.max(0, boundary - rule.window + 1);
      for (;;) {
        const found = rule.find(hay, from);
        if (!found) break;
        const end = found.at + found.length;
        if (end > boundary) {
          this.fired.add(rule.index);
          this.onHit({
            rule: rule.index,
            start: this.offset + found.at,
            end: this.offset + end,
            text: hay.slice(found.at, end),
          });
          break;
        }
        from = found.at + 1;
      }
    }
    const kept = this.keep === 0 ? '' : hay.slice(-this.keep);
    this.offset += hay.length - kept.length;
    this.carry = kept;
  }

  /** The stream is over. Nothing is matched again and anything carried is dropped. */
  end(): void {
    this.done = true;
    this.carry = '';
  }
}
