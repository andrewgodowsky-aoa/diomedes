import katex from 'katex';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SANDBOX,
  FRAME_CSP,
  FRAME_SANDBOX,
  NECTOVIA_TOKENS,
  designLayout,
  frameDocument,
  frameHeight,
  frameTokens,
  isDark,
  svgBox,
  type FrameKind,
} from '../client/console/artifact-frame';
import { ArtifactFrame } from '../client/console/artifact-frames';
import { LEAVING_ATTRIBUTES, SETTLE_PASSES, settle, withoutNavigation } from '../client/console/artifact-links';
import { artifactMaxWidth, clampArtifactWidth } from '../client/console/artifact-width';
import { indexArtifacts } from '../client/console/artifacts';
import {
  CSS_ATTRIBUTES,
  LABEL_TAGS,
  MATH_ATTRIBUTES,
  MATH_TAGS,
  REFUSED_IMAGE,
  REFUSED_MATH_HERE,
  REFUSED_MATH_MARKUP,
  REFUSED_PARTICIPANT_DETAILS,
  REFUSED_SHAPE_ESCAPE,
  REFUSED_STYLE,
  SECURE_KEYS,
  carriesPolicy,
  diagramPolicy,
  hasMath,
  isSequenceDiagram,
  keepsReference,
  mermaidConfig,
  preparedSource,
  refusal,
  shapeData,
  withoutFetchingUrls,
  type HeadLike,
} from '../client/console/mermaid-render';
import { APP_CSP } from '../shared/app-csp';

const KINDS: FrameKind[] = ['diagram', 'image', 'design'];

