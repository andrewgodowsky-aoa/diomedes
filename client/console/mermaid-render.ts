import { APP_CSP } from '../../shared/app-csp';
import { FRAME_FONT, isDark, type FrameTokens } from './artifact-frame';
import { normalizeNewlines } from './turn-blocks';

// Mermaid diagrams: loaded only when the first one is drawn (a dynamic import,
// so app start never pays for it), laid out, serialised to an SVG string, and
// shown only inside a sandboxed frame (artifact-frames.tsx). Mermaid lays a
// diagram out in the app's own document whatever its security level, so what
// it is given is fenced first:
//   - frontmatter and %%{...}%% directives are stripped, with Mermaid's own
//     grammar, so a diagram cannot change the configuration below;
//   - the `secure` list keeps those keys fixed even if one got through;
//   - labels are SVG text (htmlLabels false) except in a diagram with math
//     (below), and every label Mermaid sanitises passes an allowlist that
//     keeps no link, source or style;
//   - what would load files while Mermaid lays the diagram out is refused
//     before Mermaid sees it: a picture shape (@{ img: ... }) whose picture is
//     not written into the diagram as a data:image URL, and a style statement
//     with a CSS url(). Mermaid ends a statement at a newline or a semicolon,
//     so both split them here;
//   - so is a sequence diagram's `properties` or `details` statement: the
//     first gives a participant a picture from a link (or a <use> of an
//     element of this document), the second reads an element of this document
//     by id. They are looked for wherever Mermaid's own grammar can start a
//     statement, in the text as Mermaid will read it.
// Math ($$...$$) is drawn as MathML (KaTeX, bundled with Mermaid, no `trust`,
// MathML output only), and only on a page that carries exactly the app's
// Content-Security-Policy (APP_CSP, shared/app-csp.ts): the built index.html
// does (scripts/app-csp.ts), the development server does not. A diagram with
// math is refused if it holds any markup of its own beside the math, so its
// labels, which are HTML when a flowchart draws math, hold only text,
// Mermaid's own markup and MathML; the MathML passes an allowlist of
// presentation elements and attributes after Mermaid sanitises it (artifacts
// v2, E1: docs/product/2026-09-23-artifacts-v2-panel-board.md).
// What Mermaid returns is scanned before it goes anywhere: every <image> and
// <feImage> whose picture is not written into the drawing as a data:image URL,
// and every <use> of anything but a #fragment of the drawing, is taken out;
// so is every CSS url() that is not a same-document #fragment, and every other
// function that fetches, from the drawing's style attributes and <style> text.
// In the built app the page's own policy lets a fetch that got past all of
// this reach only the local service, and nothing it returns is readable by the
// diagram. Evidence for each of these is in
// docs/implementation/2026-09-22-model-artifacts.md,
// docs/product/2026-09-23-artifact-hardening.md and
// docs/product/2026-09-23-mermaid-fetch-hardening.md.

/** Mermaid's frontmatter grammar (mermaid 11.17.2, src/diagram-api/regexes.ts). */
const FRONTMATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
/** Mermaid's directive grammar: %%{init: ...}%%, %%{wrap}%% and the rest. */
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/**
 * Mermaid's math grammar (mermaid 11.17.2 `katexRegex`, matched in each label): $$...$$ within
 * one line, since `.` never crosses one.
 */
const MATH = /\$\$(.*?)\$\$/;
const MATH_SPANS = /\$\$(.*?)\$\$/g;
/**
 * Every spelling of `$` Mermaid may turn back into one before it looks for math. When a label
 * holds markup, Mermaid's sanitising parses it, and a character reference (`&dollar;`, `&#36`,
 * `&#x24`, with or without the semicolon) comes back as `$`; Mermaid first writes its own
 * `#dollar;` and `#36;` as such references. A markdown string reads `\$` as `$`. Not every one of
 * these reaches Mermaid as a dollar; reading them all as dollars errs towards finding math.
 */
