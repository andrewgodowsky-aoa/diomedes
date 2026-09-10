import { describe, expect, it } from 'vitest';
import type { Settings } from '../shared/types';
import { advanceSetup, hasUsableService, migrateOnboarding } from '../shared/onboarding';

function base(overrides?: Partial<Settings>): Settings {
  return {
    version: 1,
    detail: 'standard',
    surface: 'console',
    onboarding: {
      work: null,
      detail: null,
      familiarity: null,
      resumeAt: 'welcome',
      completedAt: null,
    },
    permissions: {
      changingFiles: true,
      deleting: true,
      sending: false,
      workingOutside: true,
      spending: true,
    },
    explanations: 'once',
    appearance: { package: 'field', motion: 'normal' },
    history: { keepDays: 30, maxBytesPerProject: 2147483648 },
    seen: { onlineServiceNotice: false, guidedDescriptors: {}, firstUse: [] },
    openProjects: [],
    lastPage: {},
    tasksView: {},
    services: {},
    ...overrides,
  };
}

function atStep(
  step: Settings['onboarding']['resumeAt'],
  overrides?: Partial<Settings>,
  onboarding?: Partial<Settings['onboarding']>,
): Settings {
  const s = base(overrides);
  s.onboarding = { ...s.onboarding, resumeAt: step, ...onboarding };
  return s;
}

const steps: Settings['onboarding']['resumeAt'][] = ['welcome', 'q1', 'q2', 'q3', 'ai', 'ready'];

describe('onboarding decoupling: familiarity is never authority', () => {
  it('comfortable familiarity never relaxes changingFiles on ANY next', () => {
    for (const step of steps) {
      const s = atStep(step, undefined, {
        familiarity: 'comfortable',
        work: 'software',
        detail: 'standard',
      });
      s.permissions.changingFiles = true;
      const next = advanceSetup(s, false);
      expect(next.permissions.changingFiles, `step ${step} next`).toBe(true);
    }
  });

  it('comfortable familiarity never relaxes changingFiles on ANY skip', () => {
    for (const step of steps) {
      const s = atStep(step, undefined, {
        familiarity: 'comfortable',
        work: 'software',
        detail: 'standard',
      });
      s.permissions.changingFiles = true;
      const next = advanceSetup(s, true);
      expect(next.permissions.changingFiles, `step ${step} skip`).toBe(true);
    }
  });

  it('an explicit false stays false on every transition', () => {
    for (const step of steps) {
      for (const skip of [false, true]) {
        const s = atStep(step, undefined, {
          familiarity: 'comfortable',
          work: 'mix',
          detail: 'guided',
        });
        s.permissions.changingFiles = false;
        const next = advanceSetup(s, skip);
        expect(next.permissions.changingFiles, `step ${step} skip=${skip}`).toBe(false);
      }
    }
  });

  it('migrate preserves an explicit false and never increases permissions', () => {
    const s = base();
    s.permissions.changingFiles = false;
    s.permissions.deleting = false;
    s.onboarding.familiarity = 'comfortable';
    const migrated = migrateOnboarding(s);
    expect(migrated.permissions.changingFiles).toBe(false);
    expect(migrated.permissions.deleting).toBe(false);
    expect(migrated.onboarding.setupVersion).toBe(2);
  });
});

