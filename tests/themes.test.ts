/**
 * Design Studio storage, proven through the real HTTP surface.
 *
 * The claims under test are the ones A2 makes and nothing else: one account
 * cannot see another's themes, a recorded revision cannot be rewritten, a pack
 * that has been corrupted on disk is skipped rather than applied and the app
 * falls back to the last one that worked and then to the built-in scheme, and
 * `validateSettings` keeps the two new appearance fields instead of dropping
 * them silently.
 *
 * A second person is simulated the way tests/workspaces.test.ts does it: by
 * restarting the host with a different `workspaces/identity.json`, which is the
 * labelled development fixture this build uses in place of an identity service.
 * Nothing here calls a provider or reaches the network.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { themeScopeKey } from '../server/themes.js';
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

/**
 * A5 gates theme authoring on the customization capability, so this file — which
 * is about storage, not about who may pay for it — runs on the named `paid`
 * fixture. The gate reads the environment when the app is built, so it is set
 * before `createApp`. `tests/customization-entitlement.test.ts` is where the
 * refusals are proven.
 */
function payFor() {
  process.env.DIOMEDES_TEST_MODE = '1';
  process.env.DIOMEDES_ENTITLEMENT_FIXTURE = 'paid';
}

async function launch() {
  payFor();
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function stop() {
  if (!server) return;
  const current = server;
  server = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

const identityPath = () => path.join(root, 'data', 'workspaces', 'identity.json');

/** Restart the host as whoever it was, so a stored pointer is read back fresh. */
async function restart() {
  await stop();
  await launch();
}

/** Restart the host as a different local person against the same data dir. */
async function restartAs(name: string): Promise<Person> {
  await stop();
  const current = JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;
  const next = { ...current, id: `person_${name}`, name };
  await fs.writeFile(identityPath(), JSON.stringify(next, null, 2), 'utf8');
  await launch();
  return next;
}

const currentPerson = async (): Promise<Person> =>
  JSON.parse(await fs.readFile(identityPath(), 'utf8')) as Person;

const PERSONAL: WorkspaceRef = { kind: 'personal' };

const themeDir = (person: Person, id: string) =>
  path.join(root, 'data', 'themes', themeScopeKey(PERSONAL, person.id), id);

/** A minimal valid pack. The fixtures carry artwork; this carries only tokens. */
function pack(id: string, overrides: Partial<ThemePackV1> = {}): ThemePackV1 {
  const color = (value: string) => ({ $type: 'color' as const, $value: value });
  return {
    schemaVersion: 1,
    id,
    name: `Theme ${id}`,
    revision: 1,
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: {
      author: 'A2 test',
      createdAt: '2026-09-17T00:00:00.000Z',
      tool: 'vitest',
    },
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
    motion: {
      presetId: 'settle',
      duration: 160,
      intensity: 0.5,
      reducedMotionBehaviour: 'static',
    },
    assets: {},
    ...overrides,
  } as ThemePackV1;
}

const save = (id: string, body: ThemePackV1, revision?: number) =>
  request<{ pack: ThemePackV1; revision: number }>(
    `/themes/${id}`,
    'PUT',
    body,
    revision === undefined ? {} : { 'If-Match': `"${revision}"` },
  );

const errorCode = (data: unknown): string | undefined => {
  const value = data as { error?: { code?: string }; code?: string } | null;
  return value?.error?.code ?? value?.code;
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-themes-'));
  await launch();
});

afterEach(async () => {
  await stop();
  delete process.env.DIOMEDES_TEST_MODE;
  delete process.env.DIOMEDES_ENTITLEMENT_FIXTURE;
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

test('a theme is saved, listed, read back and applied', async () => {
  const created = await save('midnight-quiet', pack('midnight-quiet'));
  expect(created.status).toBe(200);
  expect(created.data.revision).toBe(1);

  const listed = await request<{ themes: { id: string; name: string; active: boolean }[] }>(
    '/themes',
  );
  expect(listed.data.themes.map((entry) => entry.id)).toEqual(['midnight-quiet']);
  expect(listed.data.themes[0].active).toBe(false);

  const activated = await request<{ settings: Settings }>(
    '/themes/midnight-quiet/activate',
    'POST',
  );
  expect(activated.status).toBe(200);
  expect(activated.data.settings.appearance.activeTheme).toEqual({
    id: 'midnight-quiet',
    revision: 1,
    // Applying records which scope's storage the theme came from; a pointer
    // without it would name a folder the next workspace has no copy of.
    scope: themeScopeKey(PERSONAL, (await currentPerson()).id),
  });

  const active = await request<{ pack: ThemePackV1 | null; source: string; notice: null }>(
    '/themes/active',
  );
  expect(active.data.source).toBe('pack');
  expect(active.data.pack?.id).toBe('midnight-quiet');
  expect(active.data.notice).toBe(null);

  // Reset returns to the base scheme and leaves the theme itself on disk.
  const reset = await request<{ settings: Settings }>('/themes/reset', 'POST');
  expect(reset.data.settings.appearance.activeTheme).toBe(null);
  expect((await request<{ themes: unknown[] }>('/themes')).data.themes).toHaveLength(1);
});

test('two accounts cannot see each other’s themes', async () => {
  const alice = await restartAs('alice');
  expect((await save('alice-dusk', pack('alice-dusk'))).status).toBe(200);

  const bob = await restartAs('bob');
  expect(themeScopeKey(PERSONAL, bob.id)).not.toBe(themeScopeKey(PERSONAL, alice.id));
  expect((await request<{ themes: unknown[] }>('/themes')).data.themes).toEqual([]);
  expect((await request('/themes/alice-dusk')).status).toBe(404);

  // Bob may use the same theme name; it is a different theme in a different place.
  expect((await save('alice-dusk', pack('alice-dusk'))).status).toBe(200);
  const bobDir = themeDir(bob, 'alice-dusk');
  const aliceDir = themeDir(alice, 'alice-dusk');
  expect(bobDir).not.toBe(aliceDir);
  await fs.access(path.join(aliceDir, 'pack.json'));
  await fs.access(path.join(bobDir, 'pack.json'));
});

/**
 * The applied-theme pointer lives in the one global settings file; the themes
 * themselves live per scope. Without the scope recorded beside it, a pointer
 * written in one workspace names a folder the next workspace has no copy of —
 * and the app greets a switch with "the theme you chose could not be read".
 *
 * A theme applied elsewhere is not a theme that failed. It is simply not here:
 * the built-in appearance, no sentence, and the pointer left exactly as it is
 * so that switching back puts the theme back.
 */
test('a theme applied in one scope is not applied — and not a failure — in another', async () => {
  const alice = await restartAs('alice');
  await save('quiet-hours', pack('quiet-hours'));
  const applied = await request<{ settings: Settings }>('/themes/quiet-hours/activate', 'POST');
  expect(applied.status).toBe(200);
  expect(applied.data.settings.appearance.activeTheme?.scope).toBe(
    themeScopeKey(PERSONAL, alice.id),
  );
  expect((await request<{ source: string }>('/themes/active')).data.source).toBe('pack');

  await restartAs('beatrix');
  // The pointer is untouched — it is one file for the whole install — but this
  // scope has no such theme, so the built-in appearance shows, with no notice.
  const foreign = await request<{
    pack: unknown;
    source: string;
    notice: string | null;
    applies: boolean;
  }>('/themes/active');
  expect(foreign.data.pack).toBe(null);
  expect(foreign.data.source).toBe('none');
  expect(foreign.data.notice).toBe(null);
  // Not this workspace's pointer, so this workspace is not offered the control
  // that clears it — the other half of the same flag.
  expect(foreign.data.applies).toBe(false);
  // Nor is another scope's pointer allowed to claim a theme that happens to
  // share its name here.
  await save('quiet-hours', pack('quiet-hours', { name: 'Beatrix’s own' }));
  const listed = await request<{ themes: { id: string; active: boolean }[] }>('/themes');
  expect(listed.data.themes).toEqual([expect.objectContaining({ id: 'quiet-hours', active: false })]);
  const untouched = await request<Settings>('/settings');
  expect(untouched.data.appearance.activeTheme).toMatchObject({
    id: 'quiet-hours',
    scope: themeScopeKey(PERSONAL, alice.id),
  });

  // Nor may this scope put away a theme it is not wearing. Reset answers, and
  // changes nothing: the pointer belongs to a workspace this person is not in,
  // and clearing it would undo a choice made there.
  const reset = await request<{ settings: Settings }>('/themes/reset', 'POST');
  expect(reset.status).toBe(200);
  expect(reset.data.settings.appearance.activeTheme).toMatchObject({
    id: 'quiet-hours',
    scope: themeScopeKey(PERSONAL, alice.id),
  });

  // Back where it was applied, the theme is applied again.
  await restartAs('alice');
  const home = await request<{ pack: ThemePackV1 | null; source: string; applies: boolean }>(
    '/themes/active',
  );
  expect(home.data.source).toBe('pack');
  expect(home.data.pack?.id).toBe('quiet-hours');
  expect(home.data.applies).toBe(true);
  // And here, where it *is* applied, reset still works.
  const cleared = await request<{ settings: Settings }>('/themes/reset', 'POST');
  expect(cleared.data.settings.appearance.activeTheme).toBe(null);
});

test('a pointer written before scopes were recorded is still honoured', async () => {
  await save('legacy', pack('legacy'));
  // Exactly the shape an install upgrading from 0.1.2 has on disk: an id and a
  // revision and nothing else. It must keep painting rather than become a
  // silent no-theme.
  const stored = await request<Settings>('/settings', 'PUT', {
    appearance: { activeTheme: { id: 'legacy', revision: 1 } },
  });
  expect(stored.status).toBe(200);
  expect(stored.data.appearance.activeTheme).toEqual({ id: 'legacy', revision: 1 });
  const active = await request<{ pack: ThemePackV1 | null; source: string }>('/themes/active');
  expect(active.data.source).toBe('pack');
  expect(active.data.pack?.id).toBe('legacy');
  expect((await request<{ themes: { active: boolean }[] }>('/themes')).data.themes[0].active).toBe(
    true,
  );
});

test('a recorded revision is never rewritten, and restore only ever moves forward', async () => {
  const person = await currentPerson();
  await save('layered', pack('layered', { name: 'First' }));
  const second = await save('layered', pack('layered', { name: 'Second' }), 1);
  expect(second.data.revision).toBe(2);

  const first = JSON.parse(
    await fs.readFile(path.join(themeDir(person, 'layered'), 'revisions', '1.json'), 'utf8'),
  ) as ThemePackV1;
  expect(first.name).toBe('First');
  expect(first.revision).toBe(1);

  // Saving without the revision you were editing is refused, not merged.
  const unguarded = await save('layered', pack('layered', { name: 'Third' }));
  expect(unguarded.status).toBe(409);
  expect(errorCode(unguarded.data)).toBe('theme_revision_required');

  // So is saving against a revision that has moved.
  const stale = await save('layered', pack('layered', { name: 'Third' }), 1);
  expect(stale.status).toBe(409);
  expect(errorCode(stale.data)).toBe('theme_revision_conflict');

  const restored = await request<{ pack: ThemePackV1; revision: number }>(
    '/themes/layered/restore/1',
    'POST',
  );
  expect(restored.status).toBe(200);
  expect(restored.data.revision).toBe(3);
  expect(restored.data.pack.name).toBe('First');

  const history = await request<{ revisions: number[] }>('/themes/layered');
  expect(history.data.revisions).toEqual([1, 2, 3]);
  // Revision 1 still says what it always said.
  const stillFirst = JSON.parse(
    await fs.readFile(path.join(themeDir(person, 'layered'), 'revisions', '1.json'), 'utf8'),
  ) as ThemePackV1;
  expect(stillFirst.name).toBe('First');
});

test('a corrupt active pack falls back to last-known-good, then to the base scheme', async () => {
  const person = await currentPerson();
  await save('fragile', pack('fragile', { name: 'Working' }));
  await request('/themes/fragile/activate', 'POST');
  const dir = themeDir(person, 'fragile');

  await fs.writeFile(path.join(dir, 'pack.json'), '{ this is not json', 'utf8');
  const fallback = await request<{ pack: ThemePackV1 | null; source: string; notice: string }>(
    '/themes/active',
  );
  expect(fallback.data.source).toBe('last-known-good');
  expect(fallback.data.pack?.name).toBe('Working');
  expect(fallback.data.notice).toContain('Working');

  // A corrupt pack is skipped in the listing rather than breaking it.
  expect((await request<{ themes: unknown[] }>('/themes')).data.themes).toEqual([]);

  await fs.writeFile(path.join(dir, 'last-known-good.json'), '{ "schemaVersion": 9 }', 'utf8');
  const bare = await request<{ pack: null; source: string; notice: string; applies: boolean }>(
    '/themes/active',
  );
  expect(bare.data.source).toBe('none');
  expect(bare.data.pack).toBe(null);
  expect(bare.data.notice).toBeTruthy();
  // Nothing can be read through it and it is still this person's pointer, so
  // the way back to the built-in package must stay offered. `pack` being null
  // does not say that — it is null for another workspace's pointer too — which
  // is the whole reason this flag is separate.
  expect(bare.data.applies).toBe(true);

  // A theme pointed at nothing at all is the same story, not a failure.
  await fs.rm(dir, { recursive: true, force: true });
  const gone = await request<{ pack: null; source: string; notice: string; applies: boolean }>(
    '/themes/active',
  );
  expect(gone.data.source).toBe('none');
  expect(gone.data.notice).toBeTruthy();
  expect(gone.data.applies).toBe(true);
  // The pointer is still saved: nothing here quietly edits settings behind a read.
  const settings = await request<Settings>('/settings');
  expect(settings.data.appearance.activeTheme?.id).toBe('fragile');

  // And the way back works from exactly this state.
  const cleared = await request<{ settings: Settings }>('/themes/reset', 'POST');
  expect(cleared.status).toBe(200);
  expect(cleared.data.settings.appearance.activeTheme).toBe(null);
  const after = await request<{ notice: string | null; applies: boolean }>('/themes/active');
  expect(after.data.notice).toBe(null);
  expect(after.data.applies).toBe(false);
});

test('a pack that was not built for this app is refused', async () => {
  const websiteOnly = await save(
    'website-only',
    pack('website-only', { surfaces: ['website'] as ThemePackV1['surfaces'] }),
  );
  expect(websiteOnly.status).toBe(400);
  expect(errorCode(websiteOnly.data)).toBe('theme_incompatible');

  const mismatch = await save('one-name', pack('other-name'));
  expect(mismatch.status).toBe(400);
  expect(errorCode(mismatch.data)).toBe('theme_id_mismatch');

  const nonsense = await request('/themes/broken-pack', 'PUT', { schemaVersion: 1 });
  expect(nonsense.status).toBe(400);
  expect(errorCode(nonsense.data)).toBe('invalid_theme_pack');

  // Nothing was written for any of them.
  expect((await request<{ themes: unknown[] }>('/themes')).data.themes).toEqual([]);
});

test('validateSettings keeps the two new appearance fields, and refuses a bad one', async () => {
  const saved = await request<Settings>('/settings', 'PUT', {
    appearance: { activeTheme: { id: 'midnight-quiet', revision: 4 }, textureOff: true },
  });
  expect(saved.status).toBe(200);
  expect(saved.data.appearance.activeTheme).toEqual({ id: 'midnight-quiet', revision: 4 });
  expect(saved.data.appearance.textureOff).toBe(true);
  // A pointer at a theme that is not there is a notice, never a saving failure.
  expect((await request<Settings>('/settings')).data.appearance.activeTheme?.revision).toBe(4);

  const cleared = await request<Settings>('/settings', 'PUT', {
    appearance: { activeTheme: null, textureOff: false },
  });
  expect(cleared.data.appearance.activeTheme).toBe(null);
  expect(cleared.data.appearance.textureOff).toBe(false);

  for (const bad of [
    { id: 'Not A Theme Id', revision: 1 },
    { id: 'fine-theme', revision: 0 },
    { id: 'fine-theme', revision: 1.5 },
    { id: 'fine-theme', revision: 1, extra: true },
  ])
    expect(
      (await request('/settings', 'PUT', { appearance: { activeTheme: bad } })).status,
      JSON.stringify(bad),
    ).toBe(400);
  expect((await request('/settings', 'PUT', { appearance: { textureOff: 'yes' } })).status).toBe(
    400,
  );
});

test('editing the applied theme moves the pointer with it, and it survives a restart', async () => {
  await save('living', pack('living', { name: 'Before' }));
  await request('/themes/living/activate', 'POST');
  const edited = await save('living', pack('living', { name: 'After' }), 1);
  expect(edited.data.revision).toBe(2);
  const settings = await request<Settings>('/settings');
  expect(settings.data.appearance.activeTheme).toMatchObject({ id: 'living', revision: 2 });
  const active = await request<{ pack: ThemePackV1 }>('/themes/active');
  expect(active.data.pack.name).toBe('After');

  // The pointer is a stored setting, so it has to come back through readJson
  // and migrateSettings intact: the app paints the theme after a restart, not
  // the base scheme.
  await restart();
  const reread = await request<Settings>('/settings');
  expect(reread.data.appearance.activeTheme).toMatchObject({ id: 'living', revision: 2 });
  const stillActive = await request<{ pack: ThemePackV1; source: string }>('/themes/active');
  expect(stillActive.data.source).toBe('pack');
  expect(stillActive.data.pack.name).toBe('After');
});

test('a theme cannot take a name the route table already spells', async () => {
  const shadow = await save('active', pack('active'));
  expect(shadow.status).toBe(400);
  expect(errorCode(shadow.data)).toBe('reserved_theme_id');
  // The read of what is applied still answers, rather than a theme called active.
  expect((await request<{ source: string }>('/themes/active')).data.source).toBe('none');
});

test('the desktop titlebar derives the theme scope the same way this service does', async () => {
  // desktop/main.mjs is the Electron shell and cannot import this service, so
  // its themeScopeKey is a copy. Importing the file would start Electron, so
  // its one function is lifted out of the source text and run here, and its
  // answers are compared against this service's own — in both directions, for
  // both kinds of workspace. A fragment check would pass a copy that had been
  // reworded; this fails the moment the two stop agreeing on a key.
  const shell = await fs.readFile(path.join(process.cwd(), 'desktop', 'main.mjs'), 'utf8');
  const start = shell.indexOf('function themeScopeKey(');
  expect(start, 'desktop/main.mjs no longer defines themeScopeKey').toBeGreaterThan(-1);
  const end = shell.indexOf('\n}', start);
  expect(end, 'desktop/main.mjs themeScopeKey is never closed').toBeGreaterThan(start);
  const lifted = new Function(
    'createHash',
    `${shell.slice(start, end + 2)}\nreturn themeScopeKey;`,
  )(createHash) as (workspace: unknown, personId: string) => string;

  const business: WorkspaceRef = { kind: 'business', organizationId: 'org_Ab3-xY9z' };
  for (const [workspace, personId] of [
    [PERSONAL, 'person_abc123'],
    [PERSONAL, 'person_ZZZ'],
    [business, 'person_abc123'],
  ] as const) {
    expect(lifted(workspace, personId)).toBe(themeScopeKey(workspace, personId));
    expect(lifted(workspace, personId)).toMatch(/^(personal|business)-[0-9a-f]{16}$/);
  }
  // Two accounts must not land in one folder on either side of the copy.
  expect(lifted(PERSONAL, 'person_abc123')).not.toBe(lifted(PERSONAL, 'person_ZZZ'));
  expect(lifted(business, 'person_abc123')).not.toBe(lifted(PERSONAL, 'person_abc123'));
  // The path the shell then reads is not inside that function, so it is checked
  // as text: the layout this service writes is the layout the shell opens.
  expect(shell).toContain("'themes', scope, active.id, 'pack.json'");
});
