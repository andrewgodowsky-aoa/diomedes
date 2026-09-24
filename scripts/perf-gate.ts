// Deterministic performance gate: `npm run perf:gate` (`--record`, `--runs N`,
// `--factor F`, `--json <path>`, `--small`).
//
// Seeds one large synthetic project (scripts/perf-gate-seed.ts), measures six
// paths a person waits on, each as the median of N runs after one warm-up, and
// fails when a median exceeds max(baseline x factor, baseline + 250 ms) from
// scripts/perf-baselines.json. The floor keeps a 10 ms metric from failing on
// scheduler noise; the factor catches real regressions on the big ones. The
// comparison itself lives in scripts/perf-gate-compare.ts and is unit tested.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import type { ProjectState, Task } from '../shared/types.js';
import { taskEvidence } from '../client/workbench/task-evidence.js';
import { planGroups } from '../client/console/progress-bars.js';
import {
  compareMetrics,
  formatTable,
  median,
  parseGateArgs,
  type BaselineFile,
} from './perf-gate-compare.js';
import { FULL_SIZE, SMALL_SIZE, seedSyntheticProject } from './perf-gate-seed.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repo, 'scripts', 'perf-baselines.json');
const SSE_CLIENTS = 50;
// Ports the dev launcher and the UI suite own; a gate run beside them must not take one.
const RESERVED_PORTS = new Set([5173, 5174, 47631, 47632]);
const CLIENT_HEADERS = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

const args = parseGateArgs(process.argv.slice(2));
if (args.record && args.small)
  throw new Error('Baselines are recorded for the full dataset only; drop --small or --record.');
const size = args.small ? SMALL_SIZE : FULL_SIZE;
const root = path.join(repo, 'test-results', `perf-gate-${process.pid}`);
const children = new Set<ChildProcess>();

// Whatever ends the run, no service outlives it and no seeded folder is left.
const cleanupSync = () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  rmSync(root, { recursive: true, force: true });
};
process.on('exit', cleanupSync);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    cleanupSync();
    process.exit(130);
  });

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    if (port >= 1024 && !RESERVED_PORTS.has(port)) return port;
  }
}

interface Service {
  port: number;
  child: ChildProcess;
  readyMs: number;
  stop(): Promise<void>;
}

