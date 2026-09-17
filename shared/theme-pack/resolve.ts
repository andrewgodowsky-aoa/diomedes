/**
 * Appearance resolution.
 *
 * Five layers, applied in one fixed order:
 *
 *   1. defaults                — the built-in Field scheme and the Console's
 *                                shipped typography, geometry and motion.
 *   2. selected theme          — a validated ThemePack.
 *   3. authorized workspace    — branding a workspace is entitled to apply.
 *   4. personal preferences    — what the person is allowed to prefer.
 *   5. accessibility & safety  — reduced motion, texture off, a contrast floor
 *                                on text roles, visible focus. Mandatory, last,
 *                                and not editable away by any earlier layer.
 *
 * The result is a flat map of CSS custom properties plus `data-*` values, and
 * an `origins` map saying which layer produced each one so the editor can show
 * inheritance honestly. Nothing here emits CSS syntax beyond a token value.
 *
 * Self-contained by design — see the note at the top of types.ts.
 */

import {
  APPROVED_SCALES,
  BASE_THEME_COLORS,
  COLOR_TOKEN_NAMES,
  DEFAULT_BASE_THEME,
  DENSITIES,
  FONT_STACKS,
  HEX_COLOR_PATTERN,
  type ApprovedScale,
  type BaseThemeId,
  type ColorTokenName,
  type Density,
  type FontChoice,
  type Surface,
  type ThemePackV1,
} from './types.js';

export type AppearanceLayerName = 'defaults' | 'theme' | 'workspace' | 'personal' | 'accessibility';

export const APPEARANCE_LAYER_ORDER: readonly AppearanceLayerName[] = [
  'defaults',
  'theme',
  'workspace',
  'personal',
  'accessibility',
];

/** Branding a workspace may apply — only while `authorized` is true. */
export interface WorkspaceBranding {
  /**
   * Entitlement, decided elsewhere (`services/control-plane/contract`). False
   * means the whole layer is skipped; it is never partially honoured.
   */
  authorized: boolean;
  colors?: Partial<Record<ColorTokenName, string>>;
  density?: Density;
  interfaceFont?: FontChoice;
  readingFont?: FontChoice;
  codeFont?: FontChoice;
}

/** What a person may prefer for themselves, over anything a theme asked for. */
export interface PersonalPreferences {
  interfaceScale?: ApprovedScale;
  readingScale?: ApprovedScale;
  codeScale?: ApprovedScale;
  density?: Density;
  motion?: 'normal' | 'reduced';
  textureOpacity?: number;
}

/** Demands the product makes on everyone's behalf. Never negotiable. */
export interface AccessibilityDemands {
  reducedMotion?: boolean;
  textureOff?: boolean;
  /** Contrast ratio text roles must reach against `surface`, e.g. 4.5. */
  minimumContrast?: number;
  focusVisible?: boolean;
}

export interface AppearanceLayers {
  /** Which surface is being painted; artwork overrides are read for it. */
  surface?: Surface;
  theme?: ThemePackV1;
  workspace?: WorkspaceBranding;
  personal?: PersonalPreferences;
  accessibility?: AccessibilityDemands;
}

export interface ResolvedAppearance {
  /** CSS custom property name → value. */
  vars: Record<string, string>;
  /** `document.documentElement.dataset` key → value. */
  dataset: Record<string, string>;
  /** `--name` and `data:<key>` → the layer that produced it. */
  origins: Record<string, AppearanceLayerName>;
}

/** The Console's shipped appearance, as client/styles.css declares it. */
export const APPEARANCE_DEFAULTS = {
  baseTheme: DEFAULT_BASE_THEME as BaseThemeId,
  interfaceScale: 1,
  readingScale: 1,
  codeScale: 1,
  lineHeight: 1.55,
  interfaceFont: 'schibsted-grotesk' as FontChoice,
  readingFont: 'schibsted-grotesk' as FontChoice,
  codeFont: 'ibm-plex-mono' as FontChoice,
  controlRadius: 6,
  separatorStrength: 1,
  density: 'standard' as Density,
  motionDuration: 160,
  motionIntensity: 0.5,
  textureOpacity: 1,
} as const;

/** `--dm-t-view` is the motion duration; quick and extend sit either side. */
const DURATION_RATIOS = { '--dm-t-quick': 0.75, '--dm-t-view': 1, '--dm-t-extend': 1.25 };

