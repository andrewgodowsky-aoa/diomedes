// svg-check v1: what every SVG a model proposes must pass before it can become
// a Need. The server runs it on the exact text a proposal would write, refuses
// the whole proposal with the reason when it fails, and never rewrites a byte.
//
// It is an allowlist over a small strict tokenizer, not a blocklist. The
// tokenizer reads a subset of XML that an XML parser (an .svg opened in a
// browser) and an HTML parser (the same markup inlined into a page, which is
// how the artifact frame shows it) read the same way; anything outside that
// subset is refused rather than guessed at. Every element, attribute, CSS
// at-rule and CSS function it does not list is refused, with a reason naming
// it. Names compare case-insensitively, because an HTML parser lowercases
// them. Character references are decoded before any value is checked.
//
// What it lists is what the Console's own Mermaid 11.17.2 drawings need (the
// benign fixtures in tests/fixtures/svg-check are captured from it) plus the
// contract draft's shapes, text, gradients, clips, masks, patterns and
// markers. A Mermaid upgrade that writes a new element or attribute fails
// those fixtures before it reaches anyone.
//
// Pure: no DOM, no Node, no clock. The client may show the same verdict, but
// only the server's counts.

import { svgRoot } from './turn-blocks.js';

export const SVG_CHECK_VERSION = 1;
/** The one line a Need carries for a file that passed. */
export const SVG_CHECK_PASSED = `SVG check passed: no script, links or outside references (svg-check v${SVG_CHECK_VERSION})`;
/** Larger files are refused before they are read. */
export const SVG_CHECK_MAX_BYTES = 1024 * 1024;
/** How deep elements may nest. Real drawings stay far below it. */
const MAX_DEPTH = 128;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/** The elements, lower-cased, with the spelling a reason uses. */
const ELEMENTS = new Map(
  [
    // structure
    'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'style',
    // shapes and text
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
    // paint servers, clips, masks and markers
    'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
    // Mermaid's drop shadow, and no other filter primitive
    'filter', 'feDropShadow',
  ].map((name) => [name.toLowerCase(), name]),
);

/** Elements that hold text only: no child element, no comment. */
const TEXT_ONLY = new Set(['style', 'title', 'desc']);

/** The attributes, lower-cased. Their values are checked below where they can name anything. */
const ATTRIBUTES = new Set(
  [
    // identity and accessibility
    'id', 'class', 'style', 'name', 'role', 'lang', 'xml:lang', 'xml:space', 'type',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-roledescription', 'aria-hidden',
    // Mermaid 11.17.2's data attributes, by name: other data-* names are what page scripts
    // read as code (data-bind, data-hx-*), so no pattern admits them
    'data-id', 'data-et', 'data-look', 'data-type', 'data-color-id', 'data-x-shift',
    'data-venn-sets', 'data-to', 'data-from', 'data-points', 'data-edge',
    // namespaces, and references inside this file
    'xmlns', 'xmlns:xlink', 'href', 'xlink:href',
    // the viewport
    'version', 'baseProfile', 'width', 'height', 'x', 'y', 'viewBox', 'preserveAspectRatio',
    // geometry and text layout
    'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'x1', 'y1', 'x2', 'y2',
    'pathLength', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'transform',
    'transform-origin',
    // paint servers, clips, masks and markers
    'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'patternUnits',
    'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits',
    'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
    // the filter and its drop shadow
    'filterUnits', 'primitiveUnits', 'stdDeviation', 'in', 'result',
    // presentation attributes
    'alignment-baseline', 'baseline-shift', 'clip-path', 'clip-rule', 'color',
    'color-interpolation', 'color-interpolation-filters', 'direction', 'display',
    'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule', 'filter', 'flood-color',
    'flood-opacity', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
    'font-variant', 'font-weight', 'letter-spacing', 'marker', 'marker-start', 'marker-mid',
    'marker-end', 'mask', 'opacity', 'overflow', 'paint-order', 'pointer-events',
    'shape-rendering', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray',
    'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'stroke-opacity', 'stroke-width', 'text-anchor', 'text-decoration', 'text-rendering',
    'unicode-bidi', 'vector-effect', 'visibility', 'word-spacing', 'writing-mode',
  ].map((name) => name.toLowerCase()),
);

/** Attributes whose value is CSS that can name another resource: each goes through the CSS check. */
const CSS_VALUED = new Set([
  'style', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker', 'marker-start',
  'marker-mid', 'marker-end',
]);

