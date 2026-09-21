import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { modelMessageSchema } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileModelTranscripts,
  MODEL_TRANSCRIPT_MAX_BYTES,
  transcriptRef,
  type ModelTranscript,
} from '../server/harness/model-transcripts.js';
import { digest } from '../server/harness/policy.js';

const record: ModelTranscript = {
  v: 1,
  providerId: 'aws-bedrock',
  runId: 'run-1',
  capabilityId: 'napkin-audit',
  profileHash: 'a'.repeat(64),
  requestedModel: 'us.openai.gpt-5.6-luna',
  reportedModel: 'us.openai.gpt-5.6-luna',
  responseId: 'resp_1',
  portablePrefix: [
    { role: 'user', text: 'How many napkins were short?' },
    { role: 'assistant', tool: 'read_source', input: { path: 'delivery.txt' } },
  ],
  messages: [
    { role: 'user', content: 'How many napkins were short?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: '',
          providerOptions: {
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'gAAAA-opaque' },
          },
        },
        {
          type: 'tool-call',
          toolCallId: 'call_abc',
          toolName: 'read_source',
          input: { path: 'delivery.txt' },
        },
      ],
    },
  ],
  pendingTool: { callId: 'call_abc', name: 'read_source', input: { path: 'delivery.txt' } },
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-model-transcripts-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const recordFile = (opaqueRef: string) => path.join(dir, `${opaqueRef}.json`);

