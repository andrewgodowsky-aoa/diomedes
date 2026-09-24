/**
 * Automations Milestone A, slice A1: the label is a pure projection of facts.
 *
 * Table-driven on purpose: every row is a set of recorded facts and the one
 * label they must read as. Nothing here has a clock, so "Running" can never be
 * inferred from elapsed time, and nothing here can make a missing source read
 * as a clean result.
 */
import { describe, expect, test } from 'vitest';
import {
  AUTOMATION_LABEL_TEXT,
  automationLabel,
  automationSummary,
  briefAutomationId,
  byAttention,
  occurrenceResult,
  type AutomationFacts,
  type AutomationLabel,
  type AutomationResult,
  type OccurrenceFacts,
  type RunFacts,
  type ScheduleFacts,
} from '../shared/automations.js';

const ready = { state: 'ready' } as const;
const noBinding = {
  state: 'incomplete',
  code: 'no_output_project',
  message: 'Choose the project Fernbrook Joinery writes into.',
} as const;

const run = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  state: 'completed',
  waitingApproval: false,
  uncertain: false,
  waitingForData: false,
  missing: [],
  written: { entryId: 'E1', path: 'Briefs/weekly.md' },
  change: 'waiting',
  ...overrides,
});
const admitted = (facts: Partial<RunFacts> | null = {}): OccurrenceFacts => ({
  admission: 'admitted',
  refusalCode: null,
  run: facts === null ? null : run(facts),
});
const sched = (overrides: Partial<ScheduleFacts> = {}): ScheduleFacts => ({
  state: 'enabled',
  host: 'available',
  here: true,
  blocked: null,
  ...overrides,
});
const refused = (code: string): OccurrenceFacts => ({
  admission: 'refused',
  refusalCode: code,
  run: null,
});

const cases: [string, AutomationFacts, AutomationLabel][] = [
  ['never pressed, set up', { trigger: 'manual', setup: ready, latest: null }, 'manual'],
  ['never pressed, no output project', { trigger: 'manual', setup: noBinding, latest: null }, 'setup-incomplete'],
  ['queued run', { trigger: 'manual', setup: ready, latest: admitted({ state: 'queued', written: null, change: null }) }, 'running'],
  ['running run', { trigger: 'manual', setup: ready, latest: admitted({ state: 'running', written: null, change: null }) }, 'running'],
  ['running run outranks a setup that changed since', { trigger: 'manual', setup: noBinding, latest: admitted({ state: 'running', written: null, change: null }) }, 'running'],
  ['waiting on an exact approval', { trigger: 'manual', setup: ready, latest: admitted({ state: 'waiting', waitingApproval: true, written: null, change: null }) }, 'needs-approval'],
  ['waiting on something else', { trigger: 'manual', setup: ready, latest: admitted({ state: 'waiting', written: null, change: null }) }, 'needs-investigation'],
  ['missing sources stopped the run', { trigger: 'manual', setup: ready, latest: admitted({ state: 'failed', waitingForData: true, missing: ['exports/north.csv'], written: null, change: null }) }, 'waiting-for-data'],
  ['missing sources, and now setup is incomplete too', { trigger: 'manual', setup: noBinding, latest: admitted({ state: 'failed', waitingForData: true, missing: ['a.csv'], written: null, change: null }) }, 'setup-incomplete'],
  ['failed for another reason', { trigger: 'manual', setup: ready, latest: admitted({ state: 'failed', written: null, change: null }) }, 'needs-investigation'],
  ['reconciliation required', { trigger: 'manual', setup: ready, latest: admitted({ state: 'reconcile_required', uncertain: true, written: null, change: null }) }, 'needs-investigation'],
  ['cancelled with an uncertain step', { trigger: 'manual', setup: ready, latest: admitted({ state: 'cancelled', uncertain: true, written: null, change: null }) }, 'needs-investigation'],
  ['cancelled cleanly rests as manual', { trigger: 'manual', setup: ready, latest: admitted({ state: 'cancelled', written: null, change: null }) }, 'manual'],
  ['completed rests as manual', { trigger: 'manual', setup: ready, latest: admitted() }, 'manual'],
  ['admitted but the run record is unreadable', { trigger: 'manual', setup: ready, latest: admitted(null) }, 'needs-investigation'],
  ['left admitting', { trigger: 'manual', setup: ready, latest: { admission: 'admitting', refusalCode: null, run: null } }, 'needs-investigation'],
  ['interrupted before start after recovery', { trigger: 'manual', setup: ready, latest: refused('interrupted_before_start') }, 'needs-investigation'],
  ['refused because the project was busy', { trigger: 'manual', setup: ready, latest: refused('project_busy') }, 'manual'],
  ['refused for setup, setup still incomplete', { trigger: 'manual', setup: noBinding, latest: refused('no_output_project') }, 'setup-incomplete'],
  // Milestone B: the schedule's own facts, read only after the run and setup facts.
  ['schedule off reads as manual', { trigger: 'manual', setup: ready, latest: admitted(), schedule: sched({ state: 'off' }) }, 'manual'],
  ['enabled on an available computer', { trigger: 'schedule', setup: ready, latest: null, schedule: sched() }, 'scheduled'],
  ['enabled, completed last run', { trigger: 'schedule', setup: ready, latest: admitted(), schedule: sched() }, 'scheduled'],
  ['enabled, heartbeat stale', { trigger: 'schedule', setup: ready, latest: null, schedule: sched({ host: 'unknown' }) }, 'waiting-for-computer'],
  ['enabled for another computer', { trigger: 'schedule', setup: ready, latest: null, schedule: sched({ here: false }) }, 'waiting-for-computer'],
  ['paused', { trigger: 'schedule', setup: ready, latest: admitted(), schedule: sched({ state: 'paused' }) }, 'paused'],
  ['running outranks scheduled', { trigger: 'schedule', setup: ready, latest: admitted({ state: 'running', written: null, change: null }), schedule: sched() }, 'running'],
  ['waiting for data outranks scheduled', { trigger: 'schedule', setup: ready, latest: admitted({ state: 'failed', waitingForData: true, missing: ['a.csv'], written: null, change: null }), schedule: sched() }, 'waiting-for-data'],
  ['setup incomplete outranks scheduled', { trigger: 'schedule', setup: noBinding, latest: null, schedule: sched() }, 'setup-incomplete'],
  ['a blocked slot needs investigation', { trigger: 'schedule', setup: ready, latest: admitted(), schedule: sched({ blocked: { code: 'schedule_authority_lost', reason: 'A left.' } }) }, 'needs-investigation'],
  ['a block on a schedule turned off is not shown', { trigger: 'manual', setup: ready, latest: admitted(), schedule: sched({ state: 'off', blocked: { code: 'configuration_changed', reason: 'Changed.' } }) }, 'manual'],
];