describe('every srcdoc', () => {
  it('starts with a policy that reaches nothing, before any byte of the artifact', () => {
    const hostile = '<meta http-equiv="Content-Security-Policy" content="default-src *"><img src="https://example.com/x.png">';
    for (const kind of KINDS) {
      const html = frameDocument(kind, hostile);
      expect(html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`)).toBe(true);
      // A second policy in the artifact can only narrow the first; it can never widen it.
      expect(html.indexOf(FRAME_CSP)).toBeLessThan(html.indexOf('default-src *'));
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
    }
  });

  it('uses one policy for every kind, and it names no script source', () => {
    expect(FRAME_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:");
    expect(FRAME_CSP).not.toMatch(/script-src|https?:|\*|'self'|unsafe-eval|connect-src|frame-src|blob:/);
    for (const kind of KINDS) expect(frameDocument(kind, '<p>x</p>')).toContain(`content="${FRAME_CSP}"`);
  });

  it('draws a picture on its own ground and leaves a design as its own page', () => {
    expect(frameDocument('image', '<svg/>')).toContain('background:#f4f5f7');
    expect(frameDocument('diagram', '<svg/>', NECTOVIA_TOKENS)).toContain(`background:${NECTOVIA_TOKENS.ground}`);
    expect(frameDocument('design', '<p>page</p>')).toBe(
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><p>page</p>`,
    );
  });
});

describe('sandboxes', () => {
  it('run no script in any frame, a design included, and never give one the app origin', () => {
    // A frame that runs script can open WebRTC, which no policy governs (hostile review, H1).
    expect(FRAME_SANDBOX).toEqual({ diagram: '', image: '', design: '' });
    for (const tokens of Object.values(FRAME_SANDBOX))
      for (const token of tokens.split(/\s+/).filter(Boolean))
        expect(FORBIDDEN_SANDBOX as readonly string[]).not.toContain(token);
    for (const token of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals'])
      expect(FORBIDDEN_SANDBOX as readonly string[]).toContain(token);
  });

  it('draw nothing in a frame when the links cannot be made inert: here, with no parser at all', () => {
    // Node has no DOMParser, so this is the fail-closed path. The browser suite
    // (tests/artifacts-ui.spec.ts) pins what the frames render when it exists.
    expect(typeof DOMParser).toBe('undefined');
    expect(withoutNavigation('<a href="https://example.com/?secret=1">x</a>', 'page')).toBeNull();
    const records = indexArtifacts('thread-1', [
      { id: 't1', role: 'diomedes', text: '```svg\n<svg viewBox="0 0 10 10"><image href="https://example.com/x.png"/></svg>\n```\n\n```html\n<script>parent.document.title = 1</script>\n```' },
    ]).list;
    const image = renderToStaticMarkup(createElement(ArtifactFrame, { record: records[0] }));
    const design = renderToStaticMarkup(createElement(ArtifactFrame, { record: records[1] }));
    for (const [html, heading] of [
      [image, 'This image was not shown.'],
      [design, 'This design was not shown.'],
    ]) {
      expect(html).not.toContain('<iframe');
      expect(html).toContain(`aria-label="${heading}"`);
      // What the model wrote is only ever text here.
      expect(html).not.toMatch(/<(script|image)\b/);
    }
  });
});

describe('links in a frame source', () => {
  it('are read until a reading changes nothing, and refused when it never settles', () => {
    expect(settle('a', (markup) => markup)).toBe('a');
    const shrink = (markup: string) => markup.slice(0, -1) || markup;
    expect(settle('abc', shrink)).toBe('a');
    let reads = 0;
    const restless = (markup: string) => {
      reads += 1;
      return `${markup}!`;
    };
    expect(settle('a', restless)).toBeNull();
    expect(reads).toBe(SETTLE_PASSES);
  });

  it('take out every attribute that sends a frame or a request somewhere', () => {
    expect([...LEAVING_ATTRIBUTES].sort()).toEqual(['action', 'formaction', 'ping', 'target']);
  });
});

describe('frame colours', () => {
  it('take only plain colours from the running scheme', () => {
    const scheme: Record<string, string> = {
      '--chrome': ' #101014 ',
      '--raised': 'rgb(20, 20, 26)',
      '--t1': 'red; background:url(https://example.com/x)',
      '--t2': 'var(--elsewhere)',
      '--hair-2': 'hsl(210 10% 50% / 0.3)',
      '--light': '#44d2c9',
    };
    const tokens = frameTokens((name) => scheme[name] ?? '');
    expect(tokens.ground).toBe('#101014');
    expect(tokens.raised).toBe('rgb(20, 20, 26)');
    expect(tokens.text).toBe(NECTOVIA_TOKENS.text);
    expect(tokens.muted).toBe(NECTOVIA_TOKENS.muted);
    expect(tokens.rule).toBe('hsl(210 10% 50% / 0.3)');
    expect(tokens.lead).toBe('#44d2c9');
    expect(isDark('#08080c')).toBe(true);
    expect(isDark('#ffffff')).toBe(false);
    expect(isDark('rgb(250, 250, 250)')).toBe(false);
  });
});

describe('frame sizes', () => {
  it('follow the drawing\'s own proportions at the panel\'s width', () => {
    expect(svgBox('<svg viewBox="0 0 200 100" width="400">')).toEqual({ width: 200, height: 100, natural: 400 });
    expect(svgBox('<svg id="m" width="100%" style="max-width: 812px;" viewBox="-8 -8 812 300">')).toEqual({
      width: 812,
      height: 300,
      natural: 812,
    });
    expect(svgBox('<svg>')).toEqual({ width: 300, height: 150, natural: null });
    expect(frameHeight({ width: 200, height: 100, natural: null }, 424)).toBe(224);
    expect(frameHeight({ width: 200, height: 100, natural: 100 }, 424)).toBe(74);
    expect(frameHeight({ width: 1, height: 100000, natural: null }, 424)).toBe(8000);
    expect(frameHeight({ width: 1000, height: 1, natural: null }, 424)).toBe(64);
  });

  it('lay a design out at the chosen width and scale it into the panel', () => {
    expect(designLayout('fit', 448)).toEqual({ width: 448, scale: 1 });
    expect(designLayout('phone', 448)).toEqual({ width: 390, scale: 1 });
    expect(designLayout('desktop', 448)).toEqual({ width: 1280, scale: 0.35 });
  });
});

describe('the artifact column', () => {
  it('is 480 px unless moved, and never wider than 960 px or 60% of the window', () => {
    expect(artifactMaxWidth(null)).toBe(960);
    expect(artifactMaxWidth(2000)).toBe(960);
    expect(artifactMaxWidth(1440)).toBe(864);
    expect(artifactMaxWidth(400)).toBe(320);
    expect(clampArtifactWidth(2000, 1440)).toBe(864);
    expect(clampArtifactWidth(100, 1440)).toBe(320);
    expect(clampArtifactWidth(480.4, 1440)).toBe(480);
  });
});

describe('mermaid input', () => {
  it('loses frontmatter and directives, so a diagram cannot change the configuration', () => {
    const source = '---\nconfig:\n  htmlLabels: true\n  themeCSS: "@import url(https://example.com/x.css)"\n---\n%%{init: {"htmlLabels": true, "securityLevel": "loose"}}%%\n%%{wrap}%%\ngraph TD\n  %% a comment stays\n  A-->B';
    const prepared = preparedSource(source);
    expect(prepared).toBe('graph TD\n  %% a comment stays\n  A-->B');
    expect(prepared).not.toMatch(/htmlLabels|securityLevel|themeCSS/);
  });

  it('refuses what would load files while Mermaid lays the diagram out', () => {
    // Math, on a page without the app's policy (the default, and what the development server is).
    expect(refusal('graph TD\n  A["$$x^2$$"]-->B')).toBe(REFUSED_MATH_HERE);
    // A picture from a link, however the shape data hides it.
    expect(refusal('flowchart TD\n  A@{ img: "https://example.com/x.png", label: "Logo" }')).toBe(REFUSED_IMAGE);
    expect(refusal('flowchart TD\n  A@{ label: "}", img: "https://example.com/x.png" }')).toBe(REFUSED_IMAGE);
    expect(refusal('flowchart TD\n  A@{ "\\x69mg": "https://example.com/x.png" }')).toBe(REFUSED_SHAPE_ESCAPE);
    expect(refusal('flowchart TD\n  A-->B\n  style A fill:#f00,mask-image:url(https://example.com/m.png)')).toBe(REFUSED_STYLE);
    expect(refusal('flowchart TD\n  classDef c background:\\75 rl(https://example.com/x)\n  A:::c')).toBe(REFUSED_STYLE);
    expect(refusal('flowchart TD\n  linkStyle 0 stroke:red,background-image:image-set("https://example.com/x" 1x)')).toBe(REFUSED_STYLE);
    // Everything else is drawn: shapes without images, prices, and a url written in a label.
    expect(refusal('flowchart TD\n  A@{ shape: cyl, label: "Orders" }-->B["Costs $5, then $10"]')).toBeNull();
    expect(refusal('flowchart TD\n  A["See url(x) in the notes"]-->B\n  style B fill:#44d2c9,stroke:#b569fb')).toBeNull();
    expect(shapeData('A@{ shape: rounded }\nB@{ label: "x}" , img: y }')).toEqual([' shape: rounded ', ' label: "x}" , img: y ']);
  });

  it('reads a semicolon as the end of a statement, so a style joined onto one line is refused too', () => {
    const links = ['url(http://example.com/x.png)', 'url(//example.com/x.png)', 'url(data:image/png;base64,AAAA)'];
    const statements = ['style A background-image:', 'classDef foo background-image:', 'linkStyle 0 stroke:red,background:'];
    for (const link of links)
      for (const statement of statements) {
        const source = `graph TD; A-->B; ${statement}${link}; class A foo`;
        expect(refusal(source), source).toBe(REFUSED_STYLE);
      }
    // Whatever whitespace opens the statement, it is still a statement.
    expect(refusal('graph TD; style A fill:url(https://example.com/x)')).toBe(REFUSED_STYLE);
    expect(refusal('graph TD;\tclassDef foo fill:URL(https://example.com/x)')).toBe(REFUSED_STYLE);
    // Joined statements with no link in them are drawn.
    expect(refusal('graph TD; A-->B; style B fill:#44d2c9,stroke:#b569fb; classDef foo stroke-width:2px')).toBeNull();
  });

  it('is laid out strictly: SVG labels, nothing configurable, labels without links or styles', () => {
    const config = mermaidConfig(NECTOVIA_TOKENS);
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: 'base',
      darkMode: true,
    });
    for (const key of ['securityLevel', 'htmlLabels', 'flowchart', 'dompurifyConfig', 'themeCSS', 'secure'])
      expect(SECURE_KEYS).toContain(key);
    expect(config.secure).toBe(SECURE_KEYS);
    expect(config.dompurifyConfig).toEqual({ ALLOWED_TAGS: LABEL_TAGS, ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false });
    for (const tag of ['img', 'image', 'a', 'svg', 'use', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'foreignObject', 'source', 'video', 'audio', 'form', 'input'])
      expect(LABEL_TAGS).not.toContain(tag);
    expect((config.themeVariables as Record<string, string>).lineColor).toBe(NECTOVIA_TOKENS.lead);
    expect((config.themeVariables as Record<string, string>).secondaryBorderColor).toBe(NECTOVIA_TOKENS.trail);
    // MathML only, whatever a diagram asks: both are fixed keys, and both are off.
    expect(config).toMatchObject({ legacyMathML: false, forceLegacyMathML: false });
    for (const key of ['legacyMathML', 'forceLegacyMathML']) expect(SECURE_KEYS).toContain(key);
  });

  it('draws a diagram with math in HTML labels that keep MathML and nothing that links, loads or styles', () => {
    const config = mermaidConfig(NECTOVIA_TOKENS, { math: true });
    // A flowchart draws math only in an HTML label (mermaid 11.17.2 labelHelper), so a diagram
    // with math has them; refusal() has already turned away every label markup it could carry.
    expect(config).toMatchObject({ securityLevel: 'strict', htmlLabels: true, legacyMathML: false, forceLegacyMathML: false });
    expect(config.dompurifyConfig).toEqual({
      ALLOWED_TAGS: [...LABEL_TAGS, ...MATH_TAGS],
      ALLOWED_ATTR: ['class', ...MATH_ATTRIBUTES],
      ALLOW_DATA_ATTR: false,
    });
    // No element that loads, links or runs, and no MathML that can: mglyph names a picture,
    // maction switches on events, annotation-xml carries markup of its own.
    for (const tag of ['img', 'image', 'a', 'svg', 'use', 'style', 'script', 'link', 'foreignObject', 'mglyph', 'maction', 'annotation', 'annotation-xml', 'semantics'])
      expect(MATH_TAGS).not.toContain(tag);
    for (const attribute of ['href', 'xlink:href', 'src', 'style', 'id', 'name', 'xmlns', 'encoding', 'actiontype'])
      expect(MATH_ATTRIBUTES).not.toContain(attribute);
    expect(MATH_ATTRIBUTES.some((attribute) => attribute.startsWith('on'))).toBe(false);
  });

  it('keeps every element and attribute KaTeX writes for Mermaid within that allowlist, or known to be dropped', () => {
    // Mermaid's own call (mermaid 11.17.2 renderKatexUnsanitized): no `trust`, MathML output, and
    // the annotation holding the TeX source taken out afterwards.
    const render = (tex: string) =>
      katex
        .renderToString(tex, { throwOnError: true, displayMode: true, output: 'mathml' })
        .replace(/\n/g, ' ')
        .replace(/<annotation.*<\/annotation>/g, '');
    const corpus = [
      String.raw`x^2 + y^2 = r^2`,
      String.raw`\frac{p}{12}`,
      String.raw`\sqrt[3]{x} + \sqrt{y}`,
      String.raw`\sum_{i=1}^{n} i`,
      String.raw`\int_0^1 f(x)\,\mathrm{d}x`,
      String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
      String.raw`\begin{array}{c|c}1&2\\\hline 3&4\end{array}`,
      String.raw`\left( \frac{a}{b} \right)`,
      String.raw`\overbrace{x+y}^{n}`,
      String.raw`\xrightarrow{abc}`,
      String.raw`\underset{a}{b}`,
      String.raw`\not\equiv`,
      String.raw`\text{net } \mathbb{R}`,
      String.raw`\boxed{x}`,
      String.raw`\cancel{x}`,
      String.raw`\phantom{x}\hspace{1em}\rule{1em}{1em}`,
      String.raw`\color{red}{x} \colorbox{blue}{y} \fcolorbox{red}{blue}{z}`,
      String.raw`\operatorname{sin} x`,
      String.raw`\tag{1} a = b`,
      String.raw`\mathbin{x} \verb|x|`,
      // Commands that need `trust`: without it KaTeX writes their name as red text instead.
      String.raw`\href{https://example.com/x}{y}`,
      String.raw`\url{https://example.com}`,
      String.raw`\includegraphics{https://example.com/x.png}`,
      String.raw`\htmlClass{a}{b} \htmlId{c}{d} \htmlStyle{color:red}{e} \htmlData{f=g}{h}`,
    ];
    // KaTeX's outer <span class="katex"> is a label tag. DOMPurify drops <semantics> and keeps
    // what it holds; `xmlns` and `style` (a \fcolorbox border) are not allowed, so they go too.
    const droppedTags = new Set(['semantics']);
    const droppedAttributes = new Set(['xmlns', 'style']);
    const tags = new Set<string>();
    const attributes = new Set<string>();
    for (const tex of corpus) {
      const html = render(tex);
      for (const [, name] of html.matchAll(/<([a-z][a-z0-9-]*)/gi)) tags.add(name.toLowerCase());
      for (const [, name] of html.matchAll(/\s([a-z][a-z0-9:-]*)\s*=\s*"/gi)) attributes.add(name.toLowerCase());
    }
    const allowedTags = new Set([...LABEL_TAGS, ...MATH_TAGS]);
    const allowedAttributes = new Set(['class', ...MATH_ATTRIBUTES]);
    expect([...tags].filter((name) => !allowedTags.has(name) && !droppedTags.has(name))).toEqual([]);
    expect([...attributes].filter((name) => !allowedAttributes.has(name) && !droppedAttributes.has(name))).toEqual([]);
    // Nothing KaTeX wrote links or loads: no href, no src, no mglyph, whatever the TeX asked for.
    for (const name of ['href', 'src', 'xlink:href']) expect(attributes).not.toContain(name);
    expect(tags).not.toContain('mglyph');
    expect(render(String.raw`\href{https://example.com/x}{y}`)).not.toContain('example.com/x"');
    for (const name of droppedAttributes) expect(allowedAttributes).not.toContain(name);
  });
});

/** A document head holding these tags, the way a DOM would list its children. */
const headOf = (...tags: Array<Record<string, string> & { tag: string }>): HeadLike => ({
  children: tags.map(({ tag, ...attributes }) => ({
    localName: tag,
    getAttribute: (name: string) => attributes[name] ?? null,
  })),
});

describe('mermaid math', () => {
  const POLICY = { math: true };
  const MATH = 'flowchart LR\n  A["$$p = c(1 + m)$$"] --> B["$$\\frac{p}{12}$$"]\n  B --> C[Monthly price]';

  it("is on only in a page whose head carries the app's own Content-Security-Policy, as the built index.html does", () => {
    const policy = (content: string, name = 'Content-Security-Policy') => ({ tag: 'meta', 'http-equiv': name, content });
    const built = headOf(policy(APP_CSP), { tag: 'meta', charset: 'UTF-8' });
    expect(carriesPolicy(built)).toBe(true);
    expect(diagramPolicy({ head: built })).toEqual({ math: true });
    expect(carriesPolicy(headOf(policy(APP_CSP, ' content-security-policy ')))).toBe(true);
    // Another policy beside the app's can only narrow what the page may load.
    expect(carriesPolicy(headOf(policy("img-src *"), policy(APP_CSP)))).toBe(true);
    // A weaker policy, a different one, and the app's with a directive more, less or changed: none is the app's.
    for (const content of [
      "default-src 'self'",
      "img-src 'self'",
      "default-src 'none'",
      `${APP_CSP}; img-src *`,
      APP_CSP.replace("img-src 'self' data:", 'img-src *'),
      APP_CSP.split('; ').slice(1).join('; '),
      ` ${APP_CSP}`,
    ])
      expect(carriesPolicy(headOf(policy(content))), content).toBe(false);
    // The app's policy as report-only refuses nothing.
    expect(carriesPolicy(headOf(policy(APP_CSP, 'Content-Security-Policy-Report-Only')))).toBe(false);
    // The development server's head, an empty policy, a policy not on a <meta>, and no document at all.
    expect(carriesPolicy(headOf({ tag: 'meta', charset: 'UTF-8' }, { tag: 'title' }))).toBe(false);
    expect(carriesPolicy(headOf(policy(' ')))).toBe(false);
    expect(carriesPolicy(headOf({ tag: 'link', 'http-equiv': 'Content-Security-Policy', content: APP_CSP }))).toBe(false);
    expect(carriesPolicy(null)).toBe(false);
    expect(diagramPolicy(null)).toEqual({ math: false });
    // Node has no document: off.
    expect(diagramPolicy()).toEqual({ math: false });
  });

  it('is found however a label spells its dollars, and never across a line', () => {
    expect(hasMath(MATH)).toBe(true);
    expect(hasMath('flowchart LR\n  A["Costs $5, then $10"]')).toBe(false);
    expect(hasMath('flowchart LR\n  A["$$x\n$$"]')).toBe(false);
    // Mermaid's own sanitising turns character references back into dollars before it looks.
    for (const spelt of ['&dollar;&dollar;x&dollar;&dollar;', '&#36;&#36;x&#36;&#36;', '&#36&#36x&#36&#36', '&#x24;&#X24;x&#x0024;&#x24;'])
      expect(hasMath(`flowchart LR\n  A["${spelt}"]`), spelt).toBe(true);
    // Mermaid writes its own #36; and #dollar; as character references, and a markdown string reads \$ as $.
    for (const spelt of ['#36;#36;x#36;#36;', '#dollar;#dollar;x#dollar;#dollar;', '#036;#36;x#36;#0036;', '`\\$\\$x\\$\\$`'])
      expect(hasMath(`flowchart LR\n  A["${spelt}"]`), spelt).toBe(true);
  });

  it('is drawn where the page allows it, and refused where it does not', () => {
    expect(refusal(MATH)).toBe(REFUSED_MATH_HERE);
    expect(refusal(MATH, { math: false })).toBe(REFUSED_MATH_HERE);
    expect(refusal(MATH, POLICY)).toBeNull();
    // A matrix: & and \\ belong to TeX inside the math.
    expect(refusal('flowchart LR\n  A["$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$"] --> B[Area]', POLICY)).toBeNull();
    // Sequence and class diagrams draw math too.
    expect(refusal('sequenceDiagram\n  A->>B: $$x^2$$', POLICY)).toBeNull();
    expect(refusal('sequenceDiagram\n  A->>B: $$x^2$$')).toBe(REFUSED_MATH_HERE);
    // Spelt with character references, it is still math, and a page without the policy refuses it.
    expect(refusal('flowchart LR\n  A["&dollar;&dollar;x&dollar;&dollar;"]')).toBe(REFUSED_MATH_HERE);
    expect(refusal('flowchart LR\n  A["#36;#36;x#36;#36; <b>b</b>"]')).toBe(REFUSED_MATH_HERE);
  });

  it('is refused beside any markup of the label\'s own, wherever in the diagram it is', () => {
    const refused = [
      // Markup beside the math, and in another label.
      'flowchart LR\n  A["$$x^2$$ <b>bold</b>"] --> B[Done]',
      'flowchart LR\n  A["$$x^2$$"] --> B["<img src=/api/projects/p/documents/read?path=a.md>"]',
      // Dollars that pair differently across labels than within one: the markup is still found.
      'flowchart LR\n  A["$$x"] --> B["<b>$$y$$"]',
      // < inside the math too: write \\lt.
      'flowchart LR\n  A["$$a<b$$"]',
      // A character reference or an escape outside the math.
      'flowchart LR\n  A["$$x$$ &lt;b&gt;"]',
      'flowchart LR\n  A["$$x$$"] --> B["C:\\notes"]',
      // Math spelt with references has its & outside any math Mermaid would read as such.
      'flowchart LR\n  A["&dollar;&dollar;x&dollar;&dollar;"]',
      // Mermaid's own spelling of $, which it reads as a dollar in a label with markup, and a
      // markdown string's \$, whose backslashes are outside the math.
      'flowchart LR\n  A["#36;#36;x^2#36;#36; <b>b</b>"]',
      'flowchart LR\n  A["`\\$\\$x^2\\$\\$`"]',
      // A class diagram turns ~T~ into <T>.
      'classDiagram\n  class Shape~T~ {\n    +$$x^2$$ area\n  }',
    ];
    for (const source of refused) expect(refusal(source, POLICY), source).toBe(REFUSED_MATH_MARKUP);
    // Without math, the same labels are v1's business: drawn as SVG text, sanitised.
    expect(refusal('flowchart LR\n  A["<b>bold</b>"] --> B["C:\\notes &amp; more"]', POLICY)).toBeNull();
  });
});

describe('mermaid pictures', () => {
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const shape = (data: string) => `flowchart LR\n  A@{ ${data} }\n  A --> B[Shop front]`;

  it('draws a picture written into the diagram as a quoted data:image URL', () => {
    for (const data of [
      `img: "${GIF}", label: "Logo"`,
      `img: "${GIF}", label: "Logo", w: 48, h: 48, constraint: "on"`,
      `label: "Logo", img: "data:image/png;base64,iVBORw0KGgo="`,
      `img: "data:image/jpeg;base64,/9j/4AAQ"`,
      `img: "data:image/webp;base64,UklGRg=="`,
      // Letters of the payload that spell img are the payload's own.
      `img: "data:image/png;base64,imgIMGimg="`,
    ])
      expect(refusal(shape(data)), data).toBeNull();
    expect(refusal(`flowchart LR\n  A@{img: "${GIF}"}`)).toBeNull();
  });

  it('refuses every other picture: a link, another scheme or type, or a value it cannot read exactly', () => {
    for (const data of [
      'img: "https://example.com/x.png"',
      'img: "//example.com/x.png"',
      'img: "/api/projects/p/documents/read?path=a.md"',
      'img: "x.png"',
      'img: "data:image/svg+xml;base64,PHN2Zz4="',
      'img: "data:image/png,rawbytes"',
      'img: "data:text/html;base64,PGI+"',
      `img: " ${GIF}"`,
      `img: "${GIF} "`,
      // Only a double-quoted value is read as written.
      `img: '${GIF}'`,
      `img: ${GIF}`,
      // A second picture, a name that is not the key Mermaid reads, an alias or a tag.
      `img: "${GIF}", img: "https://example.com/x.png"`,
      `img: "${GIF}", label: "img"`,
      `"img": "${GIF}"`,
      `Img: "https://example.com/x.png"`,
      `x: &u "https://example.com/x.png", img: *u`,
      `img: !!str "https://example.com/x.png"`,
      `x: {img: "https://example.com/x.png"}`,
    ])
      expect(refusal(shape(data)), data).toBe(REFUSED_IMAGE);
  });

  it('refuses shape data with an escape, which could spell a picture any way at all', () => {
    expect(refusal(shape('img: "data:image/png;base64,\\x41A=="'))).toBe(REFUSED_SHAPE_ESCAPE);
    expect(refusal(shape('label: "\\u0069mg"'))).toBe(REFUSED_SHAPE_ESCAPE);
  });
});

// A sequence diagram's `properties` line gives a participant JSON whose icon Mermaid draws as a
// picture from a link (or, written @id, as a <use> of an element of the page), and a `details` line
// reads an element of the app's own document by id (mermaid 11.17.2). Both are refused before
// Mermaid sees the diagram. tests/mermaid-sequence-check.test.ts tries the same check against
// Mermaid's own parser.
describe('mermaid participant details', () => {
  const PICTURE = '{"icon": "https://example.com/shop.png"}';
  const shop = (...lines: string[]) =>
    ['sequenceDiagram', '  participant S as Shop', '  participant C as Courier', ...lines, '  S->>C: Parcel ready'].join('\n');

  it("refuses a participant's properties, whatever its icon names and however the line is written", () => {
    for (const source of [
      shop(`  properties S: ${PICTURE}`),
      shop('  properties S: {"icon": "/api/projects/p/documents/read?path=a.md"}'),
      shop('  properties S: {"icon": "@root"}'),
      shop('  properties S: {"class": "plain"}'),
      shop(`  PROPERTIES S: ${PICTURE}`),
      shop(`  PrOpErTiEs S: ${PICTURE}`),
      shop(`properties S: ${PICTURE}`),
      shop(`\t\t    properties S: ${PICTURE}`),
      `sequenceDiagram; participant S; properties S: ${PICTURE}; S->>C: x`,
      shop(`  S->>C: Parcel ready; properties S: ${PICTURE}`),
      `%% who hands the parcel to whom\n%%{wrap}%%\n\nsequenceDiagram\n  %% the shop's picture\n  properties S: ${PICTURE}`,
      `\n\n   sequenceDiagram\n  properties S: ${PICTURE}`,
    ])
      expect(refusal(source), source).toBe(REFUSED_PARTICIPANT_DETAILS);
  });

  it('refuses details, which reads an element of the page by id', () => {
    for (const source of [shop('  details S: root'), shop('  DETAILS S: root'), 'sequenceDiagram;details S: root'])
      expect(refusal(source), source).toBe(REFUSED_PARTICIPANT_DETAILS);
  });

  it('finds the line wherever Mermaid starts a statement on the same line as something else', () => {
    // After the diagram's keyword, after `end`, after the `}` that closes an accDescr block (a `;`
    // inside it ends nothing), and after / \ ( ) < and >, each of which Mermaid reads as a line of
    // its own.
    for (const source of [
      `sequenceDiagram properties S: ${PICTURE}`,
      shop('  loop every hour', '  S->>C: ping', `  end properties S: ${PICTURE}`),
      shop('  loop every hour', '  S->>C: ping', `  END\tproperties S: ${PICTURE}`),
      ...[')', '(', '<', '>', '/', '\\'].map((mark) => shop(`  ${mark}properties S: ${PICTURE}`)),
      shop('  ) ( > details S: root'),
      shop(`  accDescr { who; what } properties S: ${PICTURE}`),
      shop('  accDescr {', '    who hands the parcel over', `  }properties S: ${PICTURE}`),
    ])
      expect(refusal(source), source).toBe(REFUSED_PARTICIPANT_DETAILS);
  });

  it('reads the diagram as Mermaid will, after its own frontmatter, directive and comment passes', () => {
    // A second frontmatter block, and directives that re-form once the one inside each is taken out.
    // The Console takes each out once (preparedSource), and Mermaid takes each out once more before
    // it parses what is left, so the check reads the prepared text as Mermaid will.
    for (const source of [
      `---\ntitle: a\n---\n---\ntitle: b\n---\nsequenceDiagram\n  properties S: ${PICTURE}`,
      shop('  loop x', '  S->>C: y', `  end %%{%%{wrap}%%wrap}%%properties S: ${PICTURE}`),
      shop(`  %%{%%{wrap}%%wrap}%%details S: root`),
    ])
      expect(refusal(preparedSource(source)), source).toBe(REFUSED_PARTICIPANT_DETAILS);
    expect(refusal(`---\ntitle: a\n---\n---\ntitle: b\n---\nsequenceDiagram\n  properties S: ${PICTURE}`)).toBe(
      REFUSED_PARTICIPANT_DETAILS,
    );
  });

  it("is a sequence diagram only where Mermaid's own detector says so", () => {
    expect(isSequenceDiagram('sequenceDiagram\n  A->>B: x')).toBe(true);
    expect(isSequenceDiagram('  %% note\n\n%%{wrap}%%\n   sequenceDiagram')).toBe(true);
    expect(isSequenceDiagram('---\ntitle: a\n---\n---\ntitle: b\n---\nsequenceDiagram')).toBe(true);
    expect(isSequenceDiagram('flowchart TD\n  sequenceDiagram --> B')).toBe(false);
    expect(isSequenceDiagram('%% sequenceDiagram\nflowchart TD')).toBe(false);
    // Mermaid 11.17.2's detector is case-sensitive, so Mermaid finds no diagram here at all.
    expect(isSequenceDiagram('SEQUENCEDIAGRAM\n  A->>B: x')).toBe(false);
  });

  it('draws a flowchart, or any other kind, whose nodes are called details and properties', () => {
    for (const source of [
      'flowchart TD\n  details --> properties\n  properties[Properties] --> C[Done]',
      'graph LR; details-->properties; properties-->done',
      'flowchart TD\n  A[Order] --> details\n  details;properties',
      'classDiagram\n  class Order {\n    details\n    properties\n  }',
      'stateDiagram-v2\n  details --> properties',
    ])
      expect(refusal(source), source).toBeNull();
  });

  it('draws a sequence diagram that only says the words, in a message, a name, a note, a title or a comment', () => {
    for (const source of [
      shop('  S->>C: details of the parcel'),
      shop('  C-->>S: properties, then (details)'),
      shop('  Note over S: details: see the order'),
      shop('  loop details', '  S->>C: ping', '  end'),
      'sequenceDiagram\n  participant D as Order details\n  participant P as properties list\n  D->>P: send',
      'sequenceDiagram\n  Order details->>Courier: hand over',
      'sequenceDiagram\n  title Order details and properties\n  A->>B: x',
      'sequenceDiagram\n  %% properties S: {"icon": "/api/x"} is only a comment\n  A->>B: x',
    ])
      expect(refusal(source), source).toBeNull();
  });

  it('draws links, which only become menu entries that load and read nothing', () => {
    for (const source of [shop('  links S: {"Orders": "https://example.com/orders"}'), shop('  link S: Orders @ https://example.com/orders')])
      expect(refusal(source), source).toBeNull();
  });
});

describe('what Mermaid drew', () => {
  it('keeps a same-document url(#...), which is how its lines find their arrowheads', () => {
    for (const css of [
      'url(#arrowhead)',
      'marker-end:url(#art-mermaid-1_flowchart-v2-pointEnd)',
      'fill:url( "#grad" )',
      "filter:url('#drop-shadow')",
      'fill:url(\\23 grad)',
    ])
      expect(withoutFetchingUrls(css)).toBe(css);
  });

  it('takes out every other url(), whatever it points at and however it is spelt', () => {
    const cases: Array<[string, string]> = [
      ['background-image:url(http://example.com/x.png)', 'background-image:none'],
      ['background-image:url(https://example.com/x.png)', 'background-image:none'],
      ['background-image:url(//example.com/x.png)', 'background-image:none'],
      ['background-image:url(data:image/png;base64,AAAA)', 'background-image:none'],
      ['background:URL("https://example.com/x")', 'background:none'],
      ["cursor:url( 'https://example.com/c.cur' ),auto", 'cursor:none,auto'],
      ['mask-image:\\75 rl(https://example.com/m.png)', 'mask-image:none'],
      ['mask-image:\\000075rl(https://example.com/m.png)', 'mask-image:none'],
      ['background:u\\rl(https://example.com/x)', 'background:none'],
      ['background:url(https://example.com/a\\)b)', 'background:none'],
      ['fill:url(https://example.com/x.svg#grad)', 'fill:none'],
      ['.a{fill:red}.b>*{background:url(http://example.com/x)!important}', '.a{fill:red}.b>*{background:none!important}'],
    ];
    for (const [css, kept] of cases) expect(withoutFetchingUrls(css), css).toBe(kept);
  });

  it('takes out every other function and rule that fetches a file', () => {
    const cases: Array<[string, string]> = [
      ['mask:image-set("https://example.com/x" 1x)', 'mask:none'],
      ['mask:-webkit-image-set(url(https://example.com/x) 1x)', 'mask:none'],
      ['background:image("https://example.com/x")', 'background:none'],
      ['background:cross-fade(url(https://example.com/a), url(#b) 50%)', 'background:none'],
      ['background:element(#x)', 'background:none'],
      ['@font-face{font-family:x;src:url(https://example.com/f.woff2)}', '@font-face{font-family:x;src:none}'],
      ['@import "https://example.com/x.css"; .a{fill:red}', ' .a{fill:red}'],
      ['@IMPORT url(https://example.com/x.css) screen;.a{fill:red}', '.a{fill:red}'],
      ['@\\69mport "https://example.com/x.css";', ''],
      ['.a{fill:var(--x, url(https://example.com/x))}', '.a{fill:var(--x, none)}'],
    ];
    for (const [css, kept] of cases) expect(withoutFetchingUrls(css), css).toBe(kept);
  });

  it('leaves strings, comments and names that only mention url( as written', () => {
    for (const css of [
      'content:"url(https://example.com/x)"',
      "content:'image-set(x)'",
      '/* url(https://example.com/x) */fill:red',
      'u/**/rl(https://example.com/x)',
      'font-family:"Segoe UI",system-ui;fill:#44d2c9;stroke:rgba(230,233,237,.14)',
      '#art-mermaid-1 .node rect{fill:#14141a;stroke:#44d2c9;stroke-width:1px}',
    ])
      expect(withoutFetchingUrls(css)).toBe(css);
    // A string a newline cuts short ends there, as it does for a browser, so what follows is read.
    expect(withoutFetchingUrls('content:"x\nbackground:url(https://example.com/x)')).toBe('content:"x\nbackground:none');
  });

  it('is applied to every attribute of a drawing that holds CSS, and to nothing else', () => {
    for (const name of ['style', 'fill', 'stroke', 'marker-end', 'clip-path', 'mask', 'filter', 'cursor'])
      expect(CSS_ATTRIBUTES).toContain(name);
    for (const name of ['id', 'class', 'aria-label', 'aria-roledescription', 'data-id'])
      expect(CSS_ATTRIBUTES).not.toContain(name);
  });

  it('keeps a picture only when it is written into the drawing, and a <use> only of the drawing itself', () => {
    // The browser suite (tests/artifacts-ui.spec.ts) runs withoutFetchingSvg on whole drawings.
    const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    for (const name of ['image', 'feImage', 'feimage']) expect(keepsReference(name, [GIF]), name).toBe(true);
    for (const href of [
      'https://example.com/x.png',
      '//example.com/x.png',
      '/api/projects/p/documents/read?path=a.md',
      'x.png',
      '#logo',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,rawbytes',
      `${GIF} `,
      '',
    ]) {
      expect(keepsReference('image', [href]), href).toBe(false);
      expect(keepsReference('feImage', [href]), href).toBe(false);
    }
    // Every href it has must hold, and one it lacks is no picture at all.
    expect(keepsReference('image', [GIF, 'https://example.com/x.png'])).toBe(false);
    expect(keepsReference('image', [])).toBe(false);
    expect(keepsReference('use', ['#actor-man'])).toBe(true);
    for (const href of ['https://example.com/s.svg#x', '/api/x#y', 'x.svg#y', `${GIF}#x`, ' #x', ''])
      expect(keepsReference('use', [href]), href).toBe(false);
    expect(keepsReference('use', ['#a', '/api/x#b'])).toBe(false);
    expect(keepsReference('use', [])).toBe(false);
    // Other elements are not this check's business: a link is made inert where its frame is built.
    expect(keepsReference('a', ['https://example.com/x'])).toBe(true);
    expect(keepsReference('rect', [])).toBe(true);
  });
});
