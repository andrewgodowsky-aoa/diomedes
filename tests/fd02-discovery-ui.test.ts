import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Discovery } from '../client/console/Discovery.js';
import type { ProspectDiscoveryRecord } from '../shared/discovery.js';

const record: ProspectDiscoveryRecord = {
  v: 1,
  id: 'prospect-record-1',
  prospectId: 'prospect-1',
  operatorId: 'developer-context-must-not-render',
  prospectName: 'Juniper Coffee',
  stage: 'discovery',
  personalizationLevel: 'account',
  goalFactIds: ['fact-goal'],
  currentProcess: [
    {
      id: 'step-1',
      sequence: 1,
      actionFactId: 'fact-action',
      actorFactId: 'fact-actor',
      inputFactIds: [],
      outputFactIds: [],
      handoffFactIds: [],
      timingFactId: null,
      painPointFactIds: ['fact-pain'],
    },
  ],
  facts: [
    {
      id: 'fact-goal',
      field: 'goals.0',
      label: 'Goal',
      value: 'Save owner review time.',
      provenance: { class: 'reported', reportedBy: 'owner' },
      origin: 'facilitated-conversation',
      recordedAt: '2026-09-19T12:00:00.000Z',
      recordedBy: 'consultant-a',
      replacesFactId: null,
    },
    {
      id: 'fact-action',
      field: 'currentProcess.0.action',
      label: 'Action',
      value: 'Build the weekly note.',
      provenance: { class: 'reported', reportedBy: 'consultant' },
      origin: 'facilitated-conversation',
      recordedAt: '2026-09-19T12:00:00.000Z',
      recordedBy: 'consultant-a',
      replacesFactId: null,
    },
    {
      id: 'fact-actor',
      field: 'currentProcess.0.actor',
      label: 'Actor',
      value: 'Shift manager',
      provenance: { class: 'reported', reportedBy: 'consultant' },
      origin: 'facilitated-conversation',
      recordedAt: '2026-09-19T12:00:00.000Z',
      recordedBy: 'consultant-a',
      replacesFactId: null,
    },
    {
      id: 'fact-pain',
      field: 'currentProcess.0.painPoints.0',
      label: 'Pain point',
      value: 'Manual collation.',
      provenance: { class: 'hypothesized', sourceFactIds: [] },
      origin: 'facilitated-conversation',
      recordedAt: '2026-09-19T12:00:00.000Z',
      recordedBy: 'consultant-a',
      replacesFactId: null,
    },
    {
      id: 'fact-hypothesis',
      field: 'demoHypothesis',
      label: 'Demo hypothesis',
      value: 'A weekly brief may help.',
      provenance: { class: 'hypothesized', sourceFactIds: ['fact-pain'] },
      origin: 'facilitated-conversation',
      recordedAt: '2026-09-19T12:00:00.000Z',
      recordedBy: 'consultant-a',
      replacesFactId: null,
    },
  ],
  hypothesisFactId: 'fact-hypothesis',
  hypothesisWorkflowFamily: 'weekly-brief',
  hypothesisOutcomes: [
    {
      outcome: 'unknown',
      checkedAt: '2026-09-19T12:00:00.000Z',
      recordedAt: '2026-09-19T12:00:00.000Z',
    },
  ],
  events: [],
  exports: [
    {
      id: 'export-1',
      path: 'Discovery/Juniper Coffee.md',
      createdAt: '2026-09-19T12:00:00.000Z',
      routeLabel: 'no-file discovery',
    },
  ],
  createdAt: '2026-09-19T12:00:00.000Z',
  updatedAt: '2026-09-19T12:00:00.000Z',
};

describe('owner-facing Discovery view', () => {
  test('shows the active prospect process and provenance without developer context', () => {
    const html = renderToStaticMarkup(createElement(Discovery, { record }));

    expect(html).toContain('Juniper Coffee');
    expect(html).toContain('Build the weekly note.');
    expect(html).toContain('Reported');
    expect(html).toContain('A weekly brief may help.');
    expect(html).toContain('Discovery/Juniper Coffee.md');
    expect(html).not.toContain('developer-context-must-not-render');
    expect(html).not.toContain('prospect-record-1');
    expect(html).not.toContain('prospect-1');
  });

  test('renders only the supplied active record and has a clear empty state', () => {
    const active = renderToStaticMarkup(createElement(Discovery, { record }));
    const empty = renderToStaticMarkup(createElement(Discovery, { record: null }));

    expect(active).not.toContain('Riverstone Cabinets');
    expect(empty).toContain('Select a prospect to open their discovery record.');
    expect(empty).not.toContain('Juniper Coffee');
  });
});
