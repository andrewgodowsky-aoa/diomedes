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
  REFUSED_MATH_OR_IMAGE,
  REFUSED_STYLE,
  SECURE_KEYS,
  mermaidConfig,
  preparedSource,
  refusal,
  shapeData,
  withoutFetchingUrls,
} from '../client/console/mermaid-render';

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
    expect(refusal('graph TD\n  A["$$x^2$$"]-->B')).toBe(REFUSED_MATH_OR_IMAGE);
    expect(refusal('flowchart TD\n  A@{ img: "https://example.com/x.png", label: "Logo" }')).toBe(REFUSED_MATH_OR_IMAGE);
    expect(refusal('flowchart TD\n  A@{ label: "}", img: "https://example.com/x.png" }')).toBe(REFUSED_MATH_OR_IMAGE);
    expect(refusal('flowchart TD\n  A@{ "\\x69mg": "https://example.com/x.png" }')).toBe(REFUSED_MATH_OR_IMAGE);
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
});
