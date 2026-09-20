import { describe, expect, it } from 'vitest';
import { defaults, migrateSettings } from '../server/store';
import type { Settings } from '../shared/types';

/**
 * The Workbook is retired from a person's reach. No control switches into it
 * any more, so the failure this guards against is a stranded person: a stored
 * 'workbook' (or the older 'book') that opens a surface with no way out of it.
 * Every stored spelling opens on the Console; the API still accepts the key for
 * one more release so the legacy acceptance specs stay runnable.
 */
function saved(surface: unknown, detail: Settings['detail'] = 'standard'): Settings {
  const settings = { ...defaults(), detail } as Settings;
  (settings as { surface?: unknown }).surface = surface;
  return settings;
}

describe('the surface a stored setting opens on', () => {
  it('opens every stored spelling on the Console', () => {
    for (const stored of ['book', 'workbook', 'desk', 'console', 'technical']) {
      const settings = saved(stored);
      migrateSettings(settings);
      expect(settings.surface).toBe('console');
    }
  });

  it('opens on the Console when nothing was stored, whatever the detail level', () => {
    for (const detail of ['guided', 'standard', 'technical'] as const) {
      const settings = saved(undefined, detail);
      migrateSettings(settings);
      expect(settings.surface).toBe('console');
    }
  });

  it('leaves the detail level alone', () => {
    const settings = saved('workbook', 'guided');
    migrateSettings(settings);
    expect(settings.detail).toBe('guided');
  });

  // The store re-reads settings when it recovers an interrupted write, in the
  // middle of a session. That is not a launch: the surface showing stays put,
  // and only a value that is missing altogether is filled.
  it('leaves a running session where it is on a recovery reload', () => {
    const running = saved('workbook');
    migrateSettings(running, { atLaunch: false });
    expect(running.surface).toBe('workbook');
    const missing = saved(undefined);
    migrateSettings(missing, { atLaunch: false });
    expect(missing.surface).toBe('console');
  });

  it('is settled after one pass, so a second load changes nothing', () => {
    const settings = saved('book');
    migrateSettings(settings);
    migrateSettings(settings);
    expect(settings.surface).toBe('console');
  });
});

/**
 * History retention was configurable and never enforced: keepDays and
 * maxBytesPerProject were validated, stored and read by nothing. A setting that
 * promises to age evidence out, and does not, is worse than no setting, and
 * History is evidence. Andrew, 2026-09-10: preserve it until there is a real
 * retention and archive policy, and take the controls out meanwhile.
 *
 * Settings load with no merge against the defaults, so a key left in a stored
 * file would be read back and rewritten forever. Migration is the only thing
 * that can retire one.
 */
describe('the retired history retention settings', () => {
  const withRetention = () => {
    const settings = defaults() as Settings & { history?: unknown };
    settings.history = { keepDays: 30, maxBytesPerProject: 2147483648 };
    return settings;
  };

  it('drops the stored block so it is never written back', () => {
    const settings = withRetention();
    migrateSettings(settings);
    expect('history' in settings).toBe(false);
  });

  it('is settled after one pass, and a file that never had one is untouched', () => {
    const settings = withRetention();
    migrateSettings(settings);
    migrateSettings(settings);
    expect('history' in settings).toBe(false);
    const clean = defaults() as Settings & { history?: unknown };
    migrateSettings(clean);
    expect('history' in clean).toBe(false);
  });
});
