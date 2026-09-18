/**
 * The Design Center's own service half: autosaved drafts, and the one question
 * this feature asks a socket.
 *
 * The claims under test:
 *
 * - An autosave writes `draft.json` and **nothing else**. No revision file, no
 *   `pack.json`, no last-known-good, and `appearance.activeTheme` does not
 *   move. That is the whole reason the draft flag exists: an editor that saves
 *   every few seconds must not be able to dress the app in a half-finished
 *   design.
 * - A theme that has only ever been autosaved is visible but cannot be applied.
 * - An explicit save overtakes the draft and clears it.
 * - The Website Studio probe sends `Host` and no `Origin`, refuses anything
 *   that is not the studio answering, and gives up inside its budget.
 *
 * Nothing here calls a provider. The probe test binds its own loopback server.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { themeScopeKey } from '../server/themes.js';
import { probeWebsiteStudio } from '../server/website-studio.js';
import {
  exportThemePackage,
  importThemePackage,
  THEME_PACKAGE_EXTENSION,
} from '../shared/theme-pack/package.js';
import type { ThemePackV1 } from '../shared/theme-pack/types.js';
import type { Person, WorkspaceRef } from '../shared/workspaces.js';
import type { Settings } from '../shared/types.js';

let server: Server | undefined;
let root = '';
let url = '';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

async function request<T = any>(
  route: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-design-center-'));
  // Autosaving and saving are paid features from A5 on. This file is about what
  // a draft is, so it runs on the named `paid` fixture; the refusals without one
  // are proven in tests/customization-entitlement.test.ts.
  process.env.DIOMEDES_TEST_MODE = '1';
  process.env.DIOMEDES_ENTITLEMENT_FIXTURE = 'paid';
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const current = server;
  server = undefined;
  delete process.env.DIOMEDES_TEST_MODE;
  delete process.env.DIOMEDES_ENTITLEMENT_FIXTURE;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

const PERSONAL: WorkspaceRef = { kind: 'personal' };

async function themeDir(id: string): Promise<string> {
  const person = JSON.parse(
    await fs.readFile(path.join(root, 'data', 'workspaces', 'identity.json'), 'utf8'),
  ) as Person;
  return path.join(root, 'data', 'themes', themeScopeKey(PERSONAL, person.id), id);
}

const errorCode = (data: unknown): string | undefined => {
  const value = data as { error?: { code?: string }; code?: string } | null;
  return value?.error?.code ?? value?.code;
};

const exists = async (target: string) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

function pack(id: string, overrides: Partial<ThemePackV1> = {}): ThemePackV1 {
  const color = (value: string) => ({ $type: 'color' as const, $value: value });
  return {
    schemaVersion: 1,
    id,
    name: `Theme ${id}`,
    revision: 1,
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: { author: 'A3 test', createdAt: '2026-09-17T00:00:00.000Z', tool: 'vitest' },
    tokens: {
      color: {
        chrome: color('#101014'),
        surface: color('#15151a'),
        raised: color('#1b1b22'),
        hair: color('#ffffff12'),
        hair2: color('#ffffff1f'),
        t1: color('#f2f2f5'),
        t2: color('#b6b6c0'),
        t3: color('#8b8b96'),
        light: color('#7cf7ff'),
        attn: color('#ffce6a'),
        fail: color('#ff8080'),
      },
      lightScheme: { $type: 'boolean', $value: false },
    },
    typography: {
      interfaceScale: 1,
      readingScale: 1,
      codeScale: 1,
      lineHeight: 1.55,
      interfaceFont: 'schibsted-grotesk',
      readingFont: 'schibsted-grotesk',
      codeFont: 'ibm-plex-mono',
    },
    geometry: { controlRadius: 6, separatorStrength: 1, density: 'standard' },
    artwork: {},
    motion: { presetId: 'settle', duration: 160, intensity: 0.5, reducedMotionBehaviour: 'static' },
    assets: {},
    ...overrides,
  };
}

test('an autosaved draft writes only draft.json and never becomes the applied theme', async () => {
  const saved = await request('/themes/autosaved', 'PUT', { ...pack('autosaved'), draft: true });
  expect(saved.status).toBe(200);
  expect(saved.data.draft).toBe(true);

  const dir = await themeDir('autosaved');
  expect(await exists(path.join(dir, 'draft.json'))).toBe(true);
  // The four files a real save writes. None of them may exist.
  expect(await exists(path.join(dir, 'pack.json'))).toBe(false);
  expect(await exists(path.join(dir, 'revisions', '1.json'))).toBe(false);
  expect(await exists(path.join(dir, 'last-known-good.json'))).toBe(false);

  const settings = await request<Settings>('/settings');
  expect(settings.data.appearance.activeTheme ?? null).toBeNull();

  // Autosave again and again: still one file, still nothing applied.
  for (let n = 0; n < 3; n += 1) {
    const again = await request('/themes/autosaved', 'PUT', {
      ...pack('autosaved', { geometry: { controlRadius: n, separatorStrength: 1, density: 'standard' } }),
      draft: true,
    });
    expect(again.status).toBe(200);
  }
  expect(await exists(path.join(dir, 'pack.json'))).toBe(false);
  const active = await request('/themes/active');
  expect(active.data.pack).toBeNull();
});

test('a draft-only theme is listed as a draft and refuses to be applied', async () => {
  await request('/themes/only-a-draft', 'PUT', { ...pack('only-a-draft'), draft: true });

  const listed = await request('/themes');
  expect(listed.data.themes).toHaveLength(1);
  expect(listed.data.themes[0]).toMatchObject({
    id: 'only-a-draft',
    isDraft: true,
    hasDraft: true,
    active: false,
  });

  const applied = await request('/themes/only-a-draft/activate', 'POST');
  expect(applied.status).toBe(409);
  expect(errorCode(applied.data)).toBe('theme_is_draft');
  const settings = await request<Settings>('/settings');
  expect(settings.data.appearance.activeTheme ?? null).toBeNull();

  // Reading it hands back the draft so the editor can reopen what was in hand.
  const read = await request('/themes/only-a-draft');
  expect(read.status).toBe(200);
  expect(read.data.pack).toBeNull();
  expect(read.data.draft.pack.id).toBe('only-a-draft');
  expect(read.data.draft.basedOnRevision).toBe(0);
});

test('an explicit save overtakes the draft, clears it, and only then can be applied', async () => {
  await request('/themes/settled', 'PUT', { ...pack('settled'), draft: true });
  const dir = await themeDir('settled');
  expect(await exists(path.join(dir, 'draft.json'))).toBe(true);

  const saved = await request('/themes/settled', 'PUT', pack('settled'));
  expect(saved.status).toBe(200);
  expect(saved.data.revision).toBe(1);
  expect(await exists(path.join(dir, 'pack.json'))).toBe(true);
  expect(await exists(path.join(dir, 'draft.json'))).toBe(false);

  const listed = await request('/themes');
  expect(listed.data.themes[0]).toMatchObject({ isDraft: false, hasDraft: false, revision: 1 });

  const applied = await request('/themes/settled/activate', 'POST');
  expect(applied.status).toBe(200);
  const settings = await request<Settings>('/settings');
  expect(settings.data.appearance.activeTheme).toMatchObject({ id: 'settled', revision: 1 });
});

test('a draft beside a saved theme is reported, is refused as a pack field, and can be discarded', async () => {
  await request('/themes/both', 'PUT', pack('both'));
  await request('/themes/both', 'PUT', {
    ...pack('both', { name: 'Edited but not saved' }),
    draft: true,
  });

  const listed = await request('/themes');
  expect(listed.data.themes[0]).toMatchObject({ isDraft: false, hasDraft: true, revision: 1 });
  const read = await request('/themes/both');
  expect(read.data.pack.name).toBe('Theme both');
  expect(read.data.draft.pack.name).toBe('Edited but not saved');
  expect(read.data.draft.basedOnRevision).toBe(1);

  // `draft` is a fact about the save and takes one value. Anything else is
  // refused rather than read as "not a draft": a client that meant to autosave
  // and misspelled it would otherwise write a real revision.
  const smuggled = await request('/themes/both', 'PUT', {
    ...pack('both'),
    draft: 'yes-please',
  });
  expect(smuggled.status).toBe(400);
  expect(errorCode(smuggled.data)).toBe('invalid_draft_flag');

  const discarded = await request('/themes/both/draft', 'DELETE');
  expect(discarded.status).toBe(200);
  expect(await exists(path.join(await themeDir('both'), 'draft.json'))).toBe(false);
  const after = await request('/themes');
  expect(after.data.themes[0].hasDraft).toBe(false);
});

test('an autosave is not a way past validation, and needs no If-Match', async () => {
  const bad = await request('/themes/refused', 'PUT', {
    ...pack('refused', { name: '' }),
    draft: true,
  });
  expect(bad.status).toBe(400);
  expect(await exists(await themeDir('refused').then((dir) => path.join(dir, 'draft.json')))).toBe(
    false,
  );

  // A saved theme refuses a real save with no If-Match, but an autosave of the
  // same pack is accepted: an autosave that refused itself on a stale header
  // would simply stop saving while someone was still typing.
  await request('/themes/guarded', 'PUT', pack('guarded'));
  const unguarded = await request('/themes/guarded', 'PUT', pack('guarded'));
  expect(unguarded.status).toBe(409);
  const autosaved = await request('/themes/guarded', 'PUT', {
    ...pack('guarded'),
    draft: true,
  });
  expect(autosaved.status).toBe(200);
});

// ---------------------------------------------------------------------------
// The Website Studio probe
// ---------------------------------------------------------------------------

/** A stand-in studio that records exactly what headers it was addressed with. */
async function studio(
  answer: { status: number; body: string } | 'silent',
): Promise<{ port: number; seen: http.IncomingHttpHeaders[]; close(): Promise<void> }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const held: http.ServerResponse[] = [];
  const instance = http.createServer((req, res) => {
    seen.push(req.headers);
    if (answer === 'silent') {
      // Accept and never answer, so the caller's own budget is what ends it.
      held.push(res);
      return;
    }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(answer.body);
  });
  instance.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => instance.once('listening', resolve));
  return {
    port: (instance.address() as AddressInfo).port,
    seen,
    close: async () => {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    },
  };
}

