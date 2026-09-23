import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_CSP,
  FORBIDDEN_SANDBOX,
  FRAME_SANDBOX,
  NECTOVIA_TOKENS,
  STATIC_CSP,
  cspFor,
  designLayout,
  frameDocument,
  frameHeight,
  frameTokens,
  isDark,
  svgBox,
  type FrameKind,
} from '../client/console/artifact-frame';
import { ArtifactFrame } from '../client/console/artifact-frames';
import { artifactMaxWidth, clampArtifactWidth } from '../client/console/artifact-width';
import { indexArtifacts } from '../client/console/artifacts';
import {
  LABEL_TAGS,
  REFUSED_MATH_OR_IMAGE,
  REFUSED_STYLE,
  SECURE_KEYS,
  mermaidConfig,
  preparedSource,
  refusal,
  shapeData,
} from '../client/console/mermaid-render';

const KINDS: FrameKind[] = ['diagram', 'image', 'design'];

describe('every srcdoc', () => {
  it('starts with a policy that reaches nothing, before any byte of the artifact', () => {
    const hostile = '<meta http-equiv="Content-Security-Policy" content="default-src *"><img src="https://example.com/x.png">';
    for (const kind of KINDS) {
      const html = frameDocument(kind, hostile);
      expect(html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${cspFor(kind)}">`)).toBe(true);
      // A second policy in the artifact can only narrow the first; it can never widen it.
      expect(html.indexOf(cspFor(kind))).toBeLessThan(html.indexOf('default-src *'));
      expect(html).toContain('<meta name="referrer" content="no-referrer">');
    }
  });

  it('uses the brief\'s exact design policy, and no script at all for pictures', () => {
    expect(DESIGN_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:",
    );
    expect(cspFor('design')).toBe(DESIGN_CSP);
    expect(cspFor('diagram')).toBe(STATIC_CSP);
    expect(cspFor('image')).toBe(STATIC_CSP);
    expect(STATIC_CSP).not.toContain('script-src');
    for (const policy of [DESIGN_CSP, STATIC_CSP]) {
      expect(policy.startsWith("default-src 'none'")).toBe(true);
      expect(policy).not.toMatch(/https?:|\*|'self'|unsafe-eval|connect-src|frame-src/);
    }
  });

  it('draws a picture on its own ground and leaves a design as its own page', () => {
    expect(frameDocument('image', '<svg/>')).toContain('background:#f4f5f7');
    expect(frameDocument('diagram', '<svg/>', NECTOVIA_TOKENS)).toContain(`background:${NECTOVIA_TOKENS.ground}`);
    expect(frameDocument('design', '<p>page</p>')).toBe(
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><p>page</p>`,
    );
  });
});

describe('sandboxes', () => {
  it('never give an artifact frame the app origin, the top window, popups, forms or modals', () => {
    expect(FRAME_SANDBOX).toEqual({ diagram: '', image: '', design: 'allow-scripts' });
    for (const tokens of Object.values(FRAME_SANDBOX))
      for (const token of tokens.split(/\s+/).filter(Boolean))
        expect(FORBIDDEN_SANDBOX as readonly string[]).not.toContain(token);
    for (const token of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals'])
      expect(FORBIDDEN_SANDBOX as readonly string[]).toContain(token);
  });

  it('are what the frames actually render', () => {
    const records = indexArtifacts('thread-1', [
      { id: 't1', role: 'diomedes', text: '```svg\n<svg viewBox="0 0 10 10"><image href="https://example.com/x.png"/></svg>\n```\n\n```html\n<script>parent.document.title = 1</script>\n```' },
    ]).list;
    const image = renderToStaticMarkup(createElement(ArtifactFrame, { record: records[0] }));
    expect(image).toMatch(/<iframe class="art-frame still image" title="Image: Image 1" sandbox="" referrerPolicy="no-referrer" srcDoc="&lt;!doctype html&gt;&lt;meta http-equiv=&quot;Content-Security-Policy&quot;/);
    const design = renderToStaticMarkup(createElement(ArtifactFrame, { record: records[1] }));
    expect(design).toContain('sandbox="allow-scripts"');
    expect(design).not.toContain('allow-same-origin');
    expect(design).toContain('referrerPolicy="no-referrer"');
    // The design's markup only ever exists inside the srcdoc attribute.
    expect(design).not.toContain('<script>');
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
