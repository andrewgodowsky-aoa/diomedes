#!/usr/bin/env node
/**
 * Dev-server ownership tracking and orphan reclaim.
 *
 * `scripts/dev.mjs` normally cleans up its two children on signal, but when the
 * runner above it dies abnormally (a killed shell, a terminated test pass) the
 * whole tree can survive and keep holding ports 5174/47632. The next Playwright
 * run then fails on "port already used" and somebody has to work out whether
 * the holders are this worktree's orphans or another agent's live work.
 *
 * The mechanism is a marker file, `.dev-server.json`, written at the worktree
 * root by dev.mjs while it runs. It records the dev.mjs pid and each spawned
 * child's pid plus a command-line signature. Three states are distinguished:
 *
 *   - ORPHAN: ports held, marker present, recorded parent dead. Children are
 *     killed only when their pid is in the marker AND their live command line
 *     still contains the recorded absolute script path — pid reuse cannot fool
 *     it, because a reused pid's command line will not name this worktree.
 *   - MANAGED: marker present and the recorded parent is still alive. The tree
 *     is under live supervision (a running `npm run dev`, or a live test
 *     pass's own webServer) and is NEVER killed; the guard reports it instead.
 *   - FOREIGN: a port holder absent from the marker, or whose live command
 *     line no longer matches its recorded signature. Reported, never killed.
 *
 * Used three ways:
 *   - playwright.config.ts shells out to this file before defineConfig (and
 *     skips when TEST_WORKER_INDEX is set — Playwright workers re-evaluate the
 *     config while the webServer is legitimately up, and must not touch it).
 *   - dev.mjs calls guardDevPorts() at start so manual `npm run dev` gets the
 *     same reclaim behaviour.
 *   - CLI: `node scripts/dev-server-guard.mjs [--ports 5174,47632] [--root dir]`
 *     prints what it found and did; exit 0 = ports free or reclaimed,
 *     exit 1 = a managed or foreign process holds a port.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_SERVER_MARKER = '.dev-server.json';
const RELEASE_DEADLINE_MS = 5000;

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function markerPath(root) {
  return path.join(root, DEV_SERVER_MARKER);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** PIDs currently LISTENING on the given TCP port. */
export function listenersOn(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('netstat.exe', ['-ano'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return [];
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || !parts[0].startsWith('TCP')) continue;
      if (parts[parts.length - 2] !== 'LISTENING') continue;
      const local = parts[1];
      const localPort = Number(local.slice(local.lastIndexOf(':') + 1));
      if (localPort === port) pids.add(Number(parts[parts.length - 1]));
    }
    return [...pids];
  }
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.trim().split(/\s+/).map(Number).filter(Boolean);
}

/** pid -> command line, resolved in one batch call. Dead pids are absent. */
function commandLinesOf(pids) {
  const lines = new Map();
  if (!pids.length) return lines;
  if (process.platform === 'win32') {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0 || !result.stdout) return lines;
    for (const line of result.stdout.split(/\r?\n/)) {
      const sep = line.indexOf('|');
      if (sep > 0) lines.set(Number(line.slice(0, sep)), line.slice(sep + 1).trim());
    }
    return lines;
  }
  for (const pid of pids) {
    try {
      lines.set(pid, fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim());
    } catch {
      // Process is gone or unreadable.
    }
  }
  return lines;
}

function readMarker(root) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
    if (!marker || !Array.isArray(marker.processes)) return null;
    return marker;
  } catch {
    return null;
  }
}

/**
 * Called by dev.mjs at boot and after each child spawns. `entries` is the full
 * current process list: [{ pid, role, signature, weakSignature? }]. signature
 * is an absolute script path (strong provenance); weakSignature is an optional
 * basename fallback used only to decide whether the parent is still alive —
 * never as a kill authorization. Best-effort: the dev server still starts if
 * the marker cannot be written.
 */
