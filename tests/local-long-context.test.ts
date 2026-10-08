import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { localContextBudget, parseLocalModelDescriptor, LOCAL_MODEL_ROUTE } from '../shared/local-model.js';
import { taskSourceLimits, TASK_SOURCE_LIMITS } from '../shared/task-sources.js';
import { CONVERSATION_LIMITS, WORK_LIMITS } from '../server/engines/model-api-core.js';
import { localLimits, respondLocal } from '../server/engines/bonsai.js';
import { LocalModelRuntime } from '../server/bonsai/runtime.js';
import { contextMessage, type TextRequest } from '../server/engines/contract.js';
import { sourceTools } from '../server/harness/capabilities/conversation-sources.js';
import { readFor, LOOP_FIXTURE_ROUTE } from '../server/harness/capabilities/native-loop.js';
import type { Store } from '../server/store.js';
import { instructionSectionBudget } from '../server/harness/instruction-delivery.js';
import { validatePrepared } from '../server/harness/native-agent.js';
import { FileModelTranscripts, type ModelTranscript } from '../server/harness/model-transcripts.js';
import { FixedLocalModel, fakeLocalHost, meadowDescriptor, MEADOW_FOLDER, MEADOW_MODEL, localAnswerStream } from './fixtures/local-model.js';

const descriptor = () => {
  const raw = meadowDescriptor();
  return { ...raw, profiles: { Deep: { ...raw.profiles.Deep, outputTokens: 12_288,
    effortBudgets: {
      medium: { thinking: true, reasoningTokens: 4_096, outputTokens: 8_192 },
      xhigh: { thinking: true, reasoningTokens: 8_192, outputTokens: 12_288 },
    } } } };
};
const profile = () => parseLocalModelDescriptor(descriptor(), MEADOW_FOLDER).profiles[0];
const document = 'a'.repeat(287_775);

