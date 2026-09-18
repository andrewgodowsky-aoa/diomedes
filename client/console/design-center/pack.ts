/**
 * Building and editing a ThemePack in the Design Center.
 *
 * Every helper here returns a whole new pack rather than mutating one. That is
 * what makes the undo stack an array of packs and nothing more: no diffs, no
 * replay, no way for an undo to half-apply.
 *
 * Nothing in this file writes anything, reaches the network, or touches the
 * document. It is arithmetic on a value.
 */
import {
  APPROVED_SCALES,
  ARTWORK_MASKS,
  BASE_THEME_COLORS,
  BLEND_MODES,
  COLOR_TOKEN_NAMES,
  CONTROL_RADIUS_MAX,
  CONTROL_RADIUS_MIN,
  DENSITIES,
  FONT_CHOICES,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MOTION_DURATION_MAX,
  MOTION_DURATION_MIN,
  MOTION_PRESET_IDS,
  type ArtworkMask,
  type ArtworkSlot,
  type BaseThemeId,
  type BlendMode,
  type ColorTokenName,
  type ThemePackV1,
} from '../../../shared/theme-pack/types';
import { APPEARANCE_DEFAULTS } from '../../../shared/theme-pack/resolve';

/** What the app writes into `provenance.tool` for everything it authors. */
export const DESIGN_CENTER_TOOL = 'diomedes-design-center/1';

/**
 * Brand colours are the ones a person picks to make a theme theirs; semantic
 * colours are the ones the app assigns meaning to and which therefore carry a
 * legibility obligation. The inspector separates them because the questions are
 * different, not because the contract stores them differently.
 */
export const BRAND_TOKENS: readonly ColorTokenName[] = [
  'chrome',
  'surface',
  'raised',
  'light',
  'hair',
  'hair2',
];
export const SEMANTIC_TOKENS: readonly ColorTokenName[] = ['t1', 't2', 't3', 'attn', 'fail'];

export const TOKEN_LABELS: Readonly<Record<ColorTokenName, string>> = {
  chrome: 'Window frame',
  surface: 'Page background',
  raised: 'Card background',
  hair: 'Separator',
  hair2: 'Stronger separator',
  t1: 'Main text',
  t2: 'Supporting text',
  t3: 'Quiet text',
  light: 'Highlight',
  attn: 'Needs attention',
  fail: 'Something failed',
};

export const FONT_LABELS: Record<string, string> = {
  'schibsted-grotesk': 'Schibsted Grotesk',
  'ibm-plex-serif': 'IBM Plex Serif',
  'ibm-plex-mono': 'IBM Plex Mono',
  'big-shoulders-display': 'Big Shoulders Display',
  'system-ui': 'This computer’s own face',
};

export const MOTION_LABELS: Record<string, string> = {
  none: 'None',
  settle: 'Settle',
  drift: 'Drift',
  signal: 'Signal',
  lift: 'Lift',
};

export const DENSITY_LABELS: Record<string, string> = {
  guided: 'Guided',
  standard: 'Standard',
  technical: 'Technical',
};

export const MASK_LABELS: Record<string, string> = {
  none: 'No mask',
  'edge-fade': 'Fade at the edges',
  diffuse: 'Diffuse',
};

export const ARTWORK_SLOT_LABELS: Record<string, string> = {
  logo: 'Logo',
  bust: 'Portrait plate',
  emptyState: 'Empty-state picture',
  texture: 'Background texture',
};

export const EDITABLE_ARTWORK_SLOTS: readonly ArtworkSlot[] = ['logo', 'bust', 'emptyState', 'texture'];

export const SIDEBAR_WIDTHS = [
  { id: 'narrow', label: 'Narrow', px: 220 },
  { id: 'standard', label: 'Standard', px: 260 },
  { id: 'wide', label: 'Wide', px: 320 },
] as const;

