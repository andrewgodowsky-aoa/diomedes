import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCHEMES } from '../client/console/schemes.js';
import { INTERFACE_SCALES } from '../shared/interface-scale.js';
import {
  APPROVED_SCALES,
  BASE_THEME_COLORS,
  BASE_THEME_IDS,
  COLOR_TOKEN_NAMES,
  FONT_STACKS,
  THEME_PACK_LIMITS,
  THEME_PACK_NAME_MAX,
  type ThemePackV1,
} from '../shared/theme-pack/types.js';
import { migrate, validateThemePack } from '../shared/theme-pack/validate.js';
import {
  APPEARANCE_DEFAULTS,
  contrastRatio,
  resolveAppearance,
  textureOpacityCeiling,
} from '../shared/theme-pack/resolve.js';
import {
  APPEARANCE_OUTPUTS,
  THEME_PACK_COMPATIBILITY,
  checkCompatibility,
} from '../shared/theme-pack/compatibility.js';
import {
  checksum,
  exportThemePackage,
  importThemePackage,
  readImageHeader,
  sha256Hex,
} from '../shared/theme-pack/package.js';

const folder = fileURLToPath(new URL('../shared/theme-pack/', import.meta.url));
const readFixture = (name: string): ThemePackV1 =>
  JSON.parse(fs.readFileSync(path.join(folder, 'fixtures', `${name}.json`), 'utf8')) as ThemePackV1;
const styles = fs.readFileSync(
  fileURLToPath(new URL('../client/styles.css', import.meta.url)),
  'utf8',
);
const plate = fs.readFileSync(path.join(folder, 'fixtures', 'bust-plate.png'));
const plateHash = createHash('sha256').update(plate).digest('hex');

const accept = (value: unknown): ThemePackV1 => {
  const result = validateThemePack(value);
  if (!result.ok) throw new Error(`expected a valid pack, got: ${result.errors.join('; ')}`);
  return result.pack;
};
const reject = (value: unknown): string[] => {
  const result = validateThemePack(value);
  if (result.ok) throw new Error('expected the pack to be refused');
  return result.errors;
};
/** A deep clone that survives the fixture being JSON. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mythic = () => clone(readFixture('mythic-synthwave'));
const harbor = () => clone(readFixture('harbor-quiet'));

/** `rgba(255,255,255,.07)` as the schemes write it → `#ffffff12`. */
function rgbaToHex(value: string): string {
  if (value.startsWith('#')) return value.toLowerCase();
  const parts = value.replace(/^rgba?\(|\)$/g, '').split(',');
  const [r, g, b] = parts.slice(0, 3).map((n) => Number(n.trim()));
  const alpha = parts.length > 3 ? Number(parts[3].trim()) : 1;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return alpha >= 1 ? base : `${base}${hex(Math.round(alpha * 255))}`;
}

