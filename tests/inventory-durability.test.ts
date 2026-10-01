import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  INVENTORY_CONTRACT_VERSION,
  inventoryReceiptSchema,
  type InventoryCommand,
  type InventoryScope,
} from '../shared/inventory.js';
import {
  InventoryStockService,
  type InventoryStockAuthorization,
  type InventoryStockAuthorizer,
} from '../server/inventory/stock-service.js';
import { parseInventoryStockDocument } from '../server/inventory/ledger.js';
import { Store } from '../server/store.js';
import { denial } from '../server/trust/index.js';
import type { HistoryEntry } from '../shared/types.js';

/**
 * MI03 durability/concurrency evidence beyond the in-process suite. Real
 * temporary files and owned child processes; synchronization is file-marker
 * based, never timing guesses. Children run the same production modules
 * (Store, InventoryStockService, InventoryStockRepository) under
 * `node --import tsx`.
 *
 * The stock document is the authoritative ledger; Store History carries the
 * linked evidence entries. These tests assert both survive real crashes and
 * real competing processes.
 */

const STOCK_PATH = 'inventory/stock.json';
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'inventory-stock-child.ts');
const NOW = '2026-09-19T12:00:00.000Z';
const CHILD_WAIT_MS = 60_000;

const sha256 = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');

function balanceRow(
  itemId: string,
  binId: string,
  onHandMinor: number,
  version: string,
) {
  return {
    itemId,
    siteId: 'north',
    binId,
    onHandMinor,
    reservedMinor: 0,
    availableMinor: onHandMinor,
    unit: 'each',
    scale: 0,
    version,
    observedAt: NOW,
    lastMovementAt: null,
    lastPhysicalCountAt: null,
    countEvidence: null,
    source: {
      kind: 'recorded-ledger' as const,
      reference: 'fixture',
      revision: '1',
      observedAt: NOW,
    },
  };
}

function stockDocument(scope: InventoryScope, fillerItems = 0) {
  const items = [
    {
      id: 'bolt',
      name: 'Bolt',
      variant: null,
      unit: 'each',
      scale: 0,
      barcodes: ['0001'],
    },
  ];
  const balances = [
    balanceRow('bolt', 'a1', 5, '7'),
    balanceRow('bolt', 'b1', 2, '3'),
  ];
  for (let index = 0; index < fillerItems; index += 1) {
    items.push({
      id: `filler-${index}`,
      name: `Filler item ${index} with a reasonably long descriptive name`,
      variant: null,
      unit: 'each',
      scale: 0,
      barcodes: [],
    });
    balances.push(balanceRow(`filler-${index}`, 'a1', 1000 + index, `f${index}`));
  }
  return {
    schemaVersion: 1 as const,
    version: 'document-1',
    catalog: {
      contractVersion: INVENTORY_CONTRACT_VERSION,
      scope,
      authority: 'recorded-ledger' as const,
      reservationMode: 'read-only' as const,
      items,
      sites: [{ id: 'north', name: 'North' }],
      bins: [
        { id: 'a1', siteId: 'north', name: 'A1' },
        { id: 'b1', siteId: 'north', name: 'B1' },
      ],
      balances,
    },
    operations: [],
  };
}

function useCommand(operationId: string, minor = 4, binId = 'a1', expectedVersion = '7'): InventoryCommand {
  return {
    operationId,
    kind: 'use',
    itemId: 'bolt',
    siteId: 'north',
    binId,
    expectedVersion,
    quantity: { minor, scale: 0, unit: 'each' },
    reason: 'Synthetic job',
    jobId: 'job-1',
  };
}

function allowed(scope: InventoryScope): InventoryStockAuthorization {
  return {
    scope,
    actorPersonId: 'person-1',
    permissions: ['receive', 'use', 'transfer', 'adjust', 'record-count', 'correct'],
    authority: {
      principal: {
        kind: 'session',
        id: 'principal-1',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deviceId: 'device-1',
        sessionId: 'session-1',
        slotId: null,
      },
      generation: { identity: 1, principal: 1 },
      assurance: 'device-key',
      capabilities: new Set(['project.read', 'write.apply']),
      expiresAt: null,
      synthetic: false,
      resolvedAt: NOW,
    },
  };
}

