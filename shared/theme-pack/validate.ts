/**
 * The ThemePack v1 gate. Nothing reaches the renderer, the store or the wire
 * without passing through here, so it is deliberately closed: every key is
 * named, every number is bounded, every string is scanned, and anything it
 * does not recognise is refused rather than carried along.
 *
 * Self-contained by design — see the note at the top of types.ts.
 */

import {
  APPROVED_SCALES,
  ARTWORK_MASKS,
  ARTWORK_SLOTS,
  ASSET_MIME_TYPES,
  BASE_THEME_IDS,
  BLEND_MODES,
  COLOR_TOKEN_NAMES,
  CONTROL_CHARACTER_PATTERN,
  CONTROL_RADIUS_MAX,
  CONTROL_RADIUS_MIN,
  DENSITIES,
  FONT_CHOICES,
  FORBIDDEN_STRING_FRAGMENTS,
  HEX_COLOR_PATTERN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MOTION_DURATION_MAX,
  MOTION_DURATION_MIN,
  MOTION_PRESET_IDS,
  SHA256_PATTERN,
  SURFACES,
  THEME_PACK_ID_PATTERN,
  THEME_PACK_NAME_MAX,
  THEME_PACK_SCHEMA_VERSION,
  THEME_PACK_TOP_LEVEL_KEYS,
  WEBSITE_ONLY_ARTWORK_SLOTS,
  type ThemePackV1,
} from './types.js';

export type ThemePackValidation = { ok: true; pack: ThemePackV1 } | { ok: false; errors: string[] };

export type ThemePackMigration =
  | { ok: true; pack: ThemePackV1 }
  | { ok: false; status: 'unsupported'; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every artwork slot name a v1 pack may use, app-rendered and website-only. */
const ALL_ARTWORK_SLOTS: readonly string[] = [...ARTWORK_SLOTS, ...WEBSITE_ONLY_ARTWORK_SLOTS];
const PLACEMENT_KEYS = ['assetHash', 'focal', 'crop', 'opacity', 'blend', 'mask'] as const;

class Checker {
  readonly errors: string[] = [];

  fail(message: string): false {
    this.errors.push(message);
    return false;
  }

  /**
   * A string is safe when it is a string, is not absurdly long, and carries no
   * fragment that a careless consumer could turn back into markup, a request
   * or a stylesheet expression. Object keys go through here too.
   */
  text(path: string, value: unknown, max = 512): value is string {
    if (typeof value !== 'string') return this.fail(`${path} must be a string`);
    if (value.length > max) return this.fail(`${path} is longer than ${max} characters`);
    if (CONTROL_CHARACTER_PATTERN.test(value))
      return this.fail(`${path} contains a control character, which is not allowed in a theme`);
    const lowered = value.toLowerCase();
    for (const fragment of FORBIDDEN_STRING_FRAGMENTS)
      if (lowered.includes(fragment))
        return this.fail(`${path} contains "${fragment}", which is not allowed in a theme`);
    return true;
  }

  number(path: string, value: unknown, min: number, max: number): value is number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return this.fail(`${path} must be a finite number`);
    if (value < min || value > max)
      return this.fail(`${path} must be between ${min} and ${max}, got ${value}`);
    return true;
  }

  integer(path: string, value: unknown, min: number, max: number): value is number {
    if (!this.number(path, value, min, max)) return false;
    if (!Number.isInteger(value)) return this.fail(`${path} must be a whole number`);
    return true;
  }

  oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): value is T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
      return this.fail(`${path} must be one of: ${allowed.join(', ')}`);
    return true;
  }

  /** An object with exactly the keys named — no more, and each key itself safe. */
  object(
    path: string,
    value: unknown,
    allowed: readonly string[],
  ): value is Record<string, unknown> {
    if (!isRecord(value)) return this.fail(`${path} must be an object`);
    for (const key of Object.keys(value)) {
      if (!this.text(`${path} key`, key, 128)) return false;
      if (!allowed.includes(key)) return this.fail(`${path} has an unknown key: ${key}`);
    }
    return true;
  }

  color(path: string, value: unknown): value is string {
    if (typeof value !== 'string') return this.fail(`${path} must be a string`);
    if (!HEX_COLOR_PATTERN.test(value))
      return this.fail(`${path} must be a hex colour (#rrggbb or #rrggbbaa), got ${value}`);
    return true;
  }

  hash(path: string, value: unknown): value is string {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value))
      return this.fail(`${path} must be a lowercase sha-256 hex digest`);
    return true;
  }
}