describe('migrateOnboarding', () => {
  it('preserves legacy completed users as completed', () => {
    const doneAt = '2026-09-01T00:00:00.000Z';
    const s = atStep('done', undefined, {
      work: 'business',
      detail: 'guided',
      familiarity: 'new',
      completedAt: doneAt,
    });
    s.permissions.changingFiles = true;
    const migrated = migrateOnboarding(s);
    expect(migrated.onboarding.resumeAt).toBe('done');
    expect(migrated.onboarding.completedAt).toBe(doneAt);
    expect(migrated.onboarding.setupVersion).toBe(2);
    expect(migrated.permissions.changingFiles).toBe(true);
    const advanced = advanceSetup(migrated, false);
    expect(advanced.onboarding.resumeAt).toBe('done');
    expect(advanced.onboarding.completedAt).toBe(doneAt);
  });

  it('adds setupVersion 2 with no automatic discovery or new permissions', () => {
    const s = base();
    s.onboarding.familiarity = 'comfortable';
    const migrated = migrateOnboarding(s);
    expect(migrated.onboarding.setupVersion).toBe(2);
    expect(migrated.onboarding.discoveryConsentAt ?? null).toBeNull();
    expect(migrated.permissions.changingFiles).toBe(true);
    expect(migrated.services).toEqual({});
  });

  it('preserves work, detail, familiarity, services and completedAt/resumeAt', () => {
    const s = atStep(
      'q3',
      { detail: 'technical', services: { codex: false } },
      {
        work: 'software',
        detail: 'technical',
        familiarity: 'some',
        completedAt: null,
      },
    );
    const migrated = migrateOnboarding(s);
    expect(migrated.onboarding.work).toBe('software');
    expect(migrated.onboarding.detail).toBe('technical');
    expect(migrated.onboarding.familiarity).toBe('some');
    expect(migrated.onboarding.resumeAt).toBe('q3');
    expect(migrated.detail).toBe('technical');
    expect(migrated.services).toEqual({ codex: false });
  });
});

describe('advanceSetup', () => {
  it('reaches the ai step after q3 and ready after ai', () => {
    const q3 = atStep('q3', undefined, { work: 'mix', detail: 'standard' });
    const ai = advanceSetup(q3, false);
    expect(ai.onboarding.resumeAt).toBe('ai');
    const ready = advanceSetup(ai, false);
    expect(ready.onboarding.resumeAt).toBe('ready');
    const done = advanceSetup(ready, false, '2026-09-10T00:00:00.000Z');
    expect(done.onboarding.resumeAt).toBe('done');
    expect(done.onboarding.completedAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('keeps work and detail independent across steps', () => {
    const q1 = atStep('q1', { detail: 'technical' }, { work: 'software', detail: 'technical' });
    const afterQ1 = advanceSetup(q1, false);
    expect(afterQ1.onboarding.work).toBe('software');
    expect(afterQ1.onboarding.detail).toBe('technical');
    expect(afterQ1.detail).toBe('technical');

    const q3 = atStep('q3', { detail: 'guided' }, { work: 'school', detail: 'guided' });
    const afterQ3 = advanceSetup(q3, false);
    expect(afterQ3.onboarding.work).toBe('school');
    expect(afterQ3.detail).toBe('guided');
  });

  it('detail changes only on q2', () => {
    const q2 = atStep('q2', { detail: 'guided' }, { work: 'mix', detail: 'technical' });
    const afterQ2 = advanceSetup(q2, false);
    expect(afterQ2.detail).toBe('technical');
    expect(afterQ2.onboarding.detail).toBe('technical');

    const q3 = atStep('q3', { detail: 'guided' }, { work: 'mix', detail: 'technical' });
    const afterQ3 = advanceSetup(q3, false);
    expect(afterQ3.detail).toBe('guided');
  });

  it('skip stays conservative: no relaxed approvals, no discovery, no usable service', () => {
    const q2 = atStep('q2', undefined, { familiarity: null, work: null, detail: null });
    q2.permissions.changingFiles = true;
    const afterSkip = advanceSetup(q2, true);
    expect(afterSkip.permissions.changingFiles).toBe(true);
    expect(afterSkip.onboarding.discoveryConsentAt ?? null).toBeNull();
    expect(hasUsableService(afterSkip)).toBe(false);

    const ai = atStep('ai');
    const skippedAi = advanceSetup(ai, true);
    expect(skippedAi.onboarding.resumeAt).toBe('ready');
    expect(skippedAi.onboarding.aiSkipped).toBe(true);
    expect(skippedAi.permissions.changingFiles).toBe(true);
    expect(hasUsableService(skippedAi)).toBe(false);
  });

  it('reports a usable service only for a non-sample enabled defaultEngine', () => {
    const none = base();
    expect(hasUsableService(none)).toBe(false);
    const sample = base({ services: { defaultEngine: 'sample', sample: true } });
    expect(hasUsableService(sample)).toBe(false);
    const off = base({ services: { defaultEngine: 'codex', codex: false } });
    expect(hasUsableService(off)).toBe(false);
    const on = base({ services: { defaultEngine: 'codex', codex: true } });
    expect(hasUsableService(on)).toBe(true);
  });
});