const authorizeAll: InventoryStockAuthorizer<string> = async () =>
  allowed(scopeRef.value);
let scopeRef: { value: InventoryScope } = { value: { organizationId: '', tenantId: '', projectId: '' } };

interface ChildArgs {
  mode: 'execute' | 'guarded-commit' | 'status' | 'view' | 'recover';
  dataDir: string;
  projectRoot: string;
  projectId: string;
  scope: InventoryScope;
  stockPath: string;
  actorPersonId?: string;
  command?: unknown;
  syncDir?: string;
  selfMarker?: string;
  selfMarkerAfterWait?: boolean;
  peerMarkers?: string[];
  peerWaitSoft?: boolean;
  waitForMarkers?: string[];
  parkedMarker?: string;
  waitAfterInitMarkers?: string[];
  doneMarker?: string;
  waitTimeoutMs?: number;
  out: string;
}

interface ChildResult {
  pid: number;
  status: 'ok' | 'result' | 'applied' | 'thrown' | 'harness-failure';
  result?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  error?: { kind: string; status?: number; code?: string; message: string };
}

interface ChildHandle {
  proc: ChildProcess;
  out: string;
  exited: Promise<number | null>;
  stderr: () => string;
  result: () => Promise<ChildResult>;
}

interface Environment {
  root: string;
  dataDir: string;
  projectRoot: string;
  projectFolder: string;
  projectId: string;
  scope: InventoryScope;
  stockAbs: string;
  statePath: string;
  pendingDir: string;
  syncDir: string;
  store: Store;
}

async function seedEnvironment(root: string, fillerItems = 0): Promise<Environment> {
  const dataDir = path.join(root, 'data');
  const projectRoot = path.join(root, 'projects');
  const projectFolder = path.join(root, 'project');
  const syncDir = path.join(root, 'sync');
  await fsp.mkdir(projectFolder, { recursive: true });
  await fsp.mkdir(syncDir, { recursive: true });
  const store = new Store(dataDir, projectRoot);
  await store.init();
  const projectId = (await store.locked(() => store.createProject('Inventory', projectFolder))).id;
  const scope: InventoryScope = {
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    projectId,
  };
  scopeRef = { value: scope };
  const stockAbs = path.join(projectFolder, STOCK_PATH);
  await fsp.mkdir(path.dirname(stockAbs), { recursive: true });
  await fsp.writeFile(stockAbs, JSON.stringify(stockDocument(scope, fillerItems)), 'utf8');
  return {
    root,
    dataDir,
    projectRoot,
    projectFolder,
    projectId,
    scope,
    stockAbs,
    statePath: path.join(dataDir, 'projects', projectId, 'state.json'),
    pendingDir: path.join(dataDir, 'inventory-pending'),
    syncDir,
    store,
  };
}

async function readHistory(env: Environment): Promise<HistoryEntry[]> {
  const state = JSON.parse(await fsp.readFile(env.statePath, 'utf8')) as {
    history: HistoryEntry[];
  };
  return state.history;
}

async function stockText(env: Environment): Promise<string | null> {
  try {
    return await fsp.readFile(env.stockAbs, 'utf8');
  } catch {
    return null;
  }
}

