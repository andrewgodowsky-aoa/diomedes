import { createHash } from 'node:crypto';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Desktop-shell close-and-install handoff. No test touches the network, starts
// a real helper process or runs a real installer: files are disposable fakes
// under test-results, and the process/clock seams are injected.
const appUpdates = await import(new URL('../desktop/app-updates.mjs', import.meta.url).href);
const updateHelper = await import(new URL('../desktop/update-helper.mjs', import.meta.url).href);

const VERSION = '0.1.2';
const ASSET = `Diomedes-Experimental-${VERSION}-unsigned-setup.exe`;
const MARKER = '.diomedes-experimental-20260909';
const MARKER_CONTENT = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001';

it('opens only official stable release-note references', () => {
  const base = 'https://github.com/andrewgodowsky-aoa/diomedes/releases';
  for (const url of [base, `${base}/tag/v0.1.2`, `${base}/tag/1.2.3`])
    expect(appUpdates.isUpdateReleaseReference(url)).toBe(true);
  for (const url of [
    `${base}/tag/v0.1.2?redirect=evil`,
    `${base}/tag/v0.1.2#fragment`,
    `${base}/tag/v01.2.3`,
    `${base}/tag/v1.2.3/extra`,
    `${base}-untrusted/tag/v1.2.3`,
    'https://github.com/another/repo/releases/tag/v1.2.3',
    'file:///C:/Windows',
  ])
    expect(appUpdates.isUpdateReleaseReference(url)).toBe(false);
});

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'desktop-updates-'));
  dirs.push(dir);
  return dir;
}

function digestOf(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureBytes(size = 2048, fill = 9): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

/** Write a disposable staged installer inside the owned <dataDir>/updates dir. */
async function staging(root: string) {
  const dataDir = path.join(root, 'data');
  const ownedDir = path.join(dataDir, 'updates');
  await fs.mkdir(ownedDir, { recursive: true });
  const bytes = fixtureBytes();
  const filePath = path.join(ownedDir, ASSET);
  await fs.writeFile(filePath, bytes);
  const artifact = {
    path: filePath,
    sha256: digestOf(bytes),
    size: bytes.length,
    version: VERSION,
  };
  return { dataDir, ownedDir, filePath, bytes, artifact };
}

async function installRootFor(root: string): Promise<{ installRoot: string; execPath: string }> {
  const installRoot = path.join(root, 'Programs', 'Diomedes Experimental 20260909');
  await fs.mkdir(installRoot, { recursive: true });
  await fs.writeFile(path.join(installRoot, MARKER), MARKER_CONTENT);
  return { installRoot, execPath: path.join(installRoot, 'app', 'Diomedes.exe') };
}

/** A fake child missing only the pieces the handoff uses; tests drive its events. */
function fakeChild(options: { autoSpawn?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      return true;
    }),
    unref: vi.fn(),
  });
  if (options.autoSpawn) setImmediate(() => child.emit('spawn'));
  return child;
}

/** Build a ready-to-hand-off shell: installed marker, staged file, ack already present. */
async function readyShell(root: string, overrides: Record<string, unknown> = {}) {
  const { dataDir, ownedDir, filePath, artifact, bytes } = await staging(root);
  const { installRoot, execPath } = await installRootFor(root);
  const helperPath = path.join(root, 'desktop', 'update-helper.mjs');
  const child = fakeChild();
  const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
  const token = 'test-token';
  const handoffDir = path.join(dataDir, 'update-handoff');
  await fs.mkdir(handoffDir, { recursive: true });
  const readyFile = path.join(handoffDir, `${token}.ready.json`);
  await fs.writeFile(
    readyFile,
    JSON.stringify({
      schema: 1,
      ready: true,
      parentPid: process.pid,
      helperPid: child.pid,
      artifact,
    }),
  );
  const shell = await appUpdates.updateShellConfig({
    platform: 'win32',
    packaged: true,
    execPath: process.execPath,
    installRoot,
    dataDir,
    helperPath,
    deps: {
      spawn,
      randomToken: () => token,
      now: () => 0,
      sleep: async () => {},
      env: { PATH: 'test' },
      ...overrides,
    },
  });
  return {
    shell,
    artifact,
    bytes,
    spawn,
    child,
    token,
    readyFile,
    handoffDir,
    ownedDir,
    dataDir,
    installRoot,
    execPath,
    helperPath,
    filePath,
  };
}

