// The one place a model-written diagram, image or design becomes a document.
// Every artifact that is not drawn by the app itself is shown only inside a
// sandboxed iframe whose srcdoc this module builds, and every srcdoc starts
// with a Content-Security-Policy that lets it reach nothing: not the app's
// service, not the internet. The sandbox turns scripts off in every frame,
// designs included; the policy stops the fetches a sandbox alone would still
// allow, such as <image href="https://..."> or CSS url(). Links are made inert
// before a source reaches this module (artifact-links.ts), because neither a
// sandbox nor this policy stops a frame following a link to somewhere else.
// Pure: no React, no DOM.
//
// A design runs no script. A frame that runs script can open a WebRTC
// connection, whose ICE traffic no Content-Security-Policy governs: a design
// with `allow-scripts` sent STUN requests off the machine while its fetches,
// images, sockets and popups were all refused (hostile review, 2026-09-23).
// Interactive designs wait for isolation from the network at the process or
// operating-system level (docs/product/2026-09-23-artifact-hardening.md).

export type FrameKind = 'diagram' | 'image' | 'design';

/**
 * Every frame's policy. Nothing runs, so it names no script source (and no
 * blob:, which only a script could make); styles, images, fonts and media may
 * come only from the artifact itself, inline or as data: URLs it carries. A
 * srcdoc frame also inherits the app document's policy (scripts/app-csp.ts),
 * which allows at least these.
 */
export const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/**
 * The sandbox each frame gets: none of the sandbox's permissions, so no
 * script, no forms, no popups, no top navigation, and an opaque origin. The
 * kind stays because the panel labels and sizes each one differently.
 */
export const FRAME_SANDBOX: Readonly<Record<FrameKind, string>> = {
  diagram: '',
  image: '',
  design: '',
};

/** Sandbox tokens no artifact frame may ever carry. */
export const FORBIDDEN_SANDBOX = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-forms',
  'allow-modals',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-storage-access-by-user-activation',
] as const;

/** The document a frame's first navigation lands on; the desktop shell allows no other. */
export const FRAME_URLS = ['about:srcdoc', 'about:blank'] as const;

/**
 * The frame cannot load the app's bundled fonts (its policy allows none), and
 * Mermaid measures label text in the app document, so both use a face every
 * platform already has. Measured and drawn in the same face, labels fit.
 */
export const FRAME_FONT = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

/** Padding around an SVG inside its frame, in CSS pixels. */
export const FRAME_PAD = 12;

/** A light ground for model-drawn images: most SVG is drawn for a white page. */
export const IMAGE_GROUND = '#f4f5f7';

export interface FrameTokens {
  ground: string;
  raised: string;
  text: string;
  muted: string;
  rule: string;
  lead: string;
  trail: string;
  tab: string;
}

/** The contract's own values, used wherever the running scheme gives nothing usable. */
export const NECTOVIA_TOKENS: FrameTokens = {
  ground: '#08080c',
  raised: '#14141a',
  text: '#e6e9ed',
  muted: '#a4acb6',
  rule: 'rgba(230, 233, 237, 0.14)',
  lead: '#44d2c9',
  trail: '#b569fb',
  tab: '#f97c65',
};

/** Only plain colours cross into a frame: a hex, or rgb()/hsl() with numbers in it. */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/deg]+\))$/i;

/**
 * The running scheme's colours, read through a getter so this stays pure.
 * The Nectovia seam tokens win when the scheme defines them; the scheme's own
 * lead colour stands in for the seam lead otherwise.
 */
