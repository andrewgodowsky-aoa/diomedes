import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaults } from '../server/store';
import { WorkStylePicker, type WorkStyleView } from '../client/console/WorkStylePicker';
import { tierEntries } from '../client/console/ask-row';
import { EXPERT_NOT_INCLUDED } from '../shared/access';

describe('Expert selection and access', () => {
  it.each([false, true])('the composer uses the host access decision: %s', available => {
    expect(tierEntries(null, null, false, false, available).find(e => e.id === 'expert')).toMatchObject({ name: 'Expert', bars: 4, disabled: !available });
  });
  it.each([false, true])('the style picker uses the host access decision: %s', available => {
    const view: WorkStyleView = { route: 'nectovia', style: 'efficient', source: 'thread', resolution: null,
      expert: { available, reason: available ? null : EXPERT_NOT_INCLUDED } };
    const html = renderToStaticMarkup(createElement(WorkStylePicker, {
      thread: { id: 'expert-fixture', attachedTo: { kind: 'project', ref: 'fixture' }, name: 'Expert', mode: 'ask', turns: [], requested: null },
      settings: defaults(), live: false, busy: false, view, onStyle: () => {}, initialOpen: true,
    }));
    expect(html).toContain('Expert');
    if (!available) expect(html).toContain(EXPERT_NOT_INCLUDED);
    expect(html).toMatch(available ? /<button[^>]*>[^]*?Expert/ : /<button[^>]*disabled=""[^>]*>[^]*?Expert/);
  });
});
