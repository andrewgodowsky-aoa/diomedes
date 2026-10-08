/**
 * Auto (DIO-292, option B): one Agent for each message, picked before anything is sent.
 *
 * A rule decides when the message's words are clear. Where they aren't, Jev may choose from the
 * same shortlist when an advisor is configured; otherwise Auto answers the message itself on a
 * route that has an Auto conversation, or Researcher answers it where none exists. Every default
 * reads and answers: nothing that changes files is ever picked by default. Picking never grants
 * anything; Permissions decide what any run may do, and file changes still wait for approval.
 */
import { AUTO_AGENT, DEFAULT_AGENT, type WorkMode } from '../shared/agents.js';
import { imageMediaType } from '../shared/model-images.js';
import { ApiError } from './paths.js';

export interface PickMessage {
  readonly text: string;
  /** Project-relative paths attached to this message. */
  readonly attachments: readonly string[];
  /** The thread is attached to a document or plan, which travels with every message. */
  readonly attachedDocument: boolean;
}
export interface PickCandidate {
  readonly id: string;
  readonly summary: string;
  readonly kind: WorkMode;
}
export type Advise = (shortlist: readonly { id: string; description: string }[]) => Promise<string | null>;
export interface AgentPick {
  /** An Agent id, or `auto` when Auto answers the message itself. */
  readonly agent: string;
  readonly by: 'rule' | 'jev' | 'default';
}

const WRITER = 'diomedes.writer';
const REVIEWER = 'diomedes.reviewer';
const EXPLORER = 'diomedes.explorer';
const ANALYST = 'diomedes.analyst';
/** The Agents that change files that already exist: picked only when a file comes with the message. */
const EDITS_EXISTING = new Set<string>([DEFAULT_AGENT.build, DEFAULT_AGENT.fix]);
/** A build request with no file to change: the rule abstains rather than guess. */
const UNCLEAR = 'unclear';