function checkTokens(check: Checker, value: unknown): void {
  if (!check.object('tokens', value, ['color', 'lightScheme'])) return;
  if (check.object('tokens.color', value.color, [...COLOR_TOKEN_NAMES])) {
    for (const name of COLOR_TOKEN_NAMES) {
      const token = (value.color as Record<string, unknown>)[name];
      if (!check.object(`tokens.color.${name}`, token, ['$type', '$value'])) continue;
      if (token.$type !== 'color') check.fail(`tokens.color.${name}.$type must be "color"`);
      check.color(`tokens.color.${name}.$value`, token.$value);
    }
  }
  if (check.object('tokens.lightScheme', value.lightScheme, ['$type', '$value'])) {
    if (value.lightScheme.$type !== 'boolean')
      check.fail('tokens.lightScheme.$type must be "boolean"');
    if (typeof value.lightScheme.$value !== 'boolean')
      check.fail('tokens.lightScheme.$value must be a boolean');
  }
}

function checkTypography(check: Checker, value: unknown): void {
  const keys = [
    'interfaceScale',
    'readingScale',
    'codeScale',
    'lineHeight',
    'interfaceFont',
    'readingFont',
    'codeFont',
  ] as const;
  if (!check.object('typography', value, keys)) return;
  for (const key of ['interfaceScale', 'readingScale', 'codeScale'] as const) {
    const scale = value[key];
    if (typeof scale !== 'number' || !(APPROVED_SCALES as readonly number[]).includes(scale))
      check.fail(
        `typography.${key} must be one of the approved scales: ${APPROVED_SCALES.join(', ')}`,
      );
  }
  check.number('typography.lineHeight', value.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX);
  for (const key of ['interfaceFont', 'readingFont', 'codeFont'] as const)
    check.oneOf(`typography.${key}`, value[key], FONT_CHOICES);
}

function checkGeometry(check: Checker, value: unknown): void {
  if (!check.object('geometry', value, ['controlRadius', 'separatorStrength', 'density'])) return;
  check.number(
    'geometry.controlRadius',
    value.controlRadius,
    CONTROL_RADIUS_MIN,
    CONTROL_RADIUS_MAX,
  );
  check.number('geometry.separatorStrength', value.separatorStrength, 0, 1);
  check.oneOf('geometry.density', value.density, DENSITIES);
}

function checkPlacement(
  check: Checker,
  path: string,
  value: Record<string, unknown>,
  required: boolean,
): void {
  const present = (key: string) => required || key in value;
  if (present('assetHash')) check.hash(`${path}.assetHash`, value.assetHash);
  if (present('focal') && check.object(`${path}.focal`, value.focal, ['x', 'y'])) {
    check.number(`${path}.focal.x`, value.focal.x, 0, 1);
    check.number(`${path}.focal.y`, value.focal.y, 0, 1);
  }
  if (present('crop') && check.object(`${path}.crop`, value.crop, ['x', 'y', 'width', 'height'])) {
    const crop = value.crop as Record<string, unknown>;
    check.number(`${path}.crop.x`, crop.x, 0, 1);
    check.number(`${path}.crop.y`, crop.y, 0, 1);
    check.number(`${path}.crop.width`, crop.width, 0.01, 1);
    check.number(`${path}.crop.height`, crop.height, 0.01, 1);
  }
  if (present('opacity')) check.number(`${path}.opacity`, value.opacity, 0, 1);
  if (present('blend')) check.oneOf(`${path}.blend`, value.blend, BLEND_MODES);
  if (present('mask')) check.oneOf(`${path}.mask`, value.mask, ARTWORK_MASKS);
}

function checkArtwork(check: Checker, value: unknown, assetHashes: Set<string>): void {
  if (!check.object('artwork', value, ALL_ARTWORK_SLOTS)) return;
  for (const [slot, entry] of Object.entries(value)) {
    const path = `artwork.${slot}`;
    if (!check.object(path, entry, [...PLACEMENT_KEYS, 'surfaces'])) continue;
    for (const key of PLACEMENT_KEYS) if (!(key in entry)) check.fail(`${path}.${key} is required`);
    checkPlacement(check, path, entry, true);
    if (typeof entry.assetHash === 'string' && !assetHashes.has(entry.assetHash))
      check.fail(`${path}.assetHash names an asset the pack does not carry`);
    if (entry.surfaces === undefined) continue;
    if (!check.object(`${path}.surfaces`, entry.surfaces, SURFACES)) continue;
    for (const [surface, override] of Object.entries(entry.surfaces)) {
      const overridePath = `${path}.surfaces.${surface}`;
      if (!check.object(overridePath, override, PLACEMENT_KEYS)) continue;
      checkPlacement(check, overridePath, override, false);
      if (typeof override.assetHash === 'string' && !assetHashes.has(override.assetHash))
        check.fail(`${overridePath}.assetHash names an asset the pack does not carry`);
    }
  }
}

function checkMotion(check: Checker, value: unknown): void {
  const keys = ['presetId', 'duration', 'intensity', 'reducedMotionBehaviour'] as const;
  if (!check.object('motion', value, keys)) return;
  check.oneOf('motion.presetId', value.presetId, MOTION_PRESET_IDS);
  check.number('motion.duration', value.duration, MOTION_DURATION_MIN, MOTION_DURATION_MAX);
  check.number('motion.intensity', value.intensity, 0, 1);
  if (value.reducedMotionBehaviour !== 'static')
    check.fail('motion.reducedMotionBehaviour must be "static" in v1');
}

