/**
 * Phase 0 of the update-refresh work: a release whose app files changed since
 * its version was tagged cannot keep that version (scripts/packaged-release-check.mjs).
 * Each case builds a small real repository, because the guard is only as good
 * as the git questions it asks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The packaged-release check is an executable JavaScript module.
import { checkReleaseVersion } from '../scripts/packaged-release-check.mjs';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Guard', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const put = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await fs.writeFile(path.join(repo, file), text);
};
const version = (value: string) => put('package.json', JSON.stringify({ name: 'diomedes', version: value }));
const commit = (message: string) => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
};

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-release-guard-'));
  git('init', '-q');
  await version('0.1.11');
  await put('client/App.tsx', 'export const shown = 1;\n');
  await put('docs/notes.md', 'first\n');
  commit('0.1.11');
  git('tag', 'v0.1.11');
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('the release version guard', () => {
  test('refuses app changes after a tag under the same version, naming them', async () => {
    await put('client/App.tsx', 'export const shown = 2;\n');
    commit('display fix after the tag');
    const result = await checkReleaseVersion({ root: repo });
    expect(result.ok).toBe(false);
    expect(result.tag).toBe('v0.1.11');
    expect(result.changed).toEqual(['client/App.tsx']);
    expect(result.message).toMatch(/still says 0\.1\.11\. Bump the version/);
  });

  test('passes once the version is bumped ahead of the latest tag', async () => {
    await put('client/App.tsx', 'export const shown = 2;\n');
    await version('0.2.0');
    commit('0.2.0');
    const result = await checkReleaseVersion({ root: repo });
    expect(result).toMatchObject({ ok: true, tag: null });
  });

  test('passes a rebuild of the tag, and changes outside the app', async () => {
    expect((await checkReleaseVersion({ root: repo })).ok).toBe(true);
    await put('docs/notes.md', 'second\n');
    commit('docs only');
    expect(await checkReleaseVersion({ root: repo })).toMatchObject({ ok: true, tag: 'v0.1.11' });
  });

  test('refuses a version that is not ahead of the latest release', async () => {
    await version('0.1.10');
    commit('backwards');
    const result = await checkReleaseVersion({ root: repo });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not ahead of the latest release v0\.1\.11/);
  });

  test('says how to fetch tags when none are visible', async () => {
    git('tag', '-d', 'v0.1.11');
    const result = await checkReleaseVersion({ root: repo });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/git fetch --tags/);
  });
});