/** "Can you", "please could you": the polite opening of a request, whatever its ending. */
const ASKING = String.raw`^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?`;
const CHAT = /^(?:hi|hello|hey|thanks|thank you(?: so much)?|good (?:morning|afternoon|evening)|ok|okay|great|cool|sounds good)[\s,.!?]*$/i;
const REQUEST = /^(?:please\s+)?(?:can|could|would|will)\s+you\b/i;
const FIX = /\b(?:fix|fixes|broken|bug|bugs|error|errors|crash(?:es|ed|ing)?|fail(?:s|ed|ing)?|not working|(?:doesn't|does not|isn't|is not|won't|will not) work|off by)\b/i;
const WRITE_VERB = /\b(?:write|draft|compose|prepare)\b/i;
const WRITE_NOUN = /\b(?:letter|email|e-mail|memo|announcement|newsletter|post|flyer|invitation|invite|press release|bio|reply|message|notice|policy|description|proposal|note)\b/i;
const PLAN_REQUEST = new RegExp(`${ASKING}(?:make|write|draft|create|put together|give me)\\s+(?:me\\s+)?(?:a|an|the)?\\s*plan\\b`, 'i');
// Planning asked for: "plan" as the request's own verb, or words that ask for a way forward. The
// noun alone names a document ("tidy the plan"), and Planner changes no document.
const PLAN = new RegExp(
  `${ASKING}plan\\b|\\b(?:planning|roadmap|step[- ]by[- ]step|steps to|approach|strategy|outline)\\b|\\bhow should (?:we|i)\\b`,
  'i',
);
const BUILD = new RegExp(
  `${ASKING}(?:add|change|update|rename|build|create|make|implement|remove|delete|edit|move|replace|set up|turn|insert|rewrite|write)\\b`,
  'i',
);
// The verb, as a request opens with it: "the review about the heater" is a noun, not a request.
const REVIEW = new RegExp(
  `${ASKING}(?:review|look over|proofread)\\b|\\bcheck (?:this|the|my) (?:change|changes|diff|draft|edit|edits|work)\\b`,
  'i',
);
const EXPLORE = /\bwhere (?:is|are|does|do)\b|\bwhich file\b|\b(?:locate|find where)\b|\bhow does .+ (?:fit|connect)\b/i;
const ANALYZE = /\b(?:chart|graph|plot|totals?|sales|revenue|spreadsheet|csv|numbers|average|trend)\b/i;
const SHEET = /\.(?:csv|tsv|xlsx|xls)$/i;

/** A question asks for an answer. "Could you add ...?" is a request, whatever its ending. */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith('?') && !REQUEST.test(trimmed);
}

/** The Agent the message's own words point at, `auto` for small talk, or null when they don't say. */
export function ruleFor(message: PickMessage): string | null {
  const text = message.text.trim();
  if (CHAT.test(text)) return AUTO_AGENT;
  if (PLAN_REQUEST.test(text)) return DEFAULT_AGENT.plan;
  const question = isQuestion(text);
  const documents = message.attachments.length > 0 || message.attachedDocument;
  const found = new Set<string>();
  const write = !question && WRITE_VERB.test(text) && WRITE_NOUN.test(text);
  if (write) found.add(WRITER);
  else if (FIX.test(text))
    // A failure outranks the numbers it is about: "the sales total is off by a day" is a fix,
    // or, asked as a question, something to explain.
    found.add(question ? DEFAULT_AGENT.ask : documents ? DEFAULT_AGENT.fix : UNCLEAR);
  else if (!question && BUILD.test(text)) found.add(documents ? DEFAULT_AGENT.build : UNCLEAR);
  if (PLAN.test(text)) found.add(DEFAULT_AGENT.plan);
  if (REVIEW.test(text)) found.add(REVIEWER);
  if (EXPLORE.test(text)) found.add(EXPLORER);
  const failure = found.has(DEFAULT_AGENT.fix) || found.has(DEFAULT_AGENT.ask) || found.has(UNCLEAR);
  if (!failure && (ANALYZE.test(text) || message.attachments.some((name) => SHEET.test(name)))) found.add(ANALYST);
  if (found.size === 0) return question ? DEFAULT_AGENT.ask : null;
  if (found.size > 1 || found.has(UNCLEAR)) return null;
  return [...found][0];
}

/**
 * The Agents Auto may pick for this message on this route: built-ins only, never an internal or
 * added one, each compatible with the route its kind takes. Agents that change files are left out
 * where the conversation is the only path (Home, the Agent view, Nectovia) and when an image comes
 * with the message, and Builder and Fixer when no file does.
 */
export function candidatesFor(
  agents: readonly { id: string; summary: string; modes: readonly WorkMode[]; origin: string; internal?: true }[],
  context: { compatible(id: string): boolean; conversationOnly: boolean; documents: boolean; images: boolean },
): PickCandidate[] {
  return agents
    .filter((item) => item.origin === 'built-in' && !item.internal && context.compatible(item.id))
    .map((item) => ({ id: item.id, summary: item.summary, kind: item.modes[0] }))
    .filter((item) => item.kind === 'ask' || item.kind === 'plan' || (!context.conversationOnly && !context.images))
    .filter((item) => !EDITS_EXISTING.has(item.id) || context.documents);
}

/** Whether any attached path is an image, which only a conversation can carry. */
export const hasImage = (attachments: readonly string[]) => attachments.some((name) => Boolean(imageMediaType(name)));

export async function pickAgent(input: {
  message: PickMessage;
  candidates: readonly PickCandidate[];
  autoItself: boolean;
  advise?: Advise;
}): Promise<AgentPick> {
  const allowed = new Set(input.candidates.map((item) => item.id));
  const usable = (id: string | null): id is string =>
    id !== null && (id === AUTO_AGENT ? input.autoItself : allowed.has(id));
  const ruled = ruleFor(input.message);
  if (usable(ruled)) return { agent: ruled, by: 'rule' };
  if (input.advise && input.candidates.length > 0) {
    const advised = await input.advise(input.candidates.map((item) => ({ id: item.id, description: item.summary })));
    if (advised && allowed.has(advised)) return { agent: advised, by: 'jev' };
  }
  if (input.autoItself) return { agent: AUTO_AGENT, by: 'default' };
  if (allowed.has(DEFAULT_AGENT.ask)) return { agent: DEFAULT_AGENT.ask, by: 'default' };
  const reader = input.candidates.find((item) => item.kind === 'ask' || item.kind === 'plan');
  if (reader) return { agent: reader.id, by: 'default' };
  throw new ApiError(409, 'No agent can take this message here. Pick one in the Agent box.', { code: 'no_agent' });
}