const DOLLAR = /&(?:dollar;|#0*36(?![0-9])|#x0*24(?![0-9a-f]));?|#(?:dollar|0*36);|\\\$/gi;
/**
 * Label markup in a diagram with math, which has HTML labels: `<` anywhere, since a raw span
 * can pair its dollars differently from the label it sits in, and `~`, which a class diagram
 * turns into `<` and `>`.
 */
const MARKUP_ANYWHERE = /[<~]/;
/** Outside the math, `&` starts a character reference and `\` an escape. TeX uses both inside. */
const MARKUP_OUTSIDE_MATH = /[&\\]/;
/** Statements whose text becomes CSS. */
const STYLE_LINE = /^\s*(style|classDef|linkStyle)\b/i;
/** Mermaid ends a statement at a newline or a semicolon (`graph TD; A-->B; style A ...`). */
const STATEMENT_END = /[\n;]/;
/** Mermaid's comment lines, taken out before it detects or parses a diagram (mermaid 11.17.2 cleanupComments). */
const COMMENT_LINES = /^\s*%%(?!{)[^\n]+\n?/gm;
/** The comments Mermaid's type detection takes out as well (mermaid 11.17.2 anyCommentRegex). */
const ANY_COMMENT = /\s*%%.*\n/gm;
/** Mermaid's sequence diagram detector (mermaid 11.17.2, dist/mermaid.core.mjs:277): case-sensitive. */
const SEQUENCE_DIAGRAM = /^\s*sequenceDiagram/;
/** A sequence diagram's accessible description block, a statement that ends at its `}`. */
const DESCRIPTION_BLOCK = /accDescr\s*\{[^}]*\}/gi;
/**
 * A statement that gives a participant properties or details. Mermaid's sequence lexer ignores
 * case, and besides after a newline or a semicolon, its grammar starts a statement right after the
 * diagram's keyword, after `end`, and after any of / \ ( ) < > that starts no other token, which it
 * reads as a line of its own (mermaid 11.17.2 sequence lexer rules 55, 35 and 93).
 */
const PARTICIPANT_DETAILS = /^(?:\s|[/\\()<>]|end\b|sequenceDiagram\b)*(?:properties|details)\b/i;
/** CSS that fetches, and CSS escapes (`\75 rl(` is `url(` to a CSS parser). */
const STYLE_FETCH = /url\s*\(|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|@import|\\[0-9a-f]/i;
/** The one picture drawn: a raster image written into the diagram, base64, nothing after it. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** `img: "..."` as a key of the shape data, double-quoted: the value Mermaid reads as written. */
const PICTURE_FIELD = /(^|[\s,{])img\s*:\s*"([^"]*)"/g;

export const REFUSED_STYLE =
  'This diagram styles something with a link to a file (url() in a style, classDef or linkStyle line), so it is not drawn here.';
export const REFUSED_MATH_HERE =
  'Math ($$) in a diagram is drawn only in the app itself, where the page refuses every outside load. This page does not, so the diagram is not drawn here.';
export const REFUSED_MATH_MARKUP =
  'This diagram has math ($$) and also <, ~, or & or \\ outside the math, so it is not drawn here. In math, write < as \\lt.';
export const REFUSED_IMAGE =
  'This diagram shows a picture from a link. Only a picture written into the diagram, as a quoted data:image URL (PNG, JPEG, GIF or WebP), is drawn here.';
export const REFUSED_SHAPE_ESCAPE =
  'This diagram writes shape data with an escape (\\), which could name a picture from a link, so it is not drawn here.';
export const REFUSED_PARTICIPANT_DETAILS =
  'This sequence diagram gives a participant properties or details, which can show a picture from a link or take content from the page by id, so it is not drawn here.';

/** The diagram text Mermaid is given: no frontmatter, no directives. */
export function preparedSource(source: string): string {
  return normalizeNewlines(source).replace(FRONTMATTER, '').replace(DIRECTIVE, '').trim();
}

/** The `@{ ... }` shape-data blocks in a diagram, read with quotes respected. */
export function shapeData(source: string): string[] {
  const blocks: string[] = [];
  let at = source.indexOf('@{');
  while (at >= 0) {
    let quote = '';
    let end = at + 2;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === '\\') end += 1;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '}') break;
    }
    blocks.push(source.slice(at + 2, end));
    at = source.indexOf('@{', end);
  }
  return blocks;
}

