import { describe, expect, it } from 'vitest';
import { defaults, migrateSettings } from '../server/store';
import type { Settings } from '../shared/types';

/**
 * The Workbook is gone (Andrew, 2026-09-23), and so are the settings keys only
 * it read: `surface`, `lastPage` and `tasksView`. A settings file written by an
 * earlier build still holds them; loading it drops them, whatever they say, and
 * leaves everything else alone.
 */
function saved(extra: Record<string, unknown>, detail: Settings['detail'] = 'standard'): Settings {
  return { ...defaults(), detail, ...extra } as Settings;
}
const keys = (settings: Settings) => Object.keys(settings);

describe('settings keys retired with the Workbook', () => {
  it('drops every stored surface spelling', () => {
    for (const surface of ['book', 'workbook', 'desk', 'console', 'technical']) {
      const settings = saved({ surface });
      migrateSettings(settings);
      expect(keys(settings)).not.toContain('surface');
    }
  });

  it('drops the Workbook page and task-view memory', () => {
    const settings = saved({
      lastPage: { '0123456789ab': 'tasks' },
      tasksView: { '0123456789ab': 'board' },
    });
    migrateSettings(settings);
    expect(keys(settings)).not.toContain('lastPage');
    expect(keys(settings)).not.toContain('tasksView');
  });

  it('writes none of them into new settings', () => {
    for (const key of ['surface', 'lastPage', 'tasksView']) expect(keys(defaults())).not.toContain(key);
  });

  it('leaves the detail level and open projects alone', () => {
    const settings = saved({ surface: 'workbook', openProjects: ['0123456789ab'] }, 'guided');
    migrateSettings(settings);
    expect(settings.detail).toBe('guided');
    expect(settings.openProjects).toEqual(['0123456789ab']);
  });

  it('is settled after one pass, so a second load changes nothing', () => {
    const settings = saved({ surface: 'book', lastPage: {} });
    migrateSettings(settings);
    const once = JSON.stringify(settings);
    migrateSettings(settings);
    expect(JSON.stringify(settings)).toBe(once);
  });
});