describe('theme pack contract stays in step with the app it describes', () => {
  test('base themes mirror the built-in schemes exactly', () => {
    expect([...BASE_THEME_IDS]).toEqual(SCHEMES.map((scheme) => scheme.id));
    for (const scheme of SCHEMES) {
      const mirrored = BASE_THEME_COLORS[scheme.id as (typeof BASE_THEME_IDS)[number]];
      expect(mirrored, `${scheme.id} is missing from BASE_THEME_COLORS`).toBeDefined();
      expect(mirrored.lightScheme).toBe(scheme.lightScheme === true);
      for (const token of COLOR_TOKEN_NAMES) {
        expect(mirrored.colors[token], `${scheme.id}.${token}`).toBe(
          rgbaToHex(scheme[token] as string),
        );
      }
    }
  });

  test('approved typography scales are the approved interface scales', () => {
    expect([...APPROVED_SCALES]).toEqual([...INTERFACE_SCALES]);
  });

  test('the resolver defaults are the values client/styles.css ships', () => {
    const declared = (name: string) => {
      const match = styles.match(new RegExp(`\\${name}:\\s*([^;]+);`));
      return match?.[1].trim();
    };
    expect(declared('--r')).toBe(`${APPEARANCE_DEFAULTS.controlRadius}px`);
    expect(declared('--rb')).toBe(`${APPEARANCE_DEFAULTS.controlRadius - 1}px`);
    expect(declared('--dm-line-body')).toBe(String(APPEARANCE_DEFAULTS.lineHeight));
    expect(declared('--dm-ui-scale')).toBe(String(APPEARANCE_DEFAULTS.interfaceScale));
    expect(declared('--dm-read-scale')).toBe(String(APPEARANCE_DEFAULTS.readingScale));
    expect(declared('--dm-code-scale')).toBe(String(APPEARANCE_DEFAULTS.codeScale));
    // 120 / 160 / 200ms, i.e. 0.75x, 1x and 1.25x the default duration.
    const resolved = resolveAppearance({});
    for (const name of ['--dm-t-quick', '--dm-t-view', '--dm-t-extend'])
      expect(resolved.vars[name], name).toBe(declared(name));
    expect(declared('--dm-t-view')).toBe(`${APPEARANCE_DEFAULTS.motionDuration}ms`);
  });

  test('the appearance-output manifest tells the truth about client/styles.css', () => {
    const emitted = resolveAppearance({
      theme: accept(mythic()),
      accessibility: { focusVisible: true },
    });
    const listed = new Set(APPEARANCE_OUTPUTS.map((output) => output.name));
    for (const name of Object.keys(emitted.vars)) expect(listed, name).toContain(name);
    for (const key of Object.keys(emitted.dataset))
      expect(listed, key).toContain(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    for (const output of APPEARANCE_OUTPUTS)
      expect(styles.includes(output.name), `${output.name} in client/styles.css`).toBe(
        output.existsInAppToday,
      );
  });

  test('the handoff files import nothing outside the folder', () => {
    const shipped = ['types.ts', 'validate.ts', 'resolve.ts', 'compatibility.ts', 'package.ts'];
    for (const file of shipped) {
      const source = fs.readFileSync(path.join(folder, file), 'utf8');
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier, `${file} reaches outside the handoff bundle`).toMatch(
          /^\.\/[a-z-]+\.js$/,
        );
      }
    }
  });

  test('the bundled fixture asset is the bytes the fixtures declare', () => {
    const pack = accept(mythic());
    expect(plateHash).toBe('b28b66d844601c653a817e41e494c0bf8922a2740acb16479a78557c564e6afb');
    expect(pack.artwork.bust?.assetHash).toBe(plateHash);
    const record = pack.assets[plateHash];
    expect(record.bytes).toBe(plate.byteLength);
    expect(record.mime).toBe('image/png');
    // IHDR width and height live at bytes 16..23 of every PNG.
    expect(plate.readUInt32BE(16)).toBe(record.width);
    expect(plate.readUInt32BE(20)).toBe(record.height);
  });
});

