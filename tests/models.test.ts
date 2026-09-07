import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineCatalog, forgetCatalog, isKnownChoice } from '../server/models';

/**
 * The catalogue is read from the engine's own cache, so these tests write a
 * cache rather than a fixture of Diomedes's own making: what the runtime writes
 * is the contract, including the fields Diomedes must refuse to forward.
 */
let home: string;
let previous: string | undefined;

function writeCache(value: unknown) {
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(value), 'utf8');
  forgetCatalog();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-models-'));
  previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  forgetCatalog();
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous;
  forgetCatalog();
  fs.rmSync(home, { recursive: true, force: true });
});

const astra = {
  slug: 'gpt-6-astra',
  display_name: 'GPT-6-Astra',
  description: 'Our most capable model for complex, demanding work.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth' },
    { effort: 'ultra', description: 'Maximum reasoning with automatic delegation' },
  ],
  visibility: 'list',
  priority: 1,
  model_messages: { persistent_instructions: 'You are now in persistent mode.' },
};
const older = {
  slug: 'gpt-5.5',
  display_name: 'GPT-5.5',
  description: 'A fast everyday model.',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: '' },
    { effort: 'medium', description: '' },
  ],
  visibility: 'list',
  priority: 12,
};

describe('engine catalogue', () => {
  it('reads the models the engine lists, best first, with their own ladders', () => {
    writeCache({ models: [older, astra] });
    const catalog = engineCatalog('codex');
    expect(catalog.models.map((m) => m.slug)).toEqual(['gpt-6-astra', 'gpt-5.5']);
    expect(catalog.models[0]).toMatchObject({
      name: 'GPT-6-Astra',
      defaultEffort: 'medium',
    });
    expect(catalog.models[0].efforts.map((e) => e.id)).toEqual(['low', 'medium', 'ultra']);
    // The ladders differ per model, which is why the picker rederives them.
    expect(catalog.models[1].efforts.map((e) => e.id)).toEqual(['low', 'medium']);
  });

  it('never forwards the instruction text the cache carries', () => {
    writeCache({ models: [astra] });
    expect(JSON.stringify(engineCatalog('codex'))).not.toContain('persistent mode');
  });

  it('leaves out models the engine does not list', () => {
    writeCache({ models: [astra, { ...older, visibility: 'hidden' }] });
    expect(engineCatalog('codex').models.map((m) => m.slug)).toEqual(['gpt-6-astra']);
  });

  it('only offers a default the model actually supports', () => {
    writeCache({ models: [{ ...astra, default_reasoning_level: 'max' }] });
    expect(engineCatalog('codex').models[0].defaultEffort).toBe('low');
  });

  it('says so plainly when there is no cache, and when it cannot be read', () => {
    const missing = engineCatalog('codex');
    expect(missing.models).toEqual([]);
    expect(missing.detail).toMatch(/has not written its list yet/);
    fs.writeFileSync(path.join(home, 'models_cache.json'), 'not json', 'utf8');
    forgetCatalog();
    const broken = engineCatalog('codex');
    expect(broken.models).toEqual([]);
    expect(broken.detail).toMatch(/could not be read/);
  });

  it('reports the engines that have no catalogue without pretending otherwise', () => {
    expect(engineCatalog('sample').models).toEqual([]);
    expect(engineCatalog('sample').detail).toMatch(/deterministic/);
    expect(engineCatalog('claude-code').detail).toMatch(/does not report its choices/);
  });

  it('rejects a pair the engine does not offer, so a stale choice is never sent', () => {
    writeCache({ models: [astra] });
    expect(isKnownChoice('codex', 'gpt-6-astra', 'ultra')).toBe(true);
    expect(isKnownChoice('codex', 'gpt-6-astra', null)).toBe(true);
    // A level this model does not have, and a model that is not listed.
    expect(isKnownChoice('codex', 'gpt-6-astra', 'xhigh')).toBe(false);
    expect(isKnownChoice('codex', 'gpt-9', 'low')).toBe(false);
  });

  it('picks up a rewritten cache rather than serving the first read forever', () => {
    writeCache({ models: [astra] });
    expect(engineCatalog('codex').models).toHaveLength(1);
    writeCache({ models: [astra, older] });
    expect(engineCatalog('codex').models).toHaveLength(2);
  });
});