export function writeDevServerMarker(root, entries) {
  try {
    fs.writeFileSync(
      markerPath(root),
      JSON.stringify(
        { version: 1, root, pid: process.pid, startedAt: new Date().toISOString(), processes: entries },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`dev-server marker could not be written: ${error.message}`);
  }
}

/** Called on every dev.mjs exit path so a clean shutdown leaves no marker. */
export function clearDevServerMarker(root) {
  try {
    fs.unlinkSync(markerPath(root));
  } catch {
    // Already gone, or never written.
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return result.status === 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function parentRecord(marker) {
  return marker.processes.find((entry) => entry.pid === marker.pid) ?? marker.processes[0] ?? null;
}

/**
 * True while the marker's recorded parent is still a live process whose
 * command line matches its signature — meaning the tree is under live
 * supervision and must not be reclaimed. A live pid whose command line matches
 * neither signature is treated as dead (pid reuse).
 */
function parentIsAlive(marker, cmdlines) {
  const record = parentRecord(marker);
  if (!record) return false;
  const cmdline = (cmdlines.get(record.pid) ?? '').toLowerCase();
  if (!cmdline) return false;
  const strong = (record.signature ?? '').toLowerCase();
  const weak = (record.weakSignature ?? '').toLowerCase();
  return (strong && cmdline.includes(strong)) || (weak && cmdline.includes(weak));
}

/**
 * Free the dev ports if — and only if — their holders are provably this
 * worktree's ORPHANED dev-server tree.
 *
 * Returns { reclaimed: string[] } on success. Throws with full diagnostics
 * when a live managed tree or a foreign process holds a port, and refuses to
 * kill anything it cannot prove is ours.
 */
export function guardDevPorts({ ports, root = repoRoot(), log = () => {} }) {
  const heldByPort = new Map();
  for (const port of ports) {
    const pids = listenersOn(port);
    if (pids.length) heldByPort.set(port, pids);
  }

  const marker = readMarker(root);
  const markerPids = (marker?.processes ?? []).map((entry) => entry.pid);
  const cmdlines = commandLinesOf([...new Set([...heldByPort.values()].flat()), ...markerPids]);

  if (heldByPort.size === 0) {
    // Drop residue only when the recorded tree is truly dead; a live dev
    // server owns its marker even while its ports happen to be free.
    if (marker && !parentIsAlive(marker, cmdlines)) {
      clearDevServerMarker(root);
      log(`removed stale ${DEV_SERVER_MARKER}`);
    }
    return { reclaimed: [] };
  }

  const records = marker?.processes ?? [];
  const foreign = [];

  for (const [port, pids] of heldByPort) {
    for (const pid of pids) {
      const record = records.find((entry) => entry.pid === pid);
      const cmdline = cmdlines.get(pid) ?? '';
      const ours =
        record && record.signature && cmdline.toLowerCase().includes(record.signature.toLowerCase());
      if (!ours) {
        foreign.push({
          port,
          pid,
          commandLine: cmdline || '<could not read command line>',
          marker: record ? 'signature mismatch' : 'not in marker',
        });
      }
    }
  }

  if (foreign.length) {
    const detail = foreign
      .map((f) => `  port ${f.port} <- pid ${f.pid} (${f.marker})\n    ${f.commandLine}`)
      .join('\n');
    throw new Error(
      `Dev-server port(s) are held by processes this worktree cannot prove it owns:\n${detail}\n` +
        `Stop them yourself, or rerun with different ports. Refusing to kill foreign processes.`,
    );
  }

  if (marker && parentIsAlive(marker, cmdlines)) {
    const parent = parentRecord(marker);
    throw new Error(
      `Dev-server port(s) are held by a live dev-server tree started at ` +
        `${marker.startedAt ?? 'unknown time'} (parent pid ${parent?.pid}).\n` +
        `It is managed, not orphaned — stop it yourself (\`taskkill /PID ${parent?.pid} /T /F\` ` +
        `or Ctrl+C where it runs), or rerun with different ports.`,
    );
  }

  if (!marker) {
    // All holders carried recorded signatures, which requires a marker — this
    // branch is defensive only; treat it as foreign rather than guess.
    throw new Error(`Dev-server ports are held but no ${DEV_SERVER_MARKER} exists to prove ownership.`);
  }

  // Orphaned: the recorded parent is dead and every port holder verified.
  // Kill every marker pid whose live command line still proves it is ours.
  const killed = [];
  for (const entry of marker.processes) {
    const cmdline = (cmdlines.get(entry.pid) ?? '').toLowerCase();
    if (!entry.signature || !cmdline.includes(entry.signature.toLowerCase())) continue;
    if (killTree(entry.pid)) killed.push(`${entry.role ?? 'process'}:${entry.pid}`);
  }

  const deadline = Date.now() + RELEASE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (ports.every((port) => listenersOn(port).length === 0)) break;
    sleepSync(100);
  }
  const stillHeld = ports.filter((port) => listenersOn(port).length > 0);
  if (stillHeld.length) {
    throw new Error(
      `Killed this worktree's orphaned dev-server tree (${killed.join(', ')}) but port(s) ` +
        `${stillHeld.join(', ')} are still held. Inspect with netstat -ano.`,
    );
  }

  clearDevServerMarker(root);
  log(`reclaimed orphaned dev-server tree: ${killed.join(', ')} (ports ${ports.join(', ')} free)`);
  return { reclaimed: killed };
}

function defaultPorts() {
  const client = Number(process.env.DIOMEDES_UI_CLIENT_PORT ?? process.env.DIOMEDES_CLIENT_PORT ?? 5174);
  const service = Number(
    process.env.DIOMEDES_UI_SERVICE_PORT ?? process.env.DIOMEDES_PORT ?? 47632,
  );
  return [client, service];
}

function main() {
  const args = process.argv.slice(2);
  let ports = defaultPorts();
  let root = repoRoot();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ports') ports = args[++i].split(',').map(Number);
    else if (args[i] === '--root') root = path.resolve(args[++i]);
    else if (args[i] === '--help') {
      console.log('node scripts/dev-server-guard.mjs [--ports 5174,47632] [--root <dir>]');
      console.log("Reclaims dev ports held by this worktree's orphaned dev-server tree.");
      console.log('Exit 0: ports free or reclaimed. Exit 1: a live managed or foreign process holds a port.');
      return;
    }
  }
  try {
    const { reclaimed } = guardDevPorts({ ports, root, log: (m) => console.log(`guard: ${m}`) });
    console.log(
      reclaimed.length
        ? `dev-server guard: reclaimed orphan tree, ports ${ports.join(', ')} free`
        : `dev-server guard: ports ${ports.join(', ')} already free`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`dev-server guard: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
