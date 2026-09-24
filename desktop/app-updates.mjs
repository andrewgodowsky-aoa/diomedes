// Desktop-shell side of the bounded application-update flow, and the shell's
// pure platform decisions (see "Platform shell decisions" below).
//
// The local service (server/app-updates.ts, bundled into server/app.mjs)
// owns the fixed official release channel, the verified release record and
// staged-installer integrity. This module answers the two questions the
// service cannot -- which platform this shell runs on, and whether this shell
// is the installed packaged app -- and it owns the close-and-install handoff
// that the service cannot perform from inside its own process.
//
// Close-and-install must not race the per-user installer's running-app check:
// the installer refuses to upgrade while Diomedes holds its files open. So the
// transport spawns a detached, hidden helper (desktop/update-helper.mjs) using
// this app's own Electron executable in Node mode. The helper acknowledges
// readiness, waits boundedly for this exact parent process to exit, rechecks
// the verified installer and only then starts the existing installer directly
// with an argv array and no shell.
//
// PACKAGING NOTE: scripts/package-desktop.mjs must copy both this file and
// desktop/update-helper.mjs next to main.mjs in the staged app. Until it does,
// a packaged app cannot import them; main.mjs imports them explicitly and does
// not hide a missing helper behind a catch.

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_OWNER = 'andrewgodowsky-aoa';
export const UPDATE_REPO = 'diomedes';
export const UPDATE_RELEASE_NOTES_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;

/** Only the release index and canonical stable tag pages may open externally. */
export function isUpdateReleaseReference(destination) {
  if (destination === UPDATE_RELEASE_NOTES_URL) return true;
  if (
    typeof destination !== 'string' ||
    !destination.startsWith(`${UPDATE_RELEASE_NOTES_URL}/tag/`)
  )
    return false;
  const tag = destination.slice(`${UPDATE_RELEASE_NOTES_URL}/tag/`.length);
  return /^v?(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(tag);
}

/** The ownership marker the per-user installer writes into INSTALLDIR. */
export const UPDATE_MARKER_NAME = '.diomedes-experimental-20260909';
export const UPDATE_MARKER_CONTENT = 'Diomedes.Experimental.8c27d61a-1919-4b12-9df7-20260909e001';
/** A real install keeps its executable at INSTALLDIR/app/Diomedes.exe. */
export const UPDATE_EXECUTABLE_NAME = 'Diomedes.exe';
/** Mirrors shared/app-updates.ts UPDATE_ASSET_PATTERN. */
export const UPDATE_ASSET_PATTERN = /^Diomedes-Experimental-(\d+\.\d+\.\d+)-unsigned-setup\.exe$/;
export const UPDATE_MAX_ASSET_BYTES = 500 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stream a file's SHA-256 so a large installer is never buffered in memory. */
export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Resolve INSTALLDIR only for the installed layout `<INSTALLDIR>/app/Diomedes.exe`.
 * Portable extractions, development runs and renamed copies return null; a
 * packaged app is not automatically an installed app.
 */
export function installedRootFrom(execPath) {
  if (typeof execPath !== 'string' || !execPath) return null;
  // INSTALLDIR/app/Diomedes.exe is the Windows installer's layout, so the path
  // is read with Windows rules whatever host runs this. The host's own rules
  // see no separator in `C:\...` on macOS and return null for every input.
  const win = path.win32;
  if (win.basename(execPath).toLowerCase() !== UPDATE_EXECUTABLE_NAME.toLowerCase()) return null;
  const appDir = win.dirname(execPath);
  if (win.basename(appDir).toLowerCase() !== 'app') return null;
  return win.dirname(appDir);
}

/** True only when INSTALLDIR carries this product's exact ownership marker. */
export async function readInstallMarker(installRoot, options = {}) {
  const fsImpl = options.fs ?? fs;
  if (!installRoot) return false;
  try {
    const content = await fsImpl.readFile(path.join(installRoot, UPDATE_MARKER_NAME), 'utf8');
    return typeof content === 'string' && content.trim() === UPDATE_MARKER_CONTENT;
  } catch {
    return false;
  }
}

/**
 * Structural validation of `{ path, sha256, size, version }`. Shape only:
 * disk identity is re-established by verifyStagedInstaller.
 */
export function parseInstallArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
    throw new Error('The update installer descriptor is missing.');
  const { path: filePath, sha256, size, version } = artifact;
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath))
    throw new Error('The update installer path is not an absolute owned path.');
  const name = path.basename(filePath);
  const match = UPDATE_ASSET_PATTERN.exec(name);
  if (!match) throw new Error('The update installer name is not the supported release asset.');
  if (typeof version !== 'string' || version !== match[1])
    throw new Error('The update installer version does not match its file name.');
  if (typeof sha256 !== 'string' || !SHA_PATTERN.test(sha256))
    throw new Error('The update installer digest is not a SHA-256 hash.');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0)
    throw new Error('The update installer size is invalid.');
  if (size > UPDATE_MAX_ASSET_BYTES)
    throw new Error('The update installer is larger than the supported bound.');
  return { path: filePath, name, sha256, size, version };
}