/** What a page lets a diagram draw. */
export interface DiagramPolicy {
  /** Math, as MathML: only on a page that carries exactly the app's Content-Security-Policy. */
  math: boolean;
}

/** Just enough of a document's <head> to read its policy from, so a test can hand one in. */
export interface HeadLike {
  readonly children: ArrayLike<{ readonly localName: string; getAttribute(name: string): string | null }>;
}

/**
 * Whether a page's <head> carries the app's own Content-Security-Policy, exactly (APP_CSP), as a
 * <meta>. This is the signal math is drawn on, read from the page itself: the build writes that
 * policy (APP_CSP_TAG) first in the built index.html's head (scripts/app-csp.ts, `apply: 'build'`,
 * into index.html only), and the development server serves index.html without it. Any other
 * policy does not count: a weaker or a different one, the app's with a directive added, dropped or
 * changed, or the app's as report-only, which refuses nothing. Another policy beside the app's can
 * only narrow what the page may load, so it does not stop the app's from counting.
 */
export function carriesPolicy(head: HeadLike | null | undefined): boolean {
  if (!head) return false;
  return Array.from(head.children).some(
    (child) =>
      child.localName === 'meta' &&
      (child.getAttribute('http-equiv') ?? '').trim().toLowerCase() === 'content-security-policy' &&
      child.getAttribute('content') === APP_CSP,
  );
}

/** The policy of a page: this one's, when there is a document (never in Node). */
export function diagramPolicy(
  page: { readonly head: HeadLike | null } | null | undefined = typeof document === 'undefined' ? null : document,
): DiagramPolicy {
  return { math: carriesPolicy(page?.head) };
}

/**
 * Whether a diagram has math Mermaid would draw: a $$...$$ within one line, however its dollars
 * are spelt (DOLLAR). Where a diagram still gets math past this, what Mermaid draws passes the
 * label allowlist all the same, and without the policy that allowlist keeps no MathML at all.
 */
export function hasMath(source: string): boolean {
  return MATH.test(source.replace(DOLLAR, '$'));
}

/** Whether a diagram with math also holds markup of its own (see MARKUP_ANYWHERE). */
function markupBesideMath(source: string): boolean {
  return MARKUP_ANYWHERE.test(source) || MARKUP_OUTSIDE_MATH.test(source.replace(MATH_SPANS, ''));
}

/**
 * Whether one block of shape data may be drawn as far as its picture goes: it names no picture,
 * or exactly one, as `img: "data:image/...;base64,..."`, and mentions `img` nowhere else (not as a
 * value, a quoted key, an alias or another key's). Mermaid parses shape data as YAML, where only
 * a double-quoted value is the text between its quotes; escapes are refused before this.
 */
function pictureAllowed(block: string): boolean {
  if (!/img/i.test(block)) return true;
  const fields = [...block.matchAll(PICTURE_FIELD)];
  if (fields.length !== 1) return false;
  const [whole, lead, value] = fields[0];
  const at = fields[0].index ?? 0;
  const rest = block.slice(0, at) + lead + block.slice(at + whole.length);
  return !/img/i.test(rest) && DATA_IMAGE.test(value);
}

/**
 * What Mermaid makes of `text` before it detects and parses a diagram (mermaid 11.17.2
 * preprocessDiagram): newlines normalised, one frontmatter block taken off, then directives and
 * comment lines taken out, each once, and leading space trimmed. Mermaid also swaps the quotes in
 * a tag's attributes, which moves no statement, so that is left out. Taking any of these out again
 * would not be what Mermaid does: what one pass leaves of a directive, Mermaid's sequence lexer
 * reads as a comment.
 */
