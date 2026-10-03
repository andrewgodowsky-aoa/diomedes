import type { ContributionKind, ContributionRecord } from './pack-contributions.js';
import type { PackContributionKey, PackManifest } from './pack-manifest.js';

const KINDS: Record<PackContributionKey, { kind: ContributionKind; label: string }> = {
  tools: { kind: 'tool', label: 'Tool' },
  agents: { kind: 'agent', label: 'Agent profile' },
  rules: { kind: 'rule', label: 'Rule' },
  context: { kind: 'context', label: 'Context' },
  workflows: { kind: 'workflow', label: 'Workflow' },
  ui: { kind: 'ui', label: 'View' },
};

/** Display projection only. A declaration or a load receipt is never execution authority. */
export function pluginInventory(manifest: PackManifest, records: readonly ContributionRecord[]) {
  const components = (Object.keys(KINDS) as PackContributionKey[]).flatMap((key) =>
    manifest.contributions[key].map((item) => ({
      // Preserve the full identity: different packs and kinds may reuse a local id.
      key: `${manifest.id}/${KINDS[key].kind}/${item.id}`,
      id: item.id,
      kind: KINDS[key].kind,
      label:
        key === 'workflows' && 'kind' in item && item.kind === 'skill' ? 'Skill' : KINDS[key].label,
      name: 'name' in item ? item.name : 'label' in item ? item.label : item.id,
    })),
  );
  // Keep recorded versions, including an older run pin. Do not relabel them with
  // today's installed version or count an index registration as a body load.
  const recentLoads = records
    .filter((record) => record.packId === manifest.id && record.outcome === 'loaded')
    .slice(-5)
    .reverse();
  return { components, recentLoads };
}
