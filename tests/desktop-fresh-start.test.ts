import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The one clean start 0.1.9 gives every existing install (Andrew, 2026-09-23).
const { freshStartOnce } = await import(new URL('../desktop/fresh-start.mjs', import.meta.url).href);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function install(withOldData: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diomedes-fresh-'));
  roots.push(root);
  const userData = path.join(root, 'profile');
  const dataDir = path.join(userData, 'data');
  const projectsDir = path.join(root, 'Documents', 'Diomedes');
  if (withOldData) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"appearance":{"package":"field"}}');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'notes.md'), 'their words');
    fs.writeFileSync(path.join(userData, 'diomedes-native-auth.json'), '{"sealed":"x"}');
  }
  return { root, userData, dataDir, projectsDir };
}
const now = new Date('2026-09-23T23:40:00Z');

describe('the one clean start of 0.1.9', () => {
  it('sets the app data, projects and account session aside, deleting nothing', async () => {
    const at = install(true);
    const result = await freshStartOnce({ ...at, now });
    expect(result.reset).toBe(true);
    expect(result.kept).toEqual([]);
    expect(result.moved.map((row: { from: string }) => row.from)).toEqual([
      at.dataDir,
      at.projectsDir,
      path.join(at.userData, 'diomedes-native-auth.json'),
    ]);
    expect(fs.existsSync(at.dataDir)).toBe(false);
    expect(fs.existsSync(at.projectsDir)).toBe(false);
    for (const row of result.moved as { to: string }[]) {
      expect(fs.existsSync(row.to)).toBe(true);
      expect(path.basename(row.to)).toContain('(before 0.1.9, 2026-09-23T23-40-00-000Z)');
    }
    const aside = (result.moved as { to: string }[])[1].to;
    expect(fs.readFileSync(path.join(aside, 'notes.md'), 'utf8')).toBe('their words');
  });

  it('happens once: a second launch keeps what the fresh start created', async () => {
    const at = install(true);
    await freshStartOnce({ ...at, now });
    fs.mkdirSync(at.dataDir, { recursive: true });
    fs.writeFileSync(path.join(at.dataDir, 'settings.json'), '{"new":true}');
    const again = await freshStartOnce({ ...at, now });
    expect(again).toEqual({ reset: false, moved: [], kept: [] });
    expect(fs.readFileSync(path.join(at.dataDir, 'settings.json'), 'utf8')).toBe('{"new":true}');
  });

  it('only records the marker on a new install', async () => {
    const at = install(false);
    const result = await freshStartOnce({ ...at, now });
    expect(result).toEqual({ reset: false, moved: [], kept: [] });
    expect(fs.existsSync(path.join(at.userData, 'fresh-start-0.1.9'))).toBe(true);
  });

  it('never overwrites an earlier set-aside', async () => {
    const at = install(true);
    const taken = `${at.dataDir} (before 0.1.9, 2026-09-23T23-40-00-000Z)`;
    fs.mkdirSync(taken);
    const result = await freshStartOnce({ ...at, now });
    expect((result.moved as { to: string }[])[0].to).toBe(`${taken} 2`);
    expect(fs.existsSync(taken)).toBe(true);
  });
});
