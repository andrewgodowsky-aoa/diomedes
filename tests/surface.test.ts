import { describe, expect, it } from 'vitest';
import { defaults, migrateSettings } from '../server/store';
import type { Settings } from '../shared/types';

/**
 * Settings survive a rename. Anyone already running Diomedes has 'book' or
 * 'desk' written to disk, and the failure this guards against is silent: they
 * open the app and find themselves on a surface they never chose, with no
 * error to explain it. Old spellings are read forever; only the new ones are
 * ever written.
 */
function saved(surface: unknown, detail: Settings['detail'] = 'standard'): Settings {
  const settings = { ...defaults(), detail } as Settings;
  (settings as { surface?: unknown }).surface = surface;
  return settings;
}

describe('the surface a stored setting opens on', () => {
  it('carries the old names onto the new ones', () => {
    const book = saved('book');
    migrateSettings(book);
    expect(book.surface).toBe('workbook');
    const desk = saved('desk');
    migrateSettings(desk);
    expect(desk.surface).toBe('console');
  });

  it('still honours the detail level retired before the rename', () => {
    const technical = saved('technical');
    migrateSettings(technical);
    expect(technical.surface).toBe('console');
  });

  it('leaves the current names alone', () => {
    const workbook = saved('workbook');
    migrateSettings(workbook);
    expect(workbook.surface).toBe('workbook');
    const console_ = saved('console');
    migrateSettings(console_);
    expect(console_.surface).toBe('console');
  });

  it('falls back to the detail level when nothing was stored', () => {
    const technical = saved(undefined, 'technical');
    migrateSettings(technical);
    expect(technical.surface).toBe('console');
    const guided = saved(undefined, 'guided');
    migrateSettings(guided);
    expect(guided.surface).toBe('workbook');
  });

  it('is settled after one pass, so a second load changes nothing', () => {
    const settings = saved('desk');
    migrateSettings(settings);
    const once = settings.surface;
    migrateSettings(settings);
    expect(settings.surface).toBe(once);
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
