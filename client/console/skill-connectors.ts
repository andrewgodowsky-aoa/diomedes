/**
 * Which approved read connectors cover what a playbook reads.
 *
 * A playbook already declares the data it reads: each input names one of its
 * pack's needs (`read-sales`, `read-accounting`, ...). A connector may say it
 * provides some of those same kinds. Matching the two is all this does; it
 * names only the connector's own name and the generic kind of data, never a
 * vendor, and it says what is approved, not what a turn will do with it.
 */
import type { PackSkill } from '../../shared/capability-packs';
import {
  CONNECTOR_DATA_LABELS,
  isConnectorDataKind,
  type ConnectorDataKind,
  type ReadConnectorsView,
} from '../../shared/read-connectors';

export interface SkillDataKind {
  kind: ConnectorDataKind;
  label: string;
  /** Whether any input of this kind is one the playbook cannot run without. */
  required: boolean;
}

/** The kinds of connector data a playbook reads, required ones first, in the playbook's order. */
export function skillDataKinds(skill: PackSkill): SkillDataKind[] {
  const found = new Map<ConnectorDataKind, SkillDataKind>();
  for (const input of skill.inputs) {
    if (!isConnectorDataKind(input.need)) continue;
    const prior = found.get(input.need);
    if (prior) prior.required ||= input.required;
    else found.set(input.need, { kind: input.need, label: CONNECTOR_DATA_LABELS[input.need], required: input.required });
  }
  const kinds = [...found.values()];
  return [...kinds.filter((k) => k.required), ...kinds.filter((k) => !k.required)];
}

export interface SkillConnectorMatch {
  covered: { kind: ConnectorDataKind; label: string; connectors: string[] }[];
  missing: SkillDataKind[];
}

export function skillConnectorMatch(skill: PackSkill, view: ReadConnectorsView): SkillConnectorMatch {
  const covered: SkillConnectorMatch['covered'] = [];
  const missing: SkillDataKind[] = [];
  for (const need of skillDataKinds(skill)) {
    const names = view.connectors.filter((c) => c.provides.includes(need.kind)).map((c) => c.name);
    if (names.length > 0) covered.push({ kind: need.kind, label: need.label, connectors: names });
    else missing.push(need);
  }
  return { covered, missing };
}

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

/**
 * The one line the playbook's launch shows about connectors, and whether it offers to add one.
 * Null when the playbook reads nothing a connector could provide.
 */
export function skillConnectorNote(
  skill: PackSkill,
  view: ReadConnectorsView | null,
): { text: string; offerAdd: boolean } | null {
  const kinds = skillDataKinds(skill);
  if (kinds.length === 0) return null;
  if (!view) return null;
  if (view.state === 'malformed')
    return { text: 'The read connectors file cannot be read. See Settings > Engines.', offerAdd: true };
  const { covered, missing } = skillConnectorMatch(skill, view);
  const parts: string[] = [];
  if (covered.length > 0) {
    // One entry per connector, with every kind of this playbook's data it covers.
    const byConnector = new Map<string, string[]>();
    for (const entry of covered)
      for (const name of entry.connectors) byConnector.set(name, [...(byConnector.get(name) ?? []), entry.label]);
    parts.push(
      `Approved connector${byConnector.size > 1 ? 's' : ''}: ${[...byConnector]
        .map(([name, labels]) => `${name} (${labels.join(', ')})`)
        .join('; ')}.`,
    );
  }
  if (missing.length > 0)
    parts.push(
      covered.length > 0
        ? `None reads ${list(missing.map((m) => m.label))}.`
        : `No approved connector reads ${list(missing.map((m) => m.label))}.`,
    );
  return { text: parts.join(' '), offerAdd: missing.length > 0 };
}
