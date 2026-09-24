import { describe, expect, it } from 'vitest';
import {
  everythingSections,
  triggerClick,
  type EverythingItem,
} from '../client/console/Everything';

describe('Everything: a click on the trigger', () => {
  it('opens a closed panel however it was last opened', () => {
    expect(triggerClick(false, 'intent')).toBe('open');
    expect(triggerClick(false, 'pointer')).toBe('open');
  });

  // A click moves the pointer onto the trigger first. When the hover wins that
  // race the panel is already open as the click lands, and toggling it shut
  // would close the very thing the person asked for. Every browser spec that
  // opens Everything with a click depends on this.
  it('keeps a panel the pointer opened instead of toggling it shut', () => {
    expect(triggerClick(true, 'pointer')).toBe('keep');
  });

  it('closes a panel that was opened on purpose', () => {
    expect(triggerClick(true, 'intent')).toBe('close');
  });
});

describe('Everything: a reserved destination', () => {
  const items: EverythingItem[] = [
    { id: 'files', label: 'Files', hint: 'Everything in this workspace.' },
    // An invented destination: Automations held this place until Milestone A
    // built it, and the reserved behaviour itself still needs its test.
    {
      id: 'reports',
      label: 'Reports',
      hint: 'Work that is not built yet.',
      unavailableReason: 'Nothing is built behind this yet.',
      reserved: true,
    },
    {
      id: 'connections',
      label: 'Connections',
      hint: 'The software the business already runs on.',
      unavailableReason: 'It runs against example data only.',
    },
  ];

  // Holding a place in the sidebar changes where a destination may be pinned.
  // It must not change how the flyout reads: not ready is still not ready.
  it('still collects with the other destinations that cannot open yet', () => {
    const sections = everythingSections(items);
    expect(sections.map((section) => section.heading)).toEqual(['', 'Not ready yet']);
    expect(sections[1].items.map((item) => item.id)).toEqual(['reports', 'connections']);
  });

  it('stays where the caller put it when the caller supplies groups', () => {
    const sections = everythingSections(items, [
      { heading: 'In this workspace', ids: ['files'] },
      { heading: 'Not ready yet', ids: ['reports', 'connections'] },
    ]);
    expect(sections.map((section) => section.items.map((item) => item.id))).toEqual([
      ['files'],
      ['reports', 'connections'],
    ]);
  });
});