describe('validateThemePack', () => {
  test('accepts both shipped fixtures', () => {
    expect(accept(mythic()).id).toBe('mythic-synthwave');
    expect(accept(harbor()).baseTheme).toBe('harbor');
  });

  test('requires a display name it can actually show', () => {
    expect(accept(mythic()).name).toBe('Mythic Synthwave');
    expect(accept(harbor()).name).toBe('Harbor Quiet');
    const { name: _dropped, ...without } = mythic();
    expect(reject(without).join()).toMatch(/name is required/i);
    expect(reject({ ...mythic(), name: '' }).join()).toMatch(/name/i);
    expect(reject({ ...mythic(), name: '   ' }).join()).toMatch(/name must not be blank/i);
    expect(reject({ ...mythic(), name: 42 }).join()).toMatch(/name must be a string/i);
    expect(reject({ ...mythic(), name: 'x'.repeat(THEME_PACK_NAME_MAX + 1) }).join()).toMatch(
      /name is longer/i,
    );
    expect(reject({ ...mythic(), name: 'Bad <b>name' }).join()).toMatch(/not allowed/i);
    expect(accept({ ...mythic(), name: 'x'.repeat(THEME_PACK_NAME_MAX) }).name).toHaveLength(
      THEME_PACK_NAME_MAX,
    );
  });

  test('refuses control characters in any string', () => {
    expect(reject({ ...mythic(), name: `Mythic${'\u0000'}Synthwave` }).join()).toMatch(
      /control character/i,
    );
    const pack = mythic();
    pack.provenance.author = `Diomedes${'\u001b'}design`;
    expect(reject(pack).join()).toMatch(/control character/i);
  });

  test('refuses anything that is not an object', () => {
    expect(reject(null).join()).toMatch(/object/i);
    expect(reject('{}').join()).toMatch(/object/i);
    expect(reject([]).join()).toMatch(/object/i);
  });

  test('refuses unknown top-level keys', () => {
    const pack = { ...mythic(), css: '.a{}' };
    expect(reject(pack).join()).toMatch(/unknown top-level key: css/i);
  });

  test('refuses an unsupported schema version with a clear message', () => {
    const errors = reject({ ...mythic(), schemaVersion: 2 });
    expect(errors.join()).toMatch(/unsupported version/i);
    expect(errors.join()).toMatch(/2/);
    expect(reject({ ...mythic(), schemaVersion: 0 }).join()).toMatch(/unsupported version/i);
  });

  test('migrate passes version 1 through and refuses everything else', () => {
    const forward = migrate(mythic());
    expect(forward.ok).toBe(true);
    const backward = migrate({ ...mythic(), schemaVersion: 7 });
    expect(backward.ok).toBe(false);
    if (!backward.ok) {
      expect(backward.status).toBe('unsupported');
      expect(backward.errors.join()).toMatch(/unsupported version/i);
    }
  });

  test.each([
    ['url(', 'url(https://example.test/a.png)'],
    ['markup', 'a <script> tag'],
    ['javascript:', 'javascript:alert(1)'],
    ['expression(', 'expression(alert(1))'],
  ])('refuses executable strings anywhere — %s', (_label, value) => {
    const pack = mythic();
    pack.provenance.notes = value;
    expect(reject(pack).join()).toMatch(/not allowed|forbidden/i);
    const nested = mythic();
    nested.provenance.author = value;
    expect(reject(nested).join()).toMatch(/not allowed|forbidden/i);
  });

  test('refuses executable strings hidden in an object key', () => {
    const pack = mythic();
    (pack.tokens.color as unknown as Record<string, unknown>)['t1<script>'] = {
      $type: 'color',
      $value: '#ffffff',
    };
    expect(reject(pack).join()).toMatch(/not allowed/i);
    const asset = mythic();
    (asset.assets as Record<string, unknown>)['javascript:x'] = { ...asset.assets[plateHash] };
    expect(reject(asset).length).toBeGreaterThan(0);
  });

  test('refuses colours that are not hex', () => {
    const pack = mythic();
    pack.tokens.color.hair.$value = 'rgba(255,255,255,.07)';
    expect(reject(pack).join()).toMatch(/hex/i);
    const named = mythic();
    named.tokens.color.t1.$value = 'white';
    expect(reject(named).join()).toMatch(/hex/i);
  });

  test('refuses a token that drops its DTCG type', () => {
    const pack = mythic();
    delete (pack.tokens.color.t1 as Partial<{ $type: string }>).$type;
    expect(reject(pack).join()).toMatch(/\$type/);
  });

  test('refuses a malformed id or revision', () => {
    expect(reject({ ...mythic(), id: 'No Caps' }).join()).toMatch(/id/i);
    expect(reject({ ...mythic(), id: 'ab' }).join()).toMatch(/id/i);
    expect(reject({ ...mythic(), id: '-leading' }).join()).toMatch(/id/i);
    expect(reject({ ...mythic(), revision: 0 }).join()).toMatch(/revision/i);
    expect(reject({ ...mythic(), revision: 1.5 }).join()).toMatch(/revision/i);
  });

  test('refuses an unknown base theme or surface', () => {
    expect(reject({ ...mythic(), baseTheme: 'cobalt' }).join()).toMatch(/baseTheme/);
    expect(reject({ ...mythic(), surfaces: [] }).join()).toMatch(/surfaces/);
    expect(reject({ ...mythic(), surfaces: ['print'] }).join()).toMatch(/surfaces/);
  });

  test.each([
    ['typography.lineHeight', (p: ThemePackV1) => (p.typography.lineHeight = 2.1)],
    ['typography.lineHeight', (p: ThemePackV1) => (p.typography.lineHeight = 1.2)],
    ['typography.interfaceScale', (p: ThemePackV1) => (p.typography.interfaceScale = 1.4 as never)],
    ['geometry.controlRadius', (p: ThemePackV1) => (p.geometry.controlRadius = 13)],
    ['geometry.controlRadius', (p: ThemePackV1) => (p.geometry.controlRadius = -1)],
    ['geometry.separatorStrength', (p: ThemePackV1) => (p.geometry.separatorStrength = 1.01)],
    ['motion.duration', (p: ThemePackV1) => (p.motion.duration = 1201)],
    ['motion.intensity', (p: ThemePackV1) => (p.motion.intensity = -0.1)],
    ['artwork opacity', (p: ThemePackV1) => (p.artwork.bust!.opacity = 1.2)],
    ['artwork focal', (p: ThemePackV1) => (p.artwork.bust!.focal.x = 1.4)],
    ['artwork crop', (p: ThemePackV1) => (p.artwork.bust!.crop.width = 0)],
    ['assets.bytes', (p: ThemePackV1) => (p.assets[plateHash].bytes = 0)],
    ['assets.width', (p: ThemePackV1) => (p.assets[plateHash].width = 0)],
  ])('bounds every numeric field — %s', (_label, mutate) => {
    const pack = mythic();
    mutate(pack);
    expect(reject(pack).length).toBeGreaterThan(0);
  });

  test('refuses NaN and Infinity where a number is expected', () => {
    const pack = mythic();
    pack.geometry.controlRadius = Number.POSITIVE_INFINITY;
    expect(reject(pack).length).toBeGreaterThan(0);
  });

  test('refuses an unapproved font, motion preset, blend or mask', () => {
    const font = mythic();
    font.typography.codeFont = 'Comic Sans' as never;
    expect(reject(font).join()).toMatch(/codeFont/);
    const motion = mythic();
    motion.motion.presetId = 'explode' as never;
    expect(reject(motion).join()).toMatch(/presetId/);
    const blend = mythic();
    blend.artwork.bust!.blend = 'overlay' as never;
    expect(reject(blend).join()).toMatch(/blend/);
    const mask = mythic();
    mask.artwork.bust!.mask = 'shatter' as never;
    expect(reject(mask).join()).toMatch(/mask/);
  });

  test('refuses reducedMotionBehaviour other than static', () => {
    const pack = mythic();
    pack.motion.reducedMotionBehaviour = 'slow' as never;
    expect(reject(pack).join()).toMatch(/reducedMotionBehaviour/);
  });

  test('refuses artwork pointing at an asset the pack does not carry', () => {
    const pack = mythic();
    pack.artwork.bust!.assetHash = 'a'.repeat(64);
    expect(reject(pack).join()).toMatch(/asset/i);
  });

  test('refuses an asset key that is not a sha-256 hex digest', () => {
    const pack = mythic();
    pack.assets['not-a-hash'] = { mime: 'image/png', bytes: 10, width: 1, height: 1 };
    expect(reject(pack).join()).toMatch(/sha-?256|digest|hash/i);
  });

  test('refuses an unknown artwork slot but accepts the declared website-only ones', () => {
    const pack = mythic();
    (pack.artwork as Record<string, unknown>).wallpaper = pack.artwork.hero;
    expect(reject(pack).join()).toMatch(/wallpaper/);
    expect(accept(harbor()).artwork.sceneTreatment).toBeDefined();
  });

  test('refuses an unknown key inside a nested object', () => {
    const pack = mythic();
    (pack.geometry as unknown as Record<string, unknown>).shadow = 'heavy';
    expect(reject(pack).join()).toMatch(/shadow/);
  });

  test('returns every problem it found, not only the first', () => {
    const pack = mythic();
    pack.revision = 0;
    pack.geometry.controlRadius = 99;
    expect(reject(pack).length).toBeGreaterThanOrEqual(2);
  });
});

