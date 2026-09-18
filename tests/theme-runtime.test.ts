/**
 * The one place a ThemePack reaches the DOM.
 *
 * These tests run against a stub root rather than a browser, because what is
 * being checked is not how a value looks — that is `tests/design-studio-ui.spec.ts`
 * — but what the runtime is willing to write at all, and whether it takes back
 * exactly what it wrote. The safety claim is that a value carrying CSS syntax
 * never reaches `setProperty`, and it is worth asserting without a renderer in
 * the way.
 */
import { expect, test } from 'vitest';
import {
  applyResolvedAppearance,
  clearResolvedAppearance,
  isSafeDataset,
  isSafeProperty,
} from '../client/console/theme-runtime.js';
import { resolveAppearance } from '../shared/theme-pack/resolve.js';

/** Just enough of an HTMLElement for the runtime, and nothing it could hide in. */
function stubRoot() {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  return {
    properties,
    dataset,
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
  } as unknown as HTMLElement & { properties: Map<string, string>; dataset: Record<string, string> };
}

test('a value carrying CSS syntax is refused, never written', () => {
  expect(isSafeProperty('--surface', '#101014')).toBe(true);
  expect(isSafeProperty('--dm-font-ui', "'Schibsted Grotesk', system-ui, sans-serif")).toBe(true);
  expect(isSafeProperty('--dm-t-view', '160ms')).toBe(true);
  for (const value of [
    'red; background: url(http://example.test/x.png)',
    'url(evil.png)',
    'URL(evil.png)',
    // Every other way a value can reach outside the document. A blocklist of
    // `url(` alone lets each of these through, which is why this is a list of
    // the functions that are allowed and not of the ones that are not.
    'image-set("//host/x.png" 1x)',
    '-webkit-image-set("//host/x.png" 1x)',
    'src("//host/x.woff2")',
    'element(#x)',
    '} html { display: none } :root {',
    'expression(alert(1))',
    'javascript:alert(1)',
    'red\\3b background:red',
    'red\nbackground: red',
  ])
    expect(isSafeProperty('--surface', value), value).toBe(false);
  // The functions a token legitimately needs still pass.
  for (const value of [
    'cubic-bezier(0.2, 0, 0, 1)',
    'var(--light)',
    'rgba(255, 255, 255, 0.07)',
    'clamp(1rem, 2vw, 2rem)',
    'calc(100% - 8px)',
  ])
    expect(isSafeProperty('--dm-ease', value), value).toBe(true);
  expect(isSafeProperty('--x;background', 'red')).toBe(false);
  expect(isSafeProperty('color', 'red')).toBe(false);

  expect(isSafeDataset('themePack', 'midnight-quiet')).toBe(true);
  expect(isSafeDataset('themePack', 'quiet" onload="x')).toBe(false);
  expect(isSafeDataset('on-click', 'x')).toBe(false);
});

test('the whole resolved default appearance is safe to write', () => {
  const root = stubRoot();
  const { refused } = applyResolvedAppearance(
    resolveAppearance({ accessibility: { focusVisible: true, minimumContrast: 4.5 } }),
    root,
  );
  expect(refused).toEqual([]);
  expect(root.properties.get('--surface')).toMatch(/^#[0-9a-f]{6,8}$/);
  expect(root.dataset.package).toBe('field');
  clearResolvedAppearance(root);
});

test('applying is idempotent, and clearing removes exactly what was written', () => {
  const root = stubRoot();
  root.dataset.surface = 'console';
  const resolved = resolveAppearance({});
  applyResolvedAppearance(resolved, root);
  const first = new Map(root.properties);
  applyResolvedAppearance(resolved, root);
  expect([...root.properties.entries()]).toEqual([...first.entries()]);

  clearResolvedAppearance(root);
  expect(root.properties.size).toBe(0);
  // Someone else's dataset value on the same root is left alone.
  expect(root.dataset.surface).toBe('console');
  expect(root.dataset.package).toBe(undefined);
});

test('an unsafe value is dropped while the rest of the appearance still applies', () => {
  const root = stubRoot();
  const { refused } = applyResolvedAppearance(
    {
      vars: { '--surface': '#101014', '--attn': 'red; background: url(x)' },
      dataset: { package: 'graphite', themePack: 'bad value' },
      origins: {},
    },
    root,
  );
  expect(refused.sort()).toEqual(['--attn', 'data-themePack']);
  expect(root.properties.get('--surface')).toBe('#101014');
  expect(root.properties.has('--attn')).toBe(false);
  expect(root.dataset.package).toBe('graphite');
  expect(root.dataset.themePack).toBe(undefined);
  clearResolvedAppearance(root);
});
