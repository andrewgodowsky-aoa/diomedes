import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { FRAME_CSP } from '../client/console/artifact-frame';
import { APP_CSP, APP_CSP_DIRECTIVES, APP_CSP_TAG, appContentSecurityPolicy } from '../scripts/app-csp';

// The app document's policy (hostile review H4). The built Console is proved to
// run under it, with no violation on its main surfaces, in tests/artifacts-ui.spec.ts.

const directive = (name: string) => APP_CSP_DIRECTIVES.find((item) => item.directive === name)?.sources;

describe("the app document's policy", () => {
  it('runs only the bundle: no inline script, no eval, no plugins, no <base>', () => {
    expect(directive('script-src')).toBe("'self'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
    expect(APP_CSP).not.toMatch(/unsafe-eval|wasm-unsafe-eval|strict-dynamic/);
    expect(directive('script-src')).not.toContain('unsafe-inline');
  });

  it('reaches nothing but the local service, and no frame may be navigated anywhere', () => {
    expect(directive('default-src')).toBe("'self'");
    expect(directive('connect-src')).toBe("'self'");
    expect(directive('frame-src')).toBe("'none'");
    // No host, no scheme that leaves the machine, no wildcard.
    expect(APP_CSP).not.toMatch(/\*|https?:|wss?:|\bblob:|filesystem:/);
  });

  it('allows every source an artifact frame allows, because a srcdoc frame inherits this policy', () => {
    for (const part of FRAME_CSP.split(';')) {
      const [name, ...sources] = part.trim().split(/\s+/);
      if (name === 'default-src') continue;
      const allowed = (directive(name) ?? directive('default-src') ?? '').split(/\s+/);
      for (const source of sources) expect(allowed, `${name} ${source}`).toContain(source);
    }
  });

  it('carries only directives a <meta> can deliver, each once, each with its reason', () => {
    const names = APP_CSP_DIRECTIVES.map((item) => item.directive);
    expect(new Set(names).size).toBe(names.length);
    for (const ignoredInMeta of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) expect(names).not.toContain(ignoredInMeta);
    for (const item of APP_CSP_DIRECTIVES) expect(item.why.length, item.directive).toBeGreaterThan(10);
    expect(APP_CSP).toBe(APP_CSP_DIRECTIVES.map((item) => `${item.directive} ${item.sources}`).join('; '));
  });
});

describe('the build plugin', () => {
  it('runs at build only, so the development server is unchanged', () => {
    expect(appContentSecurityPolicy().apply).toBe('build');
    const plugins = (viteConfig as { plugins?: unknown[] }).plugins ?? [];
    expect(plugins.flat().some((plugin) => (plugin as { name?: string })?.name === 'app-content-security-policy')).toBe(true);
  });

  it('puts the policy first in the head of index.html and of no other page', () => {
    const plugin = appContentSecurityPolicy();
    const html = '<!doctype html><html><head><title>Diomedes</title></head><body></body></html>';
    expect(plugin.transformIndexHtml(html, { filename: 'F:/app/index.html' })).toEqual([APP_CSP_TAG]);
    expect(APP_CSP_TAG).toEqual({
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_CSP },
      injectTo: 'head-prepend',
    });
    expect(plugin.transformIndexHtml(html, { filename: 'F:/app/inventory.html' })).toBeUndefined();
  });
});