describe('private model continuations', () => {
  it('keeps the OpenAI reasoning continuation shape exactly as the installed SDK schema accepts it', () => {
    for (const message of record.messages) {
      const parsed = modelMessageSchema.safeParse(message);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(message);
    }
  });

  it('round-trips a record and exposes only an opaque reference bound to run, model and prefix', async () => {
    const ref = await new FileModelTranscripts(dir, 'aws-bedrock').save(record);
    expect(ref).toEqual({
      providerId: 'aws-bedrock',
      modelId: 'us.openai.gpt-5.6-luna',
      lineageId: 'run-1',
      opaqueRef: expect.stringMatching(/^[a-f0-9]{64}$/),
      prefixHash: digest(record.portablePrefix),
    });
    expect(ref).toEqual(transcriptRef(record));
    expect(JSON.stringify(ref)).not.toContain('gAAAA-opaque');
    expect(JSON.stringify(ref)).not.toContain('call_abc');
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const read = await store.read(ref);
    expect(read).toEqual(record);
    read.messages.length = 0;
    expect(await store.read(ref)).toEqual(record);
  });

  it('returns the same reference for an identical record and leaves one file and no temporaries', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const ref = await store.save(record);
    expect(await fs.readdir(dir)).toEqual([`${ref.opaqueRef}.json`]);
    expect(await store.save(structuredClone(record))).toEqual(ref);
    expect(await fs.readdir(dir)).toEqual([`${ref.opaqueRef}.json`]);
  });

  it('hashes the validated representation when the SDK schema normalizes a message', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const input = structuredClone(record);
    Object.assign(input.messages[1], { unknownSdkMetadata: 'dropped by the pinned schema' });
    const ref = await store.save(input);
    expect(ref).toEqual(transcriptRef(record));
    expect(await store.read(ref)).toEqual(record);
  });

  it('refuses a record with one altered byte', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const ref = await store.save(record);
    const bytes = await fs.readFile(recordFile(ref.opaqueRef));
    const at = bytes.indexOf('napkins');
    expect(at).toBeGreaterThan(0);
    bytes[at + 'napkin'.length] = 'z'.charCodeAt(0);
    await fs.writeFile(recordFile(ref.opaqueRef), bytes);
    JSON.parse(bytes.toString('utf8'));
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'model_transcript_corrupt' });
  });

  it('refuses bytes that hash to their name but are not the canonical record', async () => {
    const pretty = JSON.stringify(record, null, 2);
    const opaqueRef = createHash('sha256').update(pretty).digest('hex');
    await fs.writeFile(recordFile(opaqueRef), pretty);
    await expect(
      new FileModelTranscripts(dir, 'aws-bedrock').read({ ...transcriptRef(record), opaqueRef }),
    ).rejects.toMatchObject({ code: 'model_transcript_corrupt' });
  });

  it('refuses a reference bound to another run, prefix or reported model', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const ref = await store.save(record);
    for (const other of [
      { ...ref, lineageId: 'run-2' },
      { ...ref, prefixHash: 'b'.repeat(64) },
      { ...ref, prefixHash: digest(record.portablePrefix.slice(0, 1)) },
      { ...ref, modelId: 'us.openai.gpt-5.6-terra' },
      { ...ref, modelId: null },
    ])
      await expect(store.read(other)).rejects.toMatchObject({ code: 'model_transcript_mismatch' });
    const silent = await store.save({ ...record, reportedModel: null });
    expect(silent.modelId).toBeNull();
    expect((await store.read(silent)).reportedModel).toBeNull();
    await expect(store.read({ ...silent, modelId: record.reportedModel })).rejects.toMatchObject({
      code: 'model_transcript_mismatch',
    });
  });

  it('refuses a reference for another provider or with a path-like address', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const ref = await store.save(record);
    for (const other of [
      { ...ref, providerId: 'other' },
      { ...ref, opaqueRef: '../outside' },
      { ...ref, prefixHash: 'not-a-hash' },
    ])
      await expect(store.read(other)).rejects.toMatchObject({ code: 'model_transcript_mismatch' });
  });

  it("refuses another provider's record even when both stores share a directory", async () => {
    const other = new FileModelTranscripts(dir, 'other');
    const ref = await other.save({ ...record, providerId: 'other' });
    await expect(
      new FileModelTranscripts(dir, 'aws-bedrock').read({ ...ref, providerId: 'aws-bedrock' }),
    ).rejects.toMatchObject({ code: 'model_transcript_mismatch' });
  });

  it('reports a missing continuation', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const ref = await store.save(record);
    await expect(store.read({ ...ref, opaqueRef: 'c'.repeat(64) })).rejects.toMatchObject({
      code: 'model_transcript_missing',
    });
    await fs.unlink(recordFile(ref.opaqueRef));
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'model_transcript_missing' });
  });

  it('bounds private state and writes nothing for an oversized record', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    const text = 'x'.repeat(1_100_000);
    expect(text.length).toBeGreaterThan(MODEL_TRANSCRIPT_MAX_BYTES);
    await expect(
      store.save({ ...record, messages: [{ role: 'user', content: text }] }),
    ).rejects.toMatchObject({ code: 'model_transcript_too_large' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses to save another provider's record and writes nothing", async () => {
    await expect(
      new FileModelTranscripts(dir, 'aws-bedrock').save({ ...record, providerId: 'other' }),
    ).rejects.toMatchObject({ code: 'model_transcript_mismatch' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('refuses an invalid or non-JSON record and writes nothing', async () => {
    const store = new FileModelTranscripts(dir, 'aws-bedrock');
    for (const invalid of [
      { ...record, pendingTool: { ...record.pendingTool!, name: 'read source' } },
      { ...record, profileHash: 'A'.repeat(64) },
      { ...record, providerId: 'AWS Bedrock' },
      {
        ...record,
        messages: [
          {
            role: 'assistant' as const,
            content: [
              { type: 'tool-call' as const, toolCallId: 'c', toolName: 't', input: new Date(0) },
            ],
          },
        ],
      },
    ])
      await expect(store.save(invalid)).rejects.toMatchObject({ code: 'model_transcript_invalid' });
    expect(await fs.readdir(dir)).toEqual([]);
    let error: unknown;
    try {
      new FileModelTranscripts(dir, 'AWS Bedrock');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'model_transcript_invalid' });
  });
});
