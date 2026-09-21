/**
 * ThemePack v1 — the portable, versioned appearance contract shared by the
 * Diomedes desktop Console and the diomedes.net Website Studio.
 *
 * This file is deliberately self-contained: it imports nothing. The handoff
 * bundle (`F:\Diomedes\deliverables\theme-pack-v1\`) ships only the files in
 * this folder, so a consumer outside this repository can typecheck and
 * validate a pack with no dependencies at all. Values duplicated from
 * `client/console/schemes.ts` and `shared/interface-scale.ts` are held in sync
 * by drift tests in `tests/theme-pack.test.ts`.
 *
 * A theme is DATA. It never carries CSS, HTML, JavaScript, remote URLs, fonts
 * to download, or executable motion. The renderer maps validated values onto
 * CSS custom properties and `data-*` attributes that already exist.
 */

export const THEME_PACK_SCHEMA_VERSION = 1 as const;

/** Stable, lowercase, hyphenated, 3–64 characters. */
export const THEME_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * Colours are hex only: `#rrggbb` or `#rrggbbaa`. Functional notation
 * (`rgba()`, `color-mix()`, `var()`) is refused because it is a parser
 * surface, not a value. The built-in schemes express their hairlines as
 * `rgba(255,255,255,.07)`; the equivalent pack value is `#ffffff12`.
 */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Lowercase SHA-256, as produced by `checksum()` and the asset hashes. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** How long a pack's human-facing display name may be. */
export const THEME_PACK_NAME_MAX = 64;

/**
 * Control characters are refused in every string in a pack. They carry no
 * design meaning and are only ever a way to smuggle something past a reader.
 */
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Substrings that may never appear in any string anywhere in a pack. */
export const FORBIDDEN_STRING_FRAGMENTS = ['url(', '<', 'javascript:', 'expression('] as const;

// ---------------------------------------------------------------------------
// Base themes (mirrors `SCHEMES` in client/console/schemes.ts)
// ---------------------------------------------------------------------------

export const BASE_THEME_IDS = [
  'field',
  'deep-field',
  'graphite',
  'verdigris',
  'harbor',
  'ember',
  'moss',
  'dusk',
  'ink',
  'paper',
] as const;
export type BaseThemeId = (typeof BASE_THEME_IDS)[number];
export const DEFAULT_BASE_THEME: BaseThemeId = 'field';

export const COLOR_TOKEN_NAMES = [
  'chrome',
  'surface',
  'raised',
  'hair',
  'hair2',
  't1',
  't2',
  't3',
  'light',
  'attn',
  'fail',
] as const;
export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

export interface BaseThemeColors {
  readonly colors: Readonly<Record<ColorTokenName, string>>;
  readonly lightScheme: boolean;
}

/**
 * The built-in scheme values as hex. `hair`/`hair2` are the `rgba()` values of
 * `SCHEMES` converted to `#rrggbbaa`; the drift test proves the conversion.
 */
