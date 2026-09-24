/**
 * H18: how a model-API conversation turn's context is chosen, ordered and accounted for, on the
 * routes where Diomedes assembles it (`model-session-run.ts`). An external engine manages its own
 * context and gets none of this.
 *
 * Four properties, each easy to lose:
 *
 * 1. **The newest messages are never dropped.** When the history passes its budget (the same
 *    bounds `conversation-history.ts` has always applied: 12 messages, 24,000 characters), the
 *    newest `RECENT_KEEP` messages of this lineage and its opening message stay. The remaining
 *    room goes to the earlier messages that share the most words with the new one, then to the
 *    newest of the rest. A carried lineage's messages give way first, as they always did.
 * 2. **What is left out is said.** A marker at the top of the history names every message left
 *    out by number, and a lineage's own omitted messages are summarised under it.
 * 3. **A summary is evidence, not a rewrite.** `compactTurns` is a deterministic extract (the first
 *    sentence of each side), attributed to the application because no model wrote it, and it names
 *    each message it stands for by run, step and the sha-256 of what was said. The messages stay
 *    in their run untouched (decision 10), so the person can open each one.
 * 4. **The stable part goes first.** The lineage's recorded instructions and the tool note are the
 *    same bytes on every turn of a conversation; what varies per message (the read scope's note)
 *    comes after them. A provider that reuses a repeated prefix can reuse this one.
 */
import { createHash } from 'node:crypto';
import type { HarnessRun } from '../../shared/harness.js';
import {
  CONTEXT_ACCOUNT_VERSION,
  CONTEXT_ESTIMATOR,
  estimateTokens,
  modelContextWindow,
  utf8Bytes,
  type CompactionRecord,
  type ContextAccount,
  type ContextSection,
  type ContextSectionId,
  type HistoryIncluded,
  type HistorySelection,
  type PromptCacheSupport,
} from '../../shared/context-accounting.js';
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  answeredTurns,
  cutHistory,
  type AnsweredTurn,
  type BoundedHistory,
} from './conversation-history.js';

/** How many of a lineage's newest messages a history always keeps. */
export const RECENT_KEEP = 6;
/** The most a compaction summary may weigh, in characters. */
export const SUMMARY_MAX_CHARS = 2_000;
/** Room held back for the marker and the summary when anything is left out. */
const OMISSION_RESERVE_CHARS = SUMMARY_MAX_CHARS + 600;
const EXCERPT_CHARS = 160;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- relevance ----------------------------------------------------------------------------

const STOPWORDS = new Set(
  'the and for are but not you your yours with this that these those from have has had was were will would could should can what when where which who whom why how all any each some such than then there their them they its our ours out about into over also just only very been being does did doing done here more most other same own off too under again further once both few nor yes please thanks thank diomedes person'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word);
  return out;
}

/**
 * How much an earlier message has to do with this one: the words they share, over the square root
 * of the earlier message's distinct words, so a long message is not favoured for being long.
 * Deterministic, rounded to four places. No embeddings, no model, no dependency.
 */
export function relevance(earlier: string, message: string): number {
  const query = words(message);
  const candidate = words(earlier);
  if (!query.size || !candidate.size) return 0;
  let shared = 0;
  for (const word of candidate) if (query.has(word)) shared += 1;
  return Math.round((shared / Math.sqrt(candidate.size)) * 10_000) / 10_000;
}

// --- compaction ---------------------------------------------------------------------------

