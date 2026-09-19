import type { AdapterRouteContract, TransientPreview } from '../../shared/adapter-contract.js';
import type { EngineModel, ExternalEngine } from '../../shared/types.js';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
export interface TextRequest {
  projectId: string;
  threadId: string;
  requestId: string;
  prompt: string;
  documents: { path: string; text: string }[];
  instructions: string;
  model: string;
  accountRoute: string;
  effort?: string;
  signal?: AbortSignal;
  /**
   * Caller-facing preview channel: stamped, redacted, byte-bounded frames.
   * A caller never receives raw adapter text — see `previewSink` in
   * shared/adapter-contract.ts. Reconnects re-read the durable record;
   * nothing replays deltas.
   */
  onPreview?: (frame: TransientPreview) => void;
  /**
   * Adapter-facing raw text sink — set only by EngineService when it wraps
   * the caller's `onPreview`. A caller-supplied `onDelta` is refused: raw
   * deltas are unbounded, unstamped and unredacted, and the contract does
   * not let them reach a caller.
   */
  onDelta?: (text: string) => void;
}
export interface TextResponse {
  text: string;
  model: string;
  version: string;
  threadId: string;
  projectId: string;
  requestId: string;
}
export interface AdapterInspection {
  authentication: 'signed-in' | 'signed-out' | 'unknown';
  accountRoute: string | null;
  models: EngineModel[];
  detail: string;
}
export interface TextEngineAdapter {
  id: ExternalEngine;
  /**
   * The route's versioned contract — the command surface it honestly answers,
   * its streaming shape, model source, authentication and the binary version
   * the evidence covers. Registered in `server/harness/route-contract.ts`.
   */
  readonly contract: AdapterRouteContract;
  inspect(signal?: AbortSignal): Promise<AdapterInspection>;
  generate(input: TextRequest): Promise<TextResponse>;
}
/** Optional native transport, admitted separately from the default text route. */
export interface PersistentTextAdapter<C> extends TextEngineAdapter {
  readonly sessionContract: AdapterRouteContract;
  openSession(
    input: TextRequest,
    options: {
      observedVersion: string;
      restore?: C;
      fork?: boolean;
      onCheckpoint(checkpoint: C, signal: AbortSignal): Promise<void>;
    },
  ): Promise<{
    turn(input: TextRequest): Promise<TextResponse>;
    interrupt(): Promise<void>;
    close(reason?: unknown): Promise<void>;
    readonly checkpoint: C;
    readonly nativeSession: NativeSessionRef | null;
  }>;
}
/** Instructions remain distinct from selected, untrusted document data. */
export function contextMessage(input: TextRequest): string {
  const text = JSON.stringify({ request: input.prompt, documents: input.documents });
  if (Buffer.byteLength(text) + Buffer.byteLength(input.instructions) > 160_000)
    throw new Error('Select less than 160 KB of context.');
  return text;
}
