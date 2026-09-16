/**
 * Bounded exact-content evidence for the technical drill-down.
 *
 * Every claim in the Verified Summary already cites typed evidence; this module
 * produces the bytes a technical user inspects one level deeper: a real
 * before→after line diff when both sides were retained, or a clearly-labelled
 * excerpt of the side that exists. It never emits a byte the review cannot
 * bound — binary files produce `kind:'none'` with reason 'binary', oversized
 * sides produce the same with 'unreadable', and every truncation is declared
 * with the count of lines it cut.
 *
 * Bounds: at most `TEXT_EVIDENCE_MAX_LINES` changed lines and
 * `TEXT_EVIDENCE_MAX_CHARS` characters per entry, and
 * `TEXT_EVIDENCE_TOTAL_CHARS` across one manifest — the service declares the
 * rest in `coverage.limits`.
 */

import { diffLines } from 'diff';
import type { ChangeTextEvidence } from '../../shared/change-manifest.js';

/** Changed (+/−) lines kept per entry. */
export const TEXT_EVIDENCE_MAX_LINES = 200;
/** Characters kept per entry. */
export const TEXT_EVIDENCE_MAX_CHARS = 16 * 1024;
/** Total text evidence one manifest carries. */
export const TEXT_EVIDENCE_TOTAL_CHARS = 256 * 1024;
/** Input bound: sides longer than this are not diffed at all. */
export const TEXT_EVIDENCE_INPUT_LIMIT = 512 * 1024;

interface ChangePart {
  readonly value: string;
  readonly added?: boolean;
  readonly removed?: boolean;
  readonly count?: number;
}

const none = (reason: string): ChangeTextEvidence => ({
  kind: 'none',
  text: null,
  truncated: false,
  truncatedLines: 0,
  reason,
});

const splitLines = (value: string): string[] => value.replace(/\n$/, '').split('\n');

/** Render diff parts as a unified-ish excerpt: −/+/context lines, long
 *  unchanged runs collapsed to a visible marker. Bounded, declared. */
function renderDiff(parts: readonly ChangePart[]): ChangeTextEvidence {
  const out: string[] = [];
  let changed = 0;
  let cut = 0;
  let chars = 0;
  let over = false;
  const push = (line: string): boolean => {
    if (over) return false;
    if (chars + line.length > TEXT_EVIDENCE_MAX_CHARS) {
      over = true;
      return false;
    }
    out.push(line);
    chars += line.length + 1;
    return true;
  };
  for (let p = 0; p < parts.length && !over; p += 1) {
    const part = parts[p];
    const lines = splitLines(part.value);
    if (part.added || part.removed) {
      for (let i = 0; i < lines.length; i += 1) {
        if (changed >= TEXT_EVIDENCE_MAX_LINES || !push(`${part.added ? '+' : '-'}${lines[i]}`)) {
          cut += lines.length - i;
          over = true;
          break;
        }
        changed += 1;
      }
    } else if (lines.length <= 3) {
      for (const line of lines) push(` ${line}`);
    } else {
      push(` ${lines[0]}`);
      push(` ⋮ ${lines.length - 2} unchanged`);
      push(` ${lines[lines.length - 1]}`);
    }
    if (over)
      for (const later of parts.slice(p + 1))
        if (later.added || later.removed) cut += splitLines(later.value).length;
  }
  return {
    kind: 'diff',
    text: out.join('\n'),
    truncated: cut > 0 || over,
    truncatedLines: cut,
    reason: null,
  };
}

/** A bounded excerpt of one side, labelled by the caller. */
function renderExcerpt(text: string): ChangeTextEvidence {
  const lines = text.split('\n');
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= TEXT_EVIDENCE_MAX_LINES || chars + line.length > TEXT_EVIDENCE_MAX_CHARS)
      break;
    kept.push(line);
    chars += line.length + 1;
  }
  const truncated = kept.length < lines.length;
  return {
    kind: 'excerpt',
    text: kept.join('\n'),
    truncated,
    truncatedLines: truncated ? lines.length - kept.length : 0,
    reason: null,
  };
}

export interface TextEvidenceInput {
  readonly binary: boolean;
  readonly deleted: boolean;
  readonly before: string | null;
  readonly after: string | null;
  /** Stored diff parts from the write record, when they exist. */
  readonly hunks?: readonly ChangePart[] | null;
}

/**
 * Produce the bounded evidence for one change. `before`/`after` must already
 * be bounded by the caller's read limits; binary and oversized content never
 * reaches this function as text.
 */
export function textEvidenceFor(input: TextEvidenceInput): ChangeTextEvidence {
  if (input.binary) return none('binary');
  const { before, after } = input;
  if (input.deleted)
    return before !== null ? renderExcerpt(before) : none('no-before');
  if (before !== null && after !== null) {
    if (before.length > TEXT_EVIDENCE_INPUT_LIMIT || after.length > TEXT_EVIDENCE_INPUT_LIMIT)
      return none('unreadable');
    const parts =
      input.hunks && input.hunks.length
        ? input.hunks
        : diffLines(before, after);
    return renderDiff(parts);
  }
  if (after !== null) return renderExcerpt(after);
  return none(before === null ? 'no-before' : 'unreadable');
}