/**
 * The CSS functions allowed besides `url()`, which may name only a #fragment.
 * rgb, rgba and drop-shadow are what the Mermaid fixtures use; hsl and hsla
 * are the other plain colour notations. Nothing here can fetch.
 */
const CSS_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'drop-shadow']);
/** The CSS at-rules allowed: Mermaid's edge animations. */
const CSS_AT_RULES = new Set(['keyframes']);

/** A reference to an element in this file: `#` and an id. Nothing else is a same-document reference. */
const FRAGMENT = /^#[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;
const SPACE = /[ \t\r\n]*/y;
const REFERENCE = /&(?:(amp|lt|gt|quot|apos)|#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6}));/y;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const XML_DECLARATION =
  /<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/y;

class Refusal extends Error {}

/**
 * Why this SVG is refused, or null when it passes. The reason names the
 * element, attribute or CSS feature and the line, and never repeats a value.
 */
export function svgProblem(text: string): string | null {
  try {
    new Reader(text).read();
    return null;
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
}

/**
 * Whether a proposed file must pass svgProblem: every `.svg`, and an `.xml`
 * that is SVG. svgRoot decides the ordinary case; a doctype naming svg, an
 * `<svg` tag or the SVG namespace anywhere in it also counts, so no prolog
 * trick that confuses svgRoot lets an SVG through as plain XML.
 */
export function svgCheckApplies(path: string, text: string): boolean {
  if (/\.svg$/i.test(path)) return true;
  if (!/\.xml$/i.test(path)) return false;
  return (
    svgRoot(text) === 'svg' ||
    /<!doctype[ \t\r\n]+svg/i.test(text) ||
    /<svg[\s/>]/i.test(text) ||
    text.includes(SVG_NAMESPACE)
  );
}

/** Whether a code point may appear, written or referenced: XML's characters, less controls and bidi overrides. */
function characterProblem(code: number): string | null {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return null;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return 'a control character';
  if (code >= 0xd800 && code <= 0xdfff) return 'a lone surrogate';
  if (code === 0xfffe || code === 0xffff || code > 0x10ffff) return 'a character XML does not allow';
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
    return 'a bidirectional control character, which can hide text from review';
  return null;
}

/** Whether decoded text names a script URL scheme, once the controls and spaces a URL parser drops are gone. */
function namesScript(value: string): string | null {
  const squeezed = value.replace(/[\x00-\x20]+/g, '').toLowerCase();
  if (squeezed.includes('javascript:')) return 'javascript:';
  if (squeezed.includes('vbscript:')) return 'vbscript:';
  return null;
}

class Reader {
  private at = 0;
  private readonly stack: { name: string; xlink: boolean }[] = [];
  private rootSeen = false;
  constructor(private readonly text: string) {}

  private refuse(reason: string, at = this.at): never {
    let line = 1;
    for (let i = 0; i < at && i < this.text.length; i += 1) if (this.text.charCodeAt(i) === 10) line += 1;
    throw new Refusal(`${reason} (line ${line})`);
  }

  read() {
    this.characters();
    const text = this.text;
    if (text.charCodeAt(0) === 0xfeff) this.at = 1;
    if (text.startsWith('<?xml', this.at) && /[ \t\r\n]/.test(text[this.at + 5] ?? '')) {
      XML_DECLARATION.lastIndex = this.at;
      if (!XML_DECLARATION.test(text))
        this.refuse('its XML declaration is not a plain version 1.0, UTF-8 one');
      this.at = XML_DECLARATION.lastIndex;
    }
    while (this.at < text.length) {
      if (text[this.at] === '<') this.markup();
      else this.characterData();
    }
    if (!this.rootSeen) this.refuse('it has no <svg> element');
    const open = this.stack.at(-1);
    if (open) this.refuse(`<${open.name}> is never closed`);
  }

  /** Every character, before anything is read: size, controls, surrogates, bidi overrides. */
  private characters() {
    const text = this.text;
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) this.refuse('it holds a lone surrogate', i);
        bytes += 4;
        i += 1;
        continue;
      }
      const problem = characterProblem(code);
      if (problem) this.refuse(`it holds ${problem}`, i);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (bytes > SVG_CHECK_MAX_BYTES) throw new Refusal('it is larger than 1 MB');
  }

  private markup() {
    const text = this.text;
    const at = this.at;
    if (text.startsWith('<!--', at)) return this.comment();
    if (text.startsWith('<![CDATA[', at)) this.refuse('CDATA sections are not allowed');
    if (text.startsWith('<!', at)) {
      const word = /^<!([A-Za-z]*)/.exec(text.slice(at, at + 20))?.[1].toUpperCase() ?? '';
      this.refuse(word ? `<!${word}> is not allowed` : 'a "<!" that starts no comment');
    }
    if (text.startsWith('<?', at)) {
      NAME.lastIndex = at + 2;
      const name = NAME.exec(text)?.[0];
      this.refuse(
        name
          ? `the processing instruction <?${name}?> is not allowed; only a leading XML declaration is`
          : 'a "<?" that is not the leading XML declaration',
      );
    }
    if (text.startsWith('</', at)) return this.endTag();
    this.startTag();
  }

  private comment() {
    const text = this.text;
    const start = this.at;
    const close = text.indexOf('-->', start + 4);
    if (close < 0) this.refuse('a comment that never ends');
    const body = text.slice(start + 4, close);
    if (body.startsWith('>') || body.startsWith('->'))
      this.refuse('a comment that HTML and XML end in different places');
    if (body.includes('--')) this.refuse('a comment holding "--"');
    if (body.endsWith('-')) this.refuse('a comment ending in "-"');
    const scheme = namesScript(body);
    if (scheme) this.refuse(`a comment holds ${scheme}`);
    this.at = close + 3;
  }

  /** Text between tags, outside any text-only element. */
  private characterData() {
    const start = this.at;
    const decoded = this.readText();
    if (!this.stack.length && decoded.trim())
      this.refuse(this.rootSeen ? 'text after the <svg> element' : 'text before the <svg> element', start);
    const scheme = namesScript(decoded);
    if (scheme) this.refuse(`text holds ${scheme}`, start);
  }

  /** Text up to the next `<`, its references decoded. */
  private readText(): string {
    const text = this.text;
    const start = this.at;
    let decoded = '';
    while (this.at < text.length && text[this.at] !== '<') {
      if (text[this.at] === '&') decoded += this.reference();
      else {
        let end = this.at;
        while (end < text.length && text[end] !== '<' && text[end] !== '&') end += 1;
        decoded += text.slice(this.at, end);
        this.at = end;
      }
    }
    if (text.slice(start, this.at).includes(']]>')) this.refuse('text holding "]]>"', start);
    return decoded;
  }

  /** One character reference at `this.at`, decoded. */
  private reference(): string {
    REFERENCE.lastIndex = this.at;
    const match = REFERENCE.exec(this.text);
    if (!match)
      this.refuse(
        'an "&" that is not &amp;, &lt;, &gt;, &quot;, &apos; or a numeric character reference ending in ";"',
      );
    let char: string;
    if (match[1]) char = NAMED[match[1]];
    else {
      const code = match[2] ? Number.parseInt(match[2], 10) : Number.parseInt(match[3], 16);
      const problem = code === 0 ? 'a control character' : characterProblem(code);
      if (problem) this.refuse(`a character reference to ${problem}`);
      char = String.fromCodePoint(code);
    }
    this.at = REFERENCE.lastIndex;
    return char;
  }

  private skipSpace(): boolean {
    SPACE.lastIndex = this.at;
    SPACE.exec(this.text);
    const moved = SPACE.lastIndex > this.at;
    this.at = SPACE.lastIndex;
    return moved;
  }

  private readName(): string | null {
    NAME.lastIndex = this.at;
    const name = NAME.exec(this.text)?.[0] ?? null;
    if (name) this.at = NAME.lastIndex;
    return name;
  }

  private startTag() {
    const text = this.text;
    const tagStart = this.at;
    this.at += 1;
    const name = this.readName();
    if (!name) this.refuse('a "<" that starts no element, comment or end tag', tagStart);
    const lower = name.toLowerCase();
    if (name.includes(':')) this.refuse(`the prefixed element <${name}> is not allowed`, tagStart);
    if (!ELEMENTS.has(lower)) this.refuse(`the element <${name}> is not allowed`, tagStart);
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.rootSeen) this.refuse(`markup after the <svg> element`, tagStart);
      if (lower !== 'svg') this.refuse('its root element must be <svg>', tagStart);
      this.rootSeen = true;
    } else if (TEXT_ONLY.has(parent.name.toLowerCase()))
      this.refuse(`<${parent.name}> may hold only text`, tagStart);
    if (this.stack.length >= MAX_DEPTH) this.refuse(`elements nest more than ${MAX_DEPTH} deep`, tagStart);
    const seen = new Set<string>();
    let xlink = parent?.xlink ?? false;
    const prefixed: { name: string; at: number }[] = [];
    let selfClosing = false;
    for (;;) {
      const spaced = this.skipSpace();
      if (text.startsWith('/>', this.at)) {
        this.at += 2;
        selfClosing = true;
        break;
      }
      if (text[this.at] === '>') {
        this.at += 1;
        break;
      }
      if (this.at >= text.length) this.refuse(`the tag <${name}> never ends`, tagStart);
      if (!spaced) this.refuse(`the tag <${name}> is not written the way XML requires`);
      const attributeAt = this.at;
      const attribute = this.readName();
      if (!attribute) this.refuse(`the tag <${name}> holds an attribute this check cannot read`);
      const key = attribute.toLowerCase();
      this.skipSpace();
      if (text[this.at] !== '=') this.refuse(`the attribute ${attribute} on <${name}> has no value`);
      this.at += 1;
      this.skipSpace();
      const quote = text[this.at];
      if (quote !== '"' && quote !== "'") this.refuse(`the attribute ${attribute} on <${name}> is not quoted`);
      const close = text.indexOf(quote, this.at + 1);
      if (close < 0) this.refuse(`the attribute ${attribute} on <${name}> never ends`);
      if (text.slice(this.at + 1, close).includes('<'))
        this.refuse(`the attribute ${attribute} on <${name}> holds a "<"`);
      this.at += 1;
      let value = '';
      while (this.at < close) {
        if (text[this.at] === '&') value += this.reference();
        else {
          // Bounded by the value's own end: an indexOf here would scan the rest
          // of the file once per attribute.
          let end = this.at;
          while (end < close && text[end] !== '&') end += 1;
          value += text.slice(this.at, end);
          this.at = end;
        }
      }
      this.at = close + 1;
      if (seen.has(key)) this.refuse(`<${name}> repeats the attribute ${attribute}`, attributeAt);
      seen.add(key);
      this.attribute(name, attribute, key, value, attributeAt);
      if (key === 'xmlns:xlink') xlink = true;
      else if (key.startsWith('xlink:')) prefixed.push({ name: attribute, at: attributeAt });
    }
    for (const item of prefixed)
      if (!xlink) this.refuse(`${item.name} on <${name}> uses xlink: without declaring xmlns:xlink`, item.at);
    if (!selfClosing) this.stack.push({ name, xlink });
    if (!selfClosing && TEXT_ONLY.has(lower)) this.textOnly(name, lower);
  }

  /** The content of a text-only element, which must end with its own end tag. */
  private textOnly(name: string, lower: string) {
    const start = this.at;
    const decoded = this.readText();
    if (this.text.startsWith('<![CDATA[', this.at)) this.refuse('CDATA sections are not allowed');
    if (!this.text.startsWith('</', this.at)) this.refuse(`<${name}> may hold only text`);
    const scheme = namesScript(decoded);
    if (scheme) this.refuse(`the <${name}> element holds ${scheme}`, start);
    if (lower === 'style') {
      const problem = cssProblem(decoded);
      if (problem) this.refuse(`the <${name}> element: ${problem}`, start);
    }
  }

  private endTag() {
    const tagStart = this.at;
    this.at += 2;
    const name = this.readName();
    this.skipSpace();
    if (!name || this.text[this.at] !== '>') this.refuse('an end tag this check cannot read', tagStart);
    this.at += 1;
    const open = this.stack.pop();
    if (!open) this.refuse(`</${name}> closes nothing`, tagStart);
    if (open.name !== name) this.refuse(`</${name}> does not close <${open.name}>`, tagStart);
  }

  private attribute(element: string, attribute: string, key: string, value: string, at: number) {
    if (key.startsWith('on')) this.refuse(`the event attribute ${attribute} on <${element}> is not allowed`, at);
    if (key.startsWith('xmlns:') && key !== 'xmlns:xlink')
      this.refuse(`the namespace declaration ${attribute} on <${element}> is not allowed`, at);
    if (!ATTRIBUTES.has(key)) this.refuse(`the attribute ${attribute} on <${element}> is not allowed`, at);
    const scheme = namesScript(value);
    if (scheme) this.refuse(`${attribute} on <${element}> holds ${scheme}`, at);
    if (key === 'xmlns' && value !== SVG_NAMESPACE)
      this.refuse(`xmlns on <${element}> must be the SVG namespace`, at);
    else if (key === 'xmlns:xlink' && value !== XLINK_NAMESPACE)
      this.refuse(`xmlns:xlink on <${element}> must be the XLink namespace`, at);
    else if ((key === 'href' || key === 'xlink:href') && !FRAGMENT.test(value))
      this.refuse(`${attribute} on <${element}> must name a #fragment in this file`, at);
    else if (CSS_VALUED.has(key)) {
      const problem = cssProblem(value);
      if (problem) this.refuse(`${attribute} on <${element}>: ${problem}`, at);
    } else if (/url[ \t\r\n\f]*\(/i.test(value)) this.refuse(`${attribute} on <${element}> may not hold url()`, at);
  }
}

