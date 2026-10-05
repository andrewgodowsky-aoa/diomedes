/**
 * DIO-201: the local model's description, read from its folder's nectovia-connection.json. Each
 * refusal names the field, Bonsai's own file parses from a copy, and the folder comes from
 * Settings, then the environment, then nowhere. No test reads F:\Bonsai-2.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLocalProfile,
  localDeadlines,
  localModelCatalog,
  localProfileRefusal,
  localProfileSlug,
  localScriptPath,
  localSlug,
  parseLocalModelDescriptor,
} from '../shared/local-model.js';
import { FolderLocalModelSource, localModelFolder } from '../server/bonsai/descriptor.js';
import { BONSAI_DESCRIPTOR, BONSAI_FOLDER, MEADOW_FOLDER, MEADOW_MODEL, meadowDescriptor, writeLocalModelFolder } from './fixtures/local-model.js';

const FILE = 'nectovia-connection.json';
const bonsai = () => structuredClone(BONSAI_DESCRIPTOR) as Record<string, any>;
const refusal = (raw: unknown, folder = BONSAI_FOLDER) => {
  try {
    parseLocalModelDescriptor(raw, folder);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

describe("Bonsai's own description, from a copy of its file", () => {
  it('reads the name, the server, both profiles and both scripts, and ignores everything else', () => {
    const descriptor = parseLocalModelDescriptor(bonsai(), BONSAI_FOLDER);
    expect(descriptor).toMatchObject({
      folder: BONSAI_FOLDER,
      name: 'Bonsai 2 Local',
      model: 'bonsai-2-27b',
      baseUrl: 'http://127.0.0.1:18082/v1',
      serverRoot: 'http://127.0.0.1:18082',
      healthUrl: 'http://127.0.0.1:18082/health',
      lifecycle: { startScript: 'F:\\Bonsai-2\\Start-Bonsai.ps1', stopScript: 'F:\\Bonsai-2\\Stop-Bonsai.ps1', modeParameter: 'Mode' },
    });
    expect(descriptor.profiles.map((p) => [p.slug, p.mode, p.name, p.contextTokens, p.maxOutputTokens, p.inputModalities,
      p.defaultEffort, p.callTimeoutMs, p.turnTimeoutMs])).toEqual([
      ['local:gaming', 'Gaming', 'bonsai-2-27b Gaming', 16384, 4096, ['text'], 'medium', 120_000, 480_000],
      ['local:full', 'Full', 'bonsai-2-27b Full', 131072, 32768, ['text', 'image'], 'xhigh', 900_000, 1_800_000],
    ]);
    expect(descriptor.profiles.map((p) => p.description)).toEqual(['Text only, 16k context.', 'Text and images, 131k context.']);
    expect(Object.keys(descriptor)).not.toContain('mcpServer');
  });

  it('tolerates keys an installer adds later', () => {
    const raw = { ...bonsai(), installer: { version: 3 }, profiles: { ...bonsai().profiles,
      Gaming: { ...bonsai().profiles.Gaming, gpuLayers: 99 } } };
    expect(refusal(raw)).toBeNull();
  });

  it('keeps the deadlines the fixed profiles had, from each output allowance', () => {
    expect(localDeadlines(4096)).toEqual({ callTimeoutMs: 120_000, turnTimeoutMs: 480_000 });
    expect(localDeadlines(32768)).toEqual({ callTimeoutMs: 900_000, turnTimeoutMs: 1_800_000 });
    expect(localDeadlines(200_000)).toEqual({ callTimeoutMs: 1_800_000, turnTimeoutMs: 1_800_000 });
  });
});

describe('each refusal names the field', () => {
  it.each([
    ['https', 'https://127.0.0.1:18082/v1'],
    ['another computer', 'http://10.0.0.5:18082/v1'],
    ['a name that only looks local', 'http://127.0.0.1.example.com:18082/v1'],
    ['credentials', 'http://user:secret@127.0.0.1:18082/v1'],
    ['a query', 'http://127.0.0.1:18082/v1?key=1'],
  ])('a base URL with %s', (_case, url) => {
    expect(refusal({ ...bonsai(), openaiCompatibleBaseUrl: url })).toBe(
      `openaiCompatibleBaseUrl in ${FILE} must be plain http on this computer: 127.0.0.1, localhost or [::1].`);
  });

  it('accepts localhost and [::1] on plain http', () => {
    for (const host of ['localhost', '[::1]']) {
      const raw = { ...bonsai(), openaiCompatibleBaseUrl: `http://${host}:18082/v1`,
        lifecycle: { ...bonsai().lifecycle, healthUrl: `http://${host}:18082/health` } };
      expect(parseLocalModelDescriptor(raw, BONSAI_FOLDER).serverRoot).toBe(`http://${host}:18082`);
    }
  });

  it.each([
    ['another port', 'http://127.0.0.1:18083/health'],
    ['another host name', 'http://localhost:18082/health'],
    ['another computer', 'http://10.0.0.5:18082/health'],
  ])('a health URL on %s', (_case, url) => {
    expect(refusal({ ...bonsai(), lifecycle: { ...bonsai().lifecycle, healthUrl: url } })).toBe(
      `lifecycle.healthUrl in ${FILE} must be on the same address as openaiCompatibleBaseUrl.`);
  });

  it.each([
    ['another drive', 'D:\\Bonsai-2\\Start-Bonsai.ps1'],
    ['a step out of the folder', 'F:\\Bonsai-2\\..\\Start-Bonsai.ps1'],
    ['a step out from a relative name', '..\\Start-Bonsai.ps1'],
    ['a folder that only starts the same', 'F:\\Bonsai-2-old\\Start-Bonsai.ps1'],
    ['another kind of file', 'F:\\Bonsai-2\\Start-Bonsai.cmd'],
    ['a share', '\\\\server\\share\\Start-Bonsai.ps1'],
  ])('a start script on %s', (_case, script) => {
    expect(refusal({ ...bonsai(), lifecycle: { ...bonsai().lifecycle, startScript: script } })).toBe(
      `lifecycle.startScript in ${FILE} must be a .ps1 file inside ${BONSAI_FOLDER}.`);
  });

  it('a stop script outside the folder', () => {
    expect(refusal({ ...bonsai(), lifecycle: { ...bonsai().lifecycle, stopScript: 'C:\\Windows\\Stop.ps1' } })).toBe(
      `lifecycle.stopScript in ${FILE} must be a .ps1 file inside ${BONSAI_FOLDER}.`);
  });

  it('reads a relative script name from the folder, with either slash', () => {
    expect(localScriptPath('Start-Bonsai.ps1', BONSAI_FOLDER)).toBe('F:\\Bonsai-2\\Start-Bonsai.ps1');
    expect(localScriptPath('tools/Start.ps1', 'F:\\Bonsai-2\\')).toBe('F:\\Bonsai-2\\tools\\Start.ps1');
    expect(localScriptPath('f:\\bonsai-2\\Start-Bonsai.ps1', BONSAI_FOLDER)).toBe('F:\\Bonsai-2\\Start-Bonsai.ps1');
    expect(localScriptPath('Start.ps1', '/opt/models/meadow')).toBe('/opt/models/meadow/Start.ps1');
    expect(localScriptPath('/opt/other/Start.ps1', '/opt/models/meadow')).toBeNull();
  });

  it('a start argument with no parameter', () => {
    expect(refusal({ ...bonsai(), lifecycle: { ...bonsai().lifecycle, startModeArgument: 'Gaming or Full' } })).toBe(
      `lifecycle.startModeArgument in ${FILE} must start with the start script's parameter, such as -Mode.`);
  });

  it('a description with no profiles', () => {
    expect(refusal({ ...bonsai(), profiles: {} })).toBe(`profiles in ${FILE} lists no profile.`);
  });

  it.each([
    [{ name: undefined }, `${FILE} has no valid name.`],
    [{ model: '' }, `${FILE} has no valid model.`],
    [{ openaiCompatibleBaseUrl: 18082 }, `${FILE} has no valid openaiCompatibleBaseUrl.`],
    [{ lifecycle: undefined }, `${FILE} has no valid lifecycle.`],
    [{ profiles: { Gaming: { contextTokens: 16384, inputModalities: ['text'] } } }, `${FILE} has no valid profiles.Gaming.outputTokens.`],
  ])('a missing or wrong field: %j', (change, sentence) => {
    expect(refusal({ ...bonsai(), ...change })).toBe(sentence);
  });

  it('a profile name that cannot be a script argument, one that repeats, or one without text', () => {
    const profile = bonsai().profiles.Gaming;
    expect(refusal({ ...bonsai(), profiles: { 'Full mode': profile } })).toBe(
      `profiles in ${FILE} has a profile named "Full mode". A profile name starts with a letter and uses only letters, digits, - and _.`);
    expect(refusal({ ...bonsai(), profiles: { Full: profile, full: profile } })).toBe(`profiles in ${FILE} has two profiles named "full".`);
    expect(refusal({ ...bonsai(), profiles: { Gaming: { ...profile, inputModalities: ['image'] } } })).toBe(
      `profiles.Gaming.inputModalities in ${FILE} must include text.`);
    expect(refusal({ ...bonsai(), profiles: { Gaming: { ...profile, outputTokens: 16384 } } })).toBe(
      `profiles.Gaming.outputTokens in ${FILE} must be smaller than its contextTokens.`);
  });

  it('refuses something that is not a description at all', () => {
    expect(refusal(null)).toBe(`${FILE} is not a local model description.`);
    expect(refusal([])).toBe(`${FILE} is not a local model description.`);
  });
});

describe('profile slugs', () => {
  const bonsaiModel = parseLocalModelDescriptor(bonsai(), BONSAI_FOLDER);
  const meadow = parseLocalModelDescriptor(meadowDescriptor(), MEADOW_FOLDER);

  it('lists each profile as local: and its name in lower case', () => {
    expect(localProfileSlug('Deep')).toBe('local:deep');
    expect(meadow.profiles.map((profile) => profile.slug)).toEqual(['local:quick', 'local:deep']);
    expect(meadow.lifecycle).toEqual({ startScript: 'D:\\Models\\Meadow\\Start-Meadow.ps1',
      stopScript: 'D:\\Models\\Meadow\\scripts\\Stop-Meadow.ps1', modeParameter: 'Profile' });
  });

  it('maps the slugs saved before profiles came from the description', () => {
    expect(localSlug('bonsai-gaming')).toBe('local:gaming');
    expect(localSlug('bonsai-full')).toBe('local:full');
    expect(localSlug('local:deep')).toBe('local:deep');
    expect(localSlug(null)).toBeNull();
    expect(findLocalProfile(bonsaiModel, 'bonsai-gaming')?.mode).toBe('Gaming');
    expect(findLocalProfile(bonsaiModel, 'bonsai-full')?.mode).toBe('Full');
    expect(findLocalProfile(bonsaiModel, 'local:full')?.mode).toBe('Full');
  });

  it('refuses a saved slug whose profile this description lacks, and an unknown slug, in plain words', () => {
    expect(findLocalProfile(meadow, 'bonsai-gaming')).toBeUndefined();
    expect(localProfileRefusal('bonsai-gaming')).toBe('The local model has no Gaming profile now. Choose one of its profiles.');
    expect(findLocalProfile(meadow, 'local:gaming')).toBeUndefined();
    expect(localProfileRefusal('local:gaming')).toBe('Choose a local model profile.');
    expect(localProfileRefusal(undefined)).toBe('Choose a local model profile.');
  });

  it('names the catalogue for the model the server lists and uses the context it reports', () => {
    const running = localModelCatalog(meadow, { state: 'ready', installed: true, mode: 'Deep', model: MEADOW_MODEL,
      contextTokens: 131072, owned: false, detail: '' });
    expect(running.map((profile) => [profile.slug, profile.name, profile.contextTokens])).toEqual([
      ['local:quick', 'meadow-9b Quick', 16384],
      ['local:deep', 'meadow-9b Deep', 131072],
    ]);
    const stopped = localModelCatalog(meadow, { state: 'unloaded', installed: true, mode: null, owned: false, detail: '' });
    expect(stopped.map((profile) => profile.name)).toEqual(['meadow-9b Quick', 'meadow-9b Deep']);
  });
});

describe('where the folder comes from', () => {
  it('reads Settings first, then NECTOVIA_LOCAL_MODEL_HOME, then NECTOVIA_BONSAI_HOME, then nothing', () => {
    const env = { NECTOVIA_LOCAL_MODEL_HOME: 'E:\\Local', NECTOVIA_BONSAI_HOME: 'F:\\Bonsai-2' };
    expect(localModelFolder('D:\\Models\\Meadow', env)).toEqual({ path: 'D:\\Models\\Meadow', source: 'settings' });
    expect(localModelFolder(null, env)).toEqual({ path: 'E:\\Local', source: 'environment' });
    expect(localModelFolder('  ', { NECTOVIA_BONSAI_HOME: 'F:\\Bonsai-2' })).toEqual({ path: 'F:\\Bonsai-2', source: 'environment' });
    expect(localModelFolder(undefined, {})).toBeNull();
    expect(localModelFolder(null, { NECTOVIA_LOCAL_MODEL_HOME: ' ' })).toBeNull();
  });
});

describe('the folder on disk', () => {
  let root: string;
  let folder: string;
  let setting: string | null;
  let env: Record<string, string | undefined>;
  let source: FolderLocalModelSource;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-route-folder-'));
    folder = path.join(root, 'meadow');
    setting = folder;
    env = {};
    source = new FolderLocalModelSource({ setting: () => setting, env });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads a folder whose description and scripts pass every check', () => {
    writeLocalModelFolder(folder, meadowDescriptor());
    const setup = source.read();
    expect(setup.kind).toBe('ready');
    if (setup.kind !== 'ready') return;
    expect(setup.folder).toEqual({ path: folder, source: 'settings' });
    expect(setup.descriptor.name).toBe('Meadow Local');
    expect(setup.descriptor.lifecycle.startScript).toBe(path.join(folder, 'Start-Meadow.ps1'));
    expect(source.read()).toBe(setup);
  });

  it('reads the description again when it changes', () => {
    writeLocalModelFolder(folder, meadowDescriptor());
    const first = source.read();
    const changed = meadowDescriptor();
    changed.name = 'Meadow Local, second build';
    fs.writeFileSync(path.join(folder, 'nectovia-connection.json'), JSON.stringify(changed, null, 1));
    const second = source.read();
    expect(second.kind === 'ready' && second.descriptor.name).toBe('Meadow Local, second build');
    expect(second.kind === 'ready' && first.kind === 'ready' && second.key !== first.key).toBe(true);
  });

  it('reads the environment when Settings names no folder, and nothing when neither does', () => {
    writeLocalModelFolder(folder, meadowDescriptor());
    setting = null;
    expect(source.read()).toEqual({ kind: 'none' });
    env.NECTOVIA_LOCAL_MODEL_HOME = folder;
    const setup = source.read();
    expect(setup.kind === 'ready' && setup.folder).toEqual({ path: folder, source: 'environment' });
  });

  it('says what is wrong with a folder it cannot use', () => {
    expect(source.read()).toEqual({ kind: 'invalid', folder: { path: folder, source: 'settings' },
      detail: `There is no ${FILE} in ${folder}.` });
    writeLocalModelFolder(folder, meadowDescriptor());
    fs.writeFileSync(path.join(folder, FILE), '{ "name": ');
    expect(source.read()).toMatchObject({ kind: 'invalid', detail: `${FILE} in ${folder} is not valid JSON.` });
    fs.writeFileSync(path.join(folder, FILE), `{"name":"x","pad":"${'x'.repeat(70 * 1024)}"}`);
    expect(source.read()).toMatchObject({ kind: 'invalid', detail: `${FILE} in ${folder} is larger than 64 KB.` });
    setting = 'models\\meadow';
    expect(source.read()).toMatchObject({ kind: 'invalid', detail: 'The local model folder must be a full path, such as F:\\Models\\Local.' });
  });

  it('refuses a script the description names but the folder does not have', () => {
    writeLocalModelFolder(folder, meadowDescriptor());
    fs.rmSync(path.join(folder, 'Start-Meadow.ps1'));
    expect(source.read()).toMatchObject({ kind: 'invalid',
      detail: `lifecycle.startScript in ${FILE} names ${path.join(folder, 'Start-Meadow.ps1')}, which does not exist.` });
  });

  it('refuses a script that resolves outside the folder through a link', () => {
    writeLocalModelFolder(folder, meadowDescriptor());
    // The stop script's own folder is a link to somewhere else, with a script of the same name there.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'Stop-Meadow.ps1'), '# A test fixture. It is never run.\n');
    fs.rmSync(path.join(folder, 'scripts'), { recursive: true });
    fs.symlinkSync(outside, path.join(folder, 'scripts'), 'junction');
    expect(source.read()).toMatchObject({ kind: 'invalid',
      detail: `lifecycle.stopScript in ${FILE} must be a .ps1 file inside ${folder}.` });
  });

  it('refuses a description the shared checks refuse, with their sentence', () => {
    writeLocalModelFolder(folder, { ...meadowDescriptor(), profiles: {} });
    expect(source.read()).toMatchObject({ kind: 'invalid', detail: `profiles in ${FILE} lists no profile.` });
  });
});