export function frameTokens(read: (name: string) => string): FrameTokens {
  const pick = (names: readonly string[], fallback: string) => {
    for (const name of names) {
      const value = (read(name) ?? '').trim();
      if (COLOR.test(value)) return value;
    }
    return fallback;
  };
  return {
    ground: pick(['--chrome'], NECTOVIA_TOKENS.ground),
    raised: pick(['--raised'], NECTOVIA_TOKENS.raised),
    text: pick(['--t1'], NECTOVIA_TOKENS.text),
    muted: pick(['--t2'], NECTOVIA_TOKENS.muted),
    rule: pick(['--hair-2'], NECTOVIA_TOKENS.rule),
    lead: pick(['--seam-lead', '--light'], NECTOVIA_TOKENS.lead),
    trail: pick(['--seam-trail'], NECTOVIA_TOKENS.trail),
    tab: pick(['--seam-tab'], NECTOVIA_TOKENS.tab),
  };
}

/** Whether a ground colour is dark, so a diagram picks the matching Mermaid mode. */
export function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(color)?.[1];
  let rgb: number[] | null = null;
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    rgb = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
  } else {
    const numbers = /rgba?\(([^)]*)\)/i.exec(color)?.[1].match(/[\d.]+/g);
    if (numbers && numbers.length >= 3) rgb = numbers.slice(0, 3).map(Number);
  }
  if (!rgb) return true;
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}

/**
 * One frame document. The policy is always the first element, so it is in
 * force before any byte of the artifact is parsed. A design is its own page
 * and gets nothing else; a diagram or an image is laid on a ground of its own
 * and scaled to the frame.
 */
export function frameDocument(kind: FrameKind, body: string, tokens: FrameTokens = NECTOVIA_TOKENS): string {
  const head =
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    '<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">';
  if (kind === 'design') return `${head}${body}`;
  const ground = kind === 'image' ? IMAGE_GROUND : tokens.ground;
  const text = kind === 'image' ? '#1a1d21' : tokens.text;
  const style =
    `<style>html,body{margin:0;background:${ground};color:${text};font-family:${FRAME_FONT}}` +
    `body{padding:${FRAME_PAD}px;box-sizing:border-box;overflow:hidden}` +
    'svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>';
  return `${head}${style}<body>${body}</body>`;
}

// ---- sizing -----------------------------------------------------------------

export interface SvgBox {
  /** The drawing's own proportions. */
  width: number;
  height: number;
  /** The widest it asks to be drawn, in CSS pixels, or null to fill the frame. */
  natural: number | null;
}

const number = (value: string | undefined) => {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value);
  const parsed = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** The proportions of an SVG, read from its root tag's attributes, without parsing it as a document. */
export function svgBox(svg: string): SvgBox {
  const tag = /<svg\b([^>]*)>/i.exec(svg)?.[1] ?? '';
  const attr = (name: string) =>
    new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2, 4).find((v) => v !== undefined);
  const view = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasView = view.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0;
  const width = number(attr('width'));
  const height = number(attr('height'));
  const maxWidth = number(/max-width:\s*([\d.]+px)/i.exec(attr('style') ?? '')?.[1]);
  const box = hasView
    ? { width: view[2], height: view[3] }
    : { width: width ?? 300, height: height ?? 150 };
  return { ...box, natural: maxWidth ?? width ?? null };
}

/** How tall a frame must be to show the whole drawing at the frame's width. */
export function frameHeight(box: SvgBox, frameWidth: number): number {
  const inner = Math.max(40, frameWidth - FRAME_PAD * 2);
  const drawn = box.natural ? Math.min(box.natural, inner) : inner;
  const height = (drawn * box.height) / box.width + FRAME_PAD * 2;
  return Math.round(Math.min(8000, Math.max(64, height)));
}

// ---- design widths ----------------------------------------------------------

export type DesignWidth = 'fit' | 'phone' | 'desktop';

export const DESIGN_WIDTHS: Readonly<Record<DesignWidth, number | null>> = {
  fit: null,
  phone: 390,
  desktop: 1280,
};

/** The width a design is laid out at, and the scale that fits it in the pane. */
export function designLayout(mode: DesignWidth, available: number): { width: number; scale: number } {
  const target = DESIGN_WIDTHS[mode];
  if (target === null || available <= 0) return { width: Math.max(0, available), scale: 1 };
  const scale = Math.min(1, available / target);
  return { width: target, scale };
}
