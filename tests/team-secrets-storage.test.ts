import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testOnlySecretBox, type SecretBox } from '../server/connection-secrets.js';
import { Store } from '../server/store.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function profile(box: SecretBox | null) {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  root ??= await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'team-secrets-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'), box);
  await store.init();
  return store;
}

const project = '0123456789ab';
const slot = 'S0123456789ab';
const token = 'a'.repeat(64);

test('desktop team tokens are sealed at rest and reopen with the same OS box', async () => {
  const box = testOnlySecretBox();
  const store = await profile(box);
  await store.writeTeamSecrets(project, { [slot]: token });
  const bytes = await fs.readFile(store.teamSecretsPath(project));
  expect(bytes.toString('utf8')).toContain('DIOMEDES-TEAM-SECRETS-V1');
  expect(bytes.toString('utf8')).not.toContain(token);
  expect(await (await profile(box)).readTeamSecrets(project)).toEqual({ [slot]: token });
  await expect((await profile(null)).readTeamSecrets(project)).rejects.toThrow(
    'Protected team token storage is unavailable',
  );
});

test('an older plaintext team file is replaced before its token is returned', async () => {
  const box = testOnlySecretBox();
  const store = await profile(box);
  const file = store.teamSecretsPath(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ [slot]: token }));
  expect(await store.readTeamSecrets(project)).toEqual({ [slot]: token });
  const bytes = await fs.readFile(file);
  expect(bytes.toString('utf8')).not.toContain(token);
  expect(await (await profile(box)).readTeamSecrets(project)).toEqual({ [slot]: token });
});

test('desktop refuses team token writes when protected storage is unavailable', async () => {
  const box: SecretBox = {
    kind: 'unavailable', available: () => false,
    seal: () => { throw new Error('must not seal'); },
    open: () => { throw new Error('must not open'); },
  };
  const store = await profile(box);
  await expect(store.writeTeamSecrets(project, { [slot]: token })).rejects.toThrow(
    'Protected team token storage is unavailable',
  );
  await expect(fs.readFile(store.teamSecretsPath(project))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('damaged legacy JSON never exposes token text in an error', async () => {
  const store = await profile(testOnlySecretBox());
  const file = store.teamSecretsPath(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `{ "${slot}": "${token}", broken }`);
  await expect(store.readTeamSecrets(project)).rejects.toThrow('The team credentials file is invalid.');
  try {
    await store.readTeamSecrets(project);
  } catch (error) {
    expect(String(error)).not.toContain(token);
  }
});
