import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppUpdateService } from '../server/app-updates.js';
import { createApp } from '../server/app.js';
import {
  RELEASE_BODY_MAX_CHARS,
  RELEASE_NOTES_SEEN_LIMIT,
  notesFromReleaseBody,
  plainTextProblem,
  publishedRelease,
  publishedReleases,
  releaseNoticeFor,
  validateReleaseNotes,
  withReleaseNoticeSeen,
  type ReleaseEntry,
  type ReleaseNotesFile,
} from '../shared/release-notes.js';

// The release-notes contract (shared/release-notes.ts) and the committed file
// it governs, resources/release-notes/releases.json. The app bundles that file,
// the website reads it from main and the release pipeline writes to it, so the
// committed copy is validated here exactly as all three read it.
const COMMITTED = JSON.parse(
  readFileSync(new URL('../resources/release-notes/releases.json', import.meta.url), 'utf8'),
) as ReleaseNotesFile;

function entry(version: string, date: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry {
  return {
    version,
    date,
    channel: 'stable',
    platforms: ['windows'],
    headline: `Version ${version} in one plain sentence.`,
    sections: [{ title: 'New', items: [`Something a person can see in ${version}.`] }],
    ...extra,
  };
}

function file(...releases: ReleaseEntry[]): ReleaseNotesFile {
  return { schemaVersion: 1, releases };
}

function errorsOf(value: unknown): string[] {
  const result = validateReleaseNotes(value);
  return result.ok ? [] : result.errors;
}

describe('the committed releases.json', () => {
  it('passes the contract', () => {
    expect(errorsOf(COMMITTED)).toEqual([]);
  });

  it('carries every earlier release as a stable, Windows-only entry', () => {
    const seeded = ['0.1.11', '0.1.10', '0.1.9', '0.1.8', '0.1.7', '0.1.6', '0.1.5', '0.1.4', '0.1.3', '0.1.2'];
    const stable = COMMITTED.releases.filter((r) => r.channel === 'stable' && r.version !== '0.2.0');
    expect(stable.map((r) => r.version)).toEqual(seeded);
    for (const release of stable) expect(release.platforms).toEqual(['windows']);
  });

  it('publishes 0.2.0 on top for Windows and macOS, the release this build ships as', () => {
    const [first] = COMMITTED.releases;
    expect(first.version).toBe('0.2.0');
    expect(first.channel).toBe('stable');
    expect(first.platforms).toEqual(['windows', 'macos']);
    expect(publishedRelease(COMMITTED, '0.2.0')).toEqual(first);
    expect(publishedReleases(COMMITTED).some((r) => r.channel !== 'stable')).toBe(false);
    expect(first.sections.map((s) => s.title)).toEqual(['New', 'Fixed', 'Updating', 'Known limits']);
  });

  it('names no internal work-item codes in anything a person reads', () => {
    const text = COMMITTED.releases
      .flatMap((r) => [r.headline, ...r.sections.flatMap((s) => [s.title, ...s.items])])
      .join('\n');
    expect(text).not.toMatch(/\b(?:[HPDRO]\d{2}|DIO-\d+|CD-\d+|FIL-\d+)\b/);
  });
});

describe('validateReleaseNotes', () => {
  it('accepts a well-formed file', () => {
    expect(errorsOf(file(entry('0.2.0', '2026-09-25', { channel: 'draft' }), entry('0.1.11', '2026-09-24')))).toEqual([]);
  });

  it('refuses the wrong schema version, an empty list and unknown fields', () => {
    expect(errorsOf({ schemaVersion: 2, releases: [entry('0.1.0', '2026-01-01')] })).toContain(
      'schemaVersion must be 1.',
    );
    expect(errorsOf({ schemaVersion: 1, releases: [] })).toContain(
      'releases must be a non-empty array.',
    );
    expect(errorsOf({ ...file(entry('0.1.0', '2026-01-01')), extra: true })).toContain(
      'Unknown field "extra" at the top level.',
    );
    const withField = { ...entry('0.1.0', '2026-01-01'), notes: 'x' };
    expect(errorsOf(file(withField as ReleaseEntry)).join('\n')).toMatch(/unknown field "notes"/);
  });

  it('refuses versions that are not stable X.Y.Z, and a version listed twice', () => {
    for (const version of ['v0.1.0', '0.1', '0.1.0-beta.1', '01.1.0'])
      expect(errorsOf(file(entry(version, '2026-01-01'))).join('\n')).toMatch(/stable X\.Y\.Z/);
    expect(
      errorsOf(file(entry('0.1.1', '2026-01-02'), entry('0.1.1', '2026-01-01'))).join('\n'),
    ).toMatch(/appears twice/);
  });

  it('refuses a date that is not a real day', () => {
    for (const date of ['2026-02-30', '2026-9-25', '25/09/2026', ''])
      expect(errorsOf(file(entry('0.1.0', date))).join('\n')).toMatch(/real YYYY-MM-DD/);
  });

  it('refuses an unknown channel or platform', () => {
    expect(
      errorsOf(file(entry('0.1.0', '2026-01-01', { channel: 'beta' as never }))).join('\n'),
    ).toMatch(/channel/);
    for (const platforms of [[], ['linux'], ['windows', 'windows']])
      expect(
        errorsOf(file(entry('0.1.0', '2026-01-01', { platforms: platforms as never }))).join('\n'),
      ).toMatch(/platforms/);
    expect(errorsOf(file(entry('0.1.0', '2026-01-01', { platforms: ['windows', 'macos'] })))).toEqual([]);
  });

  it('holds releases newest first, by version and by date', () => {
    expect(
      errorsOf(file(entry('0.1.10', '2026-09-24'), entry('0.1.11', '2026-09-24'))).join('\n'),
    ).toMatch(/newest first/);
    // Numeric, not string, order: 0.1.10 is newer than 0.1.9.
    expect(errorsOf(file(entry('0.1.10', '2026-09-24'), entry('0.1.9', '2026-09-24')))).toEqual([]);
    expect(
      errorsOf(file(entry('0.1.11', '2026-09-20'), entry('0.1.10', '2026-09-24'))).join('\n'),
    ).toMatch(/later than 0\.1\.11/);
  });

  it('keeps a draft above every stable release', () => {
    expect(
      errorsOf(
        file(entry('0.2.0', '2026-09-25'), entry('0.1.99', '2026-09-24', { channel: 'draft' })),
      ).join('\n'),
    ).toMatch(/draft must be newer/);
  });

  it('refuses a release with no sections, an empty section or a repeated title', () => {
    expect(errorsOf(file(entry('0.1.0', '2026-01-01', { sections: [] }))).join('\n')).toMatch(
      /sections must be/,
    );
    expect(
      errorsOf(file(entry('0.1.0', '2026-01-01', { sections: [{ title: 'New', items: [] }] }))).join('\n'),
    ).toMatch(/items must be/);
    const twice = [
      { title: 'New', items: ['One.'] },
      { title: 'New', items: ['Two.'] },
    ];
    expect(errorsOf(file(entry('0.1.0', '2026-01-01', { sections: twice }))).join('\n')).toMatch(
      /appears twice in one release/,
    );
  });

  it('names every problem, with where it is', () => {
    const errors = errorsOf(
      file(entry('0.1.0', 'soon', { headline: '', sections: [{ title: '', items: ['<b>x</b>'] }] })),
    );
    expect(errors).toEqual([
      'releases[0] (0.1.0): date must be a real YYYY-MM-DD day.',
      'releases[0] (0.1.0): headline must not be empty.',
      'releases[0] (0.1.0) sections[0]: title must not be empty.',
      'releases[0] (0.1.0) sections[0] items[0] must not contain HTML.',
    ]);
  });
});

describe('plain text', () => {
  it('accepts ordinary sentences, including punctuation a person writes', () => {
    for (const text of [
      'Settings > App updates offers stable releases only.',
      'A 3,000-file folder - listed in under a second (about 40 seconds before).',
      'It says so: "No available engines found."',
      'Conversation text size: 90, 100, 110 or 125 percent.',
    ])
      expect(plainTextProblem(text, 1200)).toBeNull();
  });

  it('refuses markup, HTML, line breaks and padding', () => {
    expect(plainTextProblem('Uses **bold**', 100)).toBe('must not contain markdown');
    expect(plainTextProblem('Uses `code`', 100)).toBe('must not contain markdown');
    expect(plainTextProblem('See [the notes](https://example.com)', 100)).toBe(
      'must not contain markdown',
    );
    expect(plainTextProblem('# Heading', 100)).toBe('must not contain markdown');
    expect(plainTextProblem('- a list item', 100)).toBe('must not contain markdown');
    expect(plainTextProblem('1. a numbered item', 100)).toBe('must not contain markdown');
    expect(plainTextProblem('<script>alert(1)</script>', 100)).toBe('must not contain HTML');
    expect(plainTextProblem('Tom &amp; Jerry', 100)).toBe('must not contain HTML');
    expect(plainTextProblem('two\nlines', 100)).toBe('must be one line of plain text');
    expect(plainTextProblem(' padded', 100)).toBe('must not start or end with spaces');
    expect(plainTextProblem('x'.repeat(101), 100)).toBe('must be at most 100 characters');
    expect(plainTextProblem(7, 100)).toBe('must be a string');
  });
});

describe('what a person is shown', () => {
  const notes = file(
    entry('0.2.0', '2026-09-25', { channel: 'draft' }),
    entry('0.1.11', '2026-09-24'),
    entry('0.1.10', '2026-09-24'),
    entry('0.1.9', '2026-09-24'),
  );

  it('lists stable releases only, newest first', () => {
    expect(publishedReleases(notes).map((r) => r.version)).toEqual(['0.1.11', '0.1.10', '0.1.9']);
  });

  it('hides drafts everywhere, including by version', () => {
    expect(publishedRelease(notes, '0.2.0')).toBeNull();
    expect(publishedRelease(notes, '0.1.10')?.version).toBe('0.1.10');
    expect(publishedRelease(notes, null)).toBeNull();
  });

  it('shows nothing from a file that fails the contract', () => {
    expect(publishedReleases({ schemaVersion: 1, releases: [entry('0.1.0', 'soon')] })).toEqual([]);
    expect(publishedReleases(null)).toEqual([]);
  });
});

describe('the post-update notice', () => {
  const notes = file(
    entry('0.2.0', '2026-10-01', { channel: 'draft' }),
    entry('0.1.11', '2026-09-24'),
    entry('0.1.10', '2026-09-24'),
  );
  const updated = {
    notes,
    installedVersion: '0.1.11',
    seen: [] as string[],
    setupDone: true,
    // Set up on 0.1.10, before 0.1.11 was released: this launch is an update.
    setupCompletedAt: '2026-09-20T09:00:00.000Z',
  };

  it('offers the installed version once after an update, and not again once dismissed', () => {
    expect(releaseNoticeFor(updated)?.version).toBe('0.1.11');
    const seen = withReleaseNoticeSeen(updated.seen, '0.1.11');
    expect(seen).toEqual(['0.1.11']);
    expect(releaseNoticeFor({ ...updated, seen })).toBeNull();
    // Dismissing again changes nothing.
    expect(withReleaseNoticeSeen(seen, '0.1.11')).toEqual(['0.1.11']);
  });

  it('remembers each version on its own', () => {
    const seen = withReleaseNoticeSeen([], '0.1.10');
    expect(releaseNoticeFor({ ...updated, seen })?.version).toBe('0.1.11');
    expect(
      releaseNoticeFor({ ...updated, installedVersion: '0.1.10', seen, setupCompletedAt: '2026-09-01T00:00:00Z' }),
    ).toBeNull();
  });

  it('is not offered on a new install, during setup, or without a recorded setup time', () => {
    expect(releaseNoticeFor({ ...updated, setupCompletedAt: '2026-09-24T18:00:00.000Z' })).toBeNull();
    expect(releaseNoticeFor({ ...updated, setupCompletedAt: '2026-09-30T08:00:00.000Z' })).toBeNull();
    expect(releaseNoticeFor({ ...updated, setupDone: false })).toBeNull();
    expect(releaseNoticeFor({ ...updated, setupCompletedAt: null })).toBeNull();
    expect(releaseNoticeFor({ ...updated, setupCompletedAt: 'not a time' })).toBeNull();
  });

  it('is not offered for a draft, an unknown version or an unread version', () => {
    expect(releaseNoticeFor({ ...updated, installedVersion: '0.2.0' })).toBeNull();
    expect(releaseNoticeFor({ ...updated, installedVersion: '0.1.99' })).toBeNull();
    expect(releaseNoticeFor({ ...updated, installedVersion: null })).toBeNull();
  });

  it('keeps the remembered list bounded, dropping the oldest', () => {
    let seen: string[] = [];
    for (let i = 0; i < RELEASE_NOTES_SEEN_LIMIT + 5; i += 1) seen = withReleaseNoticeSeen(seen, `0.0.${i}`);
    expect(seen).toHaveLength(RELEASE_NOTES_SEEN_LIMIT);
    expect(seen[0]).toBe('0.0.5');
    expect(seen.at(-1)).toBe(`0.0.${RELEASE_NOTES_SEEN_LIMIT + 4}`);
  });
});

describe('notes from a GitHub release body', () => {
  it('keeps the person-facing part, from its first notes heading on', () => {
    const body = [
      'Diomedes 0.1.12 - Windows x64 experimental build',
      'WHICH FILE',
      '  Diomedes-Experimental-0.1.12-unsigned-setup.exe',
      '',
      'WHAT IS NEW',
      '  Something new.',
      '',
      'LIMITS',
      '  Unsigned.',
    ].join('\r\n');
    expect(notesFromReleaseBody(body)).toBe('WHAT IS NEW\n  Something new.\n\nLIMITS\n  Unsigned.');
  });

  it('keeps a body with no notes heading whole, and drops control characters', () => {
    expect(notesFromReleaseBody('Notes for 0.1.12.\u0007')).toBe('Notes for 0.1.12.');
  });

  it('bounds a long body and reads nothing from a missing one', () => {
    const long = notesFromReleaseBody('x'.repeat(RELEASE_BODY_MAX_CHARS + 50));
    expect(long).toHaveLength(RELEASE_BODY_MAX_CHARS + 1);
    expect(long?.endsWith('…')).toBe(true);
    expect(notesFromReleaseBody(undefined)).toBeNull();
    expect(notesFromReleaseBody('   ')).toBeNull();
  });
});

describe('the update check carries the offered release notes', () => {
  const NAME = 'Diomedes-Experimental-0.1.12-unsigned-setup.exe';
  const payload = {
    tag_name: 'v0.1.12',
    html_url: 'https://github.com/andrewgodowsky-aoa/diomedes/releases/tag/v0.1.12',
    body: 'WHICH FILE\n  the installer\n\nWHAT IS NEW\n  From the release page.',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: NAME,
        browser_download_url: `https://github.com/andrewgodowsky-aoa/diomedes/releases/download/v0.1.12/${NAME}`,
        size: 1_100_000,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  };
  const service = (releaseNotes: unknown) =>
    new AppUpdateService({
      currentVersion: '0.1.11',
      // The Windows installer channel, pinned as tests/app-updates.test.ts pins it: on a Mac
      // the check looks for the disk image instead (selectReleaseAsset).
      platform: 'win32',
      dataDir: path.join(process.cwd(), 'test-results', 'release-notes-unused'),
      isBusy: () => false,
      releaseNotes,
      transport: { fetchRelease: async () => structuredClone(payload) },
    });

  it('prefers the bundled entry when this build already knows the version', async () => {
    const bundled = file(entry('0.1.12', '2026-09-26'), entry('0.1.11', '2026-09-24'));
    const check = await service(bundled).check();
    expect(check.outcome).toBe('available');
    expect(check.notes).toEqual({ source: 'bundled', release: bundled.releases[0] });
  });

  it('falls back to the release page text, never to a draft entry', async () => {
    const drafted = file(entry('0.1.12', '2026-09-26', { channel: 'draft' }), entry('0.1.11', '2026-09-24'));
    const updates = service(drafted);
    const check = await updates.check();
    expect(check.notes).toEqual({ source: 'release-page', text: 'WHAT IS NEW\n  From the release page.' });
    expect((await updates.status()).check.notes).toEqual(check.notes);
  });

  it('carries no notes when nothing newer is offered', async () => {
    const current = new AppUpdateService({
      currentVersion: '0.1.12',
      // The Windows installer channel, pinned as tests/app-updates.test.ts pins it: on a Mac
      // the check looks for the disk image instead (selectReleaseAsset).
      platform: 'win32',
      dataDir: path.join(process.cwd(), 'test-results', 'release-notes-unused'),
      isBusy: () => false,
      transport: { fetchRelease: async () => structuredClone(payload) },
    });
    const check = await current.check();
    expect(check.outcome).toBe('current');
    expect(check.notes).toBeNull();
  });
});

describe('settings remember dismissed versions', () => {
  let root = '';
  let url = '';
  let server: Server | undefined;
  let application: Awaited<ReturnType<typeof createApp>> | undefined;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const put = (data: unknown) =>
    fetch(`${url}/api/settings`, { method: 'PUT', headers, body: JSON.stringify(data) });

  beforeAll(async () => {
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'release-notes-'));
    application = await createApp({
      dataDir: path.join(root, 'data'),
      projectRoot: path.join(root, 'projects'),
    });
    server = application.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (application) await application.locals.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stores the versions and keeps them across a read', async () => {
    const response = await put({ seen: { releaseNotes: ['0.1.10', '0.1.11'] } });
    expect(response.status).toBe(200);
    const settings = await (await fetch(`${url}/api/settings`)).json();
    expect(settings.seen.releaseNotes).toEqual(['0.1.10', '0.1.11']);
  });

  it('refuses anything that is not a list of stable versions', async () => {
    for (const releaseNotes of ['0.1.11', ['v0.1.11'], ['0.1.11-beta'], [11], Array(RELEASE_NOTES_SEEN_LIMIT + 1).fill('0.1.1')])
      expect((await put({ seen: { releaseNotes } })).status).toBe(400);
  });
});