const firstSentence = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > EXCERPT_CHARS ? `${sentence.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : sentence;
};

type Compactable = Pick<AnsweredTurn, 'runId' | 'stepId' | 'index' | 'prompt' | 'answer'>;

/** The deterministic summary of messages left out of a history. Same turns, same record. */
export function compactTurns(turns: readonly Compactable[]): CompactionRecord {
  const head =
    'Summary of the earlier messages left out, extracted by Diomedes from the first sentence of each side (no model wrote it; the full messages stay in this conversation’s History):';
  const lines: string[] = [head];
  let length = head.length;
  let listed = 0;
  for (const turn of turns) {
    const asked = turn.prompt === null ? 'nothing recorded' : `“${firstSentence(turn.prompt)}”`;
    const answered = turn.answer === null ? 'no answer was recorded' : `Diomedes answered “${firstSentence(turn.answer)}”`;
    const line = `- Message ${turn.index}: the person asked ${asked}; ${answered}.`;
    // Room for this line, and for the closing line should any turn after it not fit.
    const rest = turns.length - listed - 1;
    const closing = rest > 0 ? 64 : 0;
    if (length + 1 + line.length + closing > SUMMARY_MAX_CHARS) break;
    lines.push(line);
    length += 1 + line.length;
    listed += 1;
  }
  if (listed < turns.length) lines.push(`- ${turns.length - listed} more were left out without a line here.`);
  const text = lines.join('\n');
  const refs = turns.map((turn) => ({
    runId: turn.runId,
    stepId: turn.stepId,
    index: turn.index,
    promptSha: turn.prompt === null ? null : sha256(turn.prompt),
    answerSha: turn.answer === null ? null : sha256(turn.answer),
  }));
  const method = 'extract-first-sentence/1' as const;
  return {
    v: 1,
    id: sha256(JSON.stringify({ method, turns: refs, text })),
    kind: 'summary',
    method,
    author: 'diomedes-application',
    turns: refs,
    text,
    bytes: utf8Bytes(text),
  };
}

// --- selection ----------------------------------------------------------------------------

export interface SelectedHistory extends BoundedHistory {
  /** Null when the history fitted its budget: then it is exactly `boundedHistory`. */
  selection: HistorySelection | null;
  compaction: CompactionRecord | null;
}

const numbers = (indexes: readonly number[]) => {
  const runs: string[] = [];
  let start = indexes[0];
  let previous = indexes[0];
  for (const index of [...indexes.slice(1), Number.NaN]) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    runs.push(start === previous ? String(start) : `${start}–${previous}`);
    start = previous = index;
  }
  return runs.join(', ');
};

/**
 * The history a model-API turn is given. Within the bounds, exactly the bounded history. Past
 * them, the newest and the opening message of this lineage, then the most relevant, then the
 * newest of what is left, then the carried lineage's newest; a marker, and a summary of this
 * lineage's own omitted messages, above them.
 */
export function selectHistory(input: {
  carried?: HarnessRun | null;
  own: HarnessRun;
  exclude?: string;
  message: string;
}): SelectedHistory {
  const carried = input.carried ? answeredTurns([input.carried], input.exclude) : [];
  const own = answeredTurns([input.own], input.exclude);
  const all = [...carried, ...own].map((turn, i) => ({ ...turn, index: i + 1 }));
  const carriedSet = new Set(all.slice(0, carried.length));
  const ownTurns = all.slice(carried.length);
  const total = all.reduce((sum, turn) => sum + turn.text.length, 0) + Math.max(0, all.length - 1) * 2;
  if (all.length <= MAX_HISTORY_TURNS && total <= MAX_HISTORY_CHARS)
    return { ...cutHistory(all, MAX_HISTORY_CHARS), selection: null, compaction: null };

  const included = new Map<AnsweredTurn, HistoryIncluded>();
  const take = (turn: AnsweredTurn, reason: HistoryIncluded['reason'], score?: number) =>
    included.set(turn, { runId: turn.runId, stepId: turn.stepId, index: turn.index, reason, ...(score === undefined ? {} : { score }) });
  const recent = ownTurns.slice(-RECENT_KEEP);
  for (const turn of recent) take(turn, 'recent');
  if (ownTurns.length > recent.length) take(ownTurns[0], 'pinned');

  const joined = (turns: Iterable<AnsweredTurn>) => {
    let sum = 0;
    let count = 0;
    for (const turn of turns) {
      sum += turn.text.length;
      count += 1;
    }
    return sum + Math.max(0, count - 1) * 2;
  };
  // Room for the rest: what the protected messages leave, less the marker's and summary's reserve.
  const budget = MAX_HISTORY_CHARS - OMISSION_RESERVE_CHARS;
  let used = joined(included.keys());
  const fits = (turn: AnsweredTurn) =>
    included.size < MAX_HISTORY_TURNS && used + 2 + turn.text.length <= budget;
  const ranked = ownTurns
    .filter((turn) => !included.has(turn))
    .map((turn) => ({ turn, score: relevance(turn.text, input.message) }))
    .sort((a, b) => b.score - a.score || b.turn.index - a.turn.index);
  for (const { turn, score } of ranked)
    if (fits(turn)) {
      take(turn, score > 0 ? 'relevant' : 'fits', score);
      used += 2 + turn.text.length;
    }
  for (const turn of [...carriedSet].reverse())
    if (fits(turn)) {
      take(turn, 'fits');
      used += 2 + turn.text.length;
    }

  const chosen = all.filter((turn) => included.has(turn));
  const omitted = all.filter((turn) => !included.has(turn));
  const ownOmitted = omitted.filter((turn) => !carriedSet.has(turn));
  const carriedOmitted = omitted.filter((turn) => carriedSet.has(turn));
  const compaction = ownOmitted.length ? compactTurns(ownOmitted) : null;
  const marker = omitted.length
    ? `[Diomedes left out ${omitted.length} earlier ${omitted.length === 1 ? 'message' : 'messages'} (${numbers(
        omitted.map((turn) => turn.index),
      )}) to fit this conversation’s history budget of ${MAX_HISTORY_TURNS} messages and ${MAX_HISTORY_CHARS.toLocaleString(
        'en-US',
      )} characters.${ownOmitted.length ? ' A summary of this conversation’s own follows.' : ''}${
        carriedOmitted.length
          ? ` ${carriedOmitted.length === omitted.length ? 'They were' : `${carriedOmitted.length} of them were`} from before this conversation was updated and are not summarised.`
          : ''
      }]`
    : null;
  const head = [marker, compaction?.text].filter((part): part is string => Boolean(part)).join('\n\n');
  const room = MAX_HISTORY_CHARS - (head ? head.length + 2 : 0);
  const cut = cutHistory(chosen, room);
  const text = head ? `${head}\n\n${cut.text}` : cut.text;
  return {
    text,
    messages: cut.messages,
    selection: {
      method: 'recency+lexical/1',
      budget: { turns: MAX_HISTORY_TURNS, chars: MAX_HISTORY_CHARS },
      available: all.length,
      included: chosen.map((turn) => included.get(turn)!),
      omitted: omitted.map((turn) => ({ runId: turn.runId, stepId: turn.stepId, index: turn.index, carried: carriedSet.has(turn) })),
      marker,
      cutChars: cut.cut,
    },
    compaction,
  };
}

// --- the stable prefix --------------------------------------------------------------------

/**
 * The system text one turn is sent with: the lineage's recorded instructions and the tool note
 * first, byte-identical on every turn of the conversation, then what this message's read scope
 * adds. `lineage` must already end with the tool note.
 */
export function stablePrefix(lineage: string, variable: string | null) {
  return {
    prefix: lineage,
    instructions: variable ? `${lineage}\n\n${variable}` : lineage,
    sha: sha256(lineage),
    bytes: utf8Bytes(lineage),
  };
}

/** What this build does about prompt caching on each Diomedes-owned route. */
export function cacheSupport(route: string): { support: PromptCacheSupport; note: string } {
  switch (route) {
    case 'aws-bedrock':
    case 'azure-openai':
      return {
        support: 'automatic-prefix',
        note: 'Any reuse is the provider’s own automatic prefix caching. Diomedes sends the stable prefix first and no cache directive, and records the cached input tokens the provider reports.',
      };
    case 'google-vertex':
      return {
        support: 'automatic-prefix',
        note: 'Any reuse is Google’s implicit caching. Explicit context caching is not wired in this build. Cached input tokens are recorded when Google reports them.',
      };
    default:
      return {
        support: 'not-wired',
        note: 'Whether the upstream reuses a prefix depends on the model, and this build sends no cache directive. Cached input tokens are recorded when reported.',
      };
  }
}

// --- the account --------------------------------------------------------------------------

const section = (id: ContextSectionId, bytes: number, detail?: string): ContextSection => ({
  id,
  bytes,
  estimatedTokens: Math.ceil(bytes / 4),
  ...(detail ? { detail } : {}),
});

/**
 * One turn's account before anything is sent: every byte of the first call's context in exactly
 * one section. `system` is the whole system text; `guidance` the answer-format texts it may
 * contain, counted apart from the rest of the instructions. `separatorBytes` is what joins the
 * user message's parts, counted with the message.
 */
export function accountContext(input: {
  route: string;
  model: string;
  system: string;
  guidance: readonly string[];
  tools: readonly unknown[];
  parts: { history: string; files: string; message: string };
  separatorBytes: number;
  documents: number;
  requestLimitBytes: number | null;
  prefix: { sha: string; bytes: number };
  previousPrefixSha: string | null;
  history: HistorySelection | null;
  compaction: CompactionRecord | null;
}): ContextAccount {
  const format = input.guidance.filter((text) => text && input.system.includes(text)).reduce((sum, text) => sum + utf8Bytes(text), 0);
  const historyDetail = input.history
    ? `${input.history.included.length} of ${input.history.available} earlier messages${
        input.compaction ? `, ${input.compaction.turns.length} summarised` : ''
      }`
    : undefined;
  const sections = [
    section('instructions', utf8Bytes(input.system) - format),
    section('answer-format', format),
    section('tools', input.tools.length ? utf8Bytes(JSON.stringify(input.tools)) : 0),
    section(
      'project-files',
      utf8Bytes(input.parts.files),
      input.documents ? `${input.documents} attached, read through tools` : undefined,
    ),
    section('history', utf8Bytes(input.parts.history), historyDetail),
    section('message', utf8Bytes(input.parts.message) + input.separatorBytes),
  ];
  return {
    v: CONTEXT_ACCOUNT_VERSION,
    route: input.route,
    model: input.model,
    estimator: CONTEXT_ESTIMATOR,
    window: modelContextWindow(input.route, input.model),
    requestLimitBytes: input.requestLimitBytes,
    sections,
    estimatedTokens: sections.reduce((sum, item) => sum + item.estimatedTokens, 0),
    provider: null,
    reconciliation: null,
    stablePrefix: {
      ...input.prefix,
      sameAsPrevious: input.previousPrefixSha === null ? null : input.previousPrefixSha === input.prefix.sha,
    },
    cache: cacheSupport(input.route),
    history: input.history,
    compaction: input.compaction,
  };
}

const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The account with what the turn's run recorded: each model call's reported usage, summed, and
 * the tool results the loop sent back on later calls. The first call is reconciled against the
 * estimate, because only its context is exactly the estimated sections.
 */
export function reconcileContext(account: ContextAccount, child: Pick<HarnessRun, 'steps'>): ContextAccount {
  const models = child.steps.filter((step) => step.intent.kind === 'model' && step.state === 'succeeded');
  const tools = child.steps.filter((step) => step.intent.kind === 'tool' && step.state === 'succeeded');
  const provider = {
    calls: models.length,
    reportedCalls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    firstCallInputTokens: null as number | null,
  };
  models.forEach((step, i) => {
    const usage = (step.output as { usage?: Record<string, unknown> | null } | null)?.usage;
    const input = count(usage?.inputTokens);
    const output = count(usage?.outputTokens);
    if (input === null || output === null) return;
    provider.reportedCalls += 1;
    provider.inputTokens += input;
    provider.outputTokens += output;
    provider.cacheReadTokens += count(usage?.cacheReadTokens) ?? 0;
    provider.cacheWriteTokens += count(usage?.cacheWriteTokens) ?? 0;
    if (i === 0) provider.firstCallInputTokens = input;
  });
  const resultBytes = tools.reduce((sum, step) => sum + utf8Bytes(JSON.stringify(step.output ?? null)), 0);
  const sections = [
    ...account.sections.filter((item) => item.id !== 'tool-results'),
    section(
      'tool-results',
      resultBytes,
      tools.length ? `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}, sent back on later calls` : undefined,
    ),
  ];
  return {
    ...account,
    sections,
    provider: models.length ? provider : null,
    reconciliation:
      provider.firstCallInputTokens === null
        ? null
        : {
            estimated: account.estimatedTokens,
            reported: provider.firstCallInputTokens,
            difference: provider.firstCallInputTokens - account.estimatedTokens,
          },
  };
}

export { estimateTokens };
