/**
 * H18: how a model-API conversation turn's context is chosen, ordered and accounted for, on the
 * routes where Diomedes assembles it (`model-session-run.ts`). An external engine manages its own
 * context and gets none of this.
 *
 * Four properties, each easy to lose:
 *
 * 1. **The newest messages are never dropped.** When the history passes its budget (the same
 *    bounds `conversation-history.ts` has always applied: 12 messages, 24,000 characters), the
 *    oldest messages are folded into a summary in steps (`foldPoint`), and every message after
 *    the fold stays whole, the newest always among them. A carried lineage's messages are the
 *    oldest, so they give way first, as they always did.
 * 2. **What is left out is said.** A marker at the top of the history names the folded range, and
 *    a lineage's own folded messages are summarised under it. The selection record names every
 *    message left out, by number.
 * 3. **A summary is evidence, not a rewrite.** `compactTurns` is a deterministic extract (the first
 *    sentence of each side), attributed to the application because no model wrote it, and it names
 *    each message it stands for by run, step and the sha-256 of what was said. The messages stay
 *    in their run untouched (decision 10), so the person can open each one.
 * 4. **The stable part goes first.** The lineage's recorded instructions and the tool note are the
 *    same bytes on every turn of a conversation; what varies per message (the read scope's note)
 *    comes after them. The history does the same (DIO-23): the marker, the summary and the kept
 *    messages stay byte for byte the same from one message to the next until the fold steps,
 *    each new message only appends, and what this message alone recalls goes after them. A
 *    provider that reuses a repeated prefix can reuse all of it.
 */
import { createHash } from 'node:crypto';
import type { HarnessRun } from '../../shared/harness.js';
import type { LocalModelProfile } from '../../shared/local-model.js';
import {
  CONTEXT_ACCOUNT_VERSION,
  CONTEXT_ESTIMATOR,
  estimateTokens,
  modelContextWindow,
  summarisedCount,
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
  cacheAccount,
  type CacheMark,
  type CachePolicy,
  type RouteCapability,
} from '../../shared/route-capabilities.js';
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  answeredTurns,
  cutHistory,
  type AnsweredTurn,
  type BoundedHistory,
} from './conversation-history.js';
import { HOST_READ_STEP } from './native-agent.js';

/** The most a compaction summary may weigh, in characters. */
export const SUMMARY_MAX_CHARS = 2_000;
/** Room held back for the marker and the summary when anything is left out. */
const OMISSION_RESERVE_CHARS = SUMMARY_MAX_CHARS + 600;
/** The most summarised messages one message recalls in full. */
export const PICK_MAX = 2;
/** Room held back for the recalled messages and their note. */
export const PICK_ROOM_CHARS = 4_000;
/** The longest note before the recalled messages: two message numbers of up to six digits. */
const PICK_NOTE_CHARS = 120;
/** The longest opening message that stays whole at the top once it is folded. */
export const PINNED_MAX_CHARS = 2_400;
/**
 * Room for the stable messages: the opening message while it stays whole, and the kept messages,
 * each counted with the blank line that joins it. The marker, the summary and the recalled
 * messages have their own room, so a history never passes `MAX_HISTORY_CHARS` and is never cut
 * inside a step.
 */