/** Returns the declared asset hashes so artwork can be checked against them. */
function checkAssets(check: Checker, value: unknown): Set<string> {
  const hashes = new Set<string>();
  if (!isRecord(value)) {
    check.fail('assets must be an object');
    return hashes;
  }
  for (const [key, record] of Object.entries(value)) {
    if (!check.hash(`assets key "${key}"`, key)) continue;
    if (!check.object(`assets.${key}`, record, ['mime', 'bytes', 'width', 'height'])) continue;
    check.oneOf(`assets.${key}.mime`, record.mime, ASSET_MIME_TYPES);
    check.integer(`assets.${key}.bytes`, record.bytes, 1, Number.MAX_SAFE_INTEGER);
    check.integer(`assets.${key}.width`, record.width, 1, 65_535);
    check.integer(`assets.${key}.height`, record.height, 1, 65_535);
    hashes.add(key);
  }
  return hashes;
}

function checkProvenance(check: Checker, value: unknown): void {
  if (!check.object('provenance', value, ['author', 'createdAt', 'tool', 'notes'])) return;
  check.text('provenance.author', value.author, 200);
  check.text('provenance.tool', value.tool, 200);
  if (check.text('provenance.createdAt', value.createdAt, 40)) {
    const parsed = Date.parse(value.createdAt as string);
    if (Number.isNaN(parsed)) check.fail('provenance.createdAt must be an ISO-8601 instant');
  }
  if (value.notes !== undefined) check.text('provenance.notes', value.notes, 2_000);
}

/**
 * Validate an unknown value as a ThemePack v1.
 *
 * The version is checked first and on its own: an older or newer pack gets one
 * clear "unsupported version" answer rather than a hundred shape complaints.
 */
export function validateThemePack(unknown: unknown): ThemePackValidation {
  const check = new Checker();
  if (!isRecord(unknown)) return { ok: false, errors: ['a theme pack must be an object'] };

  if (unknown.schemaVersion !== THEME_PACK_SCHEMA_VERSION)
    return {
      ok: false,
      errors: [
        `unsupported version: this build reads ThemePack schemaVersion ${THEME_PACK_SCHEMA_VERSION}, the pack declares ${JSON.stringify(unknown.schemaVersion)}`,
      ],
    };

  for (const key of Object.keys(unknown))
    if (!(THEME_PACK_TOP_LEVEL_KEYS as readonly string[]).includes(key))
      check.fail(`unknown top-level key: ${key}`);
  for (const key of THEME_PACK_TOP_LEVEL_KEYS)
    if (!(key in unknown)) check.fail(`${key} is required`);

  if (!check.text('id', unknown.id, 64) || !THEME_PACK_ID_PATTERN.test(unknown.id as string))
    check.fail('id must match ^[a-z0-9][a-z0-9-]{2,63}$');
  if (
    check.text('name', unknown.name, THEME_PACK_NAME_MAX) &&
    (unknown.name as string).trim() === ''
  )
    check.fail('name must not be blank');
  check.integer('revision', unknown.revision, 1, Number.MAX_SAFE_INTEGER);
  check.oneOf('baseTheme', unknown.baseTheme, BASE_THEME_IDS);

  if (!Array.isArray(unknown.surfaces) || unknown.surfaces.length === 0)
    check.fail('surfaces must list at least one surface');
  else
    for (const [index, surface] of unknown.surfaces.entries())
      check.oneOf(`surfaces[${index}]`, surface, SURFACES);

  checkProvenance(check, unknown.provenance);
  checkTokens(check, unknown.tokens);
  checkTypography(check, unknown.typography);
  checkGeometry(check, unknown.geometry);
  checkMotion(check, unknown.motion);
  const hashes = checkAssets(check, unknown.assets);
  checkArtwork(check, unknown.artwork, hashes);

  if (check.errors.length > 0) return { ok: false, errors: check.errors };
  return { ok: true, pack: unknown as unknown as ThemePackV1 };
}

/**
 * v1 is the first version, so there is nothing to migrate from yet. The stub
 * exists so a future version has one honest place to grow, and so today's
 * answer to a foreign version is a refusal rather than a guess.
 */
export function migrate(unknown: unknown): ThemePackMigration {
  const result = validateThemePack(unknown);
  if (result.ok) return { ok: true, pack: result.pack };
  const version = isRecord(unknown) ? unknown.schemaVersion : undefined;
  if (version !== THEME_PACK_SCHEMA_VERSION)
    return {
      ok: false,
      status: 'unsupported',
      errors: [
        `unsupported version: no migration exists from schemaVersion ${JSON.stringify(version)} to ${THEME_PACK_SCHEMA_VERSION}`,
      ],
    };
  return { ok: false, status: 'unsupported', errors: result.errors };
}
