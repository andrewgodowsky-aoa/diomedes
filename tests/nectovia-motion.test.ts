import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NV_EASE,
  SEAM_DRAW_MS,
  VIEW_SHEAR_MS,
  drawHeaderSeam,
} from '../client/console/nectovia-motion';

// Nectovia's transitions (contract §4, brief CP6). The CSS is read as text and
// held to the contract's rules; the one scripted transition, the header seam
// redrawn on a view change, is driven against a stand-in page because it is a
// Web Animation, which the global reduced-motion CSS rule cannot reach.

// Comments out, so a note inside a rule is never read as a declaration.
const css = readFileSync('client/console/nectovia.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Page {
  package?: string;
  motion?: string;
  motionPreset?: string;
  intensity?: string;
  reducedQuery?: boolean;
}

function stagePage(page: Page) {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  const strip = { animate };
  const root = { querySelector: (selector: string) => (selector === '.top' ? strip : null) };
  vi.stubGlobal('document', {
    documentElement: {
      dataset: {
        package: page.package,
        motion: page.motion,
        motionPreset: page.motionPreset,
      },
    },
    querySelector: root.querySelector,
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--dm-motion-intensity' ? (page.intensity ?? '') : ''),
  }));
  vi.stubGlobal('matchMedia', () => ({ matches: page.reducedQuery ?? false }));
  return { animate, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the header seam, redrawn on a view change', () => {
  it('draws the strip rule’s mark left to right after the shear, as a Web Animation', () => {
    const { animate, root } = stagePage({ package: 'nectovia' });
    expect(drawHeaderSeam(root as unknown as ParentNode)).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      pseudoElement: '::after',
      duration: SEAM_DRAW_MS,
      delay: VIEW_SHEAR_MS,
      easing: NV_EASE,
      fill: 'backwards',
    });
    expect([VIEW_SHEAR_MS, SEAM_DRAW_MS]).toEqual([160, 260]);
  });

  it('never runs outside Nectovia or when stillness is asked for in any form', () => {
    for (const page of [
      { package: 'field' },
      { package: 'nectovia', motion: 'reduced' },
      { package: 'nectovia', reducedQuery: true },
      { package: 'nectovia', motionPreset: 'none' },
      { package: 'nectovia', intensity: '0' },
    ]) {
      const { animate, root } = stagePage(page);
      expect(drawHeaderSeam(root as unknown as ParentNode), JSON.stringify(page)).toBeNull();
      expect(animate).not.toHaveBeenCalled();
    }
  });

  it('cancels a seam still drawing, and never throws into a view change', () => {
    const { animate, root } = stagePage({ package: 'nectovia' });
    const first = drawHeaderSeam(root as unknown as ParentNode) as unknown as { cancel: ReturnType<typeof vi.fn> };
    drawHeaderSeam(root as unknown as ParentNode);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
    animate.mockImplementation(() => {
      throw new Error('no pseudo-element animation here');
    });
    expect(drawHeaderSeam(root as unknown as ParentNode)).toBeNull();
    vi.unstubAllGlobals();
    // No document at all (a test or a server render): nothing, quietly.
    expect(drawHeaderSeam()).toBeNull();
  });
});

