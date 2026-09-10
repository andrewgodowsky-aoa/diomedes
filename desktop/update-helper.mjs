// Close-and-install helper, spawned detached by desktop/app-updates.mjs.
//
// It runs under this app's own Electron executable in Node mode
// (ELECTRON_RUN_AS_NODE), acknowledges readiness so the shell can return its
// accepted response, waits boundedly for that exact parent process to exit,
// rechecks the verified installer and only then starts it directly -- an argv
// array, shell:false, no interpolation. It never retries: a timeout or launch
// failure is recorded as uncertainty, not auto-reinstalled.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertOwnedArtifactPath,
  parseInstallArtifact,
  verifyStagedInstaller,
} from './app-updates.mjs';

export const HELPER_SCHEMA = 1;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Strictly validate the parent-supplied handoff descriptor. */
export function parseHelperPayload(raw) {
  let payload = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('The update handoff payload was not readable JSON.');
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('The update handoff payload was missing.');
  if (payload.schema !== HELPER_SCHEMA)
    throw new Error('The update handoff payload used an unsupported schema.');
  if (!Number.isSafeInteger(payload.parentPid) || payload.parentPid <= 0)
    throw new Error('The update handoff payload did not name a valid parent process.');
  const artifact = parseInstallArtifact(payload.artifact);
  if (typeof payload.ownedDir !== 'string' || !path.isAbsolute(payload.ownedDir))
    throw new Error('The update handoff payload did not name the owned staging directory.');
  assertOwnedArtifactPath(artifact.path, payload.ownedDir);
  for (const field of ['readyFile', 'resultFile']) {
    if (typeof payload[field] !== 'string' || !path.isAbsolute(payload[field]))
      throw new Error(`The update handoff payload did not name a valid ${field}.`);
  }
  if (!Number.isSafeInteger(payload.waitMs) || payload.waitMs < 0 || payload.waitMs > 120_000)
    throw new Error('The update handoff payload did not name a bounded parent wait.');
  if (!Number.isSafeInteger(payload.pollMs) || payload.pollMs <= 0 || payload.pollMs > 1_000)
    throw new Error('The update handoff payload did not name a poll interval.');
  return {
    schema: HELPER_SCHEMA,
    parentPid: payload.parentPid,
    artifact,
    ownedDir: path.resolve(payload.ownedDir),
    readyFile: payload.readyFile,
    resultFile: payload.resultFile,
    waitMs: payload.waitMs,
    pollMs: payload.pollMs,
  };
}

function parentIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function writeResult(fsImpl, payload, status, extra = {}) {
  try {
    await fsImpl.mkdir(path.dirname(payload.resultFile), { recursive: true });
    await fsImpl.writeFile(
      payload.resultFile,
      JSON.stringify({
        schema: HELPER_SCHEMA,
        status,
        parentPid: payload.parentPid,
        artifact: payload.artifact,
        at: new Date().toISOString(),
        ...extra,
      }),
      'utf8',
    );
  } catch {
    // The record is evidence for later inspection; it must never change the outcome.
  }
}

function startInstaller(installerPath, spawnImpl) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.DIOMEDES_UPDATE_HELPER;
    delete env.DIOMEDES_UPDATE_HANDOFF;
    const child = spawnImpl(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
      env,
    });
    const onError = (error) => {
      child.removeListener?.('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.removeListener?.('error', onError);
      child.unref?.();
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

export async function runUpdateHelper(raw, overrides = {}) {
  const deps = {
    fs,
    spawn: nodeSpawn,
    hashFile: undefined,
    isParentAlive: parentIsAlive,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
  let payload;
  try {
    payload = parseHelperPayload(raw);
  } catch (error) {
    return { status: 'invalid', error: messageOf(error) };
  }

  try {
    await deps.fs.mkdir(path.dirname(payload.readyFile), { recursive: true });
    await deps.fs.writeFile(
      payload.readyFile,
      JSON.stringify({
        schema: HELPER_SCHEMA,
        ready: true,
        helperPid: process.pid,
        parentPid: payload.parentPid,
        artifact: payload.artifact,
        at: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
  } catch (error) {
    await writeResult(deps.fs, payload, 'ready-failed', { error: messageOf(error) });
    return { status: 'ready-failed', error: messageOf(error) };
  }

  const deadline = deps.now() + payload.waitMs;
  while (deps.isParentAlive(payload.parentPid)) {
    if (deps.now() >= deadline) {
      await writeResult(deps.fs, payload, 'parent-still-running');
      return { status: 'parent-still-running' };
    }
    await deps.sleep(payload.pollMs);
  }

  try {
    await verifyStagedInstaller(payload.artifact, {
      fs: deps.fs,
      hashFile: deps.hashFile,
      ownedDir: payload.ownedDir,
    });
  } catch (error) {
    await writeResult(deps.fs, payload, 'mismatch', { error: messageOf(error) });
    return { status: 'mismatch', error: messageOf(error) };
  }

  try {
    await startInstaller(payload.artifact.path, deps.spawn);
  } catch (error) {
    await writeResult(deps.fs, payload, 'launch-failed', { error: messageOf(error) });
    return { status: 'launch-failed', error: messageOf(error) };
  }

  await writeResult(deps.fs, payload, 'launched');
  return { status: 'launched' };
}

function invokedDirectly() {
  if (process.env.DIOMEDES_UPDATE_HELPER === '1') return true;
  try {
    return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const raw = process.argv[2] ?? process.env.DIOMEDES_UPDATE_HANDOFF ?? '';
  runUpdateHelper(raw)
    .then((result) => {
      process.exitCode = result.status === 'launched' ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`Diomedes update helper failed: ${messageOf(error)}\n`);
      process.exitCode = 1;
    });
}
