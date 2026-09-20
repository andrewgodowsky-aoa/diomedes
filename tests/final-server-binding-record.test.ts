/**
 * Final hostile pass, server side: the binding record under two faults the
 * repair lane did not cover.
 *
 * Red here means a defect. Both cases start from a record this build wrote and
 * could read perfectly well, and ask what happens to it when the moment of
 * reading, or the moment of replacing, goes wrong once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore } from '../server/engines/binding-store.js';
import type { EngineBinding } from '../shared/engines.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-final-binding-'));
  roots.push(made);
  return made;
}
const binding = (engine: EngineBinding['engine'], file: string): EngineBinding => ({
  id: `system:${engine}:${file}`,
  engine,
  source: 'system',
  path: file,
  version: '1.0.0',
  sha256: 'b'.repeat(64),
  boundAt: '2026-09-20T00:00:00.000Z',
  origin: 'explicit',
});

/** A record this build wrote itself, holding a choice for two separate routes. */
function twoRoutes(service: string) {
  const store = new BindingStore(service);
  store.save('opencode', {
    binding: binding('opencode', 'C:\\d\\opencode.exe'),
    revision: 2,
    key: 'opencode-key',
    model: 'opencode-go/one',
  });
  store.save('claude-code', {
    binding: binding('claude-code', 'C:\\d\\claude.exe'),
    revision: 5,
    key: 'claude-key',
    model: 'sonnet',
  });
  return path.join(service, 'bindings.json');
}

describe('a binding record that could not be read this once', () => {
  it('does not cost a person the choice they made for every other route', () => {
    const service = root();
    const file = twoRoutes(service);
    const saved = fs.readFileSync(file, 'utf8');

    // One read denied: a scanner or a backup holding the file open for a
    // moment. The bytes are intact and this build wrote them.
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((target: unknown) => {
      if (String(target) === file)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return (real as (...args: unknown[]) => unknown)(target);
    }) as typeof fs.readFileSync);

    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);
    expect(store.unreadable('claude-code')).toBe(true);

    // The person repairs one route by choosing an installation for it again.
    // That is a statement about that route and about no other.
    store.save('opencode', {
      binding: binding('opencode', 'C:\\d\\opencode.exe'),
      revision: 3,
      key: 'opencode-key-2',
      model: 'opencode-go/one',
    });

    const now = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      engines: Record<string, unknown>;
      unreadable?: string[];
    };
    expect(now.engines.opencode).toBeDefined();
    // The Claude Code row was never damaged; only one read of the file failed.
    expect(now.engines['claude-code']).toBeDefined();
    expect(now.unreadable ?? []).not.toContain('claude-code');
    expect(saved).toContain('claude-key');
  });
});

describe('replacing a record that genuinely could not be read', () => {
  it('keeps the old record on disk when the replacement cannot be staged', () => {
    const service = root();
    const file = path.join(service, 'bindings.json');
    fs.mkdirSync(service, { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);

    // The disk fills, or the folder denies a new file, at the moment the
    // replacement is written. Nothing was replaced, so nothing may be gone.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    expect(() =>
      store.save('opencode', {
        binding: binding('opencode', 'C:\\d\\opencode.exe'),
        revision: 1,
        key: 'k',
        model: null,
      }),
    ).toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    // A restart now must still find a record it cannot read, and refuse the
    // route. Finding nothing at all would read as "this person never chose
    // one", which is what lets a recommendation be adopted on their behalf.
    expect(fs.existsSync(file)).toBe(true);
    expect(new BindingStore(service).unreadable('opencode')).toBe(true);
  });
});