export const KEPT_ROOM_CHARS = MAX_HISTORY_CHARS - OMISSION_RESERVE_CHARS - PICK_ROOM_CHARS;
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
  if (sentence.length <= EXCERPT_CHARS) return sentence;
  // Never end on half of a surrogate pair: a lone surrogate is not text a provider accepts.
  let cut = EXCERPT_CHARS - 1;
  const last = sentence.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${sentence.slice(0, cut).trimEnd()}…`;
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
    const line = `- Message ${turn.index}: the person asked ${asked}; ${answered}`;
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
    listed,
  };
}

// --- selection ----------------------------------------------------------------------------

export interface SelectedHistory extends BoundedHistory {
  /** Null when the history fitted its budget: then it is exactly `boundedHistory`. */
  selection: HistorySelection | null;
  compaction: CompactionRecord | null;
  /**
   * How many characters at the start of `text` the next message's history starts with too,
   * until the fold steps: all of it inside the bounds, and past them the marker, the summary and
   * the kept messages. What this message alone recalls comes after them.
   */
  stable: number;
}

/**
 * How many of the oldest messages are folded behind the marker: the boundary between the stable
 * head and the kept messages. A pure function of the messages' sizes, never of the new message or
 * of what it recalls, so every message of a conversation computes the same boundary from the same
 * history.
 *
 * The lattice is the conversation's own step points. Replayed from the first message, the
 * boundary stays where it is while the kept messages fit their room: `MAX_HISTORY_TURNS` messages
 * in `KEPT_ROOM_CHARS`, the opening message counted while it stays whole. When the kept messages
 * outgrow it, the boundary steps to the first message that leaves them at most half of both, so
 * several more messages fit before the next step. The newest is always kept. Between steps a new
 * message only appends, so the next history starts with every byte of this one's stable part. A
 * step point depends only on the messages before it, so a new message never moves an earlier one.
 *
 * A fixed multiple of messages was the other candidate. Messages vary in size, so a fixed multiple
 * leaves the kept block nearly full or nearly empty after a step: with answers of 2,000 characters,
 * folding six at a time fills the room again two messages after the first step, so the history
 * steps twice in three messages. Stepping to half the room steps there once, and next five
 * messages later.
 */
export function foldPoint(
  turns: readonly Pick<AnsweredTurn, 'text'>[],
  carried: number,
  opening: Pick<AnsweredTurn, 'text'> | null,
): number {
  let fold = 0;
  // The kept messages' characters and the whole history's, each with the blank line that joins it.
  let kept = 0;
  let whole = 0;
  // Once folded, this lineage's opening message stays whole at the top, so it still takes room.
  const pinned = (at: number) => (opening !== null && at > carried ? 1 : 0);
  const pinnedChars = (at: number) => (opening !== null && at > carried ? opening.text.length + 2 : 0);
  for (let at = 0; at < turns.length; at++) {
    const size = turns[at].text.length + 2;
    kept += size;
    whole += size;
    // Inside the bounds the history goes whole, with nothing folded.
    if (fold === 0 && at + 1 <= MAX_HISTORY_TURNS && whole - 2 <= MAX_HISTORY_CHARS) continue;
    const fits = (count: number, chars: number) =>
      at + 1 - fold + pinned(fold) <= count && kept + pinnedChars(fold) <= chars;
    if (fold > 0 && fits(MAX_HISTORY_TURNS, KEPT_ROOM_CHARS)) continue;
    while (fold < at && !fits(MAX_HISTORY_TURNS / 2, KEPT_ROOM_CHARS / 2)) {
      kept -= turns[fold].text.length + 2;
      fold += 1;
    }
  }
  return fold;
}

const span = (from: number, to: number) => (from === to ? `Message ${from} is` : `Messages ${from} to ${to} are`);

/** The marker: the folded range in words, the same for every message between two steps. */
function foldMarker(carried: number, pinned: number | null, summarised: { from: number; to: number } | null): string {
  const parts: string[] = [];
  if (carried > 0)
    parts.push(
      carried === 1
        ? 'Message 1 came before this conversation was updated and is left out.'
        : `Messages 1 to ${carried} came before this conversation was updated and are left out.`,
    );
  if (pinned !== null) parts.push(`Message ${pinned} follows in full.`);
  if (summarised) parts.push(`${span(summarised.from, summarised.to)} summarised ${pinned !== null ? 'after it' : 'below'}.`);
  return `[${parts.join(' ')}]`;
}

/** The note before what this message recalls, naming each recalled message by number. */
function recallNote(indexes: readonly number[]): string {
  return indexes.length === 1
    ? `[Message ${indexes[0]} is repeated in full here because it bears on the new message.]`
    : `[Messages ${indexes.slice(0, -1).join(', ')} and ${indexes.at(-1)} are repeated in full here because they bear on the new message.]`;
}

/**
 * The history a model-API turn is given. Within the bounds, exactly the bounded history. Past
 * them, in this order:
 *
 * 1. The stable head: a marker naming the folded range, this lineage's opening message whole when
 *    it is short enough, and the summary of the rest of this lineage's folded messages. A carried
 *    lineage's folded messages give way without a summary.
 * 2. The kept messages after the fold, oldest first, the newest always among them.
 * 3. What this message recalls: summarised messages that bear on it more than every message
 *    already in full, with their own note.
 *
 * Parts 1 and 2 are the same bytes for every message until the fold steps (`foldPoint`), so a
 * follow-up's history starts with all of them. Part 3 changes with each message, so it goes after
 * them, next to the new message.
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
  const total = all.reduce((sum, turn) => sum + turn.text.length, 0) + Math.max(0, all.length - 1) * 2;
  if (all.length <= MAX_HISTORY_TURNS && total <= MAX_HISTORY_CHARS) {
    const bounded = cutHistory(all, MAX_HISTORY_CHARS);
    return { ...bounded, selection: null, compaction: null, stable: bounded.text.length };
  }

  const ownOpening = all[carried.length];
  const opening = ownOpening && ownOpening.text.length <= PINNED_MAX_CHARS ? ownOpening : null;
  const fold = foldPoint(all, carried.length, opening);
  const folded = all.slice(0, fold);
  const kept = all.slice(fold);
  const keptChars = kept.reduce((sum, turn) => sum + turn.text.length + 2, 0);
  // Folded and short enough, the opening message stays whole. Only a newest message too long for
  // the room on its own takes its place, and then it is summarised with the rest for this message.
  const pinned =
    opening && fold > carried.length && keptChars + opening.text.length + 2 <= KEPT_ROOM_CHARS ? opening : null;
  const carriedFolded = folded.filter((turn) => carriedSet.has(turn)).length;
  const summarised = folded.filter((turn) => !carriedSet.has(turn) && turn !== pinned);
  const compaction = summarised.length ? compactTurns(summarised) : null;
  const marker = folded.length
    ? foldMarker(
        carriedFolded,
        pinned?.index ?? null,
        summarised.length ? { from: summarised[0].index, to: summarised.at(-1)!.index } : null,
      )
    : null;
  const head = [marker, pinned?.text, compaction?.text].filter((part): part is string => Boolean(part)).join('\n\n');
  // The kept messages fit their room by construction. Only a newest message longer than the
  // whole room on its own meets the cut, which keeps its end, as before.
  const cut = cutHistory(kept, MAX_HISTORY_CHARS - (head ? head.length + 2 : 0));
  const stableText = head ? `${head}\n\n${cut.text}` : cut.text;
  const truncated = new Set<AnsweredTurn>();
  let at = 0;
  for (const turn of kept) {
    if (at < cut.cut) truncated.add(turn);
    at += turn.text.length + 2;
  }

  // What this message recalls. Only a summarised message that shares more of this message's words
  // than every message already in full adds what the model does not have; a tie adds nothing, and
  // every recalled byte comes after the part a provider can reuse. The most relevant first, whole,
  // at most `PICK_MAX`, within their own room.
  const inFull = pinned ? [pinned, ...kept] : kept;
  const floor = Math.max(0, ...inFull.map((turn) => relevance(turn.text, input.message)));
  const ranked = summarised
    .map((turn) => ({ turn, score: relevance(turn.text, input.message) }))
    .filter((item) => item.score > floor)
    .sort((a, b) => b.score - a.score || b.turn.index - a.turn.index);
  const pickRoom = Math.min(PICK_ROOM_CHARS, MAX_HISTORY_CHARS - stableText.length) - 2 - PICK_NOTE_CHARS;
  const picks: typeof ranked = [];
  let used = 0;
  for (const item of ranked) {
    if (picks.length === PICK_MAX) break;
    if (used + 2 + item.turn.text.length > pickRoom) continue;
    picks.push(item);
    used += 2 + item.turn.text.length;
  }
  picks.sort((a, b) => a.turn.index - b.turn.index);
  const recall = picks.length
    ? [recallNote(picks.map((item) => item.turn.index)), ...picks.map((item) => item.turn.text)].join('\n\n')
    : '';
  const text = recall ? `${stableText}\n\n${recall}` : stableText;

  const ref = (turn: AnsweredTurn) => ({ runId: turn.runId, stepId: turn.stepId, index: turn.index });
  const included: HistoryIncluded[] = [
    ...(pinned ? [{ ...ref(pinned), reason: 'pinned' as const }] : []),
    ...kept.map((turn) =>
      truncated.has(turn)
        ? { ...ref(turn), reason: 'recent' as const, truncated: true as const }
        : { ...ref(turn), reason: 'recent' as const },
    ),
    ...picks.map(({ turn, score }) => ({ ...ref(turn), reason: 'relevant' as const, score })),
  ].sort((a, b) => a.index - b.index);
  const inText = new Set<AnsweredTurn>([...inFull, ...picks.map((item) => item.turn)]);
  const messages = new Map<string, number>();
  for (const turn of all) if (inText.has(turn)) messages.set(turn.runId, (messages.get(turn.runId) ?? 0) + 1);
  return {
    text,
    messages,
    stable: stableText.length,
    selection: {
      method: 'stepped+lexical/2',
      budget: { turns: MAX_HISTORY_TURNS, chars: MAX_HISTORY_CHARS },
      available: all.length,
      included,
      omitted: all.filter((turn) => !inText.has(turn)).map((turn) => ({ ...ref(turn), carried: carriedSet.has(turn) })),
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

/**
 * What a turn's adapter reports about the owner's cache setting (DIO-215): the setting its calls
 * were sent under, the capability record of the model they went to, and what the breakpoint marked.
 */
export interface TurnCacheReport {
  policy: CachePolicy;
  record: RouteCapability | null;
  marked: CacheMark;
}

const count_ = (value: number) => value.toLocaleString('en-US');

/**
 * The account's cache line under the owner's setting: the setting, whether `off` is verified on
 * this identity, what the breakpoint marked and `cacheAccount`'s sentence. When the marked start
 * (the tool definitions and the marked system text, by the estimator, and the attached files read
 * before the message when a breakpoint follows them) is under the record's declared minimum for a
 * cache checkpoint, the note says it is too short to be cached. With no report the account is
 * returned as it was.
 */
export function withCacheSetting(
  account: ContextAccount,
  report: TurnCacheReport | null,
  system: { prefix: string; instructions: string },
): ContextAccount {
  if (!report) return account;
  const line = cacheAccount(report.policy, report.record, report.marked);
  const minimum = report.record?.cache.minimumTokens.value ?? null;
  const markedText =
    line.marked === 'stable-prefix' || line.marked === 'stable-prefix-and-files'
      ? system.prefix
      : line.marked === 'whole-instructions' || line.marked === 'whole-instructions-and-files'
        ? system.instructions
        : null;
  const tools = account.sections.find((item) => item.id === 'tools')?.estimatedTokens ?? 0;
  // The longest marked start decides: with the files marked it runs to the end of their reads.
  const files =
    line.marked === 'stable-prefix-and-files' || line.marked === 'whole-instructions-and-files'
      ? (account.sections.find((item) => item.id === 'project-files')?.estimatedTokens ?? 0)
      : 0;
  const markedTokens = markedText === null ? null : tools + estimateTokens(markedText) + files;
  const note =
    minimum !== null && markedTokens !== null && markedTokens < minimum
      ? `${line.note} The marked start is about ${count_(markedTokens)} tokens, under this model’s minimum of ${count_(minimum)} tokens for a cache checkpoint, so it is too short to be cached.`
      : line.note;
  return { ...account, cache: { support: account.cache.support, ...line, note } };
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
/**
 * The window a local profile declares, for the context account. The running profile is the one
 * whose context the server reports, so this is the server's window while that profile runs.
 */
export function localModelWindow(
  profile: Pick<LocalModelProfile, 'contextTokens'> | undefined,
): ContextAccount['window'] | undefined {
  return profile ? { tokens: profile.contextTokens, source: 'The local profile, whose context the running server reports' } : undefined;
}

export function accountContext(input: {
  route: string;
  model: string;
  /** The window when the caller knows it from elsewhere, such as a local profile. */
  window?: ContextAccount['window'];
  system: string;
  guidance: readonly string[];
  tools: readonly unknown[];
  parts: { history: string; files: string; message: string };
  separatorBytes: number;
  documents: number;
  images?: number;
  /**
   * The host's reads of the attached text files, sent on the first call before the history: how
   * many, and the bytes of their opener, calls and results. Counted with the project files.
   */
  reads?: { count: number; bytes: number };
  requestLimitBytes: number | null;
  prefix: { sha: string; bytes: number };
  previousPrefixSha: string | null;
  history: HistorySelection | null;
  compaction: CompactionRecord | null;
}): ContextAccount {
  const format = input.guidance.filter((text) => text && input.system.includes(text)).reduce((sum, text) => sum + utf8Bytes(text), 0);
  const historyDetail = input.history
    ? `${input.history.included.length} of ${input.history.available} earlier messages${
        input.compaction ? `, ${summarisedCount(input.compaction)} summarised` : ''
      }`
    : undefined;
  const sections = [
    section('instructions', utf8Bytes(input.system) - format),
    section('answer-format', format),
    section('tools', input.tools.length ? utf8Bytes(JSON.stringify(input.tools)) : 0),
    section(
      'project-files',
      utf8Bytes(input.parts.files) + (input.reads?.bytes ?? 0),
      input.images ? `${input.documents} attached, including ${input.images} images sent as bytes. Image tokens are excluded from the text estimate.`
        : input.reads?.count ? `${input.documents} attached, read before the message`
        : input.documents ? `${input.documents} attached, read through tools` : undefined,
    ),
    section('history', utf8Bytes(input.parts.history), historyDetail),
    section('message', utf8Bytes(input.parts.message) + input.separatorBytes),
  ];
  return {
    v: CONTEXT_ACCOUNT_VERSION,
    route: input.route,
    model: input.model,
    estimator: CONTEXT_ESTIMATOR,
    window: input.window ?? modelContextWindow(input.route, input.model),
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
  // The host's reads went on the first call and are counted with the project files already.
  const tools = child.steps.filter(
    (step) => step.intent.kind === 'tool' && step.state === 'succeeded' && !step.intent.stepId.startsWith(HOST_READ_STEP),
  );
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
