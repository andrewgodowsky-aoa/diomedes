import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spendControls } from '../src/managed-inference.js';
import { approvedConnections } from '../src/managed-bindings.js';
import * as worker from '../src/worker.js';

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
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
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

  // The gateway reads MANAGED_CONNECTIONS on every managed call and refuses all of them when it
  // does not parse, so the deployed value is checked the way the gateway reads it.
  it('carries the approved provider connections, read as the gateway reads them', () => {
    const connections = approvedConnections(deployed.vars ?? {});
    expect(connections.map(c => [c.id, c.provider, c.secretRef])).toEqual([
      ['azure-foundry-dev', 'azure-openai', 'AZURE_OPENAI_API_KEY'],
      ['aws-bedrock-us-east-1', 'aws-bedrock', 'BEDROCK_API_KEY'],
      ['openrouter', 'openrouter', 'OPENROUTER_API_KEY'],
      ['vertex-diomedes-dev', 'google-vertex', 'VERTEX_API_KEY'],
    ]);
    expect(connections.find(c => c.provider === 'azure-openai')).toMatchObject({
      resource: 'diomedes-foundry-dev-rg', host: 'services.ai.azure.com', deployments: ['gpt-6.1-sol', 'gpt-6-luna', 'claude-opus-5-5'],
    });
    expect(connections.find(c => c.provider === 'aws-bedrock')).toMatchObject({
      region: 'us-east-1', endpointFamily: 'runtime', allowedProfiles: ['us.moonshotai.kimi-k3'],
      modelProtocols: { 'us.moonshotai.kimi-k3': ['chat-completions'] },
    });
    expect(connections.find(c => c.provider === 'google-vertex')).toMatchObject({ project: 'diomedes-dev', location: 'global', publisher: 'google' });
    expect(connections.every(c => c.revision === 1 && c.payer === 'company' && c.enabled)).toBe(true);
  });

  // Every main merge deploys the root file. A binding or migration naming a class the Worker
  // does not export fails that deploy, so the class, the binding and the migration move together.
  it('binds the phone relay hub in both files, to a SQLite-backed class the Worker exports', () => {
    expect(deployed.durable_objects).toEqual(local.durable_objects);
    expect(deployed.migrations).toEqual(local.migrations);
    expect(deployed.durable_objects?.bindings).toEqual([{ name: 'RELAY_HUB', class_name: 'RelayHub' }]);
    expect(deployed.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['RelayHub'] }]);
    expect(typeof worker.RelayHub).toBe('function');
    for (const binding of deployed.durable_objects?.bindings ?? [])
      expect(typeof (worker as unknown as Record<string, unknown>)[binding.class_name]).toBe('function');
  });
});
