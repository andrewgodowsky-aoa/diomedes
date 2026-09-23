import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Reversibility of the Nectovia layer (contract A2): everything in
// client/console/nectovia.css is anchored to the scheme, so choosing any
// other scheme takes all of it away at once. Read as text, comments removed.

const css = readFileSync('client/console/nectovia.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a selector list on its top-level commas (never inside :is(), :not() ...). */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Every style rule outside @keyframes: its selectors and its declarations. */
function rules(): { selectors: string[]; body: string }[] {
  const withoutKeyframes = css.replace(/@keyframes [a-z-]+ \{[\s\S]*?\n\}/g, '');
  return [...withoutKeyframes.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ prelude: m[1].trim(), body: m[2] }))
    .filter((r) => !r.prelude.startsWith('@'))
    .map((r) => ({ selectors: splitList(r.prelude.replace(/^.*@[^{]*\{/s, '')), body: r.body }));
}

const ANCHORS = [
  ":is(html, .dc-stage)[data-package='nectovia']",
  ":is(html[data-package='nectovia'] .console, .dc-stage[data-package='nectovia'])",
];

/** Unanchored rules, each with why it is allowed: every one only takes something away. */
const REMOVE_ONLY = new Map<string, string>([
  ['.console.diomedes .nv-art', 'keeps the art out of the frame a scheme change takes to reach React'],
  ["html[data-motion='reduced'] .console.diomedes .nv-band", 'stillness: no signature band is ever drawn'],
  ["html[data-motion-preset='none'] .console.diomedes .nv-band", 'stillness: no signature band is ever drawn'],
  ['.console.diomedes .nv-band', 'stillness (inside the reduced-motion media query)'],
]);

describe('the Nectovia layer is reversible', () => {
  const all = rules();

  it('anchors every rule on the scheme, apart from rules that only hide something', () => {
    expect(all.length).toBeGreaterThan(100);
    const loose = all.flatMap((rule) =>
      rule.selectors
        .filter((selector) => !ANCHORS.some((anchor) => selector.startsWith(anchor)))
        .map((selector) => ({ selector, body: rule.body.replace(/\s+/g, ' ').trim() })),
    );
    expect(loose.map((l) => l.selector).filter((s) => !REMOVE_ONLY.has(s))).toEqual([]);
    for (const { selector, body } of loose) expect(body, selector).toBe('display: none;');
    // A stale allowance fails too.
    expect([...REMOVE_ONLY.keys()].filter((s) => !loose.some((l) => l.selector === s))).toEqual([]);
  });

  it('never lends the preview-drawn devices to a Design Center stage that previews another scheme', () => {
    const EXCLUDE = ":not(.dc-stage:not([data-package='nectovia']) *)";
    const stageDrawn = all
      .flatMap((rule) => rule.selectors)
      .filter(
        (selector) =>
          /\.mark\b|\.button\.(primary|signal)|\.rail-head|\.tick\b|button\.on/.test(selector) ||
          (/\.spine\b/.test(selector) && !/\.gp\b|\.seam\b/.test(selector)),
      );
    expect(stageDrawn.length).toBeGreaterThanOrEqual(12);
    expect(stageDrawn.filter((selector) => !selector.includes(EXCLUDE))).toEqual([]);
    // ...and the rail's rules use the stage-aware anchor, so a Nectovia stage
    // inside another scheme's app still wears them.
    for (const selector of stageDrawn.filter((s) => /\.spine|\.rail-head/.test(s)))
      expect(selector.startsWith(ANCHORS[1]), selector).toBe(true);
  });

  it('keeps the plate host defaults weightless, so every host’s own values win', () => {
    // The defaults block sets --nv-cut and friends for every host; a host's own
    // rule (the composer's 16 px cut, the need's amber) must never lose to it.
    const defaults = all.find((rule) => /--nv-cut: var\(--plate-cut\)/.test(rule.body));
    expect(defaults?.selectors.every((s) => s.includes(':where('))).toBe(true);
    expect(css).toMatch(/\.console \.composer \{\s*--nv-cut: 16px;/);
    expect(css).toMatch(/\.console \.need \{\s*--nv-cut: 14px;\s*--nv-fill: color-mix\(in oklab, var\(--attn\)/);
  });
});
