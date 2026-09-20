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
  // The real name: a temp folder spelled as an 8.3 short path (`RUNNER~1`) is
  // not the spelling the service resolves a file to before it asks about it.
  const made = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-final-binding-')),
  );
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

/**
 * Deny every read of one file until the returned handle releases it: a scanner
 * or a backup holding it open. The bytes are intact and this build wrote them.
 */
function denyReads(file: string) {
  let denied = true;
  const real = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
    if (denied && String(target) === file)
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync);
  return { release: () => (denied = false) };
}

describe('a binding record that could not be read this once', () => {
  it('reads it again rather than wedging every route on one denied read', () => {
    const service = root();
    const file = twoRoutes(service);
    const real = fs.readFileSync;
    // One read denied, the way a scan holds a file for a moment. A wait this
    // short is the whole cost, and it is the difference between five routes
    // working and five routes waiting for a restart.
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((target: unknown, ...rest: unknown[]) => {
      if (String(target) === file)
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readFileSync);

    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(false);
    expect(store.unreadable('claude-code')).toBe(false);
    expect(store.get('claude-code')).toMatchObject({ revision: 5, model: 'sonnet' });
  });

  it('does not cost a person the choice they made for every other route', () => {
    const service = root();
    const file = twoRoutes(service);
    const saved = fs.readFileSync(file, 'utf8');

    // Denied for the whole wait this time, so the record really is one this
    // build has not read.
    const scan = denyReads(file);
    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);
    expect(store.unreadable('claude-code')).toBe(true);

    // The scan moves on, and the person repairs one route by choosing an
    // installation for it again. That is a statement about that route and
    // about no other.
    scan.release();
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
    // The Claude Code row was never damaged; only the reading of the file failed.
    expect(now.engines['claude-code']).toBeDefined();
    expect(now.unreadable ?? []).not.toContain('claude-code');
    expect(saved).toContain('claude-key');
    // Nothing was filed away: the bytes were never known to be damaged.
    expect(fs.readdirSync(service)).toEqual(['bindings.json']);
  });

  it('refuses the save rather than replacing a record it still cannot read', () => {
    const service = root();
    const file = twoRoutes(service);
    const saved = fs.readFileSync(file, 'utf8');
    denyReads(file);
    const store = new BindingStore(service);

    // The file is still held. Its contents are unknown, so it is not a record
    // this build may move aside or write over: the choice inside it would go
    // with it.
    let refusal: unknown;
    try {
      store.save('opencode', {
        binding: binding('opencode', 'C:\\d\\opencode.exe'),
        revision: 3,
        key: 'opencode-key-2',
        model: 'opencode-go/one',
      });
      expect.unreachable('the save must be refused while the record cannot be read');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'RECORD_UNREADABLE', stage: 'runtime-verification' });
    vi.restoreAllMocks();
    expect(fs.readdirSync(service)).toEqual(['bindings.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    expect(store.unreadable('claude-code')).toBe(true);
  });

  it('clears the state on the next read that succeeds, without a restart', () => {
    const service = root();
    const file = twoRoutes(service);
    const scan = denyReads(file);
    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);
    expect(store.refresh()).toBe(false);

    scan.release();
    expect(store.refresh()).toBe(true);
    expect(store.unreadable('opencode')).toBe(false);
    expect(store.get('claude-code')).toMatchObject({ revision: 5, key: 'claude-key' });
    // A record that was read is a record with nothing to answer for: asking
    // again changes nothing.
    expect(store.refresh()).toBe(false);
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

  it('carries a row it read perfectly well out of a document with a damaged row', () => {
    // Damage inside one row is not damage to the document. The rows this build
    // did read are somebody's choices, and filing the document away must not
    // take them with it.
    const service = root();
    const file = twoRoutes(service);
    const document = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      engines: Record<string, Record<string, unknown>>;
    };
    document.engines.opencode.revision = 'later';
    fs.writeFileSync(file, JSON.stringify(document), 'utf8');

    const store = new BindingStore(service);
    expect(store.unreadable('opencode')).toBe(true);
    expect(store.get('claude-code')).toMatchObject({ revision: 5, model: 'sonnet' });

    store.save('cursor', {
      binding: binding('cursor', 'C:\\d\\cursor.js'),
      revision: 1,
      key: 'cursor-key',
      model: null,
    });
    const reopened = new BindingStore(service);
    expect(reopened.get('claude-code')).toMatchObject({ revision: 5, key: 'claude-key' });
    expect(reopened.get('cursor')).toMatchObject({ revision: 1 });
    expect(reopened.unreadable('opencode')).toBe(true);
    // The document it could not fully read is kept beside the new one.
    const kept = fs.readdirSync(service).filter((name) => name !== 'bindings.json');
    expect(kept.length).toBe(1);
    expect(kept[0].startsWith('bindings.json.unreadable-')).toBe(true);
  });
});