const CSS_VAR_FOR_TOKEN: Record<ColorTokenName, string> = {
  chrome: '--chrome',
  surface: '--surface',
  raised: '--raised',
  hair: '--hair',
  hair2: '--hair-2',
  t1: '--t1',
  t2: '--t2',
  t3: '--t3',
  light: '--light',
  attn: '--attn',
  fail: '--fail',
};

/** The roles that carry text and therefore owe a contrast floor. */
const TEXT_ROLES: readonly ColorTokenName[] = ['t1', 't2', 't3'];

/**
 * The workspace and personal layers do not arrive through `validateThemePack`
 * — they come from settings and from an entitlement decision. Only values that
 * pass these guards are emitted, so nothing unchecked reaches the DOM.
 */
const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_COLOR_PATTERN.test(value);

const isApprovedScale = (value: unknown): value is ApprovedScale =>
  typeof value === 'number' && (APPROVED_SCALES as readonly number[]).includes(value);

// ---------------------------------------------------------------------------
// Colour arithmetic (hex in, hex out — no CSS functions are ever emitted)
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHex(value: string): Rgba {
  const hex = value.slice(1);
  const at = (index: number) => parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return { r: at(0), g: at(1), b: at(2), a: hex.length === 8 ? at(3) / 255 : 1 };
}

function toHex(color: Rgba): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  const base = `#${part(color.r)}${part(color.g)}${part(color.b)}`;
  return color.a >= 1 ? base : `${base}${part(color.a * 255)}`;
}