function mermaidCode(text: string): string {
  const cleaned = normalizeNewlines(text);
  const frontmatter = FRONTMATTER.exec(cleaned);
  const body = frontmatter ? cleaned.slice(frontmatter[0].length) : cleaned;
  return body.replace(DIRECTIVE, '').replace(COMMENT_LINES, '').trimStart();
}

/**
 * Whether Mermaid reads `text` as a sequence diagram: its own detector, on what its type detection
 * sees (detectType takes frontmatter, directives and comments out of mermaidCode once more). A
 * detector Mermaid tries first can only claim a text for another kind of diagram.
 */
export function isSequenceDiagram(text: string): boolean {
  const seen = mermaidCode(text).replace(FRONTMATTER, '').replace(DIRECTIVE, '').replace(ANY_COMMENT, '\n');
  return SEQUENCE_DIAGRAM.test(seen);
}

/**
 * Whether a sequence diagram gives a participant properties or details (PARTICIPANT_DETAILS), in
 * the text as Mermaid will parse it. It is split wherever Mermaid can end a statement: at a
 * newline, at a semicolon, and at the `}` that closes an accDescr block. Splitting where Mermaid
 * would not (in a comment, an accTitle or accDescr value, or a participant's @{...} data) can only
 * find more. Mermaid's entity encoding, between this text and its parser, adds no place a statement
 * starts: it takes a `;` or a `#` away and puts in characters a name may hold.
 */
function hasParticipantDetails(text: string): boolean {
  if (!isSequenceDiagram(text)) return false;
  const code = mermaidCode(text).replace(DESCRIPTION_BLOCK, (block) => `${block.slice(0, -1)}\n`);
  return code.split(STATEMENT_END).some((statement) => PARTICIPANT_DETAILS.test(statement));
}

/**
 * Why a diagram is not drawn on a page with this policy, or null when it may be. `source` is the
 * text Mermaid is given (preparedSource). Math is refused on a page without the app's policy, and
 * on any page beside markup of its own. A sequence diagram that gives a participant properties or
 * details is refused. Shape data that uses an escape (a YAML key can spell `img` as `\x69mg`) is
 * refused, and so is any picture that is not written into the diagram as a data:image URL.
 * Mermaid's text limit (`maxTextSize`, fixed by `secure`) bounds how large such a picture can be.
 */
export function refusal(source: string, policy: DiagramPolicy = { math: false }): string | null {
  if (hasMath(source)) {
    if (!policy.math) return REFUSED_MATH_HERE;
    if (markupBesideMath(source)) return REFUSED_MATH_MARKUP;
  }
  if (hasParticipantDetails(source)) return REFUSED_PARTICIPANT_DETAILS;
  for (const block of shapeData(source)) {
    if (block.includes('\\')) return REFUSED_SHAPE_ESCAPE;
    if (!pictureAllowed(block)) return REFUSED_IMAGE;
  }
  if (source.split(STATEMENT_END).some((statement) => STYLE_LINE.test(statement) && STYLE_FETCH.test(statement)))
    return REFUSED_STYLE;
  return null;
}

// ---- what Mermaid drew ------------------------------------------------------
//
// A small reading of CSS (CSS Syntax 3, section 4: names, escapes, strings,
// comments and url tokens) that finds every function which fetches what it
// names. Where the reading and a browser's could differ (a number or a hash
// right before a name), it errs towards finding one.

/** CSS functions that load the file they name. `url()` stays only as a same-document `#fragment`. */
const FETCHING = new Set([
  'url',
  'src',
  'image',
  'image-set',
  '-webkit-image-set',
  'cross-fade',
  '-webkit-cross-fade',
  'element',
  '-moz-element',
]);

const isNewline = (c: string | undefined) => c === '\n' || c === '\r' || c === '\f';
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || isNewline(c);
const isNameStart = (c: string | undefined) => !!c && (/[a-z_]/i.test(c) || c.charCodeAt(0) >= 0x80);
const isNameChar = (c: string | undefined) => !!c && (/[a-z0-9_-]/i.test(c) || c.charCodeAt(0) >= 0x80);
/** A backslash starts an escape unless a newline follows it. */
const escapes = (css: string, at: number) => css[at] === '\\' && !isNewline(css[at + 1]);

