// Artifacts, derived from the record. Every artifact the Console shows is read
// out of a durable turn's text (or a saved file's text) by this module and by
// nothing else: there is no artifact store, no artifact field on a Turn and no
// lifecycle of its own (AGENTS.md, "no parallel lifecycle"). Pure: no React, no
// DOM, no clock, no network.

import {
  parseVisualSpec,
  readBlock,
  VISUAL_FENCE_TAG,
  VISUAL_MAX_JSON_BYTES,
  VISUAL_MAX_POINTS,
  type VisualKind,
  type VisualSpec,
} from '../../shared/visual-spec';
import {
  artifactKindOf,
  KIND_LABEL,
  normalizeNewlines,
  parseBlocks,
  plainText,
  type ArtifactKind,
  type CodeBlock,
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
 * A table declares nothing, and neither does a visual: its spec is strict JSON
 * with no field for an id, so each visual is the only version of itself.
 */
export function declarationOf(kind: ArtifactKind, source: string): Declaration {
  if (kind === 'table' || kind === 'visual') return { id: null, title: null };
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
    // A visual is drawn where it stands, so a heading above it is its heading.
    if (artifactKindOf(block) || isVisualBlock(block)) return null;
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

// ---- visuals ----------------------------------------------------------------

/**
 * A ```visual block, open or closed, valid or not: each one counts toward a
 * turn's limit. (Narrowed by its language too, so a code block in another
 * language is still a code block where this says no.)
 */
export function isVisualBlock(block: TurnBlock): block is CodeBlock & { lang: typeof VISUAL_FENCE_TAG } {
  return block.type === 'code' && block.lang === VISUAL_FENCE_TAG;
}

/** What a visual is called when it gives no title: its kind, in words. */
export const VISUAL_KIND_LABEL: Record<Exclude<VisualKind, 'app'>, string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
  pie: 'Donut chart',
  stat: 'Key figures',
  table: 'Table',
  progress: 'Progress',
};

/** A visual's title: the spec's own, or else its kind's label (an app card's own name). */
export function visualTitle(spec: VisualSpec): string {
  if ('title' in spec && spec.title) return spec.title;
  if (spec.kind === 'app') return spec.key === 'update-progress' ? 'App update' : 'Run status';
  return VISUAL_KIND_LABEL[spec.kind];
}

export type VisualRead = { ok: true; spec: VisualSpec } | { ok: false; reason: string };

/**
 * A visual's JSON source read with every limit a reply's block is read with
 * (shared/visual-spec.ts `readBlock`). The panel and a saved `.json` file draw
 * only what a turn could have drawn.
 */
export function visualOf(source: string): VisualRead {
  if (source.length > VISUAL_MAX_JSON_BYTES) return { ok: false, reason: 'the block is too large' };
  const read = readBlock(source, 1);
  if (read.type === 'visual') return { ok: true, spec: read.spec };
  return { ok: false, reason: read.type === 'invalid' ? read.reason : 'the block could not be read' };
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
 *
 * A visual is indexed exactly when its turn draws it: a closed block that
 * `readBlock` accepts, counted among the turn's visual blocks the way TurnBody
 * counts them, so the ninth visual of a reply, drawn as a note, is no artifact.
 */
export function indexArtifacts(scope: string, turns: readonly TurnLike[]): ArtifactIndex {
  const list: ArtifactRecord[] = [];
  const ordinal: Partial<Record<ArtifactKind, number>> = {};
  turns.forEach((turn, turnIndex) => {
    if (turn.role === 'you' || !turn.text) return;
    const turnKey = turnKeyOf(turn, turnIndex);
    const blocks = blocksOf(turn.text);
    let visuals = 0;
    blocks.forEach((block, blockIndex) => {
      if (isVisualBlock(block)) {
        visuals += 1;
        if (!block.closed) return;
        const read = readBlock(block.source, visuals);
        if (read.type !== 'visual') return;
        const key = artifactKey(scope, turnKey, blockIndex);
        list.push({
          key,
          scope,
          identity: key,
          declaredId: null,
          kind: 'visual',
          lang: VISUAL_FENCE_TAG,
          title: visualTitle(read.spec),
          source: block.source,
          table: null,
          turnKey,
          turnIndex,
          blockIndex,
          version: 1,
          versionCount: 1,
        });
        return;
      }
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

/** A file that is one artifact as a whole: the index of that one record. */
function wholeFile(
  scope: string,
  fields: Pick<ArtifactRecord, 'identity' | 'declaredId' | 'kind' | 'lang' | 'title'> & { source: string },
  key: string,
): ArtifactIndex {
  const record: ArtifactRecord = {
    key,
    scope,
    ...fields,
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

/**
 * One file's artifacts. A `.html` file is one design, and a `.json` file that
 * holds a valid visual spec is one visual (what Save to Files writes for a
 * visual); any other text is read like a turn.
 */
export function indexFile(path: string, text: string): ArtifactIndex {
  const scope = `file:${path}`;
  const key = artifactKey(scope, 'file', 0);
  const name = path.split('/').pop() ?? path;
  if (/\.html?$/i.test(path)) {
    const declared = declarationOf('design', text);
    return wholeFile(
      scope,
      {
        identity: declared.id ? `id:${declared.id}` : key,
        declaredId: declared.id,
        kind: 'design',
        lang: 'html',
        title: declared.title ?? name.replace(/\.html?$/i, ''),
        source: text,
      },
      key,
    );
  }
  if (/\.json$/i.test(path)) {
    const read = visualOf(text);
    if (!read.ok) return indexArtifacts(scope, []);
    return wholeFile(
      scope,
      {
        identity: key,
        declaredId: null,
        kind: 'visual',
        lang: VISUAL_FENCE_TAG,
        title: 'title' in read.spec && read.spec.title ? read.spec.title : name.replace(/\.json$/i, ''),
        source: text,
      },
      key,
    );
  }
  return indexArtifacts(scope, [{ id: 'file', role: 'file', text }]);
}

/** Whether a Files document holds anything the panel can open. */
export function fileHasArtifacts(path: string, text: string): boolean {
  if (!/\.(md|markdown|html?|json)$/i.test(path)) return false;
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

/**
 * The extension a saved artifact takes: a design is a web page, a visual is its
 * JSON spec, and everything else is Markdown.
 */
export function savedExtension(kind: ArtifactKind): '.html' | '.md' | '.json' {
  return kind === 'design' ? '.html' : kind === 'visual' ? '.json' : '.md';
}

/** The id a saved copy carries, so a later save can tell its own file from another's. */
export function savedIdOf(record: ArtifactRecord): string {
  return record.declaredId ?? record.key;
}

/**
 * A title as a declaration line can hold it: one line, no double quote, and no
 * run of hyphens. A `--` could close the `<!-- artifact: ... -->` comment early
 * (a heading such as "Plan --> next" would leave `next" -->` on the page of a
 * saved design) or open another, and XML allows none inside an SVG's comment.
 */
export function declarationTitle(title: string): string {
  return title.replace(/["\n\r]/g, "'").replace(/-{2,}/g, '-');
}

/** The source with its identity declared on the first line, adding one only when absent. */
export function declaredSource(record: ArtifactRecord, title: string): string {
  const id = savedIdOf(record);
  const safeTitle = declarationTitle(title);
  // A table has no line to declare on, and a visual's strict spec no field.
  if (record.kind === 'table' || record.kind === 'visual') return record.source;
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
 * What Save to Files writes. A design is its own page and a visual its own JSON
 * spec; everything else is a titled Markdown file holding the fenced source,
 * which the Files viewer can show and the panel can open again.
 */
export function savedDocument(record: ArtifactRecord, title: string): string {
  const source = declaredSource(record, title);
  if (record.kind === 'design' || record.kind === 'visual')
    return source.endsWith('\n') ? source : `${source}\n`;
  const heading = `# ${title.replace(/\s+/g, ' ').trim()}`;
  if (record.kind === 'table') return `${heading}\n\n${source}\n`;
  const lang = record.kind === 'image' ? 'svg' : record.lang || 'text';
  const fence = fenceFor(source);
  return `${heading}\n\n${fence}${lang}\n${source}\n${fence}\n`;
}

/**
 * Whether a saved file already belongs to this artifact: its first artifact
 * carries the same id. A table or a visual declares none, so its file is its
 * own when it holds the same source.
 */
export function fileBelongsTo(path: string, text: string, record: ArtifactRecord): boolean {
  const found = indexFile(path, text).list[0];
  if (!found) return false;
  if (record.kind === 'table') return found.source === record.source;
  if (record.kind === 'visual')
    return found.kind === 'visual' && found.source.trimEnd() === record.source.trimEnd();
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
 * A cell's words as a visual label: plain text on one line, no control
 * characters (the spec refuses them) and no longer than the spec allows.
 */
function specText(text: string, limit: number): string {
  const words = plainText(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > limit ? `${words.slice(0, limit - 1).trimEnd()}…` : words;
}

export type TableVisual =
  | {
      ok: true;
      spec: Extract<VisualSpec, { kind: 'bar' | 'line' }>;
      /** Says which rows are left out, or null when every row is drawn. */
      caption: string | null;
    }
  | { ok: false; reason: string };

/**
 * The visual "Chart this" draws for one column of numbers: bars across the row
 * labels, or a line when the labels read as ordered periods. It is a visual
 * spec like any a reply may hold, validated by `parseVisualSpec`, so the panel
 * draws a table's chart with the same renderer and limits as a reply's.
 *
 * A row whose cell in the column is blank is left out, and the caption says
 * so: nothing is drawn at a 0 the table never held. (A column that holds any
 * word is not a column of numbers at all; `chartColumns` never offers it.)
 */
export function tableVisual(table: TableBlock, column: number): TableVisual {
  const { category, numeric } = chartColumns(table);
  const chosen = numeric.find((entry) => entry.index === column);
  if (!chosen) return { ok: false, reason: 'this column does not hold only numbers' };
  const labels: string[] = [];
  const values: number[] = [];
  let left = 0;
  table.rows.forEach((row, index) => {
    const value = cellNumber(row[column] ?? '');
    if (value === null) {
      left += 1;
      return;
    }
    labels.push(specText(row[category] ?? '', 60) || `Row ${index + 1}`);
    values.push(value);
  });
  if (labels.length > VISUAL_MAX_POINTS)
    return {
      ok: false,
      reason: `a chart draws at most ${VISUAL_MAX_POINTS} rows, and this column has ${labels.length}`,
    };
  const name = specText(chosen.name, 60) || `Column ${column + 1}`;
  const across = specText(table.header[category] ?? '', 60) || 'row';
  const parsed = parseVisualSpec({
    kind: temporal(labels) ? 'line' : 'bar',
    title: specText(`${name} by ${across}`, 120),
    labels,
    series: [{ name, values }],
  });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.spec.kind !== 'bar' && parsed.spec.kind !== 'line')
    return { ok: false, reason: 'the chart could not be drawn' };
  return {
    ok: true,
    spec: parsed.spec,
    caption: left
      ? `${left} ${left === 1 ? 'row has' : 'rows have'} no number in ${name} and ${left === 1 ? 'is' : 'are'} left out.`
      : null,
  };
}