/** A theme id the store will accept, derived from what a person typed. */
export function themeIdFrom(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (slug.length >= 3) return slug;
  return `theme-${slug || 'new'}`.slice(0, 64);
}

/**
 * A new pack that is exactly the built-in appearance, written out.
 *
 * Starting from the base scheme rather than from an invented palette means the
 * first thing a person sees in the preview is the app they already know, and
 * every change they then make is visible as a change.
 */
export function packFromBaseTheme(
  baseTheme: BaseThemeId,
  name: string,
  id: string,
  author: string,
  now: string,
): ThemePackV1 {
  const base = BASE_THEME_COLORS[baseTheme];
  const color = Object.fromEntries(
    COLOR_TOKEN_NAMES.map((token) => [token, { $type: 'color' as const, $value: base.colors[token] }]),
  ) as ThemePackV1['tokens']['color'];
  return {
    schemaVersion: 1,
    id,
    name,
    revision: 1,
    baseTheme,
    surfaces: ['app-console', 'website'],
    provenance: { author, createdAt: now, tool: DESIGN_CENTER_TOOL },
    tokens: { color, lightScheme: { $type: 'boolean', $value: base.lightScheme } },
    typography: {
      interfaceScale: APPEARANCE_DEFAULTS.interfaceScale,
      readingScale: APPEARANCE_DEFAULTS.readingScale,
      codeScale: APPEARANCE_DEFAULTS.codeScale,
      lineHeight: APPEARANCE_DEFAULTS.lineHeight,
      interfaceFont: APPEARANCE_DEFAULTS.interfaceFont,
      readingFont: APPEARANCE_DEFAULTS.readingFont,
      codeFont: APPEARANCE_DEFAULTS.codeFont,
    },
    geometry: {
      controlRadius: APPEARANCE_DEFAULTS.controlRadius,
      separatorStrength: APPEARANCE_DEFAULTS.separatorStrength,
      density: APPEARANCE_DEFAULTS.density,
    },
    artwork: {},
    motion: {
      presetId: APPEARANCE_DEFAULTS.motionPreset,
      duration: APPEARANCE_DEFAULTS.motionDuration,
      intensity: APPEARANCE_DEFAULTS.motionIntensity,
      reducedMotionBehaviour: 'static',
    },
    assets: {},
  };
}