/** The artifact must sit directly in the owned staging directory. */
export function assertOwnedArtifactPath(filePath, ownedDir) {
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(ownedDir))
    throw new Error('The update installer is not in the owned staging directory.');
  if (!UPDATE_ASSET_PATTERN.test(path.basename(resolved)))
    throw new Error('The update installer name is not the supported release asset.');
  return resolved;
}

/** Re-establish that the staged file is exactly the verified artifact. */
export async function verifyStagedInstaller(artifact, options = {}) {
  const fsImpl = options.fs ?? fs;
  const hashFile = options.hashFile ?? sha256File;
  const parsed = parseInstallArtifact(artifact);
  assertOwnedArtifactPath(parsed.path, options.ownedDir);
  const directory = await fsImpl.lstat(options.ownedDir);
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error('The update staging directory is not an owned directory.');
  let stats;
  try {
    stats = await fsImpl.lstat(parsed.path);
  } catch {
    throw new Error('The staged installer is missing. Download it again.');
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1)
    throw new Error('The staged installer is not a regular file.');
  if (stats.size !== parsed.size)
    throw new Error('The staged installer changed after verification.');
  const digest = await hashFile(parsed.path);
  if (digest !== parsed.sha256) throw new Error('The staged installer changed after verification.');
  return parsed;
}

async function readReadyAck(fsImpl, readyFile) {
  try {
    const ack = JSON.parse(await fsImpl.readFile(readyFile, 'utf8'));
    return ack && ack.ready === true ? ack : null;
  } catch {
    return null;
  }
}

async function waitForReadiness(child, readyFile, options) {
  const { fs: fsImpl, now, sleep, readyTimeoutMs, pollMs } = options;
  let failure = null;
  const onError = (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
  };
  const onExit = (code, signal) => {
    failure = new Error(`The update helper stopped before it was ready (${signal ?? code}).`);
  };
  child.once('error', onError);
  child.once('exit', onExit);
  try {
    const deadline = now() + readyTimeoutMs;
    for (;;) {
      if (failure) throw failure;
      const ack = await readReadyAck(fsImpl, readyFile);
      if (ack) {
        const expected = options.artifact;
        if (
          ack.schema !== 1 ||
          ack.helperPid !== child.pid ||
          ack.parentPid !== process.pid ||
          ack.artifact?.path !== expected.path ||
          ack.artifact?.sha256 !== expected.sha256 ||
          ack.artifact?.size !== expected.size ||
          ack.artifact?.version !== expected.version
        )
          throw new Error('The update helper readiness record does not match this handoff.');
        return;
      }
      if (now() >= deadline)
        throw new Error('The update helper did not acknowledge readiness in time.');
      await sleep(pollMs);
    }
  } finally {
    child.removeListener?.('error', onError);
    child.removeListener?.('exit', onExit);
  }
}

