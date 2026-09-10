import type { EngineModel, ExternalEngine } from '../../shared/types.js';
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
  inspect(signal?: AbortSignal): Promise<AdapterInspection>;
  generate(input: TextRequest): Promise<TextResponse>;
}
/** Instructions remain distinct from selected, untrusted document data. */
export function contextMessage(input: TextRequest): string {
  const text = JSON.stringify({ request: input.prompt, documents: input.documents });
  if (Buffer.byteLength(text) + Buffer.byteLength(input.instructions) > 160_000)
    throw new Error('Select less than 160 KB of context.');
  return text;
}
