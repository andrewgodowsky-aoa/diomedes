import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  SVG_CHECK_MAX_BYTES,
  SVG_CHECK_PASSED,
  svgCheckApplies,
  svgProblem,
} from '../shared/svg-check.js';
import { svgRoot } from '../shared/turn-blocks.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'svg-check');
const read = (set: 'benign' | 'hostile', name: string) =>
  fs.readFileSync(path.join(FIXTURES, set, name), 'utf8');
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attributes = '') => `<svg ${NS}${attributes}>${body}</svg>`;

// One file per trick, each with the reason that must refuse it. The reason is
// specific enough that a different rule refusing the file fails the test too,
// so every rule these name is exercised by the file that names it.
const HOSTILE: Record<string, string> = {
  'anchor-link.svg': 'the element <a> is not allowed',
  'animate-href.svg': 'the element <animate> is not allowed',
  'bidi-control.svg': 'a bidirectional control character',
  'comment-bang-close.svg': 'a comment holding "--"',
  'comment-html-early-close.svg': 'a comment that HTML and XML end in different places',
  'cursor-attribute.svg': 'the attribute cursor on <rect> is not allowed',
  'doctype-entity.svg': '<!DOCTYPE> is not allowed',
  'doctype-system-entity.svg': '<!DOCTYPE> is not allowed',
  'fe-image.svg': 'the element <feImage> is not allowed',
  'foreign-object-lowercase.svg': 'the element <foreignobject> is not allowed',
  'foreign-object.svg': 'the element <foreignObject> is not allowed',
  'href-charref-no-semicolon.svg': 'a numeric character reference ending in ";"',
  'href-javascript-charref.svg': 'href on <linearGradient> holds javascript:',
  'href-javascript-tab.svg': 'href on <linearGradient> holds javascript:',
  'href-named-entity.svg': 'a numeric character reference ending in ";"',
  'iframe-element.svg': 'the element <iframe> is not allowed',
  'image-data-uri.svg': 'the element <image> is not allowed',
  'image-external.svg': 'the element <image> is not allowed',
  'onclick-mixed-case.svg': 'the event attribute OnClick on <rect> is not allowed',
  'onload-attribute.svg': 'the event attribute onload on <svg> is not allowed',
  'prefixed-script.svg': 'the namespace declaration xmlns:s on <svg> is not allowed',
  'presentation-url-quoted.svg': 'fill on <rect>: url() may name only a #fragment in this file',
  'root-html.svg': 'the element <html> is not allowed',
  'root-not-svg.svg': 'its root element must be <svg>',
  'script-element.svg': 'the element <script> is not allowed',
  'script-uppercase.svg': 'the element <SCRIPT> is not allowed',
  'set-href.svg': 'the element <set> is not allowed',
  'style-attribute-url.svg': 'style on <rect>: url() may name only a #fragment in this file',
  'style-cdata.svg': 'CDATA sections are not allowed',
  'style-charref-no-semicolon.svg': 'a numeric character reference ending in ";"',
  'style-charref-url.svg': 'the <style> element: url() may name only a #fragment in this file',
  'style-escape.svg': 'the <style> element: CSS escapes (a backslash) are not allowed',
  'style-expression.svg': 'style on <rect>: the CSS function expression() is not allowed',
  'style-font-face.svg': 'the <style> element: the CSS at-rule @font-face is not allowed',
  'style-image-set.svg': 'the <style> element: the CSS function image-set() is not allowed',
  'style-import.svg': 'the <style> element: the CSS at-rule @import is not allowed',
  'style-javascript.svg': 'the <style> element holds javascript:',
  'style-named-entity.svg': 'a numeric character reference ending in ";"',
  'svg-slash-onload.svg': 'the tag <svg> is not written the way XML requires',
  'text-javascript.svg': 'text holds javascript:',
  'title-html-breakout.svg': '<title> may hold only text',
  'use-external.svg': 'the element <use> is not allowed',
  'use-fragment.svg': 'the element <use> is not allowed',
  'xhtml-namespace.svg': 'xmlns on <g> must be the SVG namespace',
  'xinclude.svg': 'the namespace declaration xmlns:xi on <svg> is not allowed',
  'xlink-href-external.svg': 'xlink:href on <linearGradient> must name a #fragment in this file',
  'xlink-href-uppercase.svg': 'XLINK:HREF on <linearGradient> must name a #fragment in this file',
  'xlink-rebound.svg': 'the namespace declaration xmlns:x on <svg> is not allowed',
  'xml-base.svg': 'the attribute xml:base on <svg> is not allowed',
  'xml-declaration-breakout.svg': 'its XML declaration is not a plain version 1.0, UTF-8 one',
  'xml-stylesheet.svg': 'the processing instruction <?xml-stylesheet?> is not allowed',
};

