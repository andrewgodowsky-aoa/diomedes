// Artifacts, derived from the record. Every artifact the Console shows is read
// out of a durable turn's text (or a saved file's text) by this module and by
// nothing else: there is no artifact store, no artifact field on a Turn and no
// lifecycle of its own (AGENTS.md, "no parallel lifecycle"). Pure: no React, no
// DOM, no clock, no network.

import {
  artifactKindOf,
  KIND_LABEL,
  normalizeNewlines,
  parseBlocks,
  plainText,
  type ArtifactKind,
  type TableBlock,
  type TurnBlock,
} from './turn-blocks';

/** Any record with the three fields a turn is read from. */
export interface TurnLike {
  id?: string;
  role: string;
  text: string;
}

export interface ArtifactRecord {
  /** `art-` and a short digest of (scope, turn, block index): unique per block. */
  key: string;
  /** The thread (or `file:<path>`) the artifact was read from. */
  scope: string;
  /** What versions share: the declared id, or the key when nothing was declared. */
  identity: string;
  declaredId: string | null;
  kind: ArtifactKind;
  /** The fence language as written, lower-cased; '' for a table. */
  lang: string;
  title: string;
  /** The fence body exactly as written, or the table's own lines. */
  source: string;
  table: TableBlock | null;
  turnKey: string;
  turnIndex: number;
  blockIndex: number;
  /** 1-based position among the versions that share this identity. */
  version: number;
  versionCount: number;
}

export interface ArtifactIndex {
  scope: string;
  /** Every artifact in turn order, then block order. */
  list: readonly ArtifactRecord[];
  byKey: ReadonlyMap<string, ArtifactRecord>;
  versionsOf(record: ArtifactRecord): readonly ArtifactRecord[];
  forBlock(turnKey: string, blockIndex: number): ArtifactRecord | undefined;
}

// ---- parse cache ------------------------------------------------------------

const CACHE_LIMIT = 400;
const cache = new Map<string, TurnBlock[]>();

/**
 * The blocks of one text, parsed once. The thread view and the artifact index
 * both read a turn's blocks and must agree on every index, so both ask here.
 * The state stream refetches every thread on every event, so the same texts
 * come back over and over.
 */
export function blocksOf(text: string): TurnBlock[] {
  const found = cache.get(text);
  if (found) {
    cache.delete(text);
    cache.set(text, found);
    return found;
  }
  const blocks = parseBlocks(text);
  cache.set(text, blocks);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return blocks;
}

// ---- identity ---------------------------------------------------------------

/** A short, stable, non-cryptographic digest (cyrb53) in base 36. */
export function shortDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
}

export function artifactKey(scope: string, turnKey: string, blockIndex: number): string {
  return `art-${shortDigest(JSON.stringify([scope, turnKey, blockIndex]))}`;
}

/** A declared id: a letter or digit, then up to 63 of letters, digits, `.`, `_` and `-`. */
export const DECLARED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TITLE_LIMIT = 120;

export interface Declaration {
  id: string | null;
  title: string | null;
}

function attributes(text: string): Declaration {
  const out: Declaration = { id: null, title: null };
  for (const match of text.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g)) {
    const name = match[1].toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (name === 'id' && DECLARED_ID.test(value)) out.id = value;
    if (name === 'title' && value) out.title = value.slice(0, TITLE_LIMIT);
  }
  return out;
}

