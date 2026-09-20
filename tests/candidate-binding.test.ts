import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore } from '../server/engines/binding-store.js';
import type { EngineBinding } from '../shared/engines.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-binding-'));
  roots.push(made);
  return made;
}
const binding = (overrides: Partial<EngineBinding> = {}): EngineBinding => ({
  id: 'managed:opencode:C:\\d\\opencode.exe',
  engine: 'opencode',
  source: 'managed',
  path: 'C:\\d\\opencode.exe',
  version: '1.18.4',
  sha256: 'a'.repeat(64),
  boundAt: '2026-09-20T00:00:00.000Z',
  origin: 'explicit',
  ...overrides,
});

describe('the binding a person chose, remembered across restarts', () => {
  it('writes one non-secret file and reloads the binding, revision and model', () => {
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 3, key: 'k1', model: 'gpt' });
    const file = path.join(service, 'bindings.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      engines: { opencode: { revision: 3, key: 'k1', model: 'gpt' } },
    });
    // Nothing secret may reach this file: it holds identifiers and digests only.
    expect(text).not.toMatch(/token|secret|password|apiKey/i);

    const reopened = new BindingStore(service);
    expect(reopened.get('opencode')).toMatchObject({
      revision: 3,
      key: 'k1',
      model: 'gpt',
      binding: { id: binding().id, origin: 'explicit', sha256: 'a'.repeat(64) },
    });
    expect(reopened.get('claude-code')).toBeUndefined();
  });

  it('replaces the file atomically and never leaves a partial one or a phantom binding', () => {
    const service = root();
    const store = new BindingStore(service);
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    const file = path.join(service, 'bindings.json');
    const before = fs.readFileSync(file, 'utf8');
    const next = {
      binding: binding({ version: '2.0.0' }),
      revision: 2,
      key: 'k2',
      model: 'x',
    };
    // On Windows a reader holding the destination denies the rename. The
    // previous record must stay complete, and Diomedes must not remember a
    // choice that no restart would find.
    const handle = fs.openSync(file, 'r');
    try {
      expect(() => store.save('opencode', next)).toThrow(/EPERM|EACCES|EBUSY/);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(store.get('opencode')?.revision).toBe(1);
    } finally {
      fs.closeSync(handle);
    }
    store.save('opencode', next);
    expect(fs.readdirSync(service)).toEqual(['bindings.json']);
    expect(new BindingStore(service).get('opencode')).toMatchObject({
      revision: 2,
      model: 'x',
      binding: { version: '2.0.0' },
    });
  });

  it('starts empty rather than throwing when the file is unreadable or damaged', () => {
    const service = root();
    fs.writeFileSync(path.join(service, 'bindings.json'), '{ not json');
    const store = new BindingStore(service);
    expect(store.get('opencode')).toBeUndefined();
    // A damaged file is replaced by the next real save, never read as authority.
    store.save('opencode', { binding: binding(), revision: 1, key: 'k1', model: null });
    expect(new BindingStore(service).get('opencode')?.revision).toBe(1);
  });

  it('refuses a stored row that does not name the engine it is filed under', () => {
    const service = root();
    fs.writeFileSync(
      path.join(service, 'bindings.json'),
      JSON.stringify({
        version: 1,
        engines: {
          opencode: { binding: { ...binding(), engine: 'claude-code' }, revision: 9, key: 'k', model: null },
        },
      }),
    );
    expect(new BindingStore(service).get('opencode')).toBeUndefined();
  });
});