/** Flatten a translucent colour onto an opaque one, so contrast is honest. */
function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function relativeLuminance(color: Rgba): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2 contrast ratio between two opaque colours. */
export function contrastRatio(foreground: string, background: string): number {
  const back = parseHex(background);
  const front = over(parseHex(foreground), back);
  const a = relativeLuminance(front);
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Walk a text colour away from its background until it clears `target`, or
 * until it reaches plain white or black. Deterministic, 100 steps at most.
 */
function liftToContrast(foreground: string, background: string, target: number): string {
  if (contrastRatio(foreground, background) >= target) return foreground;
  const back = parseHex(background);
  const start = over(parseHex(foreground), back);
  const toward = relativeLuminance(back) > 0.18 ? 0 : 255;
  for (let step = 1; step <= 100; step++) {
    const mix = step / 100;
    const candidate: Rgba = {
      r: start.r + (toward - start.r) * mix,
      g: start.g + (toward - start.g) * mix,
      b: start.b + (toward - start.b) * mix,
      a: 1,
    };
    const hex = toHex(candidate);
    if (contrastRatio(hex, background) >= target) return hex;
  }
  return toward === 0 ? '#000000' : '#ffffff';
}

/** Scale a hairline's alpha without touching its hue. */
function applyStrength(color: string, strength: number): string {
  const parsed = parseHex(color);
  return toHex({ ...parsed, a: Math.max(0, Math.min(1, parsed.a * strength)) });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

class Resolution {
  readonly vars: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly origins: Record<string, AppearanceLayerName> = {};

  setVar(name: string, value: string, layer: AppearanceLayerName): void {
    this.vars[name] = value;
    this.origins[name] = layer;
  }

  setData(key: string, value: string, layer: AppearanceLayerName): void {
    this.dataset[key] = value;
    this.origins[`data:${key}`] = layer;
  }
}

/**
 * Resolve one appearance from its layers.
 *
 * Every earlier layer's value stays visible in `origins` only as the layer that
 * last wrote it; the accessibility layer always writes last, so a mandatory
 * override cannot be undone by a theme, a workspace or a preference.
 */
export function resolveAppearance(layers: AppearanceLayers): ResolvedAppearance {
  const out = new Resolution();
  const surface = layers.surface ?? 'app-console';
  const theme = layers.theme;
  const workspace = layers.workspace?.authorized === true ? layers.workspace : undefined;
  const personal = layers.personal ?? {};
  const demands = layers.accessibility ?? {};

  // 1. defaults ------------------------------------------------------------
  const base = BASE_THEME_COLORS[APPEARANCE_DEFAULTS.baseTheme];
  const colorLayer: Record<ColorTokenName, AppearanceLayerName> = {} as Record<
    ColorTokenName,
    AppearanceLayerName
  >;
  const colors: Record<ColorTokenName, string> = { ...base.colors };
  for (const token of COLOR_TOKEN_NAMES) colorLayer[token] = 'defaults';
  let lightScheme = base.lightScheme;
  let baseTheme: BaseThemeId = APPEARANCE_DEFAULTS.baseTheme;
  let separatorStrength: number = APPEARANCE_DEFAULTS.separatorStrength;
  let schemeLayer: AppearanceLayerName = 'defaults';

  out.setVar('--r', `${APPEARANCE_DEFAULTS.controlRadius}px`, 'defaults');
  out.setVar('--rb', `${Math.max(0, APPEARANCE_DEFAULTS.controlRadius - 1)}px`, 'defaults');
  out.setVar('--dm-line-body', String(APPEARANCE_DEFAULTS.lineHeight), 'defaults');
  out.setVar('--dm-ui-scale', String(APPEARANCE_DEFAULTS.interfaceScale), 'defaults');
  out.setVar('--dm-read-scale', String(APPEARANCE_DEFAULTS.readingScale), 'defaults');
  out.setVar('--dm-code-scale', String(APPEARANCE_DEFAULTS.codeScale), 'defaults');
  out.setVar('--dm-font-ui', FONT_STACKS[APPEARANCE_DEFAULTS.interfaceFont], 'defaults');
  out.setVar('--dm-font-read', FONT_STACKS[APPEARANCE_DEFAULTS.readingFont], 'defaults');
  out.setVar('--dm-font-code', FONT_STACKS[APPEARANCE_DEFAULTS.codeFont], 'defaults');
  out.setVar('--dm-motion-intensity', String(APPEARANCE_DEFAULTS.motionIntensity), 'defaults');
  out.setVar('--dm-texture-opacity', String(APPEARANCE_DEFAULTS.textureOpacity), 'defaults');
  out.setVar('--dm-focus-width', '1px', 'defaults');
  for (const [name, ratio] of Object.entries(DURATION_RATIOS))
    out.setVar(name, `${Math.round(APPEARANCE_DEFAULTS.motionDuration * ratio)}ms`, 'defaults');
  out.setData('package', APPEARANCE_DEFAULTS.baseTheme, 'defaults');
  out.setData('themePack', 'none', 'defaults');
  out.setData('density', APPEARANCE_DEFAULTS.density, 'defaults');
  out.setData('motion', 'normal', 'defaults');
  out.setData('texture', 'on', 'defaults');
  out.setData('colorScheme', base.lightScheme ? 'light' : 'dark', 'defaults');

  // 2. selected theme ------------------------------------------------------
  if (theme) {
    for (const token of COLOR_TOKEN_NAMES) {
      colors[token] = theme.tokens.color[token].$value;
      colorLayer[token] = 'theme';
    }
    lightScheme = theme.tokens.lightScheme.$value;
    schemeLayer = 'theme';
    baseTheme = theme.baseTheme;
    separatorStrength = theme.geometry.separatorStrength;
    out.setVar('--r', `${theme.geometry.controlRadius}px`, 'theme');
    out.setVar('--rb', `${Math.max(0, theme.geometry.controlRadius - 1)}px`, 'theme');
    out.setVar('--dm-line-body', String(theme.typography.lineHeight), 'theme');
    out.setVar('--dm-ui-scale', String(theme.typography.interfaceScale), 'theme');
    out.setVar('--dm-read-scale', String(theme.typography.readingScale), 'theme');
    out.setVar('--dm-code-scale', String(theme.typography.codeScale), 'theme');
    out.setVar('--dm-font-ui', FONT_STACKS[theme.typography.interfaceFont], 'theme');
    out.setVar('--dm-font-read', FONT_STACKS[theme.typography.readingFont], 'theme');
    out.setVar('--dm-font-code', FONT_STACKS[theme.typography.codeFont], 'theme');
    out.setVar('--dm-motion-intensity', String(theme.motion.intensity), 'theme');
    for (const [name, ratio] of Object.entries(DURATION_RATIOS))
      out.setVar(name, `${Math.round(theme.motion.duration * ratio)}ms`, 'theme');
    const texture = theme.artwork.texture;
    if (texture) {
      const override = texture.surfaces?.[surface];
      out.setVar('--dm-texture-opacity', String(override?.opacity ?? texture.opacity), 'theme');
    }
    // The desktop titlebar (desktop/main.mjs FIELD_TITLEBAR) is keyed by scheme
    // id, so a custom theme still reports the base scheme it was built on.
    out.setData('package', theme.baseTheme, 'theme');
    out.setData('themePack', theme.id, 'theme');
    out.setData('density', theme.geometry.density, 'theme');
    out.setData('colorScheme', lightScheme ? 'light' : 'dark', 'theme');
  }

  // 3. authorized workspace branding ---------------------------------------
  if (workspace) {
    for (const [token, value] of Object.entries(workspace.colors ?? {})) {
      // A theme is validated before it gets here; these two layers come from
      // live settings and entitlement, so they are re-checked at the door. An
      // unusable value is dropped, never emitted and never half-applied.
      if (!(COLOR_TOKEN_NAMES as readonly string[]).includes(token)) continue;
      if (!isHexColor(value)) continue;
      colors[token as ColorTokenName] = value;
      colorLayer[token as ColorTokenName] = 'workspace';
    }
    if (workspace.density && DENSITIES.includes(workspace.density))
      out.setData('density', workspace.density, 'workspace');
    if (workspace.interfaceFont && FONT_STACKS[workspace.interfaceFont])
      out.setVar('--dm-font-ui', FONT_STACKS[workspace.interfaceFont], 'workspace');
    if (workspace.readingFont && FONT_STACKS[workspace.readingFont])
      out.setVar('--dm-font-read', FONT_STACKS[workspace.readingFont], 'workspace');
    if (workspace.codeFont && FONT_STACKS[workspace.codeFont])
      out.setVar('--dm-font-code', FONT_STACKS[workspace.codeFont], 'workspace');
  }

  // 4. personal preferences -------------------------------------------------
  if (isApprovedScale(personal.interfaceScale))
    out.setVar('--dm-ui-scale', String(personal.interfaceScale), 'personal');
  if (isApprovedScale(personal.readingScale))
    out.setVar('--dm-read-scale', String(personal.readingScale), 'personal');
  if (isApprovedScale(personal.codeScale))
    out.setVar('--dm-code-scale', String(personal.codeScale), 'personal');
  if (personal.density !== undefined && DENSITIES.includes(personal.density))
    out.setData('density', personal.density, 'personal');
  if (typeof personal.textureOpacity === 'number' && Number.isFinite(personal.textureOpacity))
    out.setVar(
      '--dm-texture-opacity',
      String(Math.max(0, Math.min(1, personal.textureOpacity))),
      'personal',
    );
  if (personal.motion === 'reduced') {
    out.setData('motion', 'reduced', 'personal');
    out.setVar('--dm-motion-intensity', '0', 'personal');
    for (const name of Object.keys(DURATION_RATIOS)) out.setVar(name, '0ms', 'personal');
  }

  // 5. mandatory accessibility and safety -----------------------------------
  if (demands.reducedMotion) {
    out.setData('motion', 'reduced', 'accessibility');
    out.setVar('--dm-motion-intensity', '0', 'accessibility');
    for (const name of Object.keys(DURATION_RATIOS)) out.setVar(name, '0ms', 'accessibility');
  }
  if (demands.textureOff) {
    out.setVar('--dm-texture-opacity', '0', 'accessibility');
    out.setData('texture', 'off', 'accessibility');
  }
  if (demands.minimumContrast !== undefined) {
    for (const role of TEXT_ROLES) {
      const lifted = liftToContrast(colors[role], colors.surface, demands.minimumContrast);
      if (lifted !== colors[role]) {
        colors[role] = lifted;
        colorLayer[role] = 'accessibility';
      }
    }
  }
  if (demands.focusVisible) {
    out.setVar('--dm-focus-width', '2px', 'accessibility');
    out.setVar('--dm-focus-color', colors.light, 'accessibility');
  }

  // Colours are emitted last so the contrast floor is already folded in, and
  // the separator strength multiplies the hairlines rather than replacing them.
  for (const token of COLOR_TOKEN_NAMES) {
    const value =
      token === 'hair' || token === 'hair2'
        ? applyStrength(colors[token], separatorStrength)
        : colors[token];
    out.setVar(CSS_VAR_FOR_TOKEN[token], value, colorLayer[token]);
  }
  out.setData('colorScheme', lightScheme ? 'light' : 'dark', schemeLayer);
  out.setData('package', baseTheme, theme ? 'theme' : 'defaults');

  return { vars: out.vars, dataset: out.dataset, origins: out.origins };
}