describe('svg-check hostile fixtures', () => {
  test('every hostile fixture has its reason here, and every reason its fixture', () => {
    expect(fs.readdirSync(path.join(FIXTURES, 'hostile')).sort()).toEqual(
      Object.keys(HOSTILE).sort(),
    );
  });

  test.each(Object.entries(HOSTILE))('refuses %s: %s', (name, reason) => {
    expect(svgProblem(read('hostile', name))).toContain(reason);
  });
});

describe('svg-check benign fixtures', () => {
  const benign = fs.readdirSync(path.join(FIXTURES, 'benign')).sort();

  test('keeps the three Mermaid captures and the logo', () => {
    // Captured from mermaid.render() with the Console's own configuration
    // (htmlLabels off, strict), byte for byte: the allowlist is measured
    // against real output, and a Mermaid upgrade that writes something new
    // fails here first.
    expect(benign).toEqual([
      'logo.svg',
      'mermaid-flowchart.svg',
      'mermaid-pie.svg',
      'mermaid-sequence.svg',
    ]);
  });

  test.each(benign)('passes %s', (name) => {
    expect(svgProblem(read('benign', name))).toBeNull();
  });
});

describe('svg-check rules', () => {
  test('carries the verdict sentence the review shows', () => {
    expect(SVG_CHECK_PASSED).toBe(
      'SVG check passed: no script, links or outside references (svg-check v1)',
    );
  });

  test('names the line of the refusal and never repeats the value', () => {
    const problem = svgProblem(`${svg('\n<g>\n<rect width="1" height="1" onload="secret-value"/></g>')}`);
    expect(problem).toBe('the event attribute onload on <rect> is not allowed (line 3)');
  });

  test('refuses a file over 1 MB before reading it', () => {
    const padding = `<!--${'x'.repeat(SVG_CHECK_MAX_BYTES)}-->`;
    expect(svgProblem(svg(padding))).toBe('it is larger than 1 MB');
    expect(svgProblem(svg(`<!--${'x'.repeat(1000)}-->`))).toBeNull();
  });

  test('refuses nesting deeper than 128 elements', () => {
    const nest = (depth: number) => svg(`${'<g>'.repeat(depth - 1)}${'</g>'.repeat(depth - 1)}`);
    expect(svgProblem(nest(128))).toBeNull();
    expect(svgProblem(nest(129))).toContain('nest more than 128 deep');
  });

  test('compares names without case, as an HTML parser reads them', () => {
    expect(svgProblem(`<SVG ${NS}><Rect WIDTH="1" Height="1" FILL="url(#a)"/></SVG>`)).toBeNull();
    expect(svgProblem(svg('<rect width="1" height="1" FILL="url(https://example.invalid/p)"/>'))).toContain(
      'FILL on <rect>: url() may name only a #fragment',
    );
  });

  test('reads a plain XML declaration, a byte order mark and comments before the root', () => {
    const body = svg('<rect width="1" height="1"/>');
    expect(svgProblem(`${String.fromCharCode(0xfeff)}<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<!-- a -->\n${body}\n<!-- b -->\n`)).toBeNull();
    expect(svgProblem(`<?xml version="1.1"?>${body}`)).toContain('XML declaration');
    expect(svgProblem(`<?xml version="1.0" encoding="UTF-7"?>${body}`)).toContain('XML declaration');
    expect(svgProblem(` <?xml version="1.0"?>${body}`)).toContain('processing instruction <?xml?>');
  });

  test('decodes references before checking text, and keeps encoded markup as text', () => {
    expect(svgProblem(svg('<text>&lt;script&gt; &#60;b&#x3E; &amp; &quot;&apos;</text>'))).toBeNull();
    expect(svgProblem(svg('<text>&#0;</text>'))).toContain('a character reference to a control character');
    expect(svgProblem(svg('<text>&#xD800;</text>'))).toContain('a character reference to a lone surrogate');
    expect(svgProblem(svg('<text>&nbsp;</text>'))).toContain('numeric character reference ending in ";"');
  });

  test('reads only well-formed tags, as XML requires', () => {
    expect(svgProblem(svg('<rect width=1 height="1"/>'))).toContain('width on <rect> is not quoted');
    expect(svgProblem(svg('<rect width height="1"/>'))).toContain('width on <rect> has no value');
    expect(svgProblem(svg('<rect width="1"height="1"/>'))).toContain('not written the way XML requires');
    expect(svgProblem(svg('<rect fill="red" FILL="blue"/>'))).toContain('<rect> repeats the attribute FILL');
    expect(svgProblem(svg('<g></G>'))).toContain('</G> does not close <g>');
    expect(svgProblem(svg('<g>'))).toContain('</svg> does not close <g>');
    expect(svgProblem(`<svg ${NS}><g/>`)).toContain('<svg> is never closed');
    expect(svgProblem(svg('<rect title="a<b"/>'))).toContain('holds a "<"');
    expect(svgProblem(svg('<text>a ]]> b</text>'))).toContain('text holding "]]>"');
    expect(svgProblem(`${svg('')}<g/>`)).toContain('markup after the <svg> element');
    expect(svgProblem(`${svg('')} trailing`)).toContain('text after the <svg> element');
    expect(svgProblem('')).toBe('it has no <svg> element (line 1)');
  });

  test('handles namespaces explicitly', () => {
    expect(svgProblem(svg('<svg:rect width="1" height="1"/>'))).toContain(
      'the prefixed element <svg:rect> is not allowed',
    );
    expect(svgProblem(svg('<linearGradient id="a" xlink:href="#b"/>'))).toContain(
      'xlink:href on <linearGradient> uses xlink: without declaring xmlns:xlink',
    );
    expect(
      svgProblem(svg('<linearGradient id="a" xlink:href="#b"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"')),
    ).toBeNull();
    expect(
      svgProblem(svg('', ' xmlns:xlink="http://example.invalid/xlink"')),
    ).toContain('xmlns:xlink on <svg> must be the XLink namespace');
  });

  test('keeps CSS to fragments, the listed functions and @keyframes', () => {
    const style = (css: string) => svgProblem(svg(`<style>${css}</style>`));
    expect(style('@keyframes dash{to{stroke-dashoffset:0;}} .a{animation:dash 5s linear infinite}')).toBeNull();
    expect(style('.a{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));fill:hsl(10, 50%, 50%)}')).toBeNull();
    expect(style('.a{fill:url( "#g" )} .b{stroke:url(\'#g\')} .c>.d{content:"url(x)"}')).toBeNull();
    expect(style('.a{fill:url(#g) url(x.png)}')).toContain('url() may name only a #fragment');
    expect(style('.a{fill:url(#g}')).toContain('url() may name only a #fragment');
    expect(style('@media (prefers-color-scheme: dark){.a{fill:#fff}}')).toContain('the CSS at-rule @media is not allowed');
    expect(style('.a{fill:var(--x)}')).toContain('the CSS function var() is not allowed');
    expect(style('.a{fill:red} /* open')).toContain('a CSS comment that never ends');
    expect(style('.a{font-family:"open}')).toContain('a CSS string that never ends');
    expect(style('.a{fill:red}&lt;/style&gt;')).toContain('a "<" is not allowed in CSS');
  });
});