describe('automationLabel', () => {
  test.each(cases)('%s', (_name, facts, expected) => {
    const shown = automationLabel(facts);
    expect(shown.label).toBe(expected);
    expect(shown.text).toBe(AUTOMATION_LABEL_TEXT[expected]);
    expect(shown.reason.length).toBeGreaterThan(0);
  });

  test('the resting label says manual and not scheduled, in those words', () => {
    expect(automationLabel({ trigger: 'manual', setup: ready, latest: null }).text).toBe(
      'Manual — not scheduled',
    );
  });

  test('waiting for data names every missing file', () => {
    const shown = automationLabel({
      trigger: 'manual',
      setup: ready,
      latest: admitted({
        state: 'failed',
        waitingForData: true,
        missing: ['exports/north.csv', 'exports/south.csv'],
        written: null,
        change: null,
      }),
    });
    expect(shown.reason).toContain('exports/north.csv');
    expect(shown.reason).toContain('exports/south.csv');
    expect(shown.reason).toMatch(/nothing was written/);
  });

  test('setup incomplete carries the server’s own sentence', () => {
    expect(automationLabel({ trigger: 'manual', setup: noBinding, latest: null }).reason).toBe(
      noBinding.message,
    );
  });

  test('the same facts always give the same label', () => {
    for (const [, facts] of cases)
      expect(automationLabel(structuredClone(facts))).toEqual(automationLabel(facts));
  });
});

const results: [string, OccurrenceFacts, AutomationResult | null][] = [
  ['saved, waiting for review', admitted(), 'draft-saved'],
  ['kept', admitted({ change: 'kept' }), 'kept'],
  ['undone', admitted({ change: 'undone' }), 'undone'],
  ['still running', admitted({ state: 'running', written: null, change: null }), null],
  ['waiting for data', admitted({ state: 'failed', waitingForData: true, written: null, change: null }), 'not-written'],
  ['failed', admitted({ state: 'failed', written: null, change: null }), 'not-written'],
  ['cancelled', admitted({ state: 'cancelled', written: null, change: null }), 'not-written'],
  ['uncertain is not called not-written', admitted({ state: 'reconcile_required', uncertain: true, written: null, change: null }), null],
  ['refused', refused('project_busy'), 'not-written'],
  ['admitting', { admission: 'admitting', refusalCode: null, run: null }, null],
  ['unreadable run', admitted(null), null],
];

describe('summary counts, Milestone B', () => {
  test('only an enabled schedule on an available computer counts as scheduled, and open attention counts', () => {
    expect(
      automationSummary([
        { label: 'scheduled', scheduled: true },
        { label: 'paused', scheduled: false },
        { label: 'manual', scheduled: false, attention: 1 },
      ]),
    ).toEqual({ configured: 3, scheduled: 1, running: 0, needsAttention: 1, notReady: 0 });
  });
});

describe('occurrenceResult', () => {
  test.each(results)('%s', (_name, facts, expected) => {
    expect(occurrenceResult(facts)).toBe(expected);
  });

  test('nothing is ever reported as sent', () => {
    for (const [, facts] of results) expect(occurrenceResult(facts)).not.toBe('sent');
  });
});

describe('summary counts', () => {
  test('a manual job is configured and never counted as running', () => {
    expect(automationSummary([{ label: 'manual' }])).toEqual({
      configured: 1,
      scheduled: 0,
      running: 0,
      needsAttention: 0,
      notReady: 0,
    });
  });

  test('each label lands in the counts its caption defines', () => {
    expect(
      automationSummary([
        { label: 'manual' },
        { label: 'running' },
        { label: 'needs-approval' },
        { label: 'waiting-for-data' },
        { label: 'needs-investigation' },
        { label: 'setup-incomplete' },
      ]),
    ).toEqual({ configured: 5, scheduled: 0, running: 1, needsAttention: 3, notReady: 1 });
  });

  test('an empty authorized list counts nothing', () => {
    expect(automationSummary([])).toEqual({
      configured: 0,
      scheduled: 0,
      running: 0,
      needsAttention: 0,
      notReady: 0,
    });
  });
});

describe('ordering and identity', () => {
  test('rows needing a person come first, then by name', () => {
    const rows = byAttention([
      { name: 'B', status: { label: 'manual' as const } },
      { name: 'A', status: { label: 'manual' as const } },
      { name: 'C', status: { label: 'waiting-for-data' as const } },
      { name: 'D', status: { label: 'needs-approval' as const } },
    ]);
    expect(rows.map((row) => row.name)).toEqual(['D', 'C', 'A', 'B']);
  });

  test('the weekly brief id is stable per organization', () => {
    expect(briefAutomationId('org_1')).toBe('brief:org_1');
  });
});