export const BASE_THEME_COLORS: Readonly<Record<BaseThemeId, BaseThemeColors>> = {
  field: {
    colors: {
      chrome: '#121417',
      surface: '#16191d',
      raised: '#1c2025',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#e6e9ed',
      t2: '#a4acb6',
      t3: '#808b97',
      light: '#3fd6df',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  'deep-field': {
    colors: {
      chrome: '#0c1220',
      surface: '#101828',
      raised: '#162036',
      hair: '#ffffff14',
      hair2: '#ffffff24',
      t1: '#e8edf5',
      t2: '#a7b2c4',
      t3: '#7f8ca0',
      light: '#5cc8ff',
      attn: '#e6b45a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  graphite: {
    colors: {
      chrome: '#151515',
      surface: '#1a1a1a',
      raised: '#212121',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#ebe9e6',
      t2: '#aaa7a2',
      t3: '#8c8882',
      light: '#f0e6d2',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  verdigris: {
    colors: {
      chrome: '#0a1716',
      surface: '#0e1c1b',
      raised: '#142523',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#e4efeb',
      t2: '#a5b8b2',
      t3: '#7f948e',
      light: '#4fd1a5',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  harbor: {
    colors: {
      chrome: '#0d1020',
      surface: '#12162a',
      raised: '#181d35',
      hair: '#ffffff14',
      hair2: '#ffffff21',
      t1: '#e7e9f2',
      t2: '#a8adc4',
      t3: '#8188a3',
      light: '#8aa2ff',
      attn: '#e6b45a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  ember: {
    colors: {
      chrome: '#171311',
      surface: '#1c1715',
      raised: '#241d1a',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#ede7e2',
      t2: '#b0a59c',
      t3: '#90857c',
      light: '#ff8a5b',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  moss: {
    colors: {
      chrome: '#111410',
      surface: '#151914',
      raised: '#1b201a',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#e7eae3',
      t2: '#a7ada0',
      t3: '#828a7a',
      light: '#b5d84a',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  dusk: {
    colors: {
      chrome: '#151219',
      surface: '#1a161f',
      raised: '#211c28',
      hair: '#ffffff12',
      hair2: '#ffffff1f',
      t1: '#ebe6ef',
      t2: '#aea6b6',
      t3: '#8b8395',
      light: '#e58fb1',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  ink: {
    colors: {
      chrome: '#0a0a0b',
      surface: '#0f0f10',
      raised: '#161617',
      hair: '#ffffff14',
      hair2: '#ffffff24',
      t1: '#f2f2f2',
      t2: '#b3b3b3',
      t3: '#8a8a8a',
      light: '#ffffff',
      attn: '#e0a94a',
      fail: '#e06c6c',
    },
    lightScheme: false,
  },
  paper: {
    colors: {
      chrome: '#f3f4f6',
      surface: '#ffffff',
      raised: '#eef0f3',
      hair: '#00000014',
      hair2: '#00000024',
      t1: '#1a1d21',
      t2: '#4b5563',
      t3: '#666d7a',
      light: '#0e7c86',
      attn: '#b7791f',
      fail: '#c53030',
    },
    lightScheme: true,
  },
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export const SURFACES = ['app-console', 'website'] as const;
export type Surface = (typeof SURFACES)[number];

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/** Mirrors `INTERFACE_SCALES` in shared/interface-scale.ts. */
export const APPROVED_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type ApprovedScale = (typeof APPROVED_SCALES)[number];

export const LINE_HEIGHT_MIN = 1.3;
export const LINE_HEIGHT_MAX = 1.9;

/**
 * The only fonts a pack may name. Each is already bundled with the app (the
 * `@fontsource/*` dependencies in package.json) or is the platform's own UI
 * face. A pack carries the choice id, never a family string and never a URL.
 */
export const FONT_CHOICES = [
  'schibsted-grotesk',
  'ibm-plex-serif',
  'ibm-plex-mono',
  'big-shoulders-display',
  'system-ui',
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** The CSS stack each approved choice resolves to. No `url()`, ever. */
export const FONT_STACKS: Readonly<Record<FontChoice, string>> = {
  'schibsted-grotesk':
    "'Schibsted Grotesk', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  'ibm-plex-serif': "'IBM Plex Serif', Georgia, 'Times New Roman', serif",
  'ibm-plex-mono': "'IBM Plex Mono', 'Cascadia Mono', Consolas, monospace",
  'big-shoulders-display':
    "'Big Shoulders Display', 'Segoe UI Variable Display', system-ui, sans-serif",
  'system-ui': "system-ui, 'Segoe UI Variable Text', 'Segoe UI', sans-serif",
};

export interface ThemePackTypography {
  interfaceScale: ApprovedScale;
  readingScale: ApprovedScale;
  codeScale: ApprovedScale;
  lineHeight: number;
  interfaceFont: FontChoice;
  readingFont: FontChoice;
  codeFont: FontChoice;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const CONTROL_RADIUS_MIN = 0;
export const CONTROL_RADIUS_MAX = 12;

/** Unchanged in meaning from the Console's existing density setting. */
export const DENSITIES = ['guided', 'standard', 'technical'] as const;
export type Density = (typeof DENSITIES)[number];

export interface ThemePackGeometry {
  /** Control corner radius in CSS pixels, 0–12. */
  controlRadius: number;
  /** How present separators are, 0 (invisible) – 1 (full hairline alpha). */
  separatorStrength: number;
  density: Density;
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/** Slots both surfaces understand. */
export const ARTWORK_SLOTS = ['logo', 'bust', 'emptyState', 'texture'] as const;
export type ArtworkSlot = (typeof ARTWORK_SLOTS)[number];

/**
 * Optional v1 extensions that only the website renders. The app ignores them
 * and reports a warning (see compatibility.ts); it never fails on them.
 */
export const WEBSITE_ONLY_ARTWORK_SLOTS = ['hero', 'sceneTreatment'] as const;
export type WebsiteOnlyArtworkSlot = (typeof WEBSITE_ONLY_ARTWORK_SLOTS)[number];

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'soft-light'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const ARTWORK_MASKS = ['none', 'edge-fade', 'diffuse'] as const;
export type ArtworkMask = (typeof ARTWORK_MASKS)[number];

/** Normalised point, both components 0–1. */
export interface FocalPoint {
  x: number;
  y: number;
}

/** Normalised rectangle in source-image space; every component 0–1. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArtworkPlacement {
  /** SHA-256 of the decoded asset bytes; must be a key of `assets`. */
  assetHash: string;
  focal: FocalPoint;
  crop: CropRect;
  opacity: number;
  blend: BlendMode;
  mask: ArtworkMask;
}

/** A per-surface override may restate any part of the placement. */
export type ArtworkOverride = Partial<ArtworkPlacement>;

export interface ArtworkEntry extends ArtworkPlacement {
  /** Surface-specific refinements; absent means "same everywhere". */
  surfaces?: Partial<Record<Surface, ArtworkOverride>>;
}

export type ThemePackArtwork = Partial<Record<ArtworkSlot | WebsiteOnlyArtworkSlot, ArtworkEntry>>;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * A fixed list of named behaviours. A preset is an id the renderer knows, not
 * a description a theme can author: nothing executable crosses this boundary.
 */
export const MOTION_PRESET_IDS = ['none', 'settle', 'drift', 'signal', 'lift'] as const;
export type MotionPresetId = (typeof MOTION_PRESET_IDS)[number];

export const MOTION_DURATION_MIN = 0;
export const MOTION_DURATION_MAX = 1200;

export interface ThemePackMotion {
  presetId: MotionPresetId;
  /** Milliseconds, 0–1200. */
  duration: number;
  intensity: number;
  /** v1 has exactly one honest answer: motion stops. */
  reducedMotionBehaviour: 'static';
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number];

export interface AssetRecord {
  mime: AssetMimeType;
  /** Decoded byte length. Integer ≥ 1. */
  bytes: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Tokens (DTCG conventions — for tokens only, see README.md)
// ---------------------------------------------------------------------------

export interface ColorToken {
  $type: 'color';
  $value: string;
}

export interface BooleanToken {
  $type: 'boolean';
  $value: boolean;
}

export interface ThemePackTokens {
  /** Primitive colours and semantic roles, keyed as the base schemes key them. */
  color: Record<ColorTokenName, ColorToken>;
  /** True when the palette is light; drives `color-scheme` and titlebar text. */
  lightScheme: BooleanToken;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface ThemePackProvenance {
  author: string;
  /** ISO-8601 instant. */
  createdAt: string;
  /** What produced the pack, e.g. `diomedes-design-studio/1`. */
  tool: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

export interface ThemePackV1 {
  schemaVersion: 1;
  id: string;
  /** What a person calls this theme. 1–64 characters, display only. */
  name: string;
  /** Integer ≥ 1; bumped on every saved change to the same id. */
  revision: number;
  baseTheme: BaseThemeId;
  /** Which surfaces the author intends this pack for; at least one. */
  surfaces: Surface[];
  provenance: ThemePackProvenance;
  tokens: ThemePackTokens;
  typography: ThemePackTypography;
  geometry: ThemePackGeometry;
  artwork: ThemePackArtwork;
  motion: ThemePackMotion;
  assets: Record<string, AssetRecord>;
}

/** The exact set of top-level keys a v1 pack may carry. Nothing else parses. */
export const THEME_PACK_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'revision',
  'baseTheme',
  'surfaces',
  'provenance',
  'tokens',
  'typography',
  'geometry',
  'artwork',
  'motion',
  'assets',
] as const;

// ---------------------------------------------------------------------------
// Package limits
// ---------------------------------------------------------------------------

export interface ThemePackLimits {
  /** Sum of decoded asset bytes across the package. */
  totalAssetBytes: number;
  /** Decoded bytes of any single asset. */
  assetBytes: number;
  /** width × height of any single asset. */
  assetPixels: number;
}

export const THEME_PACK_LIMITS: Readonly<ThemePackLimits> = {
  totalAssetBytes: 8 * 1024 * 1024,
  assetBytes: 2 * 1024 * 1024,
  assetPixels: 16 * 1024 * 1024,
};