describe('local input room and independent serialization guards', () => {
  it('uses the NC-MEM-LC minimum and all three reservations', () => {
    const p = { ...profile(), qualifiedTaskTotalWindow: 125_000, configuredTotalWindow: 120_000 };
    expect(localContextBudget(p, { nativeTotalWindow: 118_000, outputReserve: 8_192 })).toMatchObject({
      nativeTotalWindow: 118_000, qualifiedTaskTotalWindow: 125_000, configuredTotalWindow: 120_000,
      outputReserve: 8_192, protocolAndNextToolReserve: 2_048, safetyMargin: 1_024, inputRoom: 106_736,
    });
    expect(localContextBudget(p, { nativeTotalWindow: 512 }).inputRoom).toBe(0);
  });

  it('admits the ledger bytes locally and preserves other route constants', () => {
    const p = profile(), budget = localContextBudget(p);
    expect(taskSourceLimits(p).bytes).toBeGreaterThan(document.length);
    expect(localLimits(p).maxRequestBytes).toBeGreaterThan(document.length);
    expect(instructionSectionBudget(document.length, budget.requestBytes)).toBeGreaterThan(0);
    expect(instructionSectionBudget(document.length)).toBe(0);
    expect(taskSourceLimits()).toEqual(TASK_SOURCE_LIMITS);
    expect(TASK_SOURCE_LIMITS).toEqual({ files: 8, bytes: 128_000 });
    expect(CONVERSATION_LIMITS).toEqual({ maxOutputTokens: 4_096, maxRequestBytes: 200_000,
      maxResponseBytes: 1_048_576, callWallMs: 120_000 });
    expect(WORK_LIMITS).toEqual({ maxOutputTokens: 16_384, maxRequestBytes: 400_000,
      maxResponseBytes: 2_097_152, callWallMs: 240_000 });
  });

  it('returns the entire attached source only with a host-resolved local profile', async () => {
    const read = async (local = false) => sourceTools([{ path: 'ledger.txt', text: document }], local ? profile() : undefined)
      .get('read_source').execute({ input: { path: 'ledger.txt' } } as never);
    expect(await read(true)).toMatchObject({ text: document, truncated: false });
    expect(await read()).toMatchObject({ text: document.slice(0, 131_072), truncated: true });
  });

  it('lets only an exclusively local loop read the full source and retains its explicit path scope', async () => {
    const current = vi.fn(async () => document);
    const store = { current, state: () => ({ cloudSharing: { version: 1,
      routes: [LOCAL_MODEL_ROUTE], documents: ['ledger.txt'],
      shareConversationHistory: false, shareReviewPackets: false } }) } as unknown as Store;
    const read = (routes: string | string[], scope: string[] | null = null) =>
      readFor(store, 'p', routes, 'ledger.txt', scope, profile());
    expect(await read(LOCAL_MODEL_ROUTE)).toMatchObject({ text: document, truncated: false });
    expect(await read(LOOP_FIXTURE_ROUTE)).toMatchObject({ text: document.slice(0, 24_000), truncated: true });
    expect(await read([LOCAL_MODEL_ROUTE, LOOP_FIXTURE_ROUTE])).toMatchObject({ text: document.slice(0, 24_000), truncated: true });
    current.mockClear();
    expect(await read(LOCAL_MODEL_ROUTE, ['another.txt'])).toMatchObject({ refused: expect.stringContaining('outside') });
    expect(current).not.toHaveBeenCalled();
  });

  it('sizes Work serialization for the selected local account and preserves the CLI envelope', () => {
    const input: TextRequest = { projectId: 'p', threadId: 't', requestId: 'r', prompt: 'Read.',
      documents: [{ path: 'ledger.txt', text: document }], instructions: 'Check.',
      model: 'local:deep', accountRoute: 'bonsai:local' };
    expect(contextMessage(input, profile())).toContain(document);
    expect(() => contextMessage(input)).toThrow('160 KB');
    expect(() => contextMessage({ ...input, accountRoute: 'another-account' }, profile())).toThrow('160 KB');
  });

  it('retains the prepared-context guard and checks UTF-8 bytes on the local path', () => {
    const request = { runId: 'long-run', capabilityId: 'conversation', transcript: null,
      messages: [{ role: 'user' as const, text: document }], tools: [] };
    expect(() => validatePrepared(request, request)).toThrow();
    const allowance = localContextBudget(profile()).requestBytes;
    expect(validatePrepared(request, request, allowance)).toEqual(request);
    const multibyte = { ...request, messages: [{ role: 'user' as const, text: '\u4e00'.repeat(allowance / 2) }] };
    expect(() => validatePrepared(multibyte, multibyte, allowance)).toThrow();
    expect(() => validatePrepared(request, { ...request, runId: 'another-run' }, allowance)).toThrow();
    expect(() => validatePrepared(request, request, Number.POSITIVE_INFINITY)).toThrow();
  });

  it('keeps a full local transcript with duplicated portable context while other stores remain bounded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-context-'));
    try {
      const text = 'x'.repeat(600_000);
      const record: ModelTranscript = { v: 1, providerId: LOCAL_MODEL_ROUTE, runId: 'long-run',
        capabilityId: 'conversation', profileHash: 'a'.repeat(64), requestedModel: 'local:deep',
        reportedModel: MEADOW_MODEL, responseId: 'answer', pendingTool: null,
        portablePrefix: [{ role: 'user', text }], messages: [{ role: 'user', content: text }] };
      const local = new FileModelTranscripts(dir, LOCAL_MODEL_ROUTE).withLocalByteLimit(localContextBudget(profile()).transcriptBytes);
      const ref = await local.save(record);
      expect(await local.read(ref)).toEqual(record);
      const cloud = new FileModelTranscripts(dir, 'aws-bedrock');
      expect(cloud.withLocalByteLimit(24_000_000)).toBe(cloud);
      await expect(cloud.save({ ...record, providerId: 'aws-bedrock' })).rejects.toThrow('storage limit');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});

describe('local transport admission and numeric effort', () => {
  it.each(['medium', 'xhigh'] as const)('carries long input with %s and keeps named effort and exact token refusal', async effort => {
    const raw = descriptor(), host = fakeLocalHost({ state: 'ready', mode: 'Deep', model: MEADOW_MODEL,
      contextTokens: 131_072 }), source = new FixedLocalModel(raw, MEADOW_FOLDER);
    const runtime = new LocalModelRuntime(source, host.host);
    const bodies: Record<string, unknown>[] = [];
    let promptTokens = 115_164;
    const transport: typeof fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (String(url).endsWith('/apply-template')) return Response.json({ prompt: document });
      if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array(promptTokens).fill(7) });
      return localAnswerStream({ id: 'long-answer', model: MEADOW_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: 'Checked.' } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } });
    });
    const input = { runtime, model: 'local:deep', effort, instructions: 'Read the document.',
      messages: [{ role: 'user' as const, content: document }], tools: [], signal: new AbortController().signal, transport };
    expect((await respondLocal(input)).outcome).toEqual({ kind: 'final', text: 'Checked.' });
    expect(bodies.at(-1)).toMatchObject({ cache_prompt: true, reasoning_effort: effort,
      chat_template_kwargs: { reasoning_effort: effort, enable_thinking: true },
      reasoning_budget_tokens: effort === 'medium' ? 4096 : 8192,
      max_tokens: effort === 'medium' ? 8192 : 12288 });
    bodies.length = 0;
    promptTokens = 131_072;
    await expect(respondLocal(input)).rejects.toThrow('131,072 tokens');
    expect(bodies).toHaveLength(2);
  });
});