/** Every stock operation must have exactly one linked, recorded History entry — and vice versa. */
async function assertLedgerMatchesHistory(env: Environment) {
  const text = await stockText(env);
  expect(text).not.toBeNull();
  const snapshot = parseInventoryStockDocument(JSON.parse(text as string), env.scope);
  const history = await readHistory(env);
  const stockEntries = history.filter(
    (entry) =>
      entry.kind === 'inventory-stock' &&
      entry.files.some((file) => file.path === STOCK_PATH),
  );
  expect(new Set(history.map((entry) => entry.versionId)).size).toBe(history.length);
  expect(new Set(history.map((entry) => entry.id)).size).toBe(history.length);
  expect([...stockEntries.map((entry) => entry.label)].sort()).toEqual(
    [...snapshot.operations.map((op) => op.command.operationId)].sort(),
  );
  const currentSha = sha256(text);
  const lastOpId = snapshot.operations.at(-1)?.command.operationId;
  for (const op of snapshot.operations) {
    const entry = stockEntries.find((candidate) => candidate.id === op.receipt.historyEntryId);
    expect(entry, `History entry for ${op.command.operationId}`).toBeTruthy();
    expect(entry?.label).toBe(op.command.operationId);
    expect(entry?.files).toHaveLength(1);
    expect(entry?.files[0]?.path).toBe(STOCK_PATH);
    expect(entry?.files[0]?.recorded).toBe(true);
    expect(entry?.files[0]?.after).toMatch(/^[a-f0-9]{64}$/);
    if (op.command.operationId === lastOpId) {
      expect(entry?.files[0]?.after).toBe(currentSha);
    }
  }
  return { snapshot, history, stockEntries };
}