describe('desktop shell facts and marker ownership', () => {
  it('reports installed only for a packaged Windows copy with the exact marker', async () => {
    const root = await tempDir();
    const { dataDir } = await staging(root);
    const { installRoot, execPath } = await installRootFor(root);
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: {},
    });
    expect(shell.platform).toBe('win32');
    expect(shell.packaged).toBe(true);
    expect(shell.installed).toBe(true);
    expect(typeof shell.transport.launchInstaller).toBe('function');

    // A marker whose contents differ is not this product's install.
    await fs.writeFile(path.join(installRoot, MARKER), 'someone-else');
    const forged = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: {},
    });
    expect(forged.installed).toBe(false);
  });

  it('never calls a development or portable packaged copy installed', async () => {
    const root = await tempDir();
    const dataDir = path.join(root, 'data');
    const dev = await appUpdates.updateShellConfig({
      platform: 'linux',
      packaged: true,
      execPath: path.join(root, 'app', 'Diomedes.exe'),
      dataDir,
      deps: {},
    });
    expect(dev.installed).toBe(false);
    const unpackaged = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: false,
      execPath: path.join(root, 'app', 'Diomedes.exe'),
      dataDir,
      deps: {},
    });
    expect(unpackaged.installed).toBe(false);
    // A portable extraction is under a versioned folder, not INSTALLDIR/app.
    const portable = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath: path.join(root, 'Diomedes-win32-x64', 'Diomedes.exe'),
      dataDir,
      deps: {},
    });
    expect(portable.installed).toBe(false);
  });

  it('resolves the install root from INSTALLDIR/app/Diomedes.exe only', () => {
    expect(appUpdates.installedRootFrom('C:\\Apps\\Diomedes\\app\\Diomedes.exe')).toBe(
      'C:\\Apps\\Diomedes',
    );
    expect(appUpdates.installedRootFrom('C:\\Apps\\Diomedes-win32-x64\\Diomedes.exe')).toBeNull();
    expect(appUpdates.installedRootFrom('C:\\Apps\\Diomedes\\app\\Other.exe')).toBeNull();
  });
});

describe('install handoff validation', () => {
  it('refuses close-and-install on a copy without the ownership marker', async () => {
    const root = await tempDir();
    const { dataDir, artifact } = await staging(root);
    const { execPath } = await installRootFor(root);
    await fs.rm(path.join(root, 'Programs', 'Diomedes Experimental 20260909', MARKER));
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: { spawn: vi.fn() },
    });
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/installed/i);
  });

  it('refuses a portable or development copy even when packaged', async () => {
    const root = await tempDir();
    const { dataDir, artifact } = await staging(root);
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath: path.join(root, 'Diomedes-win32-x64', 'Diomedes.exe'),
      dataDir,
      deps: { spawn: vi.fn() },
    });
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/installed/i);
  });

  it('rejects paths, names, versions, digests and sizes that are not the verified artifact', async () => {
    const root = await tempDir();
    const { artifact } = await readyShell(root, { spawn: vi.fn() });
    const cases: Array<Record<string, unknown> | null> = [
      { ...artifact, path: path.join(root, 'elsewhere', ASSET) },
      { ...artifact, path: ASSET },
      { ...artifact, path: artifact.path.replace(ASSET, 'Setup.exe') },
      { ...artifact, version: '0.1.3' },
      { ...artifact, sha256: 'not-a-hash' },
      { ...artifact, sha256: 'f'.repeat(64) },
      { ...artifact, size: artifact.size + 1 },
      { ...artifact, size: 0 },
      { ...artifact, size: Number.NaN },
      null,
      { path: artifact.path, sha256: artifact.sha256, size: artifact.size },
    ];
    for (const bad of cases) {
      const { shell } = await readyShell(root, { spawn: vi.fn() });
      await expect(shell.transport.launchInstaller(bad)).rejects.toThrow();
    }
  });

  it('rejects a staged installer tampered with after verification', async () => {
    const root = await tempDir();
    const { shell, artifact, filePath } = await readyShell(root, { spawn: vi.fn() });
    await fs.writeFile(filePath, fixtureBytes(artifact.size, 3));
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/changed/i);
  });
});

