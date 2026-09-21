import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSdkTranscripts } from '../server/harness/sdk-transcripts.js';
import type { SdkTranscript } from '../server/harness/vercel-model-adapter.js';

const record: SdkTranscript = {
  v: 1,
  providerId: 'amazon-bedrock',
  runId: 'run-1',
  capabilityId: 'test',
  profileHash: 'a'.repeat(64),
  modelId: 'us.openai.gpt-5.6-luna',
  portablePrefix: [{ role: 'user', text: 'Hello.' }],
  messages: [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'private signed reasoning' }] },
  ],
  pendingTool: null,
};
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-sdk-transcripts-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('private SDK continuations', () => {
  it('persists an immutable private record and exposes only an opaque reference', async () => {
    const store = new FileSdkTranscripts(dir);
    const ref = await store.save(record);
    expect(ref).toMatchObject({ providerId: 'amazon-bedrock', lineageId: 'run-1', modelId: null });
    expect(ref.opaqueRef).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ref)).not.toContain('private signed reasoning');
    expect(await new FileSdkTranscripts(dir).read(ref)).toEqual(record);
    expect(await store.save(record)).toEqual(ref);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('refuses a damaged record instead of silently starting a new conversation', async () => {
    const store = new FileSdkTranscripts(dir);
    const ref = await store.save(record);
    await fs.appendFile(path.join(dir, `${ref.opaqueRef}.json`), 'corruption');
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'sdk_transcript_corrupt' });
  });

  it('refuses changed lineage and path-like references', async () => {
    const store = new FileSdkTranscripts(dir);
    const ref = await store.save(record);
    await expect(store.read({ ...ref, lineageId: 'other-run' })).rejects.toMatchObject({
      code: 'sdk_transcript_mismatch',
    });
    await expect(store.read({ ...ref, opaqueRef: '../outside' })).rejects.toMatchObject({
      code: 'sdk_transcript_mismatch',
    });
  });

  it('bounds private state and leaves no partial record on rejection', async () => {
    const store = new FileSdkTranscripts(dir);
    await expect(
      store.save({ ...record, messages: [{ role: 'assistant', content: 'x'.repeat(1_048_577) }] }),
    ).rejects.toMatchObject({ code: 'sdk_transcript_too_large' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('hashes the validated SDK representation when its schema normalizes a message', async () => {
    const store = new FileSdkTranscripts(dir);
    const input = structuredClone(record);
    Object.assign(input.messages[0], { unknownSdkMetadata: 'discarded by the pinned schema' });
    const ref = await store.save(input);
    expect(await store.read(ref)).toEqual(record);
  });
});