/** The character an escape at `at` stands for, and where the escape ends. */
function escapeAt(css: string, at: number): { char: string; end: number } {
  let end = at + 1;
  let hex = '';
  while (end < css.length && hex.length < 6 && /[0-9a-f]/i.test(css[end])) hex += css[end++];
  if (!hex) return { char: css[end] ?? '�', end: Math.min(css.length, end + 1) };
  if (css[end] === '\r' && css[end + 1] === '\n') end += 2;
  else if (isSpace(css[end])) end += 1;
  const code = Number.parseInt(hex, 16);
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return { char: valid ? String.fromCodePoint(code) : '�', end };
}

/** Whether a name (an identifier) starts at `at`. */
function startsName(css: string, at: number): boolean {
  if (css[at] === '-') return isNameStart(css[at + 1]) || css[at + 1] === '-' || escapes(css, at + 1);
  return isNameStart(css[at]) || escapes(css, at);
}

/** The name at `at` with its escapes read, and where it ends. */
function readName(css: string, at: number): { value: string; end: number } {
  let value = '';
  let end = at;
  while (end < css.length) {
    if (isNameChar(css[end])) value += css[end++];
    else if (escapes(css, end)) {
      const escape = escapeAt(css, end);
      value += escape.char;
      end = escape.end;
    } else break;
  }
  return { value, end };
}

/** Where a comment starting at `at` ends. An unclosed comment runs to the end. */
function commentEnd(css: string, at: number): number {
  const close = css.indexOf('*/', at + 2);
  return close < 0 ? css.length : close + 2;
}

/**
 * A string starting at `at`: its value and where it ends. A newline the
 * string does not escape ends it without being part of it, as it does for a
 * browser, so what follows is read as CSS again.
 */
function readString(css: string, at: number): { value: string; end: number } {
  const quote = css[at];
  let value = '';
  let end = at + 1;
  while (end < css.length) {
    const c = css[end];
    if (c === quote) return { value, end: end + 1 };
    if (isNewline(c)) return { value, end };
    if (c === '\\') {
      if (isNewline(css[end + 1])) end += css[end + 1] === '\r' && css[end + 2] === '\n' ? 3 : 2;
      else {
        const escape = escapeAt(css, end);
        value += escape.char;
        end = escape.end;
      }
      continue;
    }
    value += c;
    end += 1;
  }
  return { value, end };
}

/** Where a parenthesised run that is already open at `at` closes, past its `)`. */
function closeParen(css: string, at: number): number {
  let depth = 1;
  let end = at;
  while (end < css.length) {
    const c = css[end];
    if (c === '"' || c === "'") end = readString(css, end).end;
    else if (c === '/' && css[end + 1] === '*') end = commentEnd(css, end);
    else if (escapes(css, end)) end = escapeAt(css, end).end;
    else {
      if (c === '(') depth += 1;
      else if (c === ')' && --depth === 0) return end + 1;
      end += 1;
    }
  }
  return end;
}

/** An unquoted `url(` token from `at`: what it names, and where it ends (its first unescaped `)`). */
function readUrlToken(css: string, at: number): { value: string; end: number } {
  let value = '';
  let end = at;
  while (end < css.length) {
    const c = css[end];
    if (c === ')') return { value, end: end + 1 };
    if (escapes(css, end)) {
      const escape = escapeAt(css, end);
      value += escape.char;
      end = escape.end;
    } else {
      value += c;
      end += 1;
    }
  }
  return { value, end };
}

/** Where an `@import` rule whose name ends at `at` ends: past its `;`, or before the `}` of its block. */
function importEnd(css: string, at: number): number {
  let end = at;
  while (end < css.length) {
    const c = css[end];
    if (c === '"' || c === "'") end = readString(css, end).end;
    else if (c === '/' && css[end + 1] === '*') end = commentEnd(css, end);
    else if (c === '(') end = closeParen(css, end + 1);
    else if (escapes(css, end)) end = escapeAt(css, end).end;
    else if (c === ';') return end + 1;
    else if (c === '}') return end;
    else end += 1;
  }
  return end;
}

