/**
 * H18: what went into the model context on one turn of a Diomedes-owned model route, by section,
 * and what the provider said about it afterwards.
 *
 * Only the routes where Diomedes assembles the context itself (the model-API routes: AWS, Azure,
 * OpenRouter, Google Cloud) carry this record. An external engine (Codex, Claude Code, OpenCode)
 * builds and manages its own context, so Diomedes cannot account for it and never claims to.
 *
 * Three kinds of number sit side by side and are never mixed:
 *
 * - **estimated**: Diomedes' own count, from the bytes it assembled (`estimateTokens`). Always
 *   present, always labelled an estimate.
 * - **reported**: what the provider's usage said, per call, through `nectovia-usage/1`. Absent
 *   when the provider reported nothing; missing is unknown, never zero.
 * - **declared**: the model's context window, only where a declared source names it
 *   (`modelContextWindow`). Unknown is shown as unknown.
 *
 * The record is evidence written once, on the turn that produced it. Nothing here prunes or edits
 * History (decision 10): the turns a compaction summarised stay exactly where they were.
 */

export const CONTEXT_ACCOUNT_VERSION = 1 as const;

/** Diomedes' estimator: one token per four bytes of UTF-8, rounded up. Stated, never hidden. */
export const CONTEXT_ESTIMATOR = 'utf8-bytes/4' as const;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 4);
}

export const CONTEXT_SECTION_IDS = [
  'instructions',
  'answer-format',
  'tools',
  'project-files',
  'history',
  'message',
  'tool-results',
] as const;
export type ContextSectionId = (typeof CONTEXT_SECTION_IDS)[number];

export const CONTEXT_SECTION_LABELS: Record<ContextSectionId, string> = {
  instructions: 'Instructions',
  'answer-format': 'Answer format',
  tools: 'Tool definitions',
  'project-files': 'Project files',
  history: 'Conversation history',
  message: 'Your message',
  'tool-results': 'Tool results',
};

export interface ContextSection {
  id: ContextSectionId;
  bytes: number;
  estimatedTokens: number;
  /** One short fact the numbers cannot say, or absent. */
  detail?: string;
}

/** One answered message in a conversation's history, by its durable identity. */
export interface HistoryTurnRef {
  runId: string;
  stepId: string;
  /** 1-based position among the answered messages this turn could draw on, oldest first. */
  index: number;
}

export interface HistoryIncluded extends HistoryTurnRef {
  /** Why it is in: among the newest, the conversation's opening message, or relevant to this one. */
  reason: 'recent' | 'pinned' | 'relevant' | 'fits';
  /** The lexical relevance score it was ranked by, when it was ranked. */
  score?: number;
}

/**
 * How the history of one turn was chosen. Absent from a turn whose history fitted its budget: then
 * every earlier message within the bounds went, exactly as before H18.
 */
export interface HistorySelection {
  method: 'recency+lexical/1';
  budget: { turns: number; chars: number };
  /** Answered messages this turn could draw on, carried ones included. */
  available: number;
  included: HistoryIncluded[];
  /** Left out of the text. A message of this lineage's own is summarised; a carried one gives way. */
  omitted: (HistoryTurnRef & { carried: boolean })[];
  /** The line the model reads where messages were left out. Null when none were. */
  marker: string | null;
  /** Characters cut from the oldest included message to keep the newest ones whole, or 0. */
  cutChars: number;
}

/**
 * A deterministic summary of earlier messages, stored as evidence on the turn that sent it. The
 * summarised messages stay in History; this names exactly which ones it stands for, by run, step
 * and the sha-256 of what they said, so the person can open each and see what was summarised.
 */
export interface CompactionRecord {
  v: 1;
  /** sha-256 of the method, the turns and the text. */
  id: string;
  kind: 'summary';
  method: 'extract-first-sentence/1';
  /** Truthful attribution: no model wrote this. */
  author: 'diomedes-application';
  turns: (HistoryTurnRef & { promptSha: string | null; answerSha: string | null })[];
  text: string;
  bytes: number;
}

/** What the provider reported across one turn's model calls, summed. */
export interface ProviderContextUsage {
  calls: number;
  /** Calls whose usage the provider reported. Fewer than `calls` means the sums are partial. */
  reportedCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** The first call's input, the one call whose context is exactly the estimate's sections. */
  firstCallInputTokens: number | null;
}

/** How this route can reuse a prompt prefix, as this build actually wires it. */
export type PromptCacheSupport = 'automatic-prefix' | 'not-wired';

export interface ContextAccount {
  v: typeof CONTEXT_ACCOUNT_VERSION;
  route: string;
  model: string;
  estimator: typeof CONTEXT_ESTIMATOR;
  window: { tokens: number | null; source: string };
  /** The route's own ceiling on one request, in bytes. */
  requestLimitBytes: number | null;
  sections: ContextSection[];
  /** The first call's context: every section but tool results. */
  estimatedTokens: number;
  provider: ProviderContextUsage | null;
  /**
   * The first call's estimate against what the provider reported for it. Null when the provider
   * reported nothing for that call.
   */
  reconciliation: { estimated: number; reported: number; difference: number } | null;
  /**
   * The instructions every turn of this conversation starts with, sent first and byte-identical
   * from turn to turn so a provider can reuse it. `sameAsPrevious` is null on a conversation's
   * first turn with an account.
   */
  stablePrefix: { sha: string; bytes: number; sameAsPrevious: boolean | null };
  cache: { support: PromptCacheSupport; note: string };
  history: HistorySelection | null;
  compaction: CompactionRecord | null;
}

/**
 * The model registry for context windows. An entry exists only where a declared source names the
 * window; nothing is guessed from a model's name. Empty in this build: no connection or rate card
 * this build ships declares a window, so every model reads as not declared.
 */
export const MODEL_CONTEXT_WINDOWS: readonly { route: string; model: string; tokens: number; source: string }[] = [];

export function modelContextWindow(route: string, model: string): { tokens: number | null; source: string } {
  const entry = MODEL_CONTEXT_WINDOWS.find((item) => item.route === route && item.model === model);
  return entry ? { tokens: entry.tokens, source: entry.source } : { tokens: null, source: 'not declared' };
}

/** Compact thousands for a caption: 950, 1.2k, 18k. */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1_000)}k`;
}
