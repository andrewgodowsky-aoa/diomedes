import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import type { ProviderTranscriptRef } from '../../shared/harness.js';
import type { SdkTranscript, SdkTranscripts } from './vercel-model-adapter.js';
import { canonical, digest, HarnessError } from './policy.js';

const MAX_BYTES = 1_048_576;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
  v: z.literal(1),
  providerId: z.literal('amazon-bedrock'),
  runId: z.string().min(1).max(128),
  capabilityId: z.string().min(1).max(200),
  profileHash: hex,
  modelId: z.string().min(1).max(200),
  portablePrefix: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant', 'tool']),
        text: z.string().optional(),
        tool: z.string().optional(),
        name: z.string().optional(),
        input: z.json().optional(),
        output: z.json().optional(),
      }),
    )
    .max(512),
  messages: z.array(modelMessageSchema).max(512),
  pendingTool: z
    .strictObject({
      id: z.string().min(1).max(200),
      name: z.string().min(1).max(100),
      input: z.json(),
    })
    .nullable(),
});
const sameErrorCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;
const reference = (record: SdkTranscript): ProviderTranscriptRef => ({
  providerId: record.providerId,
  // Converse selects the configured model but does not report an independently observed model ID.
  modelId: null,
  lineageId: record.runId,
  opaqueRef: digest(record),
  prefixHash: digest(record.portablePrefix),
});

/** Immutable content-addressed records, kept in the host's private data directory. */
export class FileSdkTranscripts implements SdkTranscripts {
  constructor(readonly directory: string) {}
  async save(input: SdkTranscript): Promise<ProviderTranscriptRef> {
    if (Buffer.byteLength(canonical(input)) > MAX_BYTES)
      throw new HarnessError(
        'sdk_transcript_too_large',
        'The private provider continuation exceeds its storage limit.',
      );
    const record = recordSchema.parse(input);
    const bytes = canonical(record);
    const ref = reference(record);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${ref.opaqueRef}.json`);
    const temporary = path.join(this.directory, `${ref.opaqueRef}.${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      // Publishing a hard link exposes only complete fsynced bytes and never replaces an existing record.
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (!sameErrorCode(error, 'EEXIST')) throw error;
      }
      await this.read(ref);
    } finally {
      await fs.unlink(temporary);
    }
    return ref;
  }
  async read(ref: ProviderTranscriptRef): Promise<SdkTranscript> {
    if (
      !hex.safeParse(ref.opaqueRef).success ||
      !hex.safeParse(ref.prefixHash).success ||
      ref.providerId !== 'amazon-bedrock' ||
      ref.modelId !== null
    )
      throw new HarnessError(
        'sdk_transcript_mismatch',
        'This private continuation reference is invalid.',
      );
    const target = path.join(this.directory, `${ref.opaqueRef}.json`);
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(target, 'r');
    } catch (error) {
      if (sameErrorCode(error, 'ENOENT'))
        throw new HarnessError(
          'sdk_transcript_missing',
          "This run's private provider continuation is missing.",
        );
      throw error;
    }
    let bytes: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new HarnessError(
          'sdk_transcript_too_large',
          'The private provider continuation exceeds its storage limit.',
        );
      // Read no more than the advertised bound, even if a local writer changes the file after stat.
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== stat.size)
        throw new HarnessError(
          'sdk_transcript_corrupt',
          'The private provider continuation changed while being read.',
        );
      bytes = buffer.subarray(0, offset).toString('utf8');
    } finally {
      await file.close();
    }
    if (createHash('sha256').update(bytes).digest('hex') !== ref.opaqueRef)
      throw new HarnessError(
        'sdk_transcript_corrupt',
        'The private provider continuation failed its integrity check.',
      );
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new HarnessError(
        'sdk_transcript_corrupt',
        'The private provider continuation is not valid JSON.',
      );
    }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success)
      throw new HarnessError(
        'sdk_transcript_corrupt',
        'The private provider continuation has an unsupported shape.',
      );
    const record = parsed.data;
    if (record.runId !== ref.lineageId || digest(record.portablePrefix) !== ref.prefixHash)
      throw new HarnessError(
        'sdk_transcript_mismatch',
        'The private provider continuation belongs to different input or a different run.',
      );
    return record;
  }
}