async function launchInstallerHandoff(artifact, facts) {
  const { deps, ownedUpdatesDir, dataDir, execPath, helperPath, installRoot } = facts;
  const fsImpl = deps.fs ?? fs;
  if (facts.platform !== 'win32' || facts.packaged !== true)
    throw new Error('Close-and-install runs on the packaged Windows app only.');
  if (!(await readInstallMarker(installRoot ?? installedRootFrom(execPath), { fs: fsImpl })))
    throw new Error(
      'This copy is not the installed Nectovia application, so it cannot install in place. ' +
        'Download the update from the release page instead.',
    );
  if (!ownedUpdatesDir || !dataDir) throw new Error('The update staging directory is unavailable.');

  // Claim the version before any async work so two admissions cannot both hand off.
  const descriptor = parseInstallArtifact(artifact);
  if (facts.handoffs.has(descriptor.version))
    throw new Error('That update has already been handed off. Nectovia will close to finish it.');
  facts.handoffs.set(descriptor.version, 'preparing');
  try {
    const parsed = await verifyStagedInstaller(artifact, {
      fs: fsImpl,
      hashFile: deps.hashFile ?? sha256File,
      ownedDir: ownedUpdatesDir,
    });
    const token = (deps.randomToken ?? randomUUID)();
    if (typeof token !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(token))
      throw new Error('The update handoff identifier is invalid.');
    const handoffDir = path.join(dataDir, 'update-handoff');
    const readyFile = path.join(handoffDir, `${token}.ready.json`);
    const resultFile = path.join(handoffDir, `${token}.result.json`);
    await fsImpl.mkdir(handoffDir, { recursive: true });
    const payload = {
      schema: 1,
      parentPid: process.pid,
      artifact: parsed,
      ownedDir: ownedUpdatesDir,
      readyFile,
      resultFile,
      waitMs: deps.helperWaitMs ?? 120_000,
      pollMs: deps.helperPollMs ?? 250,
    };
    const child = (deps.spawn ?? spawn)(execPath, [helperPath, JSON.stringify(payload)], {
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...(deps.env ?? process.env), ELECTRON_RUN_AS_NODE: '1', DIOMEDES_UPDATE_HELPER: '1' },
    });
    try {
      await waitForReadiness(child, readyFile, {
        fs: fsImpl,
        now: deps.now ?? Date.now,
        sleep: deps.sleep ?? defaultSleep,
        readyTimeoutMs: deps.readyTimeoutMs ?? 10_000,
        pollMs: deps.readyPollMs ?? 50,
        artifact: parsed,
      });
    } catch (error) {
      try {
        child.kill();
      } catch {
        // The helper may already be gone; the install still did not start.
      }
      throw error;
    }
    facts.handoffs.set(parsed.version, 'launched');
    child.unref?.();
  } catch (error) {
    if (facts.handoffs.get(descriptor.version) === 'preparing')
      facts.handoffs.delete(descriptor.version);
    throw error;
  }
}

/**
 * Shell facts for createApp's `updateOverrides`. `installed` is deliberately
 * distinct from `packaged`: portable candidates and development sessions are
 * packaged-capable but must not claim this copy is the installed app.
 */
export async function updateShellConfig(options = {}) {
  const deps = options.deps ?? {};
  const fsImpl = deps.fs ?? fs;
  const platform =
    typeof options.platform === 'string' && options.platform ? options.platform : process.platform;
  const packaged = options.packaged === true;
  const execPath = options.execPath ?? process.execPath;
  const installRoot = options.installRoot ?? installedRootFrom(execPath);
  const dataDir = options.dataDir;
  const helperPath =
    options.helperPath ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'update-helper.mjs');
  const ownedUpdatesDir = dataDir ? path.resolve(dataDir, 'updates') : null;
  const installed =
    packaged && platform === 'win32' ? await readInstallMarker(installRoot, { fs: fsImpl }) : false;
  const handoffs = new Map();
  return {
    platform,
    packaged,
    installed,
    transport: {
      launchInstaller: (artifact) =>
        launchInstallerHandoff(artifact, {
          platform,
          packaged,
          execPath,
          installRoot,
          dataDir,
          ownedUpdatesDir,
          helperPath,
          deps,
          handoffs,
        }),
    },
  };
}

// --------------------------------------------------------------------------
// Platform shell decisions
//
// Every branch the desktop shell takes on the operating system, as pure
// functions of an injected `platform`, so they can be exercised on Windows
// without starting Electron. They live in this module rather than a new
// desktop/platform-shell.mjs because scripts/package-desktop.mjs copies exactly
// main.mjs, app-updates.mjs and update-helper.mjs into the packaged app: a new
// desktop/*.mjs file would not be packaged, and main.mjs cannot be imported by
// a test because importing it constructs the Electron application.
//
// Windows behaviour is unchanged. Each function answers today's value for
// win32, and the operating-system discriminant stays separate from the
// architecture discriminant, which no function here reads.
// --------------------------------------------------------------------------

/**
 * Closing the last window quits Diomedes everywhere except macOS, where an
 * application conventionally stays in the Dock until it is told to quit.
 * Staying open is not background automation: the local service keeps running
 * only so the same app can reopen its window, and Quit still shuts it down.
 */