const clamp = (value: number, low: number, high: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;

/** Round to three places so a slider cannot produce 0.30000000000000004. */
const tidy = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The editable fields, each with the bound the contract already states and a
 * name the inspector shows. Every inspector control goes through one of these,
 * so no control can write a value the validator would refuse.
 */
export const packEdits = {
  colour(pack: ThemePackV1, token: ColorTokenName, value: string): ThemePackV1 {
    return {
      ...pack,
      tokens: {
        ...pack.tokens,
        color: { ...pack.tokens.color, [token]: { $type: 'color', $value: value } },
      },
    };
  },
  lightScheme(pack: ThemePackV1, light: boolean): ThemePackV1 {
    return { ...pack, tokens: { ...pack.tokens, lightScheme: { $type: 'boolean', $value: light } } };
  },
  baseTheme(pack: ThemePackV1, baseTheme: BaseThemeId): ThemePackV1 {
    return { ...pack, baseTheme };
  },
  scale(
    pack: ThemePackV1,
    which: 'interfaceScale' | 'readingScale' | 'codeScale',
    value: number,
  ): ThemePackV1 {
    const approved = (APPROVED_SCALES as readonly number[]).includes(value)
      ? (value as ThemePackV1['typography']['interfaceScale'])
      : pack.typography[which];
    return { ...pack, typography: { ...pack.typography, [which]: approved } };
  },
  lineHeight(pack: ThemePackV1, value: number): ThemePackV1 {
    return {
      ...pack,
      typography: {
        ...pack.typography,
        lineHeight: tidy(clamp(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)),
      },
    };
  },
  font(
    pack: ThemePackV1,
    which: 'interfaceFont' | 'readingFont' | 'codeFont',
    value: string,
  ): ThemePackV1 {
    if (!(FONT_CHOICES as readonly string[]).includes(value)) return pack;
    return {
      ...pack,
      typography: { ...pack.typography, [which]: value as ThemePackV1['typography']['interfaceFont'] },
    };
  },
  controlRadius(pack: ThemePackV1, value: number): ThemePackV1 {
    return {
      ...pack,
      geometry: {
        ...pack.geometry,
        controlRadius: tidy(clamp(value, CONTROL_RADIUS_MIN, CONTROL_RADIUS_MAX)),
      },
    };
  },
  separatorStrength(pack: ThemePackV1, value: number): ThemePackV1 {
    return { ...pack, geometry: { ...pack.geometry, separatorStrength: tidy(clamp(value, 0, 1)) } };
  },
  density(pack: ThemePackV1, value: string): ThemePackV1 {
    if (!(DENSITIES as readonly string[]).includes(value)) return pack;
    return { ...pack, geometry: { ...pack.geometry, density: value as ThemePackV1['geometry']['density'] } };
  },
  motionPreset(pack: ThemePackV1, value: string): ThemePackV1 {
    if (!(MOTION_PRESET_IDS as readonly string[]).includes(value)) return pack;
    return { ...pack, motion: { ...pack.motion, presetId: value as ThemePackV1['motion']['presetId'] } };
  },
  motionDuration(pack: ThemePackV1, value: number): ThemePackV1 {
    return {
      ...pack,
      motion: {
        ...pack.motion,
        duration: Math.round(clamp(value, MOTION_DURATION_MIN, MOTION_DURATION_MAX)),
      },
    };
  },
  motionIntensity(pack: ThemePackV1, value: number): ThemePackV1 {
    return { ...pack, motion: { ...pack.motion, intensity: tidy(clamp(value, 0, 1)) } };
  },
  name(pack: ThemePackV1, value: string): ThemePackV1 {
    const trimmed = value.replace(/[ -]/g, '').slice(0, 64);
    return { ...pack, name: trimmed || pack.name };
  },
};

/**
 * Artwork placement, held beside the pack rather than inside it.
 *
 * The contract says `assetHash` must be a key of `assets`, so a slot with no
 * picture is not a pack field that happens to be empty — it is a field the
 * validator refuses. Uploads arrive in A4. Until then the placement controls
 * are real and their values are kept for the session, and the inspector says
 * plainly that they are stored with the picture. Writing an invalid pack so a
 * slider could pretend to persist would be the worse answer.
 */
export interface ArtworkPlacementDraft {
  focal: { x: number; y: number };
  crop: { x: number; y: number; width: number; height: number };
  opacity: number;
  blend: BlendMode;
  mask: ArtworkMask;
}

export const defaultPlacement = (): ArtworkPlacementDraft => ({
  focal: { x: 0.5, y: 0.5 },
  crop: { x: 0, y: 0, width: 1, height: 1 },
  opacity: 1,
  blend: 'normal',
  mask: 'none',
});

export function editPlacement(
  placement: ArtworkPlacementDraft,
  patch: Partial<{ focalX: number; focalY: number; opacity: number; blend: string; mask: string }>,
): ArtworkPlacementDraft {
  return {
    ...placement,
    focal: {
      x: patch.focalX === undefined ? placement.focal.x : tidy(clamp(patch.focalX, 0, 1)),
      y: patch.focalY === undefined ? placement.focal.y : tidy(clamp(patch.focalY, 0, 1)),
    },
    opacity: patch.opacity === undefined ? placement.opacity : tidy(clamp(patch.opacity, 0, 1)),
    blend: (BLEND_MODES as readonly string[]).includes(patch.blend ?? '')
      ? (patch.blend as BlendMode)
      : placement.blend,
    mask: (ARTWORK_MASKS as readonly string[]).includes(patch.mask ?? '')
      ? (patch.mask as ArtworkMask)
      : placement.mask,
  };
}
