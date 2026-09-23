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
//   - labels are SVG text (htmlLabels false) and every label Mermaid still
//     sanitises passes an allowlist that keeps no link, source or style;
//   - the few features that load files while laying out are refused before
//     Mermaid sees them: math ($$...$$) and image shapes (@{ img: ... }) load
//     from the app's origin, and style statements can carry CSS url(). Mermaid
//     ends a statement at a newline or a semicolon, so both split them here.
// What Mermaid returns is scanned before it goes anywhere: every CSS url()
// that is not a same-document #fragment, and every other function that
// fetches, is taken out of the drawing's style attributes and <style> text.
// The app document also carries a Content-Security-Policy (vite.config.ts,
// scripts/app-csp.ts), so a fetch that got past all of this still goes nowhere.
// Evidence for each of these is in docs/implementation/2026-09-22-model-artifacts.md
// and docs/product/2026-09-23-artifact-hardening.md.

/** Mermaid's frontmatter grammar (mermaid 11.17.2, src/diagram-api/regexes.ts). */
const FRONTMATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
/** Mermaid's directive grammar: %%{init: ...}%%, %%{wrap}%% and the rest. */
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** Mermaid's math grammar: any $$...$$ on one line turns that label into HTML. */
const MATH = /\$\$(.*?)\$\$/;
/** Statements whose text becomes CSS. */
const STYLE_LINE = /^\s*(style|classDef|linkStyle)\b/i;
/** Mermaid ends a statement at a newline or a semicolon (`graph TD; A-->B; style A ...`). */
const STATEMENT_END = /[\n;]/;
/** CSS that fetches, and CSS escapes (`\75 rl(` is `url(` to a CSS parser). */
const STYLE_FETCH = /url\s*\(|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|element\s*\(|@import|\\[0-9a-f]/i;

export const REFUSED_MATH_OR_IMAGE =
  'Diagrams with math ($$) or image shapes are not drawn here: drawing them would load files from outside the diagram.';
export const REFUSED_STYLE =
  'This diagram styles something with a link to a file (url() in a style, classDef or linkStyle line), so it is not drawn here.';

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

/**
 * Why a diagram is not drawn, or null when it may be. Shape data that names an
 * image, or that uses an escape (a YAML key can spell `img` as `\x69mg`), is refused.
 */
export function refusal(source: string): string | null {
  if (source.split('\n').some((line) => MATH.test(line))) return REFUSED_MATH_OR_IMAGE;
  if (shapeData(source).some((block) => /img/i.test(block) || block.includes('\\'))) return REFUSED_MATH_OR_IMAGE;
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

/**
 * The drawing Mermaid returned, with `withoutFetchingUrls` applied to every
 * style attribute, presentation attribute and <style> element in it. It is
 * read as the frame will read it (HTML, the drawing inside <body>) in an inert
 * document, which runs nothing and loads nothing. Text and labels are not
 * touched, so a label that says "url(x)" still says it.
 */
export function withoutFetchingSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${svg}`, 'text/html');
  for (const element of parsed.body.querySelectorAll('*')) {
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
  }
  return parsed.body.innerHTML;
}

/** The label markup Mermaid may keep: plain inline text formatting, no attributes but class. */
export const LABEL_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'br', 'span', 'div', 'p', 'code', 'pre', 'ul', 'ol', 'li', 'hr',
];

/** Configuration a diagram may not change, even through a directive that escaped stripping. */
export const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'htmlLabels', 'flowchart', 'dompurifyConfig', 'themeCSS', 'themeVariables', 'theme', 'darkMode',
  'fontFamily', 'altFontFamily', 'legacyMathML', 'forceLegacyMathML', 'arrowMarkerAbsolute',
];

/** Mermaid's configuration for one render, themed from the running scheme. */
export function mermaidConfig(tokens: FrameTokens): Record<string, unknown> {
  const dark = isDark(tokens.ground);
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: dark,
    fontFamily: FRAME_FONT,
    dompurifyConfig: { ALLOWED_TAGS: LABEL_TAGS, ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false },
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
  const refused = refusal(text);
  if (refused) return { ok: false, problem: refused };
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
    mermaid.initialize(mermaidConfig(tokens));
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
