/**
 * H14: single agent versus lead and workers, measured through the real host.
 *
 *   npx tsx scripts/h14-measure.ts [runs]
 *
 * Two arrangements, each run `runs` times (default 5) in a fresh data folder:
 *
 * A. The scripted fixture route, as shipped: an H13 loop on its own against
 *    the H14 lead with two workers and an advisor. The two scripts do not do
 *    the same work (the lone loop reads one file), so this measures the
 *    coordination overhead the host adds, not a like-for-like benefit.
 * B. A stub model-API route with a fixed delay per model call and equal work:
 *    one agent reads three files one after another, against a lead that reads
 *    one and hands the other two to workers that run at once. Nothing leaves
 *    the machine; the delay stands in for a provider's latency.
 * C. The same stub with heavier sub-tasks: six files, read one after another by
 *    one agent, against a lead that hands them to three workers, two files each.
 *
 * Latency is wall-clock from the start request to the lead's write waiting for
 * approval (the same point in both). Tokens are H18's estimate (UTF-8 bytes / 4)
 * of every model request as recorded in the lead's and its children's runs,
 * because neither route reports usage. Model calls are counted from the same
 * records. The numbers are printed as JSON; nothing is claimed beyond them.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import type { Store } from '../server/store.js';
import type { HarnessHost } from '../server/harness/host.js';
import type { LoopModelRoutes } from '../server/harness/capabilities/native-loop.js';
import { VERTEX_MODEL_CONTRACT } from '../server/harness/vertex-model-adapter.js';
import type { HarnessRun, ModelRequest, ModelResult } from '../shared/harness.js';
import { estimateTokens } from '../shared/context-accounting.js';

const RUNS = Number(process.argv[2] ?? 5);
const DELAY_MS = 200;
const ACCOUNT = 'google-vertex:measure@r1';
const FILES = {
  'order.md': 'Order 1182: 100 napkins, 40 tablecloths, 12 aprons, 6 table runners.\n'.repeat(20),
  'delivery.md': 'Delivered 94 napkins, 40 tablecloths, 12 aprons. Six napkins short; runners missing.\n'.repeat(20),
  'invoice.md': 'Invoice 77: 100 napkins, 40 tablecloths, 12 aprons, 6 runners billed.\n'.repeat(20),
};
const MORE = {
  'returns.md': 'Returned 2 tablecloths, stained.\n'.repeat(20),
  'credit.md': 'Credit note 12: 2 tablecloths.\n'.repeat(20),
  'schedule.md': 'Next delivery Tuesday.\n'.repeat(20),
};
const files = (arrangement: Arrangement) => (arrangement === 'C' ? { ...FILES, ...MORE } : FILES);
type Arrangement = 'A' | 'B' | 'C';
const GROUPS = [
  ['delivery.md', 'invoice.md'],
  ['returns.md', 'credit.md'],
  ['order.md', 'schedule.md'],
];

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });
const results = (call: ModelRequest) => call.messages.filter((message) => message.role === 'tool');

/** Scripts for arrangement B: same files read, same report written. */
function stub(): LoopModelRoutes {
  return {
    admit: async () => ({ model: 'measure-model', accountRoute: ACCOUNT }),
    adapter: async (route, request, stop) => ({
      id: route,
      version: 'measure-1',
      contract: VERTEX_MODEL_CONTRACT,
      destination: 'external',
      capabilities: () => ({
        engineId: route,
        engineVersion: 'measure-1',
        protocolVersion: 'stub',
        modelCalls: 'enforced',
        toolCalls: 'enforced',
        filesystemWrites: 'unsupported',
        networkEgress: 'enforced',
        approvals: 'unsupported',
        resumability: 'observed',
        cancellability: 'observed',
        checkpointGranularity: 'step',
        notes: ['A measurement stub; no provider.'],
      }),
      async complete(call, signal): Promise<ModelResult> {
        await pause(DELAY_MS, AbortSignal.any([signal, stop]));
        const transcript = {
          providerId: route,
          modelId: 'measure-model-001',
          lineageId: `m-${request.runId}`,
          opaqueRef: `m-${Math.random()}`,
          prefixHash: `m-${call.messages.length}`,
        };
        const done = results(call);
        if (request.purpose === 'worker') {
          const scope = call.messages[0]?.text?.match(/Files you may read: (.+)\./)?.[1]?.split(', ') ?? ['delivery.md'];
          if (done.length < scope.length) return { response: { type: 'tool', name: 'read_project_file', input: { path: scope[done.length] } }, transcript };
          return { response: { type: 'final', text: `Read ${scope.join(' and ')}.` }, transcript };
        }
        if (!call.tools.length) return { response: { type: 'final', text: '1. Read the files.\n2. Write the report.' }, transcript };
        const team = call.tools.some((tool) => tool.name === 'assign_workers');
        const heavy = call.messages[0]?.text?.includes('returns');
        const plan: { name: string; input: unknown }[] = heavy
          ? team
            ? [{ name: 'assign_workers', input: { tasks: GROUPS.map((group) => ({ task: `Read ${group.join(' and ')}.`, files: group })) } }]
            : GROUPS.flat().map((file) => ({ name: 'read_project_file', input: { path: file } }))
          : team
          ? [
              { name: 'read_project_file', input: { path: 'order.md' } },
              {
                name: 'assign_workers',
                input: {
                  tasks: ['delivery.md', 'invoice.md'].map((file) => ({ task: `Read ${file} and say what it lists.`, files: [file] })),
                },
              },
            ]
          : ['order.md', 'delivery.md', 'invoice.md'].map((file) => ({ name: 'read_project_file', input: { path: file } }));
        if (done.length < plan.length) return { response: { type: 'tool', ...(plan[done.length] as { name: string; input: never }) }, transcript };
        if (done.length === plan.length)
          return { response: { type: 'tool', name: 'propose_write', input: { text: '# Report\n\nCompared.\n' } }, transcript };
        return { response: { type: 'final', text: 'Proposed the report.' }, transcript };
      },
    }),
  };
}