/**
 * CSS with everything that would fetch a file taken out: `@import` rules are
 * dropped, and every fetching function (url(), image-set() and the rest)
 * becomes `none`, except a `url()` naming a `#fragment` of the same document,
 * which is how Mermaid points its lines at their arrowheads. Comments, strings
 * and every other byte are kept as written.
 */
export function withoutFetchingUrls(css: string): string {
  let out = '';
  let at = 0;
  while (at < css.length) {
    const c = css[at];
    if (c === '/' && css[at + 1] === '*') {
      const end = commentEnd(css, at);
      out += css.slice(at, end);
      at = end;
    } else if (c === '"' || c === "'") {
      const end = readString(css, at).end;
      out += css.slice(at, end);
      at = end;
    } else if (c === '@' && startsName(css, at + 1)) {
      const name = readName(css, at + 1);
      if (name.value.toLowerCase() === 'import') at = importEnd(css, name.end);
      else {
        out += css.slice(at, name.end);
        at = name.end;
      }
    } else if (startsName(css, at)) {
      const name = readName(css, at);
      const fn = name.value.toLowerCase();
      if (css[name.end] !== '(' || !FETCHING.has(fn)) {
        out += css.slice(at, name.end);
        at = name.end;
        continue;
      }
      let named = '';
      let end: number;
      if (fn === 'url') {
        let open = name.end + 1;
        while (isSpace(css[open])) open += 1;
        if (css[open] === '"' || css[open] === "'") {
          const text = readString(css, open);
          named = text.value;
          end = closeParen(css, text.end);
        } else ({ value: named, end } = readUrlToken(css, open));
      } else end = closeParen(css, name.end + 1);
      out += fn === 'url' && named.trim().startsWith('#') ? css.slice(at, end) : 'none';
      at = end;
    } else {
      // Anything else, a backslash before a newline included, is kept as written.
      out += c;
      at += 1;
    }
  }
  return out;
}

/** The SVG attributes whose value is CSS and can name a file. */
export const CSS_ATTRIBUTES = [
  'style',
  'fill',
  'stroke',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'clip-path',
  'mask',
  'filter',
  'cursor',
];

/** The elements of a drawing that show a picture: <image>, and a filter's <feImage>. */
const PICTURE_ELEMENTS = new Set(['image', 'feimage']);

/**
 * Whether an element of a drawing may stay, as far as what it points at goes: a picture (<image>,
 * <feImage>) only when every href it has is a picture written into the drawing (DATA_IMAGE), and a
 * <use> only when every href it has is a #fragment of the drawing itself. One with no href points
 * at nothing, and goes too. Other elements are not this check's business: a link is made inert
 * where its frame is built (artifact-links.ts).
 */
export function keepsReference(element: string, hrefs: readonly string[]): boolean {
  const name = element.toLowerCase();
  if (PICTURE_ELEMENTS.has(name)) return hrefs.length > 0 && hrefs.every((href) => DATA_IMAGE.test(href));
  if (name === 'use') return hrefs.length > 0 && hrefs.every((href) => href.startsWith('#'));
  return true;
}

/** Every href an element has: `href`, `xlink:href`, and any other prefixed one the parser kept. */
function hrefsOf(element: Element): string[] {
  return [...element.attributes]
    .filter((attribute) => attribute.localName.toLowerCase() === 'href' || attribute.name.toLowerCase().endsWith(':href'))
    .map((attribute) => attribute.value);
}

