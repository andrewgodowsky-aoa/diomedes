import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spendControls } from '../src/managed-inference.js';

// Workers Builds deploys the repository root's wrangler.jsonc on every merge to
// main; this package's wrangler.jsonc is the same Worker for `wrangler dev` and
// the runtime smoke. On 2026-09-26 the deployed version carried the root file's
// empty routes and no vars while this package's file named the custom domain and
// the owner's spend limits, so neither reached Cloudflare. These tests keep the
// two files in step and prove the deployed one carries the limits.

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(here, '..');
const ROOT = path.resolve(PACKAGE, '..', '..');

interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown[];
  vars?: Record<string, string>;
}

/** Whole-line `//` comments only, which is all these files use. */
function readConfig(dir: string): WranglerConfig {
  const text = readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as WranglerConfig;
}

const deployed = readConfig(ROOT);
const local = readConfig(PACKAGE);

describe('the deployed Worker configuration', () => {
  it('is the same Worker as the package configuration', () => {
    expect(deployed.name).toBe('diomedes');
    expect(local.name).toBe(deployed.name);
    expect(path.resolve(ROOT, deployed.main)).toBe(path.resolve(PACKAGE, local.main));
    expect(local.compatibility_date).toBe(deployed.compatibility_date);
    expect({ workers_dev: local.workers_dev, preview_urls: local.preview_urls }).toEqual({
      workers_dev: deployed.workers_dev,
      preview_urls: deployed.preview_urls,
    });
  });

  it('deploys the routes and vars the package configuration declares', () => {
    expect(deployed.routes).toEqual(local.routes);
    expect(deployed.vars).toEqual(local.vars);
  });

  it("carries the owner's staging spend limits, read as the gateway reads them", () => {
    const controls = spendControls(deployed.vars ?? {});
    expect(controls.ceilingMicroUsd).toBe(100_000_000);
    expect(controls.maxOutputTokens).toBe(2000);
  });
});