describe('the scheme’s motion in nectovia.css', () => {
  const keyframes = [...css.matchAll(/@keyframes ([a-z-]+) \{([\s\S]*?)\n\}/g)].map((m) => ({
    name: m[1],
    body: m[2],
  }));

  it('moves only transforms, opacity and clip-path, apart from the contract’s brightness snap', () => {
    expect(keyframes.length).toBeGreaterThanOrEqual(12);
    for (const { name, body } of keyframes) {
      const allowed = name === 'nv-seg-snap' ? ['filter'] : ['transform', 'opacity', 'clip-path'];
      const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(properties.filter((p) => !allowed.includes(p)), name).toEqual([]);
    }
  });

  it('gives every clip-path it animates an inset at both ends, so it interpolates instead of popping', () => {
    const clipped = keyframes.filter((k) => k.body.includes('clip-path'));
    expect(clipped.map((k) => k.name).sort()).toEqual(['nv-lit-in', 'nv-seam-in']);
    for (const { name, body } of clipped) {
      const frames = [...body.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
        at: m[1].split(',').map((s) => s.trim()),
        clip: /clip-path:\s*inset\(/.test(m[2]),
      }));
      const start = frames.find((f) => f.at.some((s) => s === 'from' || s === '0%'));
      const end = frames.find((f) => f.at.some((s) => s === 'to' || s === '100%'));
      expect(start?.clip, `${name} start`).toBe(true);
      expect(end?.clip, `${name} end`).toBe(true);
    }
  });

  it('stops every animation and transition when motion intensity is 0', () => {
    const declarations = [...css.matchAll(/\b(animation|transition):\s*([^;]+);/g)].map((m) => ({
      property: m[1],
      value: m[2].replace(/\s+/g, ' ').trim(),
    }));
    const moving = declarations.filter((d) => d.value !== 'none');
    expect(moving.length).toBeGreaterThan(10);
    expect(moving.filter((d) => !d.value.includes('var(--nv-on)'))).toEqual([]);
    // --nv-on is 0 at intensity 0 and under every stillness setting.
    expect(css).toContain('--nv-on: min(1, calc(var(--dm-motion-intensity, 0.5) * 1000));');
    expect(css).toMatch(
      /\[data-package='nectovia'\]:is\(\[data-motion='reduced'\], \[data-motion-preset='none'\]\) \{\s*--nv-on: 0;/,
    );
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:is\(html, \.dc-stage\)\[data-package='nectovia'\] \{\s*--nv-on: 0;/);
  });

  it('keeps the view change inside the contract: 160 ms, 6 to 14 px, seam 260 ms, lit edge 60 ms last', () => {
    const ms = (name: string) => Number(css.match(new RegExp(`${name}: (\\d+)ms;`))?.[1]);
    expect(ms('--nv-view')).toBe(VIEW_SHEAR_MS);
    expect(ms('--nv-seam-draw')).toBe(SEAM_DRAW_MS);
    expect(ms('--nv-lit-after')).toBe(60);
    expect(ms('--nv-snap')).toBe(120);
    const shear = keyframes.find((k) => k.name === 'nv-view-in')!.body;
    const offsets = [...shear.matchAll(/translateX\((-?\d+)px\)/g)].map((m) => Math.abs(Number(m[1])));
    const steps = offsets.filter((px) => px >= 6);
    expect(steps).toHaveLength(3);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(14);
    // The lit edge waits for its plate to settle, and then 60 ms more.
    expect(css).toContain('calc((var(--nv-plate) + var(--nv-lit-after)) * var(--nv-on)) backwards');
  });

  it('leaves no transform behind on the screen or a needs-you plate', () => {
    for (const name of ['nv-view-in', 'nv-need-in', 'nv-view-ghost']) {
      const uses = [...css.matchAll(new RegExp(`animation: ${name} ([^;]+);`, 'g'))].map((m) => m[1]);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) expect(use, name).not.toMatch(/\b(forwards|both)\b/);
    }
  });
});

// C49 (CD-05): reduced motion across the whole Console, not only the scheme.
// The browser spec (tests/cd05-zoom-motion.spec.ts) reads computed styles on a
// running page; these hold the source to the two rules that make that true.
describe('reduced motion reaches everything the Console moves', () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const files = walk('client');
  const styles = strip(readFileSync('client/styles.css', 'utf8'));

  it('stops every animation and transition under the OS query and under the app’s own Reduced setting', () => {
    const everything = /\*,\s*\*::before,\s*\*::after\s*\{\s*animation: none !important;\s*transition: none !important;/;
    const query = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(query).toMatch(everything);
    expect(styles).toMatch(
      /html\[data-motion='reduced'\] \*,\s*html\[data-motion='reduced'\] \*::before,\s*html\[data-motion='reduced'\] \*::after\s*\{\s*animation: none !important;\s*transition: none !important;/,
    );
  });

  it('lets no other rule outrank that with an !important animation or transition', () => {
    const offenders = files
      .filter((file) => file.endsWith('.css') && !file.endsWith(join('client', 'styles.css')))
      .flatMap((file) =>
        [...strip(readFileSync(file, 'utf8')).matchAll(/\b(animation|transition)[a-z-]*\s*:[^;{}]*!important/g)].map(
          (m) => `${file}: ${m[0]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('guards every Web Animation, which no stylesheet can reach, with a stillness check', () => {
    const scripted = files.filter(
      (file) => /\.(ts|tsx)$/.test(file) && /\.animate\(/.test(readFileSync(file, 'utf8')),
    );
    expect(scripted.length).toBeGreaterThanOrEqual(4);
    for (const file of scripted) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/\b(reducedMotion|motionReduced|motionAllowed)\(/);
    }
  });
});