export function shouldQuitWhenAllWindowsClosed(platform) {
  return platform !== 'darwin';
}

/**
 * A Dock activation reopens the main window on macOS, and only when no window
 * is open, so activating an app that already has one never opens a second.
 */
export function shouldReopenMainWindow(platform, openWindowCount) {
  return platform === 'darwin' && openWindowCount === 0;
}

/**
 * The window's title bar options. macOS draws its own traffic lights, and
 * `titleBarOverlay` is a Windows/Linux concept, so the inset style is the whole
 * answer there and no overlay key is passed at all. Windows keeps the exact
 * hidden title bar and overlay literal it has always had.
 */
export function titleBarWindowOptions(platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121417', symbolColor: '#e6e9ed', height: 40 },
  };
}

/** `setTitleBarOverlay` exists for the overlay platforms only. */
export function supportsTitleBarOverlay(platform) {
  return platform !== 'darwin';
}

/**
 * The application menu template. Windows and Linux keep today's File/Edit/View
 * menu exactly. macOS puts the application menu first and adds the Window role
 * menu, so the standard Cmd shortcuts reach text fields and the window, and its
 * Quit lives in the application menu instead of a Quit-only File menu. Every
 * existing custom item and its handler is preserved on both.
 */
export function applicationMenuTemplate(platform, actions = {}) {
  const interfaceScale = actions.interfaceScale ?? (() => {});
  const edit = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };
  const view = {
    label: 'View',
    submenu: [
      { label: 'Increase interface size', click: () => interfaceScale('increase') },
      { label: 'Decrease interface size', click: () => interfaceScale('decrease') },
      { label: 'Reset interface size (100%)', click: () => interfaceScale('reset') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  if (platform === 'darwin')
    return [
      {
        label: 'Diomedes',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      edit,
      view,
      {
        role: 'window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
      },
    ];
  return [{ label: 'File', submenu: [{ role: 'quit' }] }, edit, view];
}

/**
 * Setup references that are not downloads. These explain an engine's own
 * authentication and open its official pages; they carry no artefact.
 */
const SETUP_REFERENCES = [
  'https://github.com/can1357/oh-my-pi/blob/v18.0.6/docs/models.md#auth-and-api-key-resolution-order',
  'https://platform.openai.com/api-keys',
  // Official Diomedes release notes, opened from Settings > App updates.
  'https://github.com/andrewgodowsky-aoa/diomedes/releases',
  // The local Website Studio, opened from the Design Center's Website target.
  // Loopback by address and listed explicitly: the allowlist is the whole
  // mechanism, so a studio on this computer is named here or it does not open.
  // Byte-identical to WEBSITE_STUDIO_URL in server/website-studio.ts.
  'http://127.0.0.1:4400/',
];

/** The pinned official Windows x64 engine artefacts, reviewed 2026-09-10. */
const WINDOWS_ENGINE_SETUP_DOWNLOADS = [
  'https://downloads.claude.ai/claude-code-releases/2.1.252/win32-x64/claude.exe',
  'https://github.com/anomalyco/opencode/releases/download/v1.18.4/opencode-windows-x64-baseline.zip',
  'https://github.com/can1357/oh-my-pi/releases/download/v18.0.6/omp-windows-x64.exe',
];

/**
 * The downloadable engine setup artefacts for a platform. These three files are
 * Windows x64 executables, so `win32` is the discriminant and every other
 * platform gets none. No macOS download is invented here: with no artefact to
 * offer, setup falls back to installing the vendor's own official release and
 * letting the existing disclosed discovery check find it (server/discovery.ts).
 */
export function engineSetupDownloads(platform) {
  return platform === 'win32' ? [...WINDOWS_ENGINE_SETUP_DOWNLOADS] : [];
}

/** Every reference the shell may open externally on this platform. */
export function setupReferenceLinks(platform) {
  return [...SETUP_REFERENCES, ...engineSetupDownloads(platform)];
}

/**
 * Wrap the graceful quit so a successful install acceptance closes Diomedes at
 * most once, and a failing quit is reported rather than thrown into the
 * response path that already succeeded.
 */
export function createInstallAccepted(quit, options = {}) {
  let used = false;
  return () => {
    if (used) return false;
    used = true;
    try {
      quit();
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };
}
