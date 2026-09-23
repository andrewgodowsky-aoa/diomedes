// The thread list's preview line: a turn's durable text, reduced to one short
// line. A fence never reads raw here, the way a bare slice of the text would
// show it — this is what stands in for a heading, a paragraph, an artifact or
// a chart instead. Pure: no React, no DOM, no clock.

import { declarationOf, isVisualBlock, visualOf } from './artifacts';
import {
  artifactKindOf,
  KIND_LABEL,
  parseBlocks,
  plainText,
  type CodeBlock,
  type TurnBlock,
} from './turn-blocks';

const ELLIPSIS = '…';

/** One line, whitespace collapsed, cut at `max` with its last character an ellipsis. */
function cut(line: string, max: number): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`;
}

/** An artifact fence or table's own line: its declared title, or its bare kind. */
function artifactLine(block: TurnBlock): string {
  const kind = artifactKindOf(block)!;
  const source = block.type === 'code' ? block.source : '';
  const title = declarationOf(kind, source).title;
  return title ? `${KIND_LABEL[kind]}: ${title}` : KIND_LABEL[kind];
}

/** A ```visual block's own line: its declared title, or the generic "Chart". */
function visualLine(block: CodeBlock): string {
  const read = visualOf(block.source);
  const title = read.ok && 'title' in read.spec && read.spec.title;
  return title || 'Chart';
}

/**
 * The thread list's line for one turn's raw text, at most `max` characters
 * (an ellipsis takes the last one when the line is cut). Each rule below scans
 * the whole turn for its own kind of block, in order, and the first one found
 * wins — so a diagram that opens a turn never beats a real opening line that
 * follows it, and a plain code fence never beats a later diagram:
 *   1. the first heading or paragraph that has words, as plain text;
 *   2. otherwise the first artifact fence or table, as its kind and title;
 *   3. otherwise the first ```visual block, by its own title or "Chart";
 *   4. otherwise the first fence of any other kind, as "Code";
 *   5. otherwise, nothing: ''.
 */
export function previewLine(text: string, max: number): string {
  const blocks = parseBlocks(text);

  const prose = blocks.find(
    (block): block is Extract<TurnBlock, { type: 'heading' | 'paragraph' }> =>
      (block.type === 'heading' || block.type === 'paragraph') &&
      plainText(block.text).trim() !== '',
  );
  if (prose) return cut(plainText(prose.text), max);

  const artifact = blocks.find((block) => artifactKindOf(block));
  if (artifact) return cut(artifactLine(artifact), max);

  const visual = blocks.find(isVisualBlock);
  if (visual) return cut(visualLine(visual), max);

  const code = blocks.find((block) => block.type === 'code');
  if (code) return cut('Code', max);

  return '';
}
