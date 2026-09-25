/**
 * Names the app makes from a person's words: task titles, plan file names and labels.
 * A name is cut on a whole word and says so with an ellipsis; it never stops mid-thought.
 */

/** `text` in at most `max` characters, cut on a whole word, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const boundary = /\s/.test(text[max - 1] ?? '') ? room.length : room.search(/\s+\S*$/);
  const kept = (boundary > 0 ? room.slice(0, boundary) : room).replace(/[\s,;:–—-]+$/, '');
  return `${kept}…`;
}

/**
 * A short title from the first line of `text`: the line itself when it fits, else its first
 * sentence, else the clause before its first colon or semicolon, else the line cut on a word.
 */
export function shortTitle(text: string, max = 80): string {
  const line = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0].replace(/\.$/, '');
  if (sentence && sentence.length >= 12 && sentence.length <= max) return sentence;
  const clause = line.match(/^(.*?)[:;](?=\s)/)?.[1].trim();
  if (clause && clause.length >= 20 && clause.length <= max) return clause;
  return clip(line, max);
}

/** A task's name from the message that asked for it. The whole message stays its description. */
export const taskNameFromText = (text: string) => shortTitle(text, 80);

const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * The file name, without `.md`, for a plan written in a thread: the name the person gave the
 * thread, else the plan's own title (its first `#` heading), else a short title from the
 * message. Characters a
 * file name cannot hold become spaces, so `catering/inquiries.md` reads as words, not
 * `cateringinquiries.md`, and a trailing file extension is dropped rather than doubled.
 */
export function planTitle(input: { threadName?: string | null; answer: string; text: string }): string {
  const named = input.threadName?.trim();
  const heading = input.answer.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1];
  for (const candidate of [named === 'New thread' ? undefined : named, heading, input.text]) {
    if (!candidate) continue;
    const safe = shortTitle(
      candidate
        .replace(/\*\*|__|`/g, '')
        .replace(UNSAFE, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      72,
    )
      .replace(/…$/, '')
      .replace(/[\s.]+$/, '')
      .replace(/\.(md|markdown|txt|csv)$/i, '')
      .replace(/[\s.]+$/, '');
    if (safe) return safe;
  }
  return 'New plan';
}

/**
 * Words the app writes in capitals wherever it makes a readable label from a file or source
 * name: `pos-weekly-summary` reads "POS weekly summary", never "Pos weekly summary". One list,
 * used by every such label (the weekly brief's source labels, the Board's default document,
 * a citation's name). Keyed by the lower-case word; the value is how it is written.
 */
export const KNOWN_ACRONYMS: Readonly<Record<string, string>> = {
  pos: 'POS',
  csv: 'CSV',
  tsv: 'TSV',
  pdf: 'PDF',
  id: 'ID',
  ids: 'IDs',
  sku: 'SKU',
  skus: 'SKUs',
  qb: 'QB',
  // File kinds the Files pane already names in capitals (shared/file-drops.ts).
  txt: 'TXT',
  json: 'JSON',
  png: 'PNG',
  jpeg: 'JPEG',
  jpg: 'JPG',
  gif: 'GIF',
  svg: 'SVG',
  xlsx: 'XLSX',
  webp: 'WebP',
  // Tax forms: written with their hyphen even when the file name splits it.
  'w-2': 'W-2',
  'w-4': 'W-4',
  'w-9': 'W-9',
};

/** A two-part acronym a separator split in a file name, such as `w-2`, rejoined. */
const SPLIT_ACRONYM = /^(w)[\s_-]+(2|4|9)$/i;

/**
 * Words from a file or source name, as a person reads them: separators become spaces, the first
 * word takes a capital, and the words in KNOWN_ACRONYMS keep theirs. Every other word is left as
 * it was written, so `schedule-2026-W39` keeps its `W39`.
 */
export function readableWords(name: string): string {
  const parts = name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const words: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const pair = `${parts[index]} ${parts[index + 1] ?? ''}`;
    if (SPLIT_ACRONYM.test(pair)) {
      words.push(KNOWN_ACRONYMS[pair.replace(SPLIT_ACRONYM, '$1-$2').toLowerCase()]);
      index += 1;
      continue;
    }
    words.push(KNOWN_ACRONYMS[parts[index].toLowerCase()] ?? parts[index]);
  }
  const text = words.join(' ');
  if (text === '') return '';
  const first = words[0];
  // An acronym, or a word already written with a capital inside it, stays as it is.
  if (Object.values(KNOWN_ACRONYMS).includes(first)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A readable name for a project file: its stem as words, after its folder when `folder` is set
 * (`catering/inquiries.md` reads "Catering inquiries"). The path itself stays the file's identity;
 * this is only what a label says.
 */
export function readableFileName(path: string, options: { folder?: boolean } = {}): string {
  const parts = path.split('/').filter(Boolean);
  const base = parts.pop() ?? path;
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const folder = options.folder ? (parts.pop() ?? '') : '';
  const words = readableWords(`${folder} ${stem}`);
  return words === '' ? path : words;
}
