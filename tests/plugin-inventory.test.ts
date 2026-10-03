import { describe, expect, it } from 'vitest';
import { sealManifest } from '../server/pack-catalogue';
import type { ContributionRecord } from '../shared/pack-contributions';
import { pluginInventory } from '../shared/plugin-inventory';

const manifest = sealManifest({
  schemaVersion: 1,
  id: 'acme.accounts',
  version: '2.0.0',
  name: 'Accounts',
  publisher: { id: 'acme', name: 'Acme' },
  description: 'Account procedures.',
  compatibility: { contract: '^1.0.0' },
  contributions: {
    tools: [
      {
        id: 'close',
        name: 'Check accounts',
        description: 'Check an export.',
        effect: 'read',
        uses: [],
      },
    ],
    agents: [],
    rules: [],
    context: [],
    workflows: [
      {
        id: 'close',
        name: 'Close accounts',
        description: 'Review the month.',
        kind: 'skill',
        mode: 'plan',
        acts: false,
      },
    ],
    ui: [{ id: 'close', label: 'Account summary', surface: 'thread' }],
  },
  permissions: { requested: [], grantsAuthority: false },
  dependencies: [],
  files: [],
});

function receipt(id: string, patch: Partial<ContributionRecord> = {}): ContributionRecord {
  return {
    id,
    at: '2026-10-03T12:00:00.000Z',
    outcome: 'loaded',
    packId: manifest.id,
    packVersion: '1.0.0',
    kind: 'workflow',
    contributionId: 'close',
    name: 'Close accounts',
    digest: `sha256:${'a'.repeat(64)}`,
    reason: 'triggered',
    runKey: 'run-old-pin',
    detail: 'Loaded.',
    ...patch,
  };
}

describe('plugin inventory is a projection of declarations and receipts', () => {
  it('preserves pack and contribution kind when local ids collide', () => {
    const first = pluginInventory(manifest, []);
    const second = pluginInventory({ ...manifest, id: 'other.accounts' }, []);
    expect(new Set([...first.components, ...second.components].map((item) => item.key)).size).toBe(
      6,
    );
    expect(first.components.map((item) => [item.label, item.name])).toEqual([
      ['Tool', 'Check accounts'],
      ['Skill', 'Close accounts'],
      ['View', 'Account summary'],
    ]);
  });

  it('does not invent use from installation, indexing, refusals, or another package', () => {
    const { recentLoads } = pluginInventory(manifest, [
      receipt('index', { outcome: 'indexed' }),
      receipt('refusal', { outcome: 'refused' }),
      receipt('unload', { outcome: 'unloaded' }),
      receipt('other', { packId: 'other.accounts' }),
    ]);
    expect(recentLoads).toEqual([]);
  });

  it('retains the recorded run pin after the installed version changes', () => {
    const record = receipt('load');
    const { recentLoads } = pluginInventory(manifest, [record]);
    expect(recentLoads).toEqual([record]);
    expect(recentLoads[0].packVersion).toBe('1.0.0');
    expect(recentLoads[0].runKey).toBe('run-old-pin');
    expect(manifest.version).toBe('2.0.0');
  });

  it('bounds recent loads in journal order without changing the source records', () => {
    const records = Array.from({ length: 7 }, (_, index) => receipt(String(index)));
    const snapshot = structuredClone(records);
    expect(pluginInventory(manifest, records).recentLoads.map((record) => record.id)).toEqual([
      '6',
      '5',
      '4',
      '3',
      '2',
    ]);
    expect(records).toEqual(snapshot);
  });
});