describe('which files svg-check reads', () => {
  test('every .svg, and an .xml that is SVG however its prolog is written', () => {
    expect(svgCheckApplies('logo.svg', 'anything')).toBe(true);
    expect(svgCheckApplies('art/LOGO.SVG', '')).toBe(true);
    expect(svgCheckApplies('icon.xml', svg(''))).toBe(true);
    // svgRoot reads a doctype only up to its first ">", so an internal subset
    // holding one hides the root from it. The doctype itself still counts.
    const subset = `<!DOCTYPE svg [<!ENTITY a ">">]>${svg('')}`;
    expect(svgRoot(subset)).toBe('other');
    expect(svgCheckApplies('icon.xml', subset)).toBe(true);
    // A document that declares itself svg is read as one, even with no <svg tag written out.
    expect(svgCheckApplies('icon.xml', '<!DOCTYPE svg [<!ENTITY r "x">]><x>&r;</x>')).toBe(true);
    expect(svgCheckApplies('icon.xml', `<p:svg xmlns:p="http://www.w3.org/2000/svg"/>`)).toBe(true);
    expect(svgCheckApplies('feed.xml', '<?xml version="1.0"?><feed><title>News</title></feed>')).toBe(false);
    expect(svgCheckApplies('page.html', svg(''))).toBe(false);
    expect(svgCheckApplies('flow.mmd', 'flowchart TD\n  A --> B')).toBe(false);
  });
});