// ---- CSS ---------------------------------------------------------------------

const cssSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const cssNameStart = (c: string | undefined) => !!c && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const cssNameChar = (c: string | undefined) => !!c && (/[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80);

/**
 * Why this CSS (a `<style>` element's text or an attribute's value, its
 * references already decoded) is refused, or null. A token scanner, ported
 * from `withoutFetchingUrls` in client/console/mermaid-render.ts and made
 * stricter: escapes are refused outright, so no name can be spelled in a way
 * the scanner does not see, and every function and at-rule must be listed.
 * Properties and selectors are not restricted: without a function or at-rule
 * that fetches, none of them can reach outside the file.
 */
function cssProblem(css: string): string | null {
  if (css.includes('\\')) return 'CSS escapes (a backslash) are not allowed';
  if (css.includes('<')) return 'a "<" is not allowed in CSS';
  let at = 0;
  while (at < css.length) {
    const c = css[at];
    if (c === '/' && css[at + 1] === '*') {
      const end = css.indexOf('*/', at + 2);
      if (end < 0) return 'a CSS comment that never ends';
      at = end + 2;
    } else if (c === '"' || c === "'") {
      const end = stringEnd(css, at);
      if (end < 0) return 'a CSS string that never ends';
      at = end;
    } else if (c === '@') {
      let end = at + 1;
      if (css[end] === '-') end += 1;
      while (cssNameChar(css[end])) end += 1;
      const rule = css.slice(at + 1, end).toLowerCase();
      if (!CSS_AT_RULES.has(rule)) return rule ? `the CSS at-rule @${rule} is not allowed` : 'an "@" that starts no allowed CSS at-rule';
      at = end;
    } else if (cssNameStart(c) || (c === '-' && (cssNameStart(css[at + 1]) || css[at + 1] === '-'))) {
      let end = at + 1;
      while (cssNameChar(css[end])) end += 1;
      const name = css.slice(at, end).toLowerCase();
      if (css[end] !== '(') {
        at = end;
        continue;
      }
      if (name === 'url') {
        const close = urlEnd(css, end + 1);
        if (close < 0) return 'url() may name only a #fragment in this file';
        at = close;
      } else if (!CSS_FUNCTIONS.has(name)) return `the CSS function ${name}() is not allowed`;
      else at = end + 1;
    } else at += 1;
  }
  return null;
}

/** Where a CSS string starting at `at` ends, past its quote, or -1 if a newline or the end comes first. */
function stringEnd(css: string, at: number): number {
  const quote = css[at];
  for (let end = at + 1; end < css.length; end += 1) {
    const c = css[end];
    if (c === quote) return end + 1;
    if (c === '\n' || c === '\r' || c === '\f') return -1;
  }
  return -1;
}

/** Where a `url(` whose argument starts at `at` ends, past its `)`, or -1 unless it names a #fragment. */
function urlEnd(css: string, at: number): number {
  let end = at;
  while (cssSpace(css[end])) end += 1;
  let named: string;
  if (css[end] === '"' || css[end] === "'") {
    const after = stringEnd(css, end);
    if (after < 0) return -1;
    named = css.slice(end + 1, after - 1);
    end = after;
    while (cssSpace(css[end])) end += 1;
    if (css[end] !== ')') return -1;
  } else {
    const close = css.indexOf(')', end);
    if (close < 0) return -1;
    named = css.slice(end, close).replace(/[ \t\n\r\f]+$/, '');
    end = close;
  }
  return FRAGMENT.test(named) ? end + 1 : -1;
}
