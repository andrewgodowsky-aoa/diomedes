import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import { jsonWrite } from '../server/store.js';

test.skipIf(process.platform !== 'win32').each(['run', 'shared'] as const)('%s record writes survive a Windows reader lock lasting longer than 300 ms', async writer => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-run-store-lock-'));
  const files = new FileRunStore(root);
  const service = new RunService(files, { clock: () => 1000 });
  await service.start({
    id: 'R-lock-proof', tenantId: 'fixture', projectId: 'fixture',
    capability: {
      id: 'fixture', version: 'v1', label: 'Fixture', description: 'Filesystem-only fixture.',
      tools: [], requestedPermissions: [], approvalPolicy: 'show-first', maxTurns: 1,
      supportedPlatforms: ['win32'],
    },
    principal: { id: 'fixture', tenantId: 'fixture', projectId: 'fixture', capabilities: [], identityGeneration: 1 },
    budget: { units: 1, modelCalls: 0, toolCalls: 0, wallMs: null },
  });
  const before = await service.get('R-lock-proof');
  const target = path.join(root, 'R-lock-proof.json');
  // This owned reader permits reads and writes but withholds Windows delete-sharing,
  // the permission atomic replacement needs. No model, app or user file is involved.
  const reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$held = [IO.File]::Open($env:DIOMEDES_TEST_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); ' +
    'try { [Console]::Out.WriteLine("locked"); [Threading.Thread]::Sleep(650) } finally { $held.Dispose() }',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DIOMEDES_TEST_LOCK_FILE: target } });
  let diagnostics = '';
  reader.stderr.on('data', chunk => { diagnostics += String(chunk); });
  const closed = once(reader, 'close');
  void closed.catch(() => undefined);
  const rename = fs.rename.bind(fs);
  let collisions = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    try { await rename(from, to); } catch (error) {
      if (String(to) === target && (error as NodeJS.ErrnoException).code === 'EPERM') collisions++;
      throw error;
    }
  });
  try {
    const [ready] = await once(reader.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
    expect(String(ready).trim(), diagnostics).toBe('locked');
    const after = { ...before, updatedAt: new Date(2000).toISOString() };
    if (writer === 'run') await files.write(after);
    else await jsonWrite(target, after);
    expect(collisions).toBeGreaterThan(0);
    expect(await files.read(before.id)).toEqual(after);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    spy.mockRestore();
    const [code] = await closed;
    expect(code, diagnostics).toBe(0);
    await fs.rm(root, { recursive: true, force: true });
  }
});