test('the probe addresses loopback with Host and no Origin, and reports the version', async () => {
  const fake = await studio({
    status: 200,
    body: JSON.stringify({ ok: true, studio: 'website', version: '2.4.0' }),
  });
  try {
    const result = await probeWebsiteStudio({ host: '127.0.0.1', port: fake.port });
    expect(result.reachable).toBe(true);
    expect(result.version).toBe('2.4.0');
    expect(result.url).toBe(`http://127.0.0.1:${fake.port}/`);
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].host).toBe(`127.0.0.1:${fake.port}`);
    // Not a browser request, and it must not be mistaken for one.
    expect(fake.seen[0].origin).toBeUndefined();
  } finally {
    await fake.close();
  }
});

test('the probe refuses something that is not the studio, and nothing at all', async () => {
  const impostor = await studio({ status: 200, body: JSON.stringify({ ok: true }) });
  try {
    const result = await probeWebsiteStudio({ host: '127.0.0.1', port: impostor.port });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('Something else');
  } finally {
    await impostor.close();
  }

  // A closed port: nothing is listening, and the answer says so in one sentence.
  const closed = await studio({ status: 200, body: '{}' });
  const port = closed.port;
  await closed.close();
  const gone = await probeWebsiteStudio({ host: '127.0.0.1', port });
  expect(gone.reachable).toBe(false);
  expect(gone.detail).toContain('not running');
});

