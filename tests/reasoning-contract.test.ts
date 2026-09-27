import { describe, expect, test } from 'vitest';
import {
  REASONING,
  adapterRouteContractSchema,
  reasoningPreviewSchema,
  reasoningSink,
  type ReasoningPreview,
} from '../shared/adapter-contract.js';
import { contractChecks } from '../server/harness/conformance.js';
import { ROUTE_CONTRACTS, routeContractFor } from '../server/harness/route-contract.js';
import { MODEL_API_REASONING } from '../server/harness/model-api-adapter.js';
import { AWS_MODEL_CONTRACT } from '../server/harness/aws-model-adapter.js';
import { AZURE_MODEL_CONTRACT } from '../server/harness/azure-model-adapter.js';
import { NECTOVIA_MODEL_CONTRACT } from '../server/harness/nectovia-model-adapter.js';
import { OPENROUTER_MODEL_CONTRACT } from '../server/harness/openrouter-model-adapter.js';
import { VERTEX_MODEL_CONTRACT } from '../server/harness/vertex-model-adapter.js';
import { MODEL_API_ROUTES } from '../shared/model-api.js';

const identity = {
  projectId: 'P1',
  threadId: 'T1',
  requestId: 'R1',
  runId: 'run-1',
  stepId: 'text:dispatch',
  attempt: 1,
  fence: 1,
};
/** A clock that answers each call with the next time given, then keeps the last. */
const clock = (...times: number[]) => {
  let at = 0;
  return () => times[Math.min(at++, times.length - 1)];
};

describe('thinking frames', () => {
  test('stamp the run identity and a dense sequence from 1', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    sink('Weighing the menu. ');
    sink('Checking prices.');
    expect(frames.map((frame) => [frame.kind, frame.seq, frame.text])).toEqual([
      ['reasoning-delta', 1, 'Weighing the menu. '],
      ['reasoning-delta', 2, 'Checking prices.'],
    ]);
    expect(frames.every((frame) => reasoningPreviewSchema.safeParse(frame).success)).toBe(true);
    expect(frames[0]).toMatchObject(identity);
  });

  test('a chunk over the frame budget is split, never inside a character', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    const big = `${'a'.repeat(REASONING.maxChunkBytes - 1)}😀${'b'.repeat(10)}`;
    sink(big);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(frames.map((frame) => frame.text).join('')).toBe(big);
    expect(frames[1].text.startsWith('😀')).toBe(true);
  });

  test('each frame is redacted and stripped of control characters; an empty result sends nothing', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({
      identity,
      redact: (text) => text.replaceAll('sk-live-1', '[redacted]'),
      onReasoning: (frame) => frames.push(frame),
    });
    sink('key sk-live-1\u0007 found\u202e');
    sink('\u0001\u0002');
    sink('');
    expect(frames.map((frame) => frame.text)).toEqual(['key [redacted] found']);
  });

  test('a lone surrogate or control characters never crash the sink', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    expect(() => sink('\ud83d')).not.toThrow();
    expect(() => sink('\u0000\u0008')).not.toThrow();
    expect(frames.every((frame) => frame.text.length > 0)).toBe(true);
    expect(frames.length).toBeLessThanOrEqual(1);
  });

  test('nothing is sent or kept after the request is stopped', () => {
    const frames: ReasoningPreview[] = [];
    const control = new AbortController();
    const sink = reasoningSink({ identity, signal: control.signal, onReasoning: (frame) => frames.push(frame) });
    control.abort();
    sink('late');
    expect(frames).toHaveLength(0);
    expect(sink.finish()).toBeNull();
  });

  test('a presenter that throws never fails the producer', () => {
    const sink = reasoningSink({
      identity,
      onReasoning: () => {
        throw new Error('the screen went away');
      },
    });
    expect(() => sink('still fine')).not.toThrow();
    expect(sink.finish()?.text).toBe('still fine');
  });
});

describe('the finished thinking', () => {
  test('is null when no thinking came', () => {
    expect(reasoningSink({ identity }).finish()).toBeNull();
  });

  test('keeps the whole text, redacted as one piece, with how long it ran', () => {
    const sink = reasoningSink({
      identity,
      redact: (text) => text.replaceAll('sk-live-12', '[redacted]'),
      now: clock(1_000, 1_500, 15_000),
    });
    sink('The key is sk-li');
    sink('ve-12, so ');
    expect(sink.finish()).toEqual({ text: 'The key is [redacted], so', ms: 14_000, shortened: false });
  });

  test('is cut at 32 KiB on a character boundary and marked shortened', () => {
    const sink = reasoningSink({ identity });
    sink('é'.repeat(REASONING.maxSavedBytes));
    const record = sink.finish()!;
    expect(new TextEncoder().encode(record.text).byteLength).toBeLessThanOrEqual(REASONING.maxSavedBytes);
    expect(record.text).toBe('é'.repeat(REASONING.maxSavedBytes / 2));
    expect(record.shortened).toBe(true);
  });

  test('stops keeping raw text past its bound and still says it was shortened', () => {
    const sink = reasoningSink({ identity });
    for (let index = 0; index < 10; index += 1) sink('x'.repeat(REASONING.maxSavedBytes));
    const record = sink.finish()!;
    expect(record.text).toHaveLength(REASONING.maxSavedBytes);
    expect(record.shortened).toBe(true);
  });
});

describe('route descriptors declare thinking', () => {
  test('the descriptor schema requires streaming.reasoning', () => {
    const contract = routeContractFor('claude-code');
    const { reasoning: _reasoning, ...streaming } = contract.streaming;
    expect(adapterRouteContractSchema.safeParse({ ...contract, streaming }).success).toBe(false);
    expect(adapterRouteContractSchema.safeParse(contract).success).toBe(true);
  });

  test('every registered route declares it, and each model-API route follows its own entry', () => {
    for (const contract of Object.values(ROUTE_CONTRACTS))
      expect(['reasoning-delta', 'none']).toContain(contract.streaming.reasoning);
    expect(Object.keys(MODEL_API_REASONING).sort()).toEqual([...MODEL_API_ROUTES].sort());
    for (const contract of [
      AWS_MODEL_CONTRACT,
      AZURE_MODEL_CONTRACT,
      NECTOVIA_MODEL_CONTRACT,
      OPENROUTER_MODEL_CONTRACT,
      VERTEX_MODEL_CONTRACT,
    ])
      expect(contract.streaming.reasoning).toBe(
        MODEL_API_REASONING[contract.routeId as keyof typeof MODEL_API_REASONING],
      );
  });

  test('a route cannot stream thinking without a live text channel', () => {
    const sample = routeContractFor('sample');
    const checks = contractChecks({ ...sample, streaming: { ...sample.streaming, reasoning: 'reasoning-delta' } });
    expect(checks.find((item) => item.id === 'reasoning-needs-live-channel')?.outcome).toBe('failed');
    const passing = contractChecks(routeContractFor('claude-code'));
    expect(passing.find((item) => item.id === 'reasoning-needs-live-channel')?.outcome).toBe('passed');
  });
});