interface Sample {
  latencyMs: number;
  modelCalls: number;
  estimatedTokens: number;
  runs: number;
}

async function measure(arrangement: Arrangement, team: boolean): Promise<Sample> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-h14-measure-'));
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
    ...(arrangement !== 'A' ? { loopModelRoutes: stub() } : {}),
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store: Store = app.locals.store;
  const host: HarnessHost = app.locals.harness;
  try {
    const project = await store.locked(() => store.createProject('Measure'));
    for (const [name, text] of Object.entries(files(arrangement))) await fs.writeFile(path.join(project.folder, name), text);
    const taskId = await store.locked(async () => {
      const task = store.createTask(store.state(project.id), { name: 'Compare' });
      await store.persist(store.state(project.id));
      return task.id;
    });
    const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
    if (arrangement !== 'A') {
      await store.saveSettings({
        ...store.settings,
        services: { ...(store.settings.services ?? {}), 'google-vertex': true, 'google-vertexAccountRoute': ACCOUNT },
      });
      await fetch(`${url}/api/projects/${project.id}/cloud-sharing`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedVersion: 0, routes: ['google-vertex'], documents: Object.keys(files(arrangement)), shareConversationHistory: false, shareReviewPackets: false }),
      });
    }
    const began = performance.now();
    const response = await fetch(`${url}/api/projects/${project.id}/loop/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 1,
        commandId: `measure-${team ? 'team' : 'single'}`,
        taskId,
        goal:
          arrangement === 'C'
            ? 'Compare the order with the delivery, invoice, returns, credit and schedule, and write the report.'
            : 'Compare the order with the delivery and the invoice, and write the report.',
        route: arrangement === 'A' ? 'native-fixture' : 'google-vertex',
        consent: arrangement !== 'A',
        sources: Object.keys(files(arrangement)),
        ...(team ? { team: { worker: {}, advisor: arrangement === 'A' ? {} : null } } : {}),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const { runId } = (await response.json()) as { runId: string };
    for (;;) {
      if (store.state(project.id).needs.some((need) => need.state === 'open')) break;
      const run = await host.get(project.id, runId);
      if (['failed', 'cancelled', 'completed'].includes(run.state)) throw new Error(`The lead ended ${run.state} before its write.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latencyMs = performance.now() - began;
    const lead = await host.get(project.id, runId);
    const children = await host.loop.children(lead);
    const all: HarnessRun[] = [lead, ...children];
    let modelCalls = 0;
    let estimatedTokens = 0;
    for (const run of all)
      for (const step of run.steps)
        if (step.intent.kind === 'model' && step.state === 'succeeded') {
          modelCalls += 1;
          estimatedTokens += estimateTokens(JSON.stringify(step.intent.input));
        }
    return { latencyMs, modelCalls, estimatedTokens, runs: all.length };
  } finally {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function main() {
  const report: Record<string, unknown> = { runs: RUNS, delayPerModelCallMs: DELAY_MS, node: process.version, platform: `${process.platform} ${os.arch()}`, cpus: os.cpus().length };
  for (const arrangement of ['A', 'B', 'C'] as const)
    for (const team of [false, true]) {
      const samples: Sample[] = [];
      for (let index = 0; index < RUNS; index++) samples.push(await measure(arrangement, team));
      report[`${arrangement}:${team ? 'lead+workers' : 'single'}`] = {
        latencyMs: { median: Math.round(median(samples.map((s) => s.latencyMs))), min: Math.round(Math.min(...samples.map((s) => s.latencyMs))), max: Math.round(Math.max(...samples.map((s) => s.latencyMs))) },
        modelCalls: samples[0].modelCalls,
        estimatedTokens: samples[0].estimatedTokens,
        harnessRuns: samples[0].runs,
      };
    }
  console.log(JSON.stringify(report, null, 2));
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
