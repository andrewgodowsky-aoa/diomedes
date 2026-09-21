// Generalizes the vercel-model-bridge lane's Converse-only FileSdkTranscripts (server/harness/sdk-transcripts.ts).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Json, PortableMessage, ProviderTranscriptRef } from '../../shared/harness.js';
import { canonical, copy, digest, HarnessError } from './policy.js';

/**
 * A model provider's private continuation. The provider is called with `store: false`, so these
 * provider-format messages (encrypted reasoning included) and the pending tool call's provider call
 * id exist only here. A run record holds the opaque `ProviderTranscriptRef` that names this record,
 * never the record itself.
 */
export interface ModelTranscript {
  v: 1;
  providerId: string;
  runId: string;
  capabilityId: string;
  profileHash: string;
  requestedModel: string;
  /** What the provider's response envelope said; null when it said nothing. */
  reportedModel: string | null;
  /** Evidence only; a continuation is never resumed from it. */
  responseId: string | null;
  /** The exact portable context this continuation corresponds to. */
  portablePrefix: PortableMessage[];
  messages: ModelMessage[];
  pendingTool: { callId: string; name: string; input: Json } | null;
}

export interface ModelTranscripts {
  save(value: ModelTranscript): Promise<ProviderTranscriptRef>;
  read(ref: ProviderTranscriptRef): Promise<ModelTranscript>;
}

export const MODEL_TRANSCRIPT_MAX_BYTES = 1_048_576;

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.strictObject({
  v: z.literal(1),
  providerId: z.string().regex(PROVIDER_ID),
  runId: z.string().min(1).max(128),
  capabilityId: z.string().min(1).max(200),
  profileHash: hex,
  requestedModel: z.string().min(1).max(200),
  reportedModel: z.string().min(1).max(200).nullable(),
  responseId: z.string().min(1).max(200).nullable(),
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
      callId: z.string().min(1).max(200),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
      input: z.json(),
    })
    .nullable(),
});
type StoredTranscript = z.infer<typeof recordSchema>;
const refSchema = z.object({
  providerId: z.string(),
  modelId: z.string().nullable(),
  lineageId: z.string(),
  opaqueRef: hex,
  prefixHash: hex,
});

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

/** Schema validation that never throws: a pathological value is simply not a record. */
function validated(value: unknown): StoredTranscript | null {
  try {
    const parsed = recordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Names a record by the sha256 of its canonical bytes, bound to its run, reported model and prefix. */
export function transcriptRef(record: ModelTranscript): ProviderTranscriptRef {
  return {
    providerId: record.providerId,
    modelId: record.reportedModel,
    lineageId: record.runId,
    opaqueRef: digest(record),
    prefixHash: digest(record.portablePrefix),
  };
}

/** Immutable content-addressed records, kept in the host's private data directory. */
export class FileModelTranscripts implements ModelTranscripts {
  constructor(
    readonly directory: string,
    readonly providerId: string,
  ) {
    if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId))
      throw new HarnessError(
        'model_transcript_invalid',
        'This private continuation store has an invalid provider id.',
      );
  }

  async save(value: ModelTranscript): Promise<ProviderTranscriptRef> {
    let size: number;
    try {
      size = Buffer.byteLength(canonical(value));
    } catch {
      throw new HarnessError(
        'model_transcript_invalid',
        'The private provider continuation is not plain JSON.',
      );
    }
    if (size > MODEL_TRANSCRIPT_MAX_BYTES)
      throw new HarnessError(
        'model_transcript_too_large',
        'The private provider continuation exceeds its storage limit.',
      );
    const record = validated(value);
    if (!record)
      throw new HarnessError(
        'model_transcript_invalid',
        'The private provider continuation has an unsupported shape.',
      );
    if (record.providerId !== this.providerId)
      throw new HarnessError(
        'model_transcript_mismatch',
        'The private provider continuation belongs to a different provider.',
      );
    // Hash and write the validated representation: the message schema drops keys it does not know.
    const bytes = Buffer.from(canonical(record), 'utf8');
    if (bytes.length > MODEL_TRANSCRIPT_MAX_BYTES)
      throw new HarnessError(
        'model_transcript_too_large',
        'The private provider continuation exceeds its storage limit.',
      );
    const ref = transcriptRef(record);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${ref.opaqueRef}.json`);
    const temporary = path.join(this.directory, `${ref.opaqueRef}.${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // A hard link publishes only complete, fsynced bytes and never replaces an existing record.
      try {
        await fs.link(temporary, target);
      } catch (error) {
        // The name is the content's hash, so an existing record holds these bytes; read() proves it.
        if (!hasCode(error, 'EEXIST')) throw error;
      }
    } finally {
      await fs.unlink(temporary);
    }
    await this.read(ref);
    return ref;
  }

  async read(ref: ProviderTranscriptRef): Promise<ModelTranscript> {
    const shape = refSchema.safeParse(ref);
    if (!shape.success || shape.data.providerId !== this.providerId)
      throw new HarnessError(
        'model_transcript_mismatch',
        'This private continuation reference is invalid.',
      );
    const { opaqueRef, prefixHash, lineageId, modelId } = shape.data;
    const target = path.join(this.directory, `${opaqueRef}.json`);
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(target, 'r');
    } catch (error) {
      if (hasCode(error, 'ENOENT'))
        throw new HarnessError(
          'model_transcript_missing',
          "This run's private provider continuation is missing.",
        );
      throw error;
    }
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MODEL_TRANSCRIPT_MAX_BYTES)
        throw new HarnessError(
          'model_transcript_too_large',
          'The private provider continuation exceeds its storage limit.',
        );
      // Ask for one byte past the advertised size, so a file that grows after stat is caught.
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== stat.size)
        throw new HarnessError(
          'model_transcript_corrupt',
          'The private provider continuation changed while being read.',
        );
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
    if (createHash('sha256').update(bytes).digest('hex') !== opaqueRef)
      throw new HarnessError(
        'model_transcript_corrupt',
        'The private provider continuation failed its integrity check.',
      );
    const text = bytes.toString('utf8');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HarnessError(
        'model_transcript_corrupt',
        'The private provider continuation is not valid JSON.',
      );
    }
    const record = validated(value);
    // Return a record only in the exact form its hash covers, never a lossy normalization of it.
    if (!record || !isCanonical(record, text))
      throw new HarnessError(
        'model_transcript_corrupt',
        'The private provider continuation has an unsupported shape.',
      );
    if (
      record.providerId !== this.providerId ||
      record.runId !== lineageId ||
      record.reportedModel !== modelId ||
      digest(record.portablePrefix) !== prefixHash
    )
      throw new HarnessError(
        'model_transcript_mismatch',
        'The private provider continuation belongs to a different provider, model, input or run.',
      );
    return copy(record);
  }
}

function isCanonical(record: StoredTranscript, text: string): boolean {
  try {
    return canonical(record) === text;
  } catch {
    return false;
  }
}