/** withoutFetchingSvg's pass over one parsed tree, and over every template's contents in it. */
function scrub(root: ParentNode): void {
  for (const element of root.querySelectorAll('*')) {
    if (!keepsReference(element.localName, hrefsOf(element))) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (!CSS_ATTRIBUTES.includes(attribute.localName)) continue;
      const kept = withoutFetchingUrls(attribute.value);
      if (kept !== attribute.value) attribute.value = kept;
    }
    if (element.localName === 'style') {
      const text = element.textContent ?? '';
      const kept = withoutFetchingUrls(text);
      if (kept !== text) element.textContent = kept;
    }
    // A template's contents are not among its descendants, and a frame draws them when the
    // template declares a shadow root.
    if (element instanceof HTMLTemplateElement) scrub(element.content);
  }
}

/**
 * The drawing Mermaid returned, with every picture and <use> that `keepsReference` refuses taken
 * out, and `withoutFetchingUrls` applied to every style attribute, presentation attribute and
 * <style> element left, template contents included. It is read as the frame will read it (HTML,
 * the drawing inside <body>) in an inert document, which runs nothing and loads nothing. Text and
 * labels are not touched, so a label that says "url(x)" still says it.
 */
export function withoutFetchingSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${svg}`, 'text/html');
  scrub(parsed.body);
  return parsed.body.innerHTML;
}

/** The label markup Mermaid may keep: plain inline text formatting, no attributes but class. */
export const LABEL_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'br', 'span', 'div', 'p', 'code', 'pre', 'ul', 'ol', 'li', 'hr',
];

/**
 * The MathML KaTeX writes (katex/src/mathMLTree.ts) that a label may keep: presentation elements
 * only. Not <mglyph> (it names a picture, and KaTeX writes one only for a trusted
 * \includegraphics), <maction>, <annotation> or <annotation-xml>. DOMPurify drops <semantics>
 * and keeps what it holds, so it is not listed either.
 */
export const MATH_TAGS = [
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mover', 'munder',
  'munderover', 'mfrac', 'mroot', 'msqrt', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'menclose', 'mstyle',
  'mpadded', 'mphantom',
];

/**
 * The presentation attributes KaTeX sets. None of them names a file; `href` and `src` (written
 * only for a trusted command) and `style` (a \fcolorbox border) are not among them.
 */
export const MATH_ATTRIBUTES = [
  'display', 'mathvariant', 'mathcolor', 'mathbackground', 'mathsize', 'stretchy', 'fence', 'separator',
  'lspace', 'rspace', 'minsize', 'maxsize', 'width', 'height', 'depth', 'voffset', 'notation',
  'scriptlevel', 'displaystyle', 'rowspacing', 'columnspacing', 'columnalign', 'columnlines', 'rowlines',
  'linethickness', 'accent', 'accentunder', 'largeop', 'linebreak',
];

/** Configuration a diagram may not change, even through a directive that escaped stripping. */
export const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'htmlLabels', 'flowchart', 'dompurifyConfig', 'themeCSS', 'themeVariables', 'theme', 'darkMode',
  'fontFamily', 'altFontFamily', 'legacyMathML', 'forceLegacyMathML', 'arrowMarkerAbsolute',
];

/**
 * Mermaid's configuration for one render, themed from the running scheme. `drawing.math` is set
 * only for a diagram with math that `refusal` let through on a page with the app's policy: a
 * flowchart draws math only in an HTML label (mermaid 11.17.2 labelHelper), so its labels are
 * HTML, and what Mermaid sanitises may keep MathML as well as the label tags.
 */
export function mermaidConfig(tokens: FrameTokens, drawing: { math: boolean } = { math: false }): Record<string, unknown> {
  const dark = isDark(tokens.ground);
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: drawing.math,
    // MathML only: KaTeX's HTML output would need its stylesheet and fonts.
    legacyMathML: false,
    forceLegacyMathML: false,
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
    fontFamily: FRAME_FONT,
    dompurifyConfig: drawing.math
      ? { ALLOWED_TAGS: [...LABEL_TAGS, ...MATH_TAGS], ALLOWED_ATTR: ['class', ...MATH_ATTRIBUTES], ALLOW_DATA_ATTR: false }
      : { ALLOWED_TAGS: LABEL_TAGS, ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false },
    secure: SECURE_KEYS,
    themeVariables: {
      darkMode: dark,
      background: tokens.ground,
      fontFamily: FRAME_FONT,
      fontSize: '14px',
      primaryColor: tokens.raised,
      primaryBorderColor: tokens.lead,
      primaryTextColor: tokens.text,
      secondaryColor: tokens.raised,
      secondaryBorderColor: tokens.trail,
      secondaryTextColor: tokens.text,
      tertiaryColor: tokens.ground,
      tertiaryBorderColor: tokens.rule,
      tertiaryTextColor: tokens.text,
      mainBkg: tokens.raised,
      nodeBorder: tokens.lead,
      lineColor: tokens.lead,
      textColor: tokens.text,
      titleColor: tokens.text,
      clusterBkg: tokens.ground,
      clusterBorder: tokens.rule,
      edgeLabelBackground: tokens.raised,
      noteBkgColor: tokens.raised,
      noteTextColor: tokens.text,
      noteBorderColor: tokens.trail,
      actorBkg: tokens.raised,
      actorBorder: tokens.lead,
      actorTextColor: tokens.text,
      actorLineColor: tokens.muted,
      signalColor: tokens.text,
      signalTextColor: tokens.text,
      labelBoxBkgColor: tokens.raised,
      labelBoxBorderColor: tokens.lead,
      labelTextColor: tokens.text,
      loopTextColor: tokens.text,
      activationBkgColor: tokens.raised,
      activationBorderColor: tokens.trail,
      sequenceNumberColor: tokens.ground,
      pie1: tokens.lead,
      pie2: tokens.trail,
      pie3: tokens.tab,
      pie4: tokens.muted,
      pieStrokeColor: tokens.ground,
      pieTitleTextColor: tokens.text,
      pieSectionTextColor: tokens.ground,
      pieLegendTextColor: tokens.text,
      git0: tokens.lead,
      git1: tokens.trail,
      git2: tokens.tab,
      gitBranchLabel0: tokens.ground,
      gitBranchLabel1: tokens.ground,
      gitBranchLabel2: tokens.ground,
    },
  };
}

export type DiagramResult = { ok: true; svg: string } | { ok: false; problem: string };

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

let loading: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

function load(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((module) => module.default as unknown as MermaidApi);
  // A failed load may succeed later (a transient chunk error); do not keep the failure.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const trimmed = text.trim().slice(0, 600);
  return trimmed || 'Mermaid could not read this diagram.';
}

async function draw(source: string, tokens: FrameTokens): Promise<DiagramResult> {
  const text = preparedSource(source);
  if (!text) return { ok: false, problem: 'The diagram is empty.' };
  // Read from the page at every draw: it carries the app's policy or it does not.
  const policy = diagramPolicy();
  const refused = refusal(text, policy);
  if (refused) return { ok: false, problem: refused };
  const math = policy.math && hasMath(text);
  let mermaid: MermaidApi;
  try {
    mermaid = await load();
  } catch {
    return { ok: false, problem: 'The diagram drawer could not be loaded. Close the panel and open the diagram again.' };
  }
  serial += 1;
  const id = `art-mermaid-${serial}`;
  // Mermaid needs a laid-out container to measure text. This one is off
  // screen, hidden from assistive technology, and removed afterwards.
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:absolute;left:-10000px;top:0;width:1024px;visibility:hidden;pointer-events:none;contain:layout style;';
  document.body.appendChild(host);
  try {
    mermaid.initialize(mermaidConfig(tokens, { math }));
    const { svg } = await mermaid.render(id, text, host);
    return { ok: true, svg: withoutFetchingSvg(svg) };
  } catch (error) {
    return { ok: false, problem: describe(error) };
  } finally {
    host.remove();
    for (const leftover of [id, `d${id}`, `i${id}`]) document.getElementById(leftover)?.remove();
  }
}

/** Draws one diagram. Renders run one at a time: Mermaid's configuration is global. */
export function renderDiagram(source: string, tokens: FrameTokens): Promise<DiagramResult> {
  const next = queue.then(() => draw(source, tokens));
  queue = next.catch(() => undefined);
  return next;
}
