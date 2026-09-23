import type { TeamCarriageOptions } from '../team/carriage.js';
import type {
  AdapterRouteContract,
  RawToolActivity,
  ToolActivity,
  TransientPreview,
} from '../../shared/adapter-contract.js';
import type { EngineModel, ExternalEngine } from '../../shared/types.js';
import type { AccountRouteIssue } from '../../shared/engines.js';
import type { NativeSessionRef } from '../../shared/contract-revision.js';
import type { Json } from '../../shared/harness.js';
import type { ReadScope } from './read-scope.js';
/**
 * One message of a Diomedes conversation, as the host admitted it. Set by the host's own
 * prepare step and never taken from a client or a model. It rides on the request the way
 * `onPreview` does, so the engine service passes it through without knowing it is there, and
 * the native session driver removes it before anything reaches an adapter.
 */
export interface InteractionRequest {
  /** `sm.` and 32 hex characters, computed from the project, the thread and the command. */
  sourceMessageId: string;
  /**
   * Splits a committed answer into the text a person reads and the body of the first
   * interaction phase. Pure: no I/O, no store, no model. It runs again on every replay, so it
   * must give the same result for the same answer.
   */
  decide(answer: string): { answerText: string; body: Json };
}
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
   * What the person sent, reduced to one digest by the host before it resolves anything else:
   * the text, the chosen mode, each chosen source with its version, and the transport action.
   * The native session driver saves it with the turn. A later request that reuses the command
   * is compared against it before any recorded answer is returned, so a reused command with a
   * different message is refused rather than answered with somebody else's reply.
   */
  binding?: string;
  interaction?: InteractionRequest;
  /**
   * The run of the lineage "Update this conversation" retired before this conversation's lineage
   * (`ConversationLineage.carriedFrom`). Set only by the host, never from a client or a model. A
   * conversation driver reads that run's recent answered messages as the start of this
   * conversation's history, only where history sharing allows it for the route at send time; the
   * native session driver removes it before anything reaches an adapter.
   */
  carriedFrom?: string;
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
  /**
   * Caller-facing tool activity: stamped, redacted frames from `activitySink`
   * in shared/adapter-contract.ts. Narration only; the durable run record is
   * what a tool actually did.
   */
  onActivity?: (frame: ToolActivity) => void;
  /**
   * Adapter-facing raw tool activity sink, set only by EngineService when it
   * wraps the caller's `onActivity`. An adapter calls it once when a tool call
   * starts and once when it finishes or fails, with a plain one-line summary.
   */
  onToolActivity?: (raw: RawToolActivity) => void;
  /**
   * Read-only tools for an Ask or Plan turn: the project folder, web search and
   * the owner's approved MCP read tools (server/engines/read-scope.ts). Set only
   * by the host from its own project record, never from a client or a model.
   * Absent means the text-only route, unchanged. Writes never ride on it.
   */
  readScope?: ReadScope;
  /**
   * The Diomedes team tools for one member's Work run, reached over the loopback
   * team MCP service with the member's leased token (server/team/carriage.ts).
   * Set only by the host's Work path for a route that carries team tools by MCP;
   * every other adapter refuses a request that carries it. Never with a read scope.
   */
  team?: TeamCarriageOptions & { onToolCall?: (tool: string) => void };
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
  /**
   * Set when the native tool answered and its connected account is not the
   * route this adapter accepts. That is neither signed-out nor a failure to
   * reach the tool, and the screen explains it rather than asking for sign-in.
   */
  routeIssue?: AccountRouteIssue;
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