function firstLine(source: string): string {
  return normalizeNewlines(source).split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

const MERMAID_DECLARATION = /^%%\s*artifact:\s*(.*)$/i;
const COMMENT_DECLARATION = /^<!--\s*artifact:\s*([\s\S]*?)\s*-->$/i;

/**
 * The identity a model may declare on an artifact's first line, so a later
 * turn can add a version of the same artifact:
 *   mermaid:  %% artifact: id=delivery-flow title="Delivery check"
 *   html, svg, markdown:  <!-- artifact: id=home-mock title="Home mock" -->
 *   chart:    top-level "id" and "title" fields
 */
export function declarationOf(kind: ArtifactKind, source: string): Declaration {
  if (kind === 'table') return { id: null, title: null };
  if (kind === 'chart') {
    try {
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { id: null, title: null };
      const record = value as Record<string, unknown>;
      return {
        id: typeof record.id === 'string' && DECLARED_ID.test(record.id) ? record.id : null,
        title:
          typeof record.title === 'string' && record.title.trim()
            ? record.title.trim().slice(0, TITLE_LIMIT)
            : null,
      };
    } catch {
      return { id: null, title: null };
    }
  }
  const line = firstLine(source);
  const match =
    kind === 'diagram' ? MERMAID_DECLARATION.exec(line) : COMMENT_DECLARATION.exec(line);
  return match ? attributes(match[1]) : { id: null, title: null };
}

/** The source without its declaration line, for the renderers that would show it. */
export function withoutDeclaration(kind: ArtifactKind, source: string): string {
  const lines = normalizeNewlines(source).split('\n');
  const at = lines.findIndex((line) => line.trim() !== '');
  if (at < 0) return source;
  const line = lines[at].trim();
  const declared = kind === 'diagram' ? MERMAID_DECLARATION.test(line) : COMMENT_DECLARATION.test(line);
  if (!declared) return source;
  return [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
}

// ---- titles -----------------------------------------------------------------

const BOLD_LINE = /^\*\*(.+?)\*\*:?$/;

function cleanTitle(text: string): string {
  return plainText(text)
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim()
    .slice(0, TITLE_LIMIT);
}

/**
 * The nearest heading or bold line above an artifact in its own turn. The
 * search stops at an earlier artifact, so two diagrams under one heading do
 * not both borrow it.
 */
export function nearbyTitle(blocks: readonly TurnBlock[], blockIndex: number): string | null {
  for (let index = blockIndex - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (artifactKindOf(block)) return null;
    if (block.type === 'heading' && block.text.trim()) return cleanTitle(block.text) || null;
    if (block.type === 'paragraph') {
      const lines = block.text.split('\n');
      for (let line = lines.length - 1; line >= 0; line -= 1) {
        const bold = BOLD_LINE.exec(lines[line].trim());
        if (bold) return cleanTitle(bold[1]) || null;
      }
    }
  }
  return null;
}

// ---- the index --------------------------------------------------------------

/** A table's own lines, as a Markdown table, for Copy source and Save. */
export function tableSource(table: TableBlock): string {
  const row = (cells: readonly string[]) =>
    `| ${cells.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`;
  const rule = table.align.map((align) =>
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---',
  );
  return [row(table.header), `| ${rule.join(' | ')} |`, ...table.rows.map(row)].join('\n');
}

/** The key a turn is known by: its id, or its place when an old record has none. */
export function turnKeyOf(turn: TurnLike, index: number): string {
  return turn.id ? turn.id : `#${index}`;
}

/**
 * Every artifact in one scope's assistant turns. Versions are grouped by the
 * declared id and ordered by turn order, then block order; an artifact that
 * declares nothing is the only version of itself.
 */
export function indexArtifacts(scope: string, turns: readonly TurnLike[]): ArtifactIndex {
  const list: ArtifactRecord[] = [];
  const ordinal: Partial<Record<ArtifactKind, number>> = {};
  turns.forEach((turn, turnIndex) => {
    if (turn.role === 'you' || !turn.text) return;
    const turnKey = turnKeyOf(turn, turnIndex);
    const blocks = blocksOf(turn.text);
    blocks.forEach((block, blockIndex) => {
      const kind = artifactKindOf(block);
      if (!kind) return;
      ordinal[kind] = (ordinal[kind] ?? 0) + 1;
      const source =
        block.type === 'code' ? block.source : block.type === 'table' ? tableSource(block) : '';
      const declared = declarationOf(kind, source);
      const key = artifactKey(scope, turnKey, blockIndex);
      list.push({
        key,
        scope,
        identity: declared.id ? `id:${declared.id}` : key,
        declaredId: declared.id,
        kind,
        lang: block.type === 'code' ? block.lang : '',
        title:
          declared.title ?? nearbyTitle(blocks, blockIndex) ?? `${KIND_LABEL[kind]} ${ordinal[kind]}`,
        source,
        table: block.type === 'table' ? block : null,
        turnKey,
        turnIndex,
        blockIndex,
        version: 1,
        versionCount: 1,
      });
    });
  });
  const groups = new Map<string, ArtifactRecord[]>();
  for (const record of list) {
    const group = groups.get(record.identity) ?? [];
    group.push(record);
    groups.set(record.identity, group);
  }
  for (const group of groups.values())
    group.forEach((record, index) => {
      record.version = index + 1;
      record.versionCount = group.length;
    });
  const byKey = new Map(list.map((record) => [record.key, record]));
  const byBlock = new Map(list.map((record) => [`${record.turnKey}\n${record.blockIndex}`, record]));
  return {
    scope,
    list,
    byKey,
    versionsOf: (record) => groups.get(record.identity) ?? [record],
    forBlock: (turnKey, blockIndex) => byBlock.get(`${turnKey}\n${blockIndex}`),
  };
}

/** One file's artifacts. A `.html` file is one design; any other text is read like a turn. */
export function indexFile(path: string, text: string): ArtifactIndex {
  const scope = `file:${path}`;
  if (/\.html?$/i.test(path)) {
    const name = path.split('/').pop() ?? path;
    const declared = declarationOf('design', text);
    const key = artifactKey(scope, 'file', 0);
    const record: ArtifactRecord = {
      key,
      scope,
      identity: declared.id ? `id:${declared.id}` : key,
      declaredId: declared.id,
      kind: 'design',
      lang: 'html',
      title: declared.title ?? name.replace(/\.html?$/i, ''),
      source: text,
      table: null,
      turnKey: 'file',
      turnIndex: 0,
      blockIndex: 0,
      version: 1,
      versionCount: 1,
    };
    return {
      scope,
      list: [record],
      byKey: new Map([[key, record]]),
      versionsOf: () => [record],
      forBlock: (turnKey, blockIndex) => (turnKey === 'file' && blockIndex === 0 ? record : undefined),
    };
  }
  return indexArtifacts(scope, [{ id: 'file', role: 'file', text }]);
}

/** Whether a Files document holds anything the panel can open. */
export function fileHasArtifacts(path: string, text: string): boolean {
  if (!/\.(md|markdown|html?)$/i.test(path)) return false;
  return indexFile(path, text).list.length > 0;
}

// ---- saving -----------------------------------------------------------------

/** The visible folder saved artifacts go to. Never `artifacts`: the listing skips that name. */
export const SAVED_FOLDER = 'Saved artifacts';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name a project folder accepts on every platform, from a title. */
export function safeFileBase(title: string, fallback: string): string {
  let name = '';
  for (const char of title.normalize('NFC')) {
    const code = char.charCodeAt(0);
    name += code < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char;
  }
  name = name.replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '').trim();
  if (!name || RESERVED.test(name)) name = fallback;
  return name;
}

/** The extension a saved artifact takes: a design is a web page, everything else Markdown. */
export function savedExtension(kind: ArtifactKind): '.html' | '.md' {
  return kind === 'design' ? '.html' : '.md';
}

/** The id a saved copy carries, so a later save can tell its own file from another's. */
export function savedIdOf(record: ArtifactRecord): string {
  return record.declaredId ?? record.key;
}

/** The source with its identity declared on the first line, adding one only when absent. */
export function declaredSource(record: ArtifactRecord, title: string): string {
  const id = savedIdOf(record);
  const safeTitle = title.replace(/["\n\r]/g, "'");
  if (record.kind === 'table') return record.source;
  if (record.kind === 'chart') {
    if (record.declaredId) return record.source;
    try {
      const value: unknown = JSON.parse(record.source);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return record.source;
      return JSON.stringify({ id, title, ...(value as Record<string, unknown>) }, null, 2);
    } catch {
      return record.source;
    }
  }
  if (record.declaredId) return record.source;
  const line =
    record.kind === 'diagram'
      ? `%% artifact: id=${id} title="${safeTitle}"`
      : `<!-- artifact: id=${id} title="${safeTitle}" -->`;
  return `${line}\n${record.source}`;
}

/** A fence one backtick longer than any backtick run inside the source. */
function fenceFor(source: string): string {
  let longest = 0;
  for (const match of source.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * What Save to Files writes. A design is its own page; everything else is a
 * titled Markdown file holding the fenced source, which the Files viewer can
 * show and the panel can open again.
 */
export function savedDocument(record: ArtifactRecord, title: string): string {
  const source = declaredSource(record, title);
  if (record.kind === 'design') return source.endsWith('\n') ? source : `${source}\n`;
  const heading = `# ${title.replace(/\s+/g, ' ').trim()}`;
  if (record.kind === 'table') return `${heading}\n\n${source}\n`;
  const lang = record.kind === 'image' ? 'svg' : record.lang || 'text';
  const fence = fenceFor(source);
  return `${heading}\n\n${fence}${lang}\n${source}\n${fence}\n`;
}

/** Whether a saved file already belongs to this artifact (its first artifact carries the same id). */
export function fileBelongsTo(path: string, text: string, record: ArtifactRecord): boolean {
  const found = indexFile(path, text).list[0];
  if (!found) return false;
  if (record.kind === 'table') return found.source === record.source;
  return found.declaredId === savedIdOf(record) && found.kind === record.kind;
}

// ---- tables to charts -------------------------------------------------------

/** A number as a table cell writes it: 1,234 · $12.50 · 45% · -3 · 1 200. */
export function cellNumber(cell: string): number | null {
  const text = cell
    .trim()
    .replace(/^[$€£¥]\s?/, '')
    .replace(/\s?%$/, '')
    .replace(/(?<=\d)[,\s](?=\d{3}\b)/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const MONTHS =
  /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)(\s+\d{2,4})?$/i;
const DAYS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i;

/** Labels that read as a sequence in time, which a line shows better than bars. */
export function temporal(labels: readonly string[]): boolean {
  if (labels.length < 2) return false;
  return labels.every((raw) => {
    const label = raw.trim();
    return (
      /^\d{4}$/.test(label) ||
      /^\d{4}-\d{1,2}(-\d{1,2})?$/.test(label) ||
      /^\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?$/.test(label) ||
      /^(q[1-4]\s*\d{2,4}|\d{4}\s*q[1-4])$/i.test(label) ||
      /^(w|wk|week)\s*\d{1,2}$/i.test(label) ||
      MONTHS.test(label) ||
      DAYS.test(label)
    );
  });
}

export interface TableColumn {
  index: number;
  name: string;
}

/** The column the chart is drawn across, and the columns of numbers it can draw. */
export function chartColumns(table: TableBlock): { category: number; numeric: TableColumn[] } {
  const numericAt = (column: number) => {
    let seen = 0;
    for (const row of table.rows) {
      const cell = row[column] ?? '';
      if (!cell.trim()) continue;
      if (cellNumber(cell) === null) return false;
      seen += 1;
    }
    return seen > 0;
  };
  const firstLabels = table.rows.map((row) => row[0] ?? '');
  // The first column names the rows unless it is plainly a column of numbers
  // that is not a sequence in time (a year column still names its rows).
  let category = 0;
  if (numericAt(0) && !temporal(firstLabels)) {
    const text = table.header.findIndex((_, column) => !numericAt(column));
    category = text >= 0 ? text : 0;
  }
  const numeric = table.header
    .map((name, index) => ({ index, name: plainText(name) || `Column ${index + 1}` }))
    .filter((column) => column.index !== category && numericAt(column.index));
  return { category, numeric };
}

/**
 * The chart "Chart this" draws for one column: bars across the row labels, or
 * a line when the labels are a sequence in time. Cells that are not numbers
 * are drawn as 0 and said so in the caption.
 */
export function tableChart(
  table: TableBlock,
  column: number,
): { type: 'bar' | 'line'; title: string; x: string[]; series: { name: string; values: number[] }[]; caption?: string } {
  const { category } = chartColumns(table);
  const x = table.rows.map((row, index) => plainText(row[category] ?? '') || `Row ${index + 1}`);
  let blanks = 0;
  const values = table.rows.map((row) => {
    const value = cellNumber(row[column] ?? '');
    if (value === null) blanks += 1;
    return value ?? 0;
  });
  const name = plainText(table.header[column] ?? '') || `Column ${column + 1}`;
  return {
    type: temporal(x) ? 'line' : 'bar',
    title: `${name} by ${plainText(table.header[category] ?? '') || 'row'}`,
    x,
    series: [{ name, values }],
    ...(blanks
      ? { caption: `${blanks} ${blanks === 1 ? 'row has' : 'rows have'} no number in ${name} and ${blanks === 1 ? 'is' : 'are'} drawn at 0.` }
      : {}),
  };
}
