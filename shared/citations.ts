/**
 * The source tags the weekly brief writes, read back so a person sees a source, never an id.
 *
 * The brief (server/weekly-brief.ts) ends every claim line with `[<id>]` and lists each id under
 * `## Sources` as `- [<id>] <label> (<path>, SHA-256: <sha>)` (before plain writing, 2026-09-25:
 * `<label> — <path> (SHA-256: <sha>)`, still read). That text is the brief's record and
 * its change detection reads it back, so it is never rewritten; only its rendering changes. A
 * reader of the brief resolves each tag through the document's own Sources list. An answer that
 * quotes a tag resolves it through the project's recorded files, by the same slug the brief made
 * the id from. Pure: no React, no DOM.
 */
import { readableFileName, readableWords } from './display-names.js';

/** A path slug, so a reference reads like the file it came from: `Imports/pos.txt` → `imports-pos`. */
export function sourceSlug(selected: string): string {
  const base = selected.split('/').pop() ?? selected;
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const folder = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '';
  const slug = `${folder} ${stem}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'source' : slug;
}

export interface CitedSource {
  readonly id: string;
  /** What a person reads: the file's readable name. */
  readonly name: string;
  readonly path: string;
  /** The exact bytes the brief read, when the brief recorded them. */
  readonly sha: string | null;
}

/** `- [<id>] <label> (<path>, SHA-256: <sha>)`; a path may hold balanced parentheses. */
const SOURCE_LINE =
  /^\s*[-*]\s+\[([^\]\s]+)\]\s+.*?\s\(((?:[^()]|\([^()]*\))+?),\s*SHA-256:\s*([a-f0-9]{64})\)\s*$/;
/** The same line as briefs wrote it before plain writing: `- [<id>] <label> — <path> (SHA-256: <sha>)`. */
const SOURCE_LINE_DASHED = /^\s*[-*]\s+\[([^\]\s]+)\]\s+.*\s—\s(.+?)\s\(SHA-256:\s*([a-f0-9]{64})\)\s*$/;

/**
 * The `## Sources` list of a brief, by id. Empty for a document that has none, which is how a
 * reader knows the document is not a brief and leaves its brackets alone.
 */
export function briefSources(markdown: string): Map<string, CitedSource> {
  const sources = new Map<string, CitedSource>();
  let inSources = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inSources = /^##\s+Sources\s*$/.test(line.trim());
      continue;
    }
    if (!inSources) continue;
    const match = SOURCE_LINE_DASHED.exec(line) ?? SOURCE_LINE.exec(line);
    if (!match) continue;
    const [, id, path, sha] = match;
    sources.set(id, { id, name: readableFileName(path), path, sha });
  }
  return sources;
}

/** An id as the brief makes them: lower-case slug words, a per-run `-<n>` suffix allowed. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Resolves an id against project files by the brief's own slug rule: `imports-pos-weekly-summary-1`
 * names `Imports/pos-weekly-summary.txt`. Null when no file makes that slug.
 */
export function resolveBySlug(id: string, paths: Iterable<string>): CitedSource | null {
  if (!ID.test(id)) return null;
  const base = id.replace(/-\d+$/, '');
  for (const path of paths) {
    const slug = sourceSlug(path);
    if (slug === id || slug === base) return { id, name: readableFileName(path), path, sha: null };
  }
  return null;
}

/** The readable words an unresolved id stands for, never the id itself. */
export function citationName(id: string): string {
  return readableWords(id.replace(/-\d+$/, ''));
}

export type CitationPart =
  | { type: 'text'; text: string }
  | { type: 'cite'; source: CitedSource }
  | { type: 'named'; id: string; name: string };

/** One bracketed group of ids: `[a-b]` or `[a-b, c-d]`, never a link's text `[x](…)`. */
const GROUP = /\[([A-Za-z0-9][A-Za-z0-9-]*(?:,\s*[A-Za-z0-9][A-Za-z0-9-]*)*)\](?!\()/g;

/**
 * A run of text with its source tags taken apart. `resolve` names a tag's source, or null.
 * With `strict`, a group any of whose ids does not resolve stays the text it was: in an answer a
 * bracket may be anything. Without it (a brief, which only brackets ids), an unresolved id that is
 * shaped like one reads as its words.
 */
export function splitCitations(
  text: string,
  resolve: (id: string) => CitedSource | null,
  strict: boolean,
): CitationPart[] {
  const out: CitationPart[] = [];
  let last = 0;
  for (const match of text.matchAll(GROUP)) {
    const at = match.index ?? 0;
    const ids = match[1].split(/,\s*/);
    const parts: CitationPart[] = [];
    for (const id of ids) {
      const source = resolve(id);
      if (source) parts.push({ type: 'cite', source });
      else if (!strict && ID.test(id)) parts.push({ type: 'named', id, name: citationName(id) });
      else break;
    }
    if (parts.length !== ids.length) continue;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    out.push(...parts);
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