test('the probe gives up inside its budget rather than hanging the screen', async () => {
  const quiet = await studio('silent');
  try {
    const started = Date.now();
    const result = await probeWebsiteStudio({ host: '127.0.0.1', port: quiet.port, timeoutMs: 150 });
    expect(result.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    await quiet.close();
  }
});

test('the route answers the same thing, and nothing on this computer is listening', async () => {
  const probed = await request('/design-center/website-studio');
  expect(probed.status).toBe(200);
  expect(typeof probed.data.reachable).toBe('boolean');
  expect(probed.data.url).toBe('http://127.0.0.1:4400/');
  expect(typeof probed.data.detail).toBe('string');
});

/**
 * Export writes the file Import reads.
 *
 * The Design Center's Export used to write a bare `ThemePackV1` while its
 * Import required the package container, so a person who exported a theme and
 * then imported the same file was told it was not a Diomedes theme. Both halves
 * now go through `shared/theme-pack/package.ts`, and this is the assertion that
 * says so: the exact bytes that leave the Export button, parsed back in.
 */
test('a theme exported from the Design Center imports again unchanged', () => {
  const original = pack('round-trip');
  const exported = exportThemePackage(original, {});
  expect(exported.ok, exported.ok ? '' : exported.errors.join('; ')).toBe(true);
  if (!exported.ok) return;

  // What the Blob would carry: the container, serialized, nothing else.
  const onDisk = JSON.stringify(exported.package, null, 2);
  expect(THEME_PACKAGE_EXTENSION).toBe('.diomedes-theme');

  const back = importThemePackage(JSON.parse(onDisk));
  expect(back.ok, back.ok ? '' : back.errors.join('; ')).toBe(true);
  if (!back.ok) return;
  expect(back.pack).toEqual(original);
});

/**
 * The preview restates, scoped to the stage, every rule in `client/styles.css`
 * that is anchored to `html`.
 *
 * Custom properties inherit into the stage without help. `html[data-density]`,
 * `html[data-color-scheme]` and the rest do not: they select the document
 * element, and the stage is not it. Each one therefore has a `.dc-stage`
 * counterpart in `client/console/design-center.css`, or the preview quietly
 * shows the app's own density, colour scheme or contrast carve-out instead of
 * the theme being designed — which is the one thing this screen exists to do
 * honestly.
 *
 * This test is the thing that notices when a rule is added to one file and not
 * the other. A rule that deliberately has no counterpart goes in the allowlist
 * below **with the reason written down**, not silently.
 */
// Keys are written with double quotes because selectors are normalized to that
// form before they are looked up; the stylesheets themselves use single quotes.
const STAGE_RESTATEMENT_EXEMPT = new Map<string, string>([
  // The eleven built-in scheme blocks define --chrome, --surface, --t1 and the
  // rest. The resolver writes every one of those custom properties onto the
  // stage as an inline value from the theme's own tokens, which beats a
  // stylesheet rule, so restating them would be dead weight that could only go
  // stale. See resolve.ts's colour token map.
  ...(
    [
      'field',
      'deep-field',
      'graphite',
      'verdigris',
      'harbor',
      'cobalt',
      'ember',
      'moss',
      'dusk',
      'ink',
      'paper',
    ] as const
  ).map(
    (scheme) =>
      [
        `html[data-package="${scheme}"]`,
        'the resolver writes these tokens onto the stage inline',
      ] as [string, string],
  ),
  // The reduced-motion freeze. Restating it scoped to the stage is on the
  // ledger rather than done here, so the stage's reduced-motion preview zeroes
  // the duration channels (which it does restate) without reproducing the
  // `!important` blanket the document-level rule lays over every animation.
  ['html[data-motion="reduced"] *', 'ledger: the !important freeze is not reproduced'],
  ['html[data-motion="reduced"] *::before', 'ledger: the !important freeze is not reproduced'],
  ['html[data-motion="reduced"] *::after', 'ledger: the !important freeze is not reproduced'],
]);

/** Every selector in a stylesheet, comments removed, one per entry. */
function selectorsOf(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  // Selector groups are what sits between the end of the previous rule or block
  // and the next `{`. At-rule bodies are skipped by ignoring anything starting
  // with `@`, which is enough here: nothing inside a media query is anchored to
  // `html[data-`.
  for (const match of clean.matchAll(/(^|[{}])([^{}]+)\{/g)) {
    for (const part of match[2].split(',')) {
      const selector = part.trim().replace(/\s+/g, ' ');
      if (selector && !selector.startsWith('@')) found.push(selector);
    }
  }
  return found;
}

test('every html[data-…] rule in styles.css is restated for the preview stage', async () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const app = await fs.readFile(path.join(here, '..', 'client', 'styles.css'), 'utf8');
  const stage = await fs.readFile(
    path.join(here, '..', 'client', 'console', 'design-center.css'),
    'utf8',
  );
  const restated = new Set(selectorsOf(stage).map((s) => s.replace(/["']/g, '"')));

  const anchored = selectorsOf(app).filter((s) => s.startsWith('html[data-'));
  // If this is ever zero the test has stopped reading the file and is passing
  // for the wrong reason.
  expect(anchored.length).toBeGreaterThan(15);

  const missing: string[] = [];
  for (const selector of anchored) {
    const key = selector.replace(/["']/g, '"');
    if (STAGE_RESTATEMENT_EXEMPT.has(key)) continue;
    if (!restated.has(key.replace(/^html/, '.dc-stage'))) missing.push(selector);
  }
  expect(
    missing,
    `client/console/design-center.css does not restate these rules from client/styles.css, so the preview will show the app's own values instead of the theme being designed. Add a .dc-stage-scoped counterpart, or an allowlist entry saying why not: ${missing.join(' | ')}`,
  ).toEqual([]);
});

/**
 * A refusal must not cost a store recovery pass.
 *
 * `Store.locked` reads any throw as a failed write: it latches
 * `recoveryRequired` and runs `recoverAndReload()`, which re-reads every
 * project state and the settings file. In a shipped build the customization
 * entitlement is always absent, so *every* press of Apply is a 403 — and a 403
 * thrown inside the lock would pay for a full reload of the store each time.
 * The capability and the theme name are therefore settled before the lock is
 * taken, and this is the test that says so.
 *
 * The spy is on `Store.prototype`, which is the same class `createApp` builds,
 * and the last block is a positive control: a spy that never fires would pass
 * this test for the wrong reason.
 */
test('a refused activate and a malformed name never cost a store recovery pass', async () => {
  const recovered = vi.spyOn(Store.prototype as unknown as { recoverAndReload: () => Promise<void> }, 'recoverAndReload');
  try {
    await request('/themes/refusable', 'PUT', pack('refusable'));

    // The process runs on the `paid` fixture; this one request asks to be the
    // free one, which is what every shipped install is.
    const free = { 'X-Diomedes-Entitlement-Fixture': 'free' };
    const applied = await request('/themes/refusable/activate', 'POST', undefined, free);
    expect(applied.status).toBe(403);
    const restored = await request('/themes/refusable/restore/1', 'POST', undefined, free);
    expect(restored.status).toBe(403);

    // A name this app cannot store is the other refusal that used to throw
    // inside the lock. `ab` is too short for THEME_PACK_ID_PATTERN.
    expect((await request('/themes/ab/activate', 'POST')).status).toBe(400);
    expect((await request('/themes/ab/restore/1', 'POST')).status).toBe(400);
    expect((await request('/themes/ab/draft', 'DELETE')).status).toBe(400);
    // And a revision number that is not one.
    expect((await request('/themes/refusable/restore/0', 'POST')).status).toBe(400);

    expect(recovered).not.toHaveBeenCalled();

    // The store is not in a latched recovery state either: the next write works.
    const saved = await request('/themes/refusable', 'PUT', pack('refusable'), {
      'If-Match': '"1"',
    });
    expect(saved.status).toBe(200);
    expect(recovered).not.toHaveBeenCalled();

    // Positive control: a throw inside `locked` does reach `recoverAndReload`,
    // so the assertions above are about the routes and not about the spy.
    const control = new Store(path.join(root, 'control'), path.join(root, 'projects'));
    await control.init();
    recovered.mockClear();
    await expect(
      control.locked(() => Promise.reject(new Error('a failed write'))),
    ).rejects.toThrow('a failed write');
    expect(recovered).toHaveBeenCalledTimes(1);
  } finally {
    recovered.mockRestore();
  }
});

test('a bare pack is not a package, which is why Export must not write one', () => {
  // The old Export's output, checked explicitly so the regression cannot come
  // back quietly: a lone pack has no manifest and Import refuses it.
  const bare = importThemePackage(JSON.parse(JSON.stringify(pack('bare'))));
  expect(bare.ok).toBe(false);
});