describe('checkCompatibility', () => {
  test('the manifest covers every field both surfaces could see', () => {
    const fields = THEME_PACK_COMPATIBILITY.map((entry) => entry.field);
    expect(new Set(fields).size).toBe(fields.length);
    for (const required of ['tokens.color', 'typography', 'geometry', 'motion', 'artwork.hero'])
      expect(fields).toContain(required);
  });

  test('each fixture warns exactly once on the app console and never on the website', () => {
    for (const pack of [accept(mythic()), accept(harbor())]) {
      const app = checkCompatibility(pack, 'app-console');
      expect(app.ok).toBe(true);
      expect(app.errors).toEqual([]);
      expect(app.warnings).toHaveLength(1);
      expect(app.warnings[0]).toMatch(/ignored/i);
      const site = checkCompatibility(pack, 'website');
      expect(site.ok).toBe(true);
      expect(site.warnings).toEqual([]);
    }
  });

  test('a pack that does not declare the surface is a hard incompatibility', () => {
    const pack = accept({ ...mythic(), surfaces: ['website'] });
    const report = checkCompatibility(pack, 'app-console');
    expect(report.ok).toBe(false);
    expect(report.errors.join()).toMatch(/app-console/);
  });
});

describe('resolveAppearance', () => {
  const surfaceOf = (vars: Record<string, string>) => vars['--surface'];

  /** Flatten an opaque colour at `alpha` onto another, the way a browser does. */
  const compositeHex = (top: string, alpha: number, bottom: string): string => {
    const parts = (hex: string) =>
      [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
    const [tr, tg, tb] = parts(top);
    const [br, bg, bb] = parts(bottom);
    const mix = (a: number, b: number) =>
      Math.round(a * alpha + b * (1 - alpha))
        .toString(16)
        .padStart(2, '0');
    return `#${mix(tr, br)}${mix(tg, bg)}${mix(tb, bb)}`;
  };

  test('defaults alone produce a complete, labelled Field appearance', () => {
    const resolved = resolveAppearance({});
    expect(surfaceOf(resolved.vars)).toBe(BASE_THEME_COLORS.field.colors.surface);
    expect(resolved.dataset.package).toBe('field');
    expect(resolved.origins['--surface']).toBe('defaults');
    for (const token of COLOR_TOKEN_NAMES)
      expect(Object.keys(resolved.vars)).toContain(token === 'hair2' ? '--hair-2' : `--${token}`);
  });

  test('a theme overrides the defaults and is recorded as their source', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({ theme: pack });
    expect(surfaceOf(resolved.vars)).toBe('#100b1a');
    expect(resolved.origins['--surface']).toBe('theme');
    expect(resolved.dataset.themePack).toBe('mythic-synthwave');
    // The desktop titlebar is keyed by scheme id, so the base theme must survive.
    expect(resolved.dataset.package).toBe('graphite');
  });

  test('authorized workspace branding overrides the theme; unauthorized branding is ignored', () => {
    const pack = accept(mythic());
    const branding = { authorized: true, colors: { light: '#00ff88' } };
    const resolved = resolveAppearance({ theme: pack, workspace: branding });
    expect(resolved.vars['--light']).toBe('#00ff88');
    expect(resolved.origins['--light']).toBe('workspace');
    const refused = resolveAppearance({
      theme: pack,
      workspace: { ...branding, authorized: false },
    });
    expect(refused.vars['--light']).toBe('#4ff0ff');
    expect(refused.origins['--light']).toBe('theme');
  });

  test('the layers that are not validated packs are re-checked at the door', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({
      theme: pack,
      workspace: {
        authorized: true,
        colors: { light: 'url(https://example.test/x.png)', attn: 'rgba(0,0,0,.5)' },
      },
      personal: { interfaceScale: 3 as never, textureOpacity: 9 },
    });
    expect(resolved.vars['--light']).toBe('#4ff0ff');
    expect(resolved.origins['--light']).toBe('theme');
    expect(resolved.vars['--attn']).toBe('#c77dff');
    expect(resolved.vars['--dm-ui-scale']).toBe('1');
    expect(resolved.origins['--dm-ui-scale']).toBe('theme');
    expect(resolved.vars['--dm-texture-opacity']).toBe('1');
  });

  test('a workspace font choice is matched by membership, not by truthiness', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({
      theme: pack,
      // 'toString' is an Object.prototype key: a `FONT_STACKS[x]` truthiness
      // guard would put a function into the custom property.
      workspace: {
        authorized: true,
        interfaceFont: 'toString' as never,
        readingFont: 'constructor' as never,
        codeFont: 'hasOwnProperty' as never,
      },
    });
    for (const name of ['--dm-font-ui', '--dm-font-read', '--dm-font-code']) {
      expect(typeof resolved.vars[name]).toBe('string');
      expect(resolved.vars[name]).not.toMatch(/function|native code|\[object/i);
      expect(resolved.origins[name]).toBe('theme');
    }
    expect(resolved.vars['--dm-font-ui']).toBe(FONT_STACKS['schibsted-grotesk']);
  });

  test('the motion preset is emitted and reduced motion forces it to none', () => {
    const pack = accept(mythic());
    expect(resolveAppearance({}).dataset.motionPreset).toBe('settle');
    const themed = resolveAppearance({ theme: pack });
    expect(themed.dataset.motionPreset).toBe('drift');
    expect(themed.origins['data:motionPreset']).toBe('theme');
    const reduced = resolveAppearance({ theme: pack, accessibility: { reducedMotion: true } });
    expect(reduced.dataset.motionPreset).toBe('none');
    expect(reduced.origins['data:motionPreset']).toBe('accessibility');
    const preferred = resolveAppearance({ theme: pack, personal: { motion: 'reduced' } });
    expect(preferred.dataset.motionPreset).toBe('none');
    expect(preferred.origins['data:motionPreset']).toBe('personal');
  });

  test('personal preferences override workspace branding for the fields they own', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({
      theme: pack,
      workspace: { authorized: true, density: 'guided' },
      personal: { interfaceScale: 1.25, density: 'technical' },
    });
    expect(resolved.vars['--dm-ui-scale']).toBe('1.25');
    expect(resolved.origins['--dm-ui-scale']).toBe('personal');
    expect(resolved.dataset.density).toBe('technical');
    expect(resolved.origins['data:density']).toBe('personal');
  });

  test('reduced motion wins over the theme and over the personal preference', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({
      theme: pack,
      personal: { motion: 'normal' },
      accessibility: { reducedMotion: true },
    });
    expect(resolved.dataset.motion).toBe('reduced');
    expect(resolved.origins['data:motion']).toBe('accessibility');
    expect(resolved.vars['--dm-t-quick']).toBe('0ms');
    expect(resolved.vars['--dm-t-view']).toBe('0ms');
    expect(resolved.vars['--dm-t-extend']).toBe('0ms');
    expect(resolved.vars['--dm-motion-intensity']).toBe('0');
  });

  test('texture-off cannot be edited away by a theme or a personal preference', () => {
    const pack = accept(mythic());
    const resolved = resolveAppearance({
      theme: pack,
      personal: { textureOpacity: 0.9 },
      accessibility: { textureOff: true },
    });
    expect(resolved.vars['--dm-texture-opacity']).toBe('0');
    expect(resolved.dataset.texture).toBe('off');
    expect(resolved.origins['--dm-texture-opacity']).toBe('accessibility');
  });

  /**
   * A texture is the one decoration a theme can ask for that sits between the
   * surface and every label on it. Nothing in this product can decode the
   * picture, so the ceiling is computed against the two colours that could do
   * the most harm — pure white and pure black — and the tighter one is taken.
   */
  const withTexture = (pack: ReturnType<typeof accept>, opacity: number) => {
    const hash = 'a'.repeat(64);
    pack.artwork.texture = {
      assetHash: hash,
      focal: { x: 0.5, y: 0.5 },
      crop: { x: 0, y: 0, width: 1, height: 1 },
      opacity,
      blend: 'normal',
      mask: 'none',
    };
    pack.assets[hash] = { mime: 'image/png', bytes: 232, width: 16, height: 16 };
    return pack;
  };

  test('a texture is capped at the opacity this theme’s own colours can survive', () => {
    const pack = withTexture(accept(mythic()), 1);
    const resolved = resolveAppearance({ theme: pack });
    const painted = Number(resolved.vars['--dm-texture-opacity']);
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(1);
    expect(resolved.origins['--dm-texture-opacity']).toBe('accessibility');

    // The cap is the claim, so check the claim: at the painted opacity every
    // text role still clears 4.5:1 over the worst texture it could be hiding.
    for (const worst of ['#ffffff', '#000000']) {
      const over = compositeHex(worst, painted, resolved.vars['--surface']);
      for (const role of ['--t1', '--t2', '--t3'])
        expect(contrastRatio(resolved.vars[role], over)).toBeGreaterThanOrEqual(4.5);
    }
    // One step above it, something is unreadable — the cap is not slack.
    const tooFar = compositeHex('#ffffff', painted + 0.02, resolved.vars['--surface']);
    expect(
      Math.min(...['--t1', '--t2', '--t3'].map((r) => contrastRatio(resolved.vars[r], tooFar))),
    ).toBeLessThan(4.5);
  });

  test('a texture a theme already keeps modest is left exactly where it was put', () => {
    const pack = withTexture(accept(mythic()), 0.01);
    const resolved = resolveAppearance({ theme: pack });
    expect(resolved.vars['--dm-texture-opacity']).toBe('0.01');
    expect(resolved.origins['--dm-texture-opacity']).toBe('theme');
  });

  test('the cap holds a personal preference too, and texture-off still wins over the cap', () => {
    const pack = withTexture(accept(mythic()), 0.01);
    const raised = resolveAppearance({ theme: pack, personal: { textureOpacity: 1 } });
    expect(Number(raised.vars['--dm-texture-opacity'])).toBeLessThan(1);
    expect(raised.origins['--dm-texture-opacity']).toBe('accessibility');
    const off = resolveAppearance({
      theme: pack,
      personal: { textureOpacity: 1 },
      accessibility: { textureOff: true },
    });
    expect(off.vars['--dm-texture-opacity']).toBe('0');
    expect(off.dataset.texture).toBe('off');
  });

  test('every shipped scheme states the texture opacity it can carry', () => {
    const measured = Object.entries(BASE_THEME_COLORS).map(([id, base]) => [
      id,
      textureOpacityCeiling(
        [base.colors.t1, base.colors.t2, base.colors.t3],
        base.colors.surface,
        4.5,
      ),
    ]) as [string, number][];
    // Every scheme can carry *some* texture: none of them ships a text role
    // that already fails on its own surface, and a ceiling of 0 would say one
    // does. They are all small, because a quiet text role sits near the floor
    // before a picture is put under it — that is a fact about the schemes, not
    // a fudge in the cap.
    for (const [id, ceiling] of measured) {
      expect(ceiling, id).toBeGreaterThan(0);
      expect(ceiling, id).toBeLessThan(0.2);
    }
  });

  test('a text role below the contrast floor is lifted, and the lift is attributed', () => {
    const pack = accept(mythic());
    pack.tokens.color.t3.$value = '#1a1420';
    const resolved = resolveAppearance({ theme: pack, accessibility: { minimumContrast: 4.5 } });
    expect(resolved.vars['--t3']).not.toBe('#1a1420');
    expect(resolved.origins['--t3']).toBe('accessibility');
    const kept = resolveAppearance({
      theme: accept(mythic()),
      accessibility: { minimumContrast: 4.5 },
    });
    expect(kept.vars['--t3']).toBe('#8d84a6');
    expect(kept.origins['--t3']).toBe('theme');
  });

  test('focus visibility is forced on and never left to the theme', () => {
    const resolved = resolveAppearance({
      theme: accept(mythic()),
      accessibility: { focusVisible: true },
    });
    expect(resolved.vars['--dm-focus-width']).toBe('2px');
    expect(resolved.origins['--dm-focus-width']).toBe('accessibility');
  });

  test('separator strength scales the hairline alpha without changing its colour', () => {
    const pack = accept(harbor());
    const resolved = resolveAppearance({ theme: pack });
    expect(resolved.vars['--hair']).toMatch(/^#ffffff[0-9a-f]{2}$/);
    expect(resolved.vars['--hair']).not.toBe('#ffffff0f');
  });

  test('a light pack flips the colour scheme dataset', () => {
    const pack = accept(mythic());
    pack.tokens.lightScheme.$value = true;
    expect(resolveAppearance({ theme: pack }).dataset.colorScheme).toBe('light');
    expect(resolveAppearance({}).dataset.colorScheme).toBe('dark');
  });

  test('every resolved value carries an origin', () => {
    const resolved = resolveAppearance({
      theme: accept(mythic()),
      workspace: { authorized: true, colors: { attn: '#ffcc00' } },
      personal: { codeScale: 1.1 },
      accessibility: { reducedMotion: true, focusVisible: true },
    });
    for (const name of Object.keys(resolved.vars)) expect(resolved.origins[name]).toBeDefined();
    for (const key of Object.keys(resolved.dataset))
      expect(resolved.origins[`data:${key}`]).toBeDefined();
  });

  test('a resolved value never contains anything executable', () => {
    const resolved = resolveAppearance({ theme: accept(mythic()) });
    for (const value of Object.values(resolved.vars)) {
      expect(value).not.toMatch(/url\(|javascript:|expression\(|</);
    }
  });
});

describe('the .diomedes-theme package', () => {
  const bytes = () => ({ [plateHash]: new Uint8Array(plate) });

  test('sha256Hex matches the published vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new Uint8Array(plate))).toBe(plateHash);
  });

  test('checksum is content identity and ignores key order', () => {
    const pack = accept(mythic());
    // Same content, every object's keys written in the opposite order.
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reverseKeys(entry)]),
        );
      return value;
    };
    const reordered = accept(reverseKeys(pack));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(pack));
    expect(checksum(reordered)).toBe(checksum(pack));
    const changed = accept({ ...mythic(), revision: 4 });
    expect(checksum(changed)).not.toBe(checksum(pack));
    expect(checksum(pack)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('exports and imports back to the same pack and the same bytes', () => {
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.package.manifest.format).toBe('diomedes-theme');
    expect(exported.package.manifest.formatVersion).toBe(1);
    expect(exported.package.manifest.checksum).toBe(checksum(pack));
    const wire = JSON.parse(JSON.stringify(exported.package));
    const imported = importThemePackage(wire);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.pack).toEqual(pack);
    expect([...imported.assets[plateHash]]).toEqual([...new Uint8Array(plate)]);
  });

  test('refuses an asset whose bytes do not hash to its key', () => {
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    if (!exported.ok) throw new Error('export failed');
    const tampered = JSON.parse(JSON.stringify(exported.package));
    tampered.assets[plateHash] = tampered.assets[plateHash].replace(/^.{4}/, 'AAAA');
    const imported = importThemePackage(tampered);
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.errors.join()).toMatch(/hash|digest|checksum/i);
  });

  test('refuses a package whose manifest checksum does not match the pack', () => {
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    if (!exported.ok) throw new Error('export failed');
    const tampered = JSON.parse(JSON.stringify(exported.package));
    tampered.manifest.checksum = 'f'.repeat(64);
    const imported = importThemePackage(tampered);
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.errors.join()).toMatch(/checksum/i);
  });

  test('refuses assets the pack never declared and declarations with no bytes', () => {
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    if (!exported.ok) throw new Error('export failed');
    const extra = JSON.parse(JSON.stringify(exported.package));
    extra.assets['b'.repeat(64)] = 'AAAA';
    expect(importThemePackage(extra).ok).toBe(false);
    const missing = JSON.parse(JSON.stringify(exported.package));
    delete missing.assets[plateHash];
    expect(importThemePackage(missing).ok).toBe(false);
  });

  test('refuses an export whose declared byte count is a lie', () => {
    const pack = accept(mythic());
    pack.assets[plateHash].bytes = 231;
    const exported = exportThemePackage(pack, bytes());
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.errors.join()).toMatch(/bytes/i);
  });

  test('enforces the per-asset, total and megapixel caps', () => {
    const pack = accept(mythic());
    const tight = { totalAssetBytes: 1024, assetBytes: 100, assetPixels: 1024 };
    const perAsset = exportThemePackage(pack, bytes(), tight);
    expect(perAsset.ok).toBe(false);
    if (!perAsset.ok) expect(perAsset.errors.join()).toMatch(/2 MB|per-asset|larger than/i);

    const total = exportThemePackage(pack, bytes(), { ...THEME_PACK_LIMITS, totalAssetBytes: 100 });
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.errors.join()).toMatch(/total/i);

    const pixels = exportThemePackage(pack, bytes(), { ...THEME_PACK_LIMITS, assetPixels: 4 });
    expect(pixels.ok).toBe(false);
    if (!pixels.ok) expect(pixels.errors.join()).toMatch(/pixel/i);
  });

  test('reads the real dimensions out of PNG, JPEG and WebP bytes', () => {
    expect(readImageHeader(new Uint8Array(plate))).toEqual({
      mime: 'image/png',
      width: 16,
      height: 16,
    });

    // A JPEG with one APP0 segment before the SOF0 frame header.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
      0x04, 0xb0, 0x03,
    ]);
    expect(readImageHeader(jpeg)).toEqual({ mime: 'image/jpeg', width: 1200, height: 600 });

    const riff = (fourcc: string, payload: number[]) => {
      const bytes = new Uint8Array(12 + 8 + payload.length);
      const write = (text: string, at: number) =>
        [...text].forEach((char, index) => (bytes[at + index] = char.charCodeAt(0)));
      write('RIFF', 0);
      write('WEBP', 8);
      write(fourcc, 12);
      bytes[16] = payload.length;
      bytes.set(payload, 20);
      return bytes;
    };
    // VP8X carries the canvas size as two 24-bit little-endian "minus one"s.
    expect(readImageHeader(riff('VP8X', [0, 0, 0, 0, 0x2f, 0x00, 0x00, 0x1d, 0x00, 0x00]))).toEqual(
      {
        mime: 'image/webp',
        width: 48,
        height: 30,
      },
    );
    // VP8L packs width-1 and height-1 into 14 bits each after the 0x2f signature.
    const packed = (47 & 0x3fff) | ((29 & 0x3fff) << 14);
    expect(
      readImageHeader(
        riff('VP8L', [
          0x2f,
          packed & 0xff,
          (packed >>> 8) & 0xff,
          (packed >>> 16) & 0xff,
          (packed >>> 24) & 0xff,
          0,
          0,
          0,
          0,
          0,
        ]),
      ),
    ).toEqual({ mime: 'image/webp', width: 48, height: 30 });
    // Lossy VP8: three frame-tag bytes, the 9d 01 2a sync code, then the size.
    expect(
      readImageHeader(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x30, 0x00, 0x1e, 0x00])),
    ).toEqual({ mime: 'image/webp', width: 48, height: 30 });

    expect(readImageHeader(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(readImageHeader(new TextEncoder().encode('GIF89a not supported'))).toBeUndefined();
  });

  test('refuses an asset whose declared size or type its bytes contradict', () => {
    const big = accept(mythic());
    big.assets[plateHash].width = 4096;
    big.assets[plateHash].height = 4096;
    const lied = exportThemePackage(big, bytes());
    expect(lied.ok).toBe(false);
    if (!lied.ok) expect(lied.errors.join()).toMatch(/declares 4096×4096 but its bytes are 16×16/);

    const mistyped = accept(mythic());
    mistyped.assets[plateHash].mime = 'image/webp';
    const wrong = exportThemePackage(mistyped, bytes());
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.errors.join()).toMatch(/declares image\/webp but its bytes are/);
  });

  test('refuses bytes that are not a readable image at all', () => {
    const notAnImage = new TextEncoder().encode('this is not an image, it is a note');
    const hash = sha256Hex(notAnImage);
    const pack = accept({
      ...mythic(),
      artwork: {},
      assets: {
        [hash]: { mime: 'image/png', bytes: notAnImage.length, width: 16, height: 16 },
      },
    });
    const exported = exportThemePackage(pack, { [hash]: notAnImage });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.errors.join()).toMatch(/dimensions cannot be verified/i);
  });

  test('the megapixel cap is measured from the bytes, not from the record', () => {
    const pack = accept(mythic());
    const capped = exportThemePackage(pack, bytes(), { ...THEME_PACK_LIMITS, assetPixels: 100 });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.errors.join()).toMatch(/16×16, over the 100 pixel limit/);
  });

  test('the shipped defaults are the caps the brief fixed', () => {
    expect(THEME_PACK_LIMITS.totalAssetBytes).toBe(8 * 1024 * 1024);
    expect(THEME_PACK_LIMITS.assetBytes).toBe(2 * 1024 * 1024);
    expect(THEME_PACK_LIMITS.assetPixels).toBe(16 * 1024 * 1024);
  });

  test('refuses a container that is not a v1 diomedes-theme package', () => {
    expect(importThemePackage(null).ok).toBe(false);
    expect(importThemePackage({ manifest: {}, pack: {}, assets: {} }).ok).toBe(false);
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    if (!exported.ok) throw new Error('export failed');
    const wrong = JSON.parse(JSON.stringify(exported.package));
    wrong.manifest.formatVersion = 2;
    expect(importThemePackage(wrong).ok).toBe(false);
  });

  test('refuses base64 that is not base64', () => {
    const pack = accept(mythic());
    const exported = exportThemePackage(pack, bytes());
    if (!exported.ok) throw new Error('export failed');
    const bad = JSON.parse(JSON.stringify(exported.package));
    bad.assets[plateHash] = 'not base64!!';
    expect(importThemePackage(bad).ok).toBe(false);
  });
});
