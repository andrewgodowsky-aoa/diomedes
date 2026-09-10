import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ApiError,
  projectFile,
  relativeName,
  rejectForbidden,
  safeAbsolute,
} from '../server/paths.js';

// Pure guard regression: no runtime 8.3 alias creation is exercised. Windows
// alias generation is volume/OS dependent and may be disabled, so these tests
// pin only the conservative name-shape rejection in rejectForbidden; they do
// not claim a filesystem sandbox or prove real alias resolution on disk.
const statusOf = (run: () => unknown): number | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};
const statusOfAsync = async (run: () => Promise<unknown>): Promise<number | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
};
const tempRoot = async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  return fs.mkdtemp(path.join(process.cwd(), 'test-results', 'path-alias-'));
};

describe('dos short-name guard', () => {
  test('relativeName refuses plausible 8.3 alias components with 403', () => {
    expect(statusOf(() => relativeName('NODEMO~1/notes.txt'))).toBe(403);
    expect(statusOf(() => relativeName('docs/CREDEN~1.JSON'))).toBe(403);
    expect(statusOf(() => relativeName('docs/CREDEN~1.JSO'))).toBe(403);
    expect(statusOf(() => relativeName('ENV~1.LOC/values.txt'))).toBe(403);
    expect(statusOf(() => relativeName('GITCON~1'))).toBe(403);
    expect(statusOf(() => relativeName('file~1.txt'))).toBe(403);
  });

  test('relativeName refusal is case-insensitive', () => {
    expect(statusOf(() => relativeName('nodemo~1/notes.txt'))).toBe(403);
    expect(statusOf(() => relativeName('NodeMo~1/notes.txt'))).toBe(403);
    expect(statusOf(() => relativeName('docs/creden~1.json'))).toBe(403);
  });

  test('relativeName allows benign tilde filenames that cannot be DOS aliases', () => {
    expect(relativeName('notes~backup.md')).toBe('notes~backup.md');
    expect(relativeName('main.py~')).toBe('main.py~');
    expect(relativeName('data~draft~2.log')).toBe('data~draft~2.log');
    expect(relativeName('file.txt~1')).toBe('file.txt~1');
    expect(relativeName('~draft/notes~backup.md')).toBe('~draft/notes~backup.md');
    expect(relativeName('draft~')).toBe('draft~');
  });

  test('safeAbsolute refuses alias components before touching the filesystem', async () => {
    const base = path.resolve('nowhere-at-all');
    expect(await statusOfAsync(() => safeAbsolute(path.join(base, 'NODEMO~1', 'notes.txt')))).toBe(
      403,
    );
    expect(await statusOfAsync(() => safeAbsolute(path.join(base, 'CREDEN~1.JSON')))).toBe(403);
    expect(
      await statusOfAsync(() => safeAbsolute(path.join(base, 'cred en', 'CRedeN~1.jSo'))),
    ).toBe(403);
  });

  test('safeAbsolute allows benign tilde filenames', async () => {
    const temp = await tempRoot();
    expect(await safeAbsolute(path.join(temp, 'notes~backup.md'))).toBe(
      path.join(temp, 'notes~backup.md'),
    );
    expect(await safeAbsolute(path.join(temp, 'main.py~'))).toBe(path.join(temp, 'main.py~'));
    expect(await safeAbsolute(path.join(temp, 'data~draft~2.log'))).toBe(
      path.join(temp, 'data~draft~2.log'),
    );
  });

  test('projectFile refuses alias components before guarded targets must exist', async () => {
    const temp = await tempRoot();
    expect(await statusOfAsync(() => projectFile(temp, 'CREDEN~1.JSON'))).toBe(403);
    expect(await statusOfAsync(() => projectFile(temp, 'NODEMO~1/notes.txt'))).toBe(403);
    expect(await statusOfAsync(() => projectFile(temp, 'docs/creden~1.jso'))).toBe(403);
  });

  test('projectFile allows benign tilde filenames', async () => {
    const temp = await tempRoot();
    const result = await projectFile(temp, 'notes~backup.md');
    expect(result.relative).toBe('notes~backup.md');
    expect(result.absolute).toBe(path.join(temp, 'notes~backup.md'));
  });

  test('rejectForbidden checks alias shapes in any path component', () => {
    expect(() => rejectForbidden(path.resolve('project', 'NODEMO~1', 'store.json'))).toThrow(
      ApiError,
    );
    expect(() => rejectForbidden(path.resolve('project', 'docs', 'CREDEN~1.JSON'))).toThrow(
      ApiError,
    );
    expect(() => rejectForbidden(path.resolve('project', 'notes~backup.md'))).not.toThrow();
    expect(() => rejectForbidden(path.resolve('project', 'notes~1.txt'))).toThrow(ApiError);
  });

  test('existing guarded-name checks are retained', () => {
    expect(statusOf(() => relativeName('node_modules/store.json'))).toBe(403);
    expect(statusOf(() => relativeName('credentials.json'))).toBe(403);
    expect(statusOf(() => relativeName('.env.local'))).toBe(403);
    expect(statusOf(() => relativeName('soul.md'))).toBe(403);
    expect(() => rejectForbidden(path.resolve('project', '.git', 'config'))).toThrow(ApiError);
  });
});