describe('handoff launch and readiness', () => {
  it('refuses a readiness record from a different helper or artifact', async () => {
    const root = await tempDir();
    const { shell, artifact, child, dataDir } = await readyShell(root);
    await fs.writeFile(
      path.join(dataDir, 'update-handoff', 'test-token.ready.json'),
      JSON.stringify({
        schema: 1,
        ready: true,
        parentPid: process.pid,
        helperPid: child.pid + 1,
        artifact,
      }),
    );
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/does not match/);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('spawns exactly one detached hidden helper in Node mode with an argv array and no shell', async () => {
    const root = await tempDir();
    const { shell, artifact, spawn, helperPath, child, dataDir } = await readyShell(root);
    await expect(shell.transport.launchInstaller(artifact)).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(helperPath);
    expect(args).toHaveLength(2);
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(options.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    const payload = JSON.parse(args[1]);
    expect(payload.artifact).toMatchObject({ path: artifact.path, version: VERSION });
    expect(payload.parentPid).toBe(process.pid);
    expect(payload.readyFile).toBe(path.join(dataDir, 'update-handoff', 'test-token.ready.json'));
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('hands off one version only once even if the install is requested twice', async () => {
    const root = await tempDir();
    const { shell, artifact, spawn } = await readyShell(root);
    await shell.transport.launchInstaller(artifact);
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/already/i);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports failure when the helper errors before it acknowledges readiness', async () => {
    const root = await tempDir();
    const { artifact, dataDir } = await staging(root);
    const { execPath } = await installRootFor(root);
    const child = fakeChild();
    const spawn = vi.fn(() => {
      setImmediate(() => child.emit('error', new Error('helper exploded')));
      return child;
    });
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: {
        spawn,
        randomToken: () => 'no-ack',
        now: () => Date.now(),
        readyTimeoutMs: 2_000,
        readyPollMs: 5,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      },
    });
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/helper exploded/);
    expect(child.kill).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports failure when the helper exits before acknowledging readiness', async () => {
    const root = await tempDir();
    const { artifact, dataDir } = await staging(root);
    const { execPath } = await installRootFor(root);
    const child = fakeChild();
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: {
        spawn: () => {
          setImmediate(() => child.emit('exit', 3));
          return child;
        },
        randomToken: () => 'no-ack',
        now: () => Date.now(),
        readyTimeoutMs: 2_000,
        readyPollMs: 5,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      },
    });
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/before it was ready/i);
    expect(child.kill).toHaveBeenCalled();
  });

  it('reports a bounded readiness timeout and kills the helper instead of installing', async () => {
    const root = await tempDir();
    const { artifact, dataDir } = await staging(root);
    const { execPath } = await installRootFor(root);
    const child = fakeChild();
    let clock = 0;
    const shell = await appUpdates.updateShellConfig({
      platform: 'win32',
      packaged: true,
      execPath,
      dataDir,
      deps: {
        spawn: () => child,
        randomToken: () => 'no-ack',
        readyTimeoutMs: 50,
        readyPollMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        },
      },
    });
    await expect(shell.transport.launchInstaller(artifact)).rejects.toThrow(/readiness/i);
    expect(child.kill).toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });
});

