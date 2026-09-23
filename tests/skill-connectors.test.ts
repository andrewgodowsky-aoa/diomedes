import { describe, expect, test } from 'vitest';
import { findSkill, SMALL_BUSINESS_PACK } from '../shared/capability-packs';
import type { ReadConnectorsView, ReadConnectorView } from '../shared/read-connectors';
import { skillConnectorMatch, skillConnectorNote, skillDataKinds } from '../client/console/skill-connectors';

const skill = (id: string) => {
  const found = findSkill(SMALL_BUSINESS_PACK.id, id);
  if (!found) throw new Error(`No skill ${id}`);
  return found;
};
const connector = (name: string, provides: ReadConnectorView['provides']): ReadConnectorView => ({
  name,
  command: `${name}.exe`,
  args: [],
  envFrom: [],
  missingEnv: [],
  readTools: ['read'],
  provides,
  note: null,
});
const view = (connectors: ReadConnectorView[], state: ReadConnectorsView['state'] = 'ok'): ReadConnectorsView => ({
  state,
  problem: null,
  connectors,
  ignored: [],
});

describe('which approved connectors cover what a playbook reads', () => {
  test('a playbook reads the kinds its inputs declare, required ones first', () => {
    expect(skillDataKinds(skill('business-pulse'))).toEqual([
      { kind: 'read-sales', label: 'sales', required: true },
      { kind: 'read-payroll', label: 'timesheets and payroll', required: false },
      { kind: 'read-bank', label: 'bank balances and transactions', required: false },
      { kind: 'read-reviews', label: 'customer reviews', required: false },
    ]);
  });

  test('every playbook reads at least one kind a connector could provide, or none is claimed', () => {
    for (const entry of SMALL_BUSINESS_PACK.skills) {
      const kinds = skillDataKinds(entry);
      const note = skillConnectorNote(entry, view([]));
      if (kinds.length === 0) expect(note).toBeNull();
      else expect(note).toEqual({ text: expect.stringMatching(/^No approved connector reads /), offerAdd: true });
    }
  });

  test('a matching connector is named, with the generic kind of data, and nothing else is claimed', () => {
    const pulse = skill('business-pulse');
    const approved = view([connector('till', ['read-sales', 'read-inventory']), connector('books', ['read-accounting'])]);
    expect(skillConnectorMatch(pulse, approved).covered).toEqual([
      { kind: 'read-sales', label: 'sales', connectors: ['till'] },
    ]);
    expect(skillConnectorNote(pulse, approved)).toEqual({
      text: 'Approved connector: till (sales). None reads timesheets and payroll, bank balances and transactions or customer reviews.',
      offerAdd: true,
    });
  });

  test('when every kind is covered there is nothing to add', () => {
    const pulse = skill('business-pulse');
    const all = view([
      connector('till', ['read-sales', 'read-reviews']),
      connector('bank', ['read-bank', 'read-payroll']),
    ]);
    expect(skillConnectorNote(pulse, all)).toEqual({
      text: 'Approved connectors: till (sales, customer reviews); bank (timesheets and payroll, bank balances and transactions).',
      offerAdd: false,
    });
  });

  test('an unreadable connectors file is said, and an unread one says nothing', () => {
    expect(skillConnectorNote(skill('business-pulse'), view([], 'malformed'))).toEqual({
      text: 'The read connectors file cannot be read. See Settings > Engines.',
      offerAdd: true,
    });
    expect(skillConnectorNote(skill('business-pulse'), null)).toBeNull();
  });
});
