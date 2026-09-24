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