describe('owned update helper', () => {
  function helperPayload(root: string, artifact: any, readyFile: string) {
    return {
      schema: 1,
      parentPid: 4321,
      artifact,
      ownedDir: path.dirname(artifact.path),
      readyFile,
      resultFile: path.join(path.dirname(readyFile), 'result.json'),
      waitMs: 1_000,
      pollMs: 10,
    };
  }

  it('rejects malformed handoff payloads without touching the installer', () => {
    for (const bad of [
      'not json',
      {},
      { schema: 2, parentPid: 1, artifact: {}, readyFile: 'x', resultFile: 'y', ownedDir: 'z' },
      { schema: 1, parentPid: -1, artifact: {}, readyFile: 'x', resultFile: 'y', ownedDir: 'z' },
    ])
      expect(() => updateHelper.parseHelperPayload(bad)).toThrow();
  });

  it('waits for the parent, rechecks the installer, then spawns it with no shell', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    vi.stubEnv('DIOMEDES_UPDATE_HELPER', '1');
    const root = await tempDir();
    const { artifact } = await staging(root);
    const readyFile = path.join(root, 'update-handoff', 'ready.json');
    const resultFile = path.join(root, 'update-handoff', 'result.json');
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) =>
      fakeChild({ autoSpawn: true }),
    );
    const payload = { ...helperPayload(root, artifact, readyFile), resultFile };
    const result = await updateHelper.runUpdateHelper(payload, {
      spawn,
      isParentAlive: () => false,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result.status).toBe('launched');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(artifact.path);
    expect(args).toEqual([]);
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.env?.DIOMEDES_UPDATE_HELPER).toBeUndefined();
    const ready = JSON.parse(await fs.readFile(readyFile, 'utf8'));
    expect(ready.ready).toBe(true);
    expect(ready.parentPid).toBe(4321);
    const recorded = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    expect(recorded.status).toBe('launched');
  });

  it('records uncertainty and does not install while the parent is still running', async () => {
    const root = await tempDir();
    const { artifact } = await staging(root);
    const readyFile = path.join(root, 'update-handoff', 'ready.json');
    const resultFile = path.join(root, 'update-handoff', 'result.json');
    const spawn = vi.fn(() => fakeChild());
    let clock = 0;
    const result = await updateHelper.runUpdateHelper(
      { ...helperPayload(root, artifact, readyFile), resultFile },
      {
        spawn,
        isParentAlive: () => true,
        waitMs: 40,
        now: () => (clock += 100),
        sleep: async () => {},
      },
    );
    expect(result.status).toBe('parent-still-running');
    expect(spawn).not.toHaveBeenCalled();
    const recorded = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    expect(recorded.status).toBe('parent-still-running');
  });

  it('rechecks the installer after the parent exits and refuses a tampered file', async () => {
    const root = await tempDir();
    const { artifact, filePath, bytes } = await staging(root);
    const readyFile = path.join(root, 'update-handoff', 'ready.json');
    const resultFile = path.join(root, 'update-handoff', 'result.json');
    const spawn = vi.fn(() => fakeChild());
    await fs.writeFile(filePath, fixtureBytes(bytes.length, 4));
    const result = await updateHelper.runUpdateHelper(
      { ...helperPayload(root, artifact, readyFile), resultFile },
      { spawn, isParentAlive: () => false, now: () => 0, sleep: async () => {} },
    );
    expect(result.status).toBe('mismatch');
    expect(spawn).not.toHaveBeenCalled();
    expect((JSON.parse(await fs.readFile(resultFile, 'utf8')) as { status: string }).status).toBe(
      'mismatch',
    );
  });

  it('reports a readiness write failure instead of installing', async () => {
    const root = await tempDir();
    const { artifact } = await staging(root);
    const blocked = path.join(root, 'update-handoff', 'ready.json');
    await fs.mkdir(blocked, { recursive: true });
    const spawn = vi.fn(() => fakeChild());
    const result = await updateHelper.runUpdateHelper(
      {
        ...helperPayload(root, artifact, blocked),
        resultFile: path.join(root, 'update-handoff', 'result.json'),
      },
      { spawn, isParentAlive: () => false, now: () => 0, sleep: async () => {} },
    );
    expect(result.status).toBe('ready-failed');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('graceful install acceptance', () => {
  it('invokes the graceful quit once and never twice', () => {
    const quit = vi.fn();
    const accepted = appUpdates.createInstallAccepted(quit);
    expect(accepted()).toBe(true);
    expect(accepted()).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('reports a throwing quit path without masking it', () => {
    const onError = vi.fn();
    const accepted = appUpdates.createInstallAccepted(
      () => {
        throw new Error('quit refused');
      },
      { onError },
    );
    expect(accepted()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