/** Spawn the real local service and time it until `GET /api/settings` answers 200. */
async function startService(
  dataDir: string,
  projectsDir: string,
  codexHome: string,
): Promise<Service> {
  const [port, clientPort] = [await freePort(), await freePort()];
  let output = '';
  const started = performance.now();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repo, 'server', 'index.ts')],
    {
      cwd: repo,
      env: {
        ...process.env,
        DIOMEDES_DATA_DIR: dataDir,
        DIOMEDES_PROJECTS_DIR: projectsDir,
        DIOMEDES_PORT: String(port),
        DIOMEDES_CLIENT_PORT: String(clientPort),
        DIOMEDES_TEST_MODE: '1',
        DIOMEDES_ALLOW_UNPROTECTED_BROWSER: '1',
        CODEX_HOME: codexHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      await exited;
      clearTimeout(timer);
    }
    children.delete(child);
  };
  const deadline = started + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The service exited during start:\n${output}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
      await res.arrayBuffer();
      if (res.status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (performance.now() > deadline) {
      await stop();
      throw new Error(`The service did not answer within 60 s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { port, child, readyMs: performance.now() - started, stop };
}

async function timed(action: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}

/** One warm-up, then N timed samples. */
async function sample(action: () => Promise<number>, warmUp = true): Promise<number[]> {
  if (warmUp) await action();
  const samples: number[] = [];
  for (let n = 0; n < args.runs; n++) samples.push(await action());
  return samples;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

interface SseClient {
  /** Resolves with the time the next complete `projects` frame naming the project arrived. */
  next(): Promise<number>;
  close(): void;
}

/**
 * A raw SSE reader. Every change fans the whole project state out to every
 * client, so this scans bytes for the frame that ends one fan-out (`projects`)
 * instead of decoding megabytes of JSON per client, which would time the reader.
 */
function openSse(port: number, projectId: string): Promise<SseClient> {
  const marker = Buffer.from('\nevent: projects\n');
  const frameEnd = Buffer.from('\n\n');
  return new Promise((resolve, reject) => {
    let waiting: ((at: number) => void) | null = null;
    let tail: Buffer = Buffer.alloc(0);
    let frame: Buffer | null = null;
    let ready = false;
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/events', headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          if (!ready && chunk.includes('event: ready')) {
            ready = true;
            resolve({
              next: () => new Promise<number>((done) => (waiting = done)),
              close: () => req.destroy(),
            });
          }
          if (frame) {
            frame = Buffer.concat([frame, chunk]);
          } else {
            const joined = Buffer.concat([tail, chunk]);
            const found = joined.indexOf(marker);
            if (found < 0) {
              tail = joined.subarray(Math.max(0, joined.length - marker.length));
              return;
            }
            frame = joined.subarray(found + marker.length);
          }
          const end = frame.indexOf(frameEnd);
          if (end < 0) return;
          const body = frame.subarray(0, end);
          const rest = frame.subarray(end);
          frame = null;
          tail = rest.subarray(Math.max(0, rest.length - marker.length));
          if (body.includes(projectId) && waiting) {
            const done = waiting;
            waiting = null;
            done(performance.now());
          }
        });
      },
    );
    req.on('error', (error) => {
      if (!ready) reject(error);
    });
  });
}

async function main() {
  await fs.rm(root, { recursive: true, force: true });
  const codexHome = path.join(root, 'codex');
  await fs.mkdir(codexHome, { recursive: true });
  const seedStarted = performance.now();
  const { dataDir, projectsDir, projectId } = await seedSyntheticProject(root, size);
  console.log(
    `Seeded ${size.historyEntries} History entries, ${size.files} files and ${size.tasks} tasks ` +
      `in ${((performance.now() - seedStarted) / 1000).toFixed(1)} s (${path.relative(repo, root)}).`,
  );
  const samples: Record<string, number[]> = {};

  // Cold start: a fresh process each time, stopped cleanly so the data-folder lock is released.
  samples.coldStart = await sample(async () => {
    const service = await startService(dataDir, projectsDir, codexHome);
    await service.stop();
    return service.readyMs;
  });

  // In-process load of every saved project, with no service holding the folder.
  samples.projectStateLoad = await sample(() =>
    timed(() => new Store(dataDir, projectsDir).init()),
  );

  const service = await startService(dataDir, projectsDir, codexHome);
  try {
    const base = `http://127.0.0.1:${service.port}/api/projects/${projectId}`;
    // The listing route walks the folder on every call (Store.listDocuments), so
    // each sample is an uncached walk; only the OS file cache is warm.
    samples.filesList = await sample(() =>
      timed(async () => {
        const { documents } = JSON.parse(await getText(`${base}/documents`)) as {
          documents: unknown[];
        };
        if (documents.length < size.files)
          throw new Error(`Files listed ${documents.length} of ${size.files}.`);
      }),
    );
    samples.historyPage = await sample(() =>
      timed(async () => {
        const { days } = JSON.parse(await getText(`${base}/history`)) as { days: unknown[] };
        if (!days.length) throw new Error('History answered no days.');
      }),
    );
    // What the Console Board is fed and computes: the project projection over
    // HTTP, then the column and plan projection BoardView runs per task.
    samples.boardProjection = await sample(() =>
      timed(async () => {
        const state = JSON.parse(await getText(`${base}/state`)) as ProjectState;
        const evidenceOf = (task: Task) =>
          taskEvidence(task, state.sessions, state.needs, state.changes);
        const columns = state.tasks.map((task) => evidenceOf(task).column);
        planGroups(state.tasks, evidenceOf);
        if (columns.length < size.tasks)
          throw new Error(`Board saw ${columns.length} of ${size.tasks} tasks.`);
      }),
    );

    const clients = await Promise.all(
      Array.from({ length: SSE_CLIENTS }, () => openSse(service.port, projectId)),
    );
    try {
      let made = 0;
      samples.sseFanout = await sample(async () => {
        // Let any background refresh settle so the sample times this change alone.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const arrivals = clients.map((client) => client.next());
        const started = performance.now();
        const res = await fetch(`${base}/tasks`, {
          method: 'POST',
          headers: CLIENT_HEADERS,
          body: JSON.stringify({ name: `Fan-out probe ${++made}` }),
        });
        if (!res.ok) throw new Error(`Task creation answered ${res.status}: ${await res.text()}`);
        await res.arrayBuffer();
        return Math.max(...(await Promise.all(arrivals))) - started;
      });
    } finally {
      for (const client of clients) client.close();
    }
  } finally {
    await service.stop();
  }

  const metrics = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [name, median(values)]),
  );
  const machine = {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    node: process.version,
  };
  let baseline: BaselineFile | undefined;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as BaselineFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const sameDataset =
    baseline &&
    (Object.keys(size) as (keyof typeof size)[]).every(
      (key) => baseline.synthetic[key] === size[key],
    );
  if (baseline && !sameDataset)
    console.log(
      'Baselines were recorded for a different dataset size; every metric reports as new.',
    );
  const { rows, failed } = compareMetrics(
    metrics,
    sameDataset ? baseline?.metrics : undefined,
    args.factor,
  );
  console.log(`\nMedian of ${args.runs} run(s) after one warm-up; ${SSE_CLIENTS} SSE clients.`);
  console.log(
    `Threshold = max(baseline x ${args.factor}, baseline + 250 ms).\n\n${formatTable(rows)}\n`,
  );

  const round = (value: number) => Math.round(value * 10) / 10;
  if (args.json) {
    const target = path.resolve(args.json);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      `${JSON.stringify(
        {
          version: 1,
          runAt: new Date().toISOString(),
          machine,
          synthetic: size,
          runs: args.runs,
          factor: args.factor,
          sseClients: SSE_CLIENTS,
          samples: Object.fromEntries(
            Object.entries(samples).map(([name, values]) => [name, values.map(round)]),
          ),
          rows,
          failed,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (args.record) {
    const file: BaselineFile = {
      version: 1,
      recordedAt: new Date().toISOString(),
      machine,
      synthetic: size,
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([name, value]) => [name, { medianMs: round(value) }]),
      ),
    };
    await fs.writeFile(baselinePath, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`Recorded baselines to ${path.relative(repo, baselinePath)}.`);
    return 0;
  }
  if (failed) {
    console.log('Performance gate FAILED: a median exceeded its threshold.');
    return 1;
  }
  console.log('Performance gate passed.');
  return 0;
}

main().then(
  (code) => {
    cleanupSync();
    process.exit(code);
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    cleanupSync();
    process.exit(1);
  },
);