async function pendingJournals(env: Environment): Promise<string[]> {
  try {
    return (await fsp.readdir(env.pendingDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = CHILD_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function stamp(env: Environment, marker: string): Promise<void> {
  return fsp.writeFile(path.join(env.syncDir, marker), String(Date.now()));
}

function spawnChild(
  env: Environment,
  name: string,
  args: Omit<
    ChildArgs,
    'dataDir' | 'projectRoot' | 'projectId' | 'scope' | 'stockPath' | 'out' | 'syncDir'
  >,
): ChildHandle {
  const out = path.join(env.syncDir, `${name}.out.json`);
  const argsPath = path.join(env.syncDir, `${name}.args.json`);
  const full: ChildArgs = {
    dataDir: env.dataDir,
    projectRoot: env.projectRoot,
    projectId: env.projectId,
    scope: env.scope,
    stockPath: STOCK_PATH,
    syncDir: env.syncDir,
    out,
    ...args,
  };
  fs.writeFileSync(argsPath, JSON.stringify(full));
  const proc = spawn(process.execPath, ['--import', 'tsx', FIXTURE, argsPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  proc.stderr?.on('data', (chunk) => {
    stderrBuf += chunk;
  });
  proc.stdout?.on('data', () => {});
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', resolve);
    proc.on('error', () => resolve(null));
  });
  return {
    proc,
    out,
    exited,
    stderr: () => stderrBuf,
    result: async () => {
      try {
        return JSON.parse(await fsp.readFile(out, 'utf8')) as ChildResult;
      } catch {
        return {
          pid: -1,
          status: 'harness-failure',
          error: { kind: 'error', message: `no result file; stderr: ${stderrBuf.slice(-400)}` },
        };
      }
    },
  };
}

async function runChild(
  env: Environment,
  name: string,
  args: Parameters<typeof spawnChild>[2],
): Promise<ChildResult> {
  const child = spawnChild(env, name, args);
  await child.exited;
  return child.result();
}

function kill(proc: ChildProcess): boolean {
  try {
    return proc.kill('SIGKILL');
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function makeEnv(fillerItems = 0): Promise<Environment> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'diomedes-inv-dur-'));
  roots.push(root);
  return seedEnvironment(root, fillerItems);
}

describe('inventory durability — malformed recovery records (in-process)', () => {
  test('a malformed pending journal fails closed and is preserved for inspection', async () => {
    const env = await makeEnv();
    const service = new InventoryStockService({
      store: env.store,
      stockPath: STOCK_PATH,
      authorize: authorizeAll,
    });
    await fsp.mkdir(env.pendingDir, { recursive: true });
    const journalPath = path.join(env.pendingDir, 'corrupt.json');
    await fsp.writeFile(journalPath, '{this is not json', 'utf8');

    const beforeText = await stockText(env);
    await expect(
      service.execute(env.projectId, useCommand('use-malformed'), 'probe'),
    ).rejects.toThrow();
    // The corrupt journal is evidence; recovery must not delete or truncate it.
    expect(await fsp.readFile(journalPath, 'utf8')).toBe('{this is not json');
    expect(await stockText(env)).toBe(beforeText);
    expect(
      (await readHistory(env)).filter((entry) => entry.kind === 'inventory-stock'),
    ).toHaveLength(0);

    // Clearing the damaged record unblocks the ledger.
    await fsp.unlink(journalPath);
    const recovered = await service.execute(env.projectId, useCommand('use-after-clear'), 'probe');
    expect(recovered.status).toBe('applied');
    await assertLedgerMatchesHistory(env);
  });

  test('a structurally broken journal fails closed; a foreign-path journal is left alone', async () => {
    const env = await makeEnv();
    const service = new InventoryStockService({
      store: env.store,
      stockPath: STOCK_PATH,
      authorize: authorizeAll,
    });
    await fsp.mkdir(env.pendingDir, { recursive: true });

    // Valid JSON, wrong shape: must fail closed, not be skipped silently.
    const brokenPath = path.join(env.pendingDir, 'broken-shape.json');
    await fsp.writeFile(
      brokenPath,
      JSON.stringify({ schemaVersion: 2, id: 'x', note: 'not a journal' }),
      'utf8',
    );
    await expect(
      service.execute(env.projectId, useCommand('use-broken'), 'probe'),
    ).rejects.toThrow();
    await fsp.unlink(brokenPath);

    // A real journal for a different stock path in the same pending folder is
    // skipped by the ownership filter and left for its own ledger's recovery.
    // Capture one by running a genuine commit on a second stock document and
    // copying the journal out at the replace barrier.
    const otherPath = 'inventory/other-stock.json';
    const otherAbs = path.join(env.projectFolder, otherPath);
    await fsp.mkdir(path.dirname(otherAbs), { recursive: true });
    await fsp.writeFile(otherAbs, JSON.stringify(stockDocument(env.scope)), 'utf8');
    const { InventoryStockRepository } = await import('../server/inventory/stock-repository.js');
    const { prepareInventoryCommand } = await import('../server/inventory/commands.js');
    const { identifier } = await import('../server/store.js');
    const otherRepo = new InventoryStockRepository(env.store, otherPath);
    const otherBefore = (await otherRepo.read(env.projectId)) as string;
    let capturedJournal = '';
    const foreignCommand = useCommand('use-elsewhere', 1);
    await env.store.locked(() =>
      otherRepo.commit(
        env.projectId,
        otherBefore,
        { sentence: 'Foreign commit.', label: foreignCommand.operationId },
        (entry) => {
          const snapshot = parseInventoryStockDocument(JSON.parse(otherBefore), env.scope);
          const prepared = prepareInventoryCommand(snapshot, foreignCommand, {
            scope: env.scope,
            actorPersonId: 'person-1',
            now: entry.time,
            nextDocumentVersion: identifier('D'),
            receiptId: identifier('R'),
            historyEntryId: entry.id,
            balanceVersions: { source: identifier('B') },
          });
          if (prepared.status !== 'prepared') throw new Error('unexpected');
          return {
            afterText: JSON.stringify(prepared.proposedDocument, null, 2),
            receipt: inventoryReceiptSchema.parse(prepared.proposedReceipt),
          };
        },
        async () => {
          const names = (await fsp.readdir(env.pendingDir)).filter((n) => n.endsWith('.json'));
          capturedJournal = await fsp.readFile(
            path.join(env.pendingDir, names[0] as string),
            'utf8',
          );
        },
      ),
    );
    expect(capturedJournal.length).toBeGreaterThan(0);
    // The commit consumed its own journal; restore a copy as the foreign record.
    const foreignPath = path.join(env.pendingDir, 'foreign.json');
    await fsp.writeFile(foreignPath, capturedJournal, 'utf8');

    const outcome = await service.execute(env.projectId, useCommand('use-foreign-ok'), 'probe');
    expect(outcome.status).toBe('applied');
    await assertLedgerMatchesHistory(env);
    expect(JSON.parse(await fsp.readFile(foreignPath, 'utf8')).operationId).toBe('use-elsewhere');
  });
});

describe('inventory durability — real competing processes', () => {
  test('a stale second process cannot erase a committed History entry', async () => {
    const env = await makeEnv();
    // B fully initializes (loads project state into memory) and parks. A then
    // commits a stock operation. B wakes and commits its own operation from its
    // stale in-memory state. Both operations target different balances so only
    // the state snapshot staleness is under test.
    const a = spawnChild(env, 'stale-a', {
      mode: 'execute',
      command: useCommand('use-a', 4, 'a1', '7'),
      parkedMarker: 'a.parked',
      waitAfterInitMarkers: ['go'],
      doneMarker: 'a.done',
      waitTimeoutMs: 45_000,
    });
    const b = spawnChild(env, 'stale-b', {
      mode: 'execute',
      command: useCommand('use-b', 1, 'b1', '3'),
      parkedMarker: 'b.parked',
      waitAfterInitMarkers: ['a.done'],
      waitTimeoutMs: 45_000,
    });
    await waitFor('both children parked', async () => {
      return (
        fs.existsSync(path.join(env.syncDir, 'a.parked')) &&
        fs.existsSync(path.join(env.syncDir, 'b.parked'))
      );
    });
    await stamp(env, 'go');
    await Promise.all([a.exited, b.exited]);
    const [outA, outB] = [await a.result(), await b.result()];
    expect((outA.result as { status: string } | undefined)?.status).toBe('applied');
    expect((outB.result as { status: string } | undefined)?.status).toBe('applied');

    // Both operations and BOTH linked History entries must survive — B's
    // persist may not silently drop what it never saw.
    const { snapshot, stockEntries } = await assertLedgerMatchesHistory(env);
    expect(snapshot.operations).toHaveLength(2);
    expect(stockEntries).toHaveLength(2);
    const a1 = snapshot.catalog.balances.find((row) => row.itemId === 'bolt' && row.binId === 'a1');
    const b1 = snapshot.catalog.balances.find((row) => row.itemId === 'bolt' && row.binId === 'b1');
    expect(a1?.availableMinor).toBe(1);
    expect(b1?.availableMinor).toBe(1);
  });

  test('the MI03 regression case across two processes: last units go to exactly one worker', async () => {
    const env = await makeEnv();
    const a = spawnChild(env, 'race-a', {
      mode: 'execute',
      command: useCommand('use-a', 4),
      parkedMarker: 'a.parked',
      waitAfterInitMarkers: ['race.go'],
      waitTimeoutMs: 45_000,
    });
    const b = spawnChild(env, 'race-b', {
      mode: 'execute',
      command: useCommand('use-b', 4),
      parkedMarker: 'b.parked',
      waitAfterInitMarkers: ['race.go'],
      waitTimeoutMs: 45_000,
    });
    await waitFor('both children parked', async () => {
      return (
        fs.existsSync(path.join(env.syncDir, 'a.parked')) &&
        fs.existsSync(path.join(env.syncDir, 'b.parked'))
      );
    });
    await stamp(env, 'race.go');
    await Promise.all([a.exited, b.exited]);
    const [outA, outB] = [await a.result(), await b.result()];
    const statuses = [outA, outB].map(
      (row) => (row.result as { status: string })?.status ?? row.status,
    );
    expect(statuses.filter((status) => status === 'applied')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'conflict')).toHaveLength(1);

    const { snapshot, stockEntries } = await assertLedgerMatchesHistory(env);
    expect(snapshot.operations).toHaveLength(1);
    expect(stockEntries).toHaveLength(1);
    const balance = snapshot.catalog.balances.find(
      (row) => row.itemId === 'bolt' && row.binId === 'a1',
    );
    expect(balance?.availableMinor).toBe(1);

    // Loser reconciles by ID; winner replays without a duplicate effect.
    const loserId = statuses[0] === 'conflict' ? 'use-a' : 'use-b';
    const winnerId = loserId === 'use-a' ? 'use-b' : 'use-a';
    const statusLoser = await runChild(env, 'status-loser', {
      mode: 'status',
      command: loserId,
    });
    expect((statusLoser.result as { status: string }).status).toBe('not-found');
    const replayWinner = await runChild(env, 'replay-winner', {
      mode: 'execute',
      command: useCommand(winnerId, 4),
    });
    expect((replayWinner.result as { status: string }).status).toBe('already-applied');
    const { snapshot: after } = await assertLedgerMatchesHistory(env);
    expect(after.operations).toHaveLength(1);
  });

  test(
    'a racing second process cannot steal a live commit journal',
    { timeout: 120_000 },
    async () => {
    const env = await makeEnv(400);
    // A commits with a barrier inside the replace guard: its journal exists on
    // disk while it waits (softly) for B's recovery to have run. B waits for
    // A's barrier marker — the journal is guaranteed live at that point — then
    // inits, which runs recover. Post-fix B's recover must serialize behind
    // A's in-flight commit rather than sweep its journal.
    const a = spawnChild(env, 'commit-a', {
      mode: 'guarded-commit',
      command: useCommand('use-a', 4),
      selfMarker: 'a.ready',
      peerMarkers: ['b.done'],
      peerWaitSoft: true,
      waitTimeoutMs: 12_000,
    });
    await waitFor('a barrier marker', async () =>
      fs.existsSync(path.join(env.syncDir, 'a.ready')),
    );
    await waitFor('a journal on disk', async () => (await pendingJournals(env)).length > 0);

    const b = spawnChild(env, 'recover-b', {
      mode: 'recover',
      waitForMarkers: ['a.ready'],
      doneMarker: 'b.done',
      waitTimeoutMs: 45_000,
    });
    const [aResult, bResult] = await Promise.all([
      a.exited.then(() => a.result()),
      b.exited.then(() => b.result()),
    ]);
    expect(aResult.status).toBe('applied');
    expect(bResult.status).toBe('ok');
    expect(await pendingJournals(env)).toEqual([]);
    const { snapshot } = await assertLedgerMatchesHistory(env);
    expect(snapshot.operations).toHaveLength(1);
    expect(snapshot.operations[0]?.command.operationId).toBe('use-a');
    },
  );
});

describe('inventory durability — owned-process termination and restart', () => {
  test.each(['journal-written', 'stock-replaced', 'commit-complete'] as const)(
    'SIGKILL at %s leaves a reconcilable ledger — restart confirms exactly once',
    { timeout: 120_000 },
    async (trigger) => {
      const env = await makeEnv(400);
      const beforeText = (await stockText(env)) as string;
      const beforeSha = sha256(beforeText);
      const command = useCommand(`use-kill-${trigger}`, 4);
      const outFile = path.join(env.syncDir, `kill-${trigger}.out.json`);

      const child = spawnChild(env, `kill-${trigger}`, { mode: 'execute', command });

      let journal: { afterSha?: string } | null = null;
      if (trigger === 'journal-written') {
        await waitFor('journal file', async () => {
          const names = await pendingJournals(env);
          if (names.length === 0) return false;
          journal = JSON.parse(
            await fsp.readFile(path.join(env.pendingDir, names[0] as string), 'utf8'),
          );
          return true;
        });
        kill(child.proc);
      } else if (trigger === 'stock-replaced') {
        await waitFor('journal file', async () => {
          const names = await pendingJournals(env);
          if (names.length === 0) return false;
          journal = JSON.parse(
            await fsp.readFile(path.join(env.pendingDir, names[0] as string), 'utf8'),
          );
          return true;
        });
        await waitFor('stock file reaching the journaled after-sha', async () => {
          return sha256(await stockText(env)) === journal?.['afterSha'];
        });
        kill(child.proc);
      } else {
        // The result file exists → commit + persist + journal cleanup all done;
        // kill the finishing process for real termination evidence.
        await waitFor('child result file', async () => fs.existsSync(outFile));
        kill(child.proc);
      }
      await child.exited;

      const recover = await runChild(env, `recover-${trigger}`, { mode: 'recover' });
      expect(recover.status).toBe('ok');
      expect(await pendingJournals(env)).toEqual([]);

      const actualText = (await stockText(env)) as string;
      const actualSha = sha256(actualText);
      const landedOnDisk = parseInventoryStockDocument(
        JSON.parse(actualText),
        env.scope,
      ).operations.some((op) => op.command.operationId === command.operationId);

      const status = await runChild(env, `status-${trigger}`, {
        mode: 'status',
        command: command.operationId,
      });
      if (landedOnDisk) {
        // The effect landed durably: status finds it, replay returns the same receipt.
        expect((status.result as { status: string }).status).toBe('applied');
        const replay = await runChild(env, `replay-${trigger}`, {
          mode: 'execute',
          command,
        });
        expect((replay.result as { status: string }).status).toBe('already-applied');
        const replayReceipt = (replay.result as { receipt: unknown }).receipt;
        const statusReceipt = (status.result as { receipt: unknown }).receipt;
        expect(replayReceipt).toEqual(statusReceipt);
        const { snapshot } = await assertLedgerMatchesHistory(env);
        expect(snapshot.operations).toHaveLength(1);
      } else {
        // The effect never landed: recovery must not mint a ghost — the document
        // is unchanged, status is not-found, and a retry applies exactly once.
        expect(actualSha).toBe(beforeSha);
        expect((status.result as { status: string }).status).toBe('not-found');
        const replay = await runChild(env, `replay-${trigger}`, {
          mode: 'execute',
          command,
        });
        expect((replay.result as { status: string }).status).toBe('applied');
        const { snapshot } = await assertLedgerMatchesHistory(env);
        expect(snapshot.operations).toHaveLength(1);
      }
    },
  );

  test(
    'a killed transfer never debits without crediting',
    { timeout: 120_000 },
    async () => {
    const env = await makeEnv(400);
    const beforeText = (await stockText(env)) as string;
    const command: InventoryCommand = {
      operationId: 'transfer-killed',
      kind: 'transfer',
      itemId: 'bolt',
      siteId: 'north',
      binId: 'a1',
      expectedVersion: '7',
      quantity: { minor: 2, scale: 0, unit: 'each' },
      destination: { siteId: 'north', binId: 'b1', expectedVersion: '3' },
      reason: 'Move to point of use',
    };
    const child = spawnChild(env, 'transfer-kill', {
      mode: 'guarded-commit',
      command,
      selfMarker: 'transfer.parked',
      peerMarkers: ['transfer.never'],
      waitTimeoutMs: CHILD_WAIT_MS,
    });
    // The barrier marker is written inside the commit's replace guard, so the
    // journal is guaranteed on disk — a deterministic kill point, no polling race.
    await waitFor('transfer parked at the replace barrier', async () =>
      fs.existsSync(path.join(env.syncDir, 'transfer.parked')));
    expect(await pendingJournals(env)).not.toEqual([]);
    kill(child.proc);
    await child.exited;

    const recover = await runChild(env, 'transfer-recover', { mode: 'recover' });
    expect(recover.status).toBe('ok');
    const text = (await stockText(env)) as string;
    const snapshot = parseInventoryStockDocument(JSON.parse(text), env.scope);
    const source = snapshot.catalog.balances.find(
      (row) => row.binId === 'a1' && row.itemId === 'bolt',
    );
    const dest = snapshot.catalog.balances.find(
      (row) => row.binId === 'b1' && row.itemId === 'bolt',
    );
    if (snapshot.operations.length === 1) {
      // Atomic: both endpoints moved together, or neither did.
      expect(snapshot.operations[0]?.command.operationId).toBe('transfer-killed');
      expect(source?.availableMinor).toBe(3);
      expect(dest?.availableMinor).toBe(4);
    } else {
      expect(snapshot.operations).toHaveLength(0);
      expect(source?.availableMinor).toBe(5);
      expect(dest?.availableMinor).toBe(2);
      expect(text).toBe(beforeText);
      }
    await assertLedgerMatchesHistory(env);
    },
  );
});

describe('inventory durability — cross-process replay and status', () => {
  test('a committed operation replays already-applied from a different process', async () => {
    const env = await makeEnv();
    const first = await runChild(env, 'first', {
      mode: 'execute',
      command: useCommand('use-shared', 4),
    });
    expect((first.result as { status: string }).status).toBe('applied');
    const firstReceipt = (first.result as { receipt: unknown }).receipt;

    const replay = await runChild(env, 'replay', {
      mode: 'execute',
      command: useCommand('use-shared', 4),
    });
    expect((replay.result as { status: string }).status).toBe('already-applied');
    expect((replay.result as { receipt: unknown }).receipt).toEqual(firstReceipt);

    const { snapshot } = await assertLedgerMatchesHistory(env);
    expect(snapshot.operations).toHaveLength(1);
  });

  test('the same operation id with changed intent is rejected across processes', async () => {
    const env = await makeEnv();
    const first = await runChild(env, 'orig', {
      mode: 'execute',
      command: useCommand('use-same-id', 4),
    });
    expect((first.result as { status: string }).status).toBe('applied');

    const changed = await runChild(env, 'changed', {
      mode: 'execute',
      command: {
        ...useCommand('use-same-id', 4),
        quantity: { minor: 3, scale: 0, unit: 'each' },
      },
    });
    // A reused operation ID carrying different intent is refused (409 from the
    // recorded-match check), never silently replayed.
    expect(changed.status).toBe('thrown');
    expect(changed.error?.kind).toBe('api');
    expect(changed.error?.status).toBe(409);
    const { snapshot } = await assertLedgerMatchesHistory(env);
    expect(snapshot.operations).toHaveLength(1);
  });

  test('a view across processes shows receipts joined to their History entries', async () => {
    const env = await makeEnv();
    await runChild(env, 'exec-1', { mode: 'execute', command: useCommand('use-1', 4, 'a1', '7') });
    await runChild(env, 'exec-2', { mode: 'execute', command: useCommand('use-2', 1, 'b1', '3') });
    const view = await runChild(env, 'view', { mode: 'view' });
    expect(view.status).toBe('result');
    const result = view.result as {
      receipts: { operationId: string; historyEntryId: string }[];
      historyEntries: number;
      historyLabels: (string | null)[];
    };
    expect(result.receipts).toHaveLength(2);
    expect(result.historyLabels).toContain('use-1');
    expect(result.historyLabels).toContain('use-2');
    await assertLedgerMatchesHistory(env);
  });
});

describe('inventory durability — authority changes across restart', () => {
  test(
    'recovery completes after revocation but new writes are denied',
    { timeout: 120_000 },
    async () => {
    const env = await makeEnv();
    const child = spawnChild(env, 'killable', {
      mode: 'execute',
      command: useCommand('use-then-die', 4),
    });
    await waitFor('journal file', async () => (await pendingJournals(env)).length > 0);
    kill(child.proc);
    await child.exited;

    const deniedAuthorizer: InventoryStockAuthorizer<string> = async () =>
      denial(403, 'revoked', 'Access was revoked.');
    const deniedService = new InventoryStockService({
      store: env.store,
      stockPath: STOCK_PATH,
      authorize: deniedAuthorizer,
    });
    const denied = await deniedService.execute(
      env.projectId,
      useCommand('use-post-revoke', 1, 'b1', '3'),
      'probe',
    );
    expect(denied.status).toBe('denied');

    const recover = await runChild(env, 'post-revoke-recover', { mode: 'recover' });
    expect(recover.status).toBe('ok');
    await assertLedgerMatchesHistory(env);
    },
  );
});
