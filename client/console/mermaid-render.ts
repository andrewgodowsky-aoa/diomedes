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
//     from the app's origin, and style lines can carry CSS url().
// Evidence for each of these is in docs/implementation/2026-09-22-model-artifacts.md.

/** Mermaid's frontmatter grammar (mermaid 11.17.2, src/diagram-api/regexes.ts). */
const FRONTMATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
/** Mermaid's directive grammar: %%{init: ...}%%, %%{wrap}%% and the rest. */
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** Mermaid's math grammar: any $$...$$ on one line turns that label into HTML. */
const MATH = /\$\$(.*?)\$\$/;
/** Lines whose text becomes CSS. */
const STYLE_LINE = /^[ \t]*(style|classDef|linkStyle)\b/i;
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
  if (source.split('\n').some((line) => STYLE_LINE.test(line) && STYLE_FETCH.test(line))) return REFUSED_STYLE;
  return null;
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
    return { ok: true, svg };
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
