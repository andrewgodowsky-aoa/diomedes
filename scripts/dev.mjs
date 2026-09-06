import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
port(process.env.DIOMEDES_PORT, 47631, 'DIOMEDES_PORT');

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

function start(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  children.add(child);
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

console.log(`Diomedes: http://127.0.0.1:${clientPort}. Press Ctrl+C to stop both local processes.`);
start('Local service', ['--import', 'tsx', 'server/index.ts']);
start('Interface', [
  'node_modules/vite/bin/vite.js',
  '--host',
  '127.0.0.1',
  '--port',
  String(clientPort),
  '--strictPort',
]);
