import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { TextRequest } from '../server/engines/contract';
import type { TransientPreview } from '../shared/adapter-contract';
import { contractChecks } from '../server/harness/conformance';
import { routeContractFor } from '../server/harness/route-contract';
import { fixtureTextDispatch, textResponse } from './h01-fixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function heldRequest() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h01-preview-repair-'));
  roots.push(root);
  const runtime = fixtureTextDispatch(root);
  const frames: TransientPreview[] = [];
  let input: TextRequest | undefined;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [{ id: 'claude-code', name: 'Fixture', kind: 'online',
      found: true, available: false, enabled: false, status: 'Installed', detail: '',
      capabilities: [], signIn: 'unknown', adapter: 'planned',
      installedVersion: TESTED_VERSIONS['claude-code'], location: 'fixture', disclosure: [] }],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => ({ id: 'claude-code', contract: routeContractFor('claude-code'),
      inspect: async () => ({ authentication: 'signed-in', accountRoute: 'fixture:account',
        models: [{ slug: 'fixture-model', name: 'Fixture', description: '', efforts: [], defaultEffort: null }], detail: '' }),
      generate: async request => {
        input = request;
        request.onDelta?.('current');
        await held;
        return textResponse(request, 'final', TESTED_VERSIONS['claude-code']);
      },
    }),
  });
  service.dispatch = runtime.dispatch;
  const job = service.generate('claude-code', {
    projectId: 'preview-project', threadId: 'preview-thread', requestId: 'preview-request',
    prompt: 'Fixture', instructions: '', documents: [], model: 'fixture-model',
    accountRoute: 'fixture:account', onPreview: frame => frames.push(frame),
  });
  const settled = job.then(value => ({ value }), error => ({ error }));
  await vi.waitFor(() => expect(frames.map(frame => frame.text)).toEqual(['current']));
  const run = await runtime.runs.get('preview-project-preview-request');
  return { ...runtime, frames, run, input: input!, finish, settled };
}

describe('preview publication follows the current durable lease', () => {
  it('drops output after lease expiry even when no replacement owner has claimed yet', async () => {
    const f = await heldRequest();
    try {
      await f.runs.claim(f.run.id, f.run.owner!, 1);
      const expiry = (await f.runs.get(f.run.id)).leaseExpiresAt!;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(expiry));
      f.input.onDelta?.('expired');
    } finally { f.finish(); await f.settled; }
    expect(f.frames.map(frame => frame.text)).toEqual(['current']);
    expect((await f.runs.get(f.run.id)).result).toBeNull();
  });

  it('invalidates the provider signal and callback on exclusive recovery', async () => {
    const f = await heldRequest();
    try {
      await f.runs.recover(f.run.id, f.run.principal);
      expect.soft(f.input.signal?.aborted).toBe(true);
      f.input.onDelta?.('recovered-old-owner');
    } finally { f.finish(); await f.settled; }
    expect(f.frames.map(frame => frame.text)).toEqual(['current']);
    expect((await f.runs.get(f.run.id)).state).toBe('reconcile_required');
  });

  it('keeps valid previews ordered across renewal and flushes them before completion', async () => {
    const f = await heldRequest();
    try {
      expect(await f.runs.claim(f.run.id, f.run.owner!, 60_000)).toBe(f.run.fence);
      expect(f.input.signal?.aborted).toBe(false);
      f.input.onDelta?.('second');
      f.input.onDelta?.('third');
    } finally { f.finish(); }
    expect(await f.settled).toHaveProperty('value.text', 'final');
    expect(f.frames.map(frame => [frame.seq, frame.text])).toEqual([
      [1, 'current'], [2, 'second'], [3, 'third'],
    ]);
    f.input.onDelta?.('after-completion');
    expect(f.frames).toHaveLength(3);
    expect((await f.runs.get(f.run.id)).state).toBe('completed');
  });
});

describe('direct Codex durability conformance', () => {
  it('accepts its actual host-record mode and rejects a fabricated run-record claim', () => {
    const direct = routeContractFor('codex');
    expect(direct.streaming.durableEvents).toBe('host-record');
    expect(contractChecks(direct).filter(check => check.outcome === 'failed')).toEqual([]);
    const unsupported = structuredClone(direct);
    unsupported.streaming.durableEvents = 'run-record';
    expect(contractChecks(unsupported)).toContainEqual(expect.objectContaining({
      id: 'streaming-matches-mode', outcome: 'failed',
    }));
    expect(contractChecks(routeContractFor('codex-report')).filter(check => check.outcome === 'failed')).toEqual([]);
  });
});
