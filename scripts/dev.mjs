import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  clearDevServerMarker,
  guardDevPorts,
  writeDevServerMarker,
} from './dev-server-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
let stopping = false;

function port(value, fallback, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return result;
}

const clientPort = port(process.env.DIOMEDES_CLIENT_PORT, 5173, 'DIOMEDES_CLIENT_PORT');
const servicePort = port(process.env.DIOMEDES_PORT, 47631, 'DIOMEDES_PORT');

// If a previous dev.mjs died without running its signal handlers, its children
// still hold the ports. The marker proves which holders are ours to reclaim;
// anything else makes this fail loudly instead of killing a foreign process.
guardDevPorts({ ports: [clientPort, servicePort], root, log: (m) => console.log(`guard: ${m}`) });

// The marker records pid + command-line signature for every process we own so a
// later run can tell our orphans from another worktree's servers. Children are
// spawned with absolute script paths so their signatures carry this root. The
// parent's own command line may spell its script path relatively, so it also
// records a basename fallback — used for liveness checks only, never to kill.
const markerEntries = [
  {
    pid: process.pid,
    role: 'dev.mjs',
    signature: fileURLToPath(import.meta.url),
    weakSignature: 'dev.mjs',
  },
];
writeDevServerMarker(root, markerEntries);

function terminate(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    // Scope cleanup to the child PID and its descendants. Never kill by image name.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', (error) => {
      console.error(`Could not clean up child ${child.pid}: ${error.message}`);
      child.kill();
    });
  } else {
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000);
    force.unref();
  }
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) terminate(child);
}

function start(name, args, signature) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  children.add(child);
  if (child.pid) {
    markerEntries.push({ pid: child.pid, role: name, signature });
    writeDevServerMarker(root, markerEntries);
  }
  child.on('error', (error) => {
    children.delete(child);
    console.error(`${name} could not start: ${error.message}`);
    shutdown(1);
  });
  child.on('close', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} stopped (${signal ?? code ?? 'unknown'}).`);
      shutdown(code === 0 ? 0 : 1);
    }
  });
}

process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
// Every exit path — clean shutdown, child failure, an unhandled error — must
// drop the marker so the next run does not mistake live ports for our orphans.
process.on('exit', () => clearDevServerMarker(root));

const serviceScript = path.join(root, 'server', 'index.ts');
const viteScript = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

console.log(`Diomedes: http://127.0.0.1:${clientPort}. Press Ctrl+C to stop both local processes.`);
start('Local service', ['--import', 'tsx', serviceScript], serviceScript);
start('Interface', [
  viteScript,
  '--host',
  '127.0.0.1',
  '--port',
  String(clientPort),
  '--strictPort',
], viteScript);
