/**
 * The earlier messages a conversation turn is given, read from durable run records and never from
 * the thread's transcript. A note the application writes in the thread (a lineage retirement, or
 * "Update this conversation") is not a message: it is never a `turn:` step, so it never reaches a
 * model.
 *
 * One reader for both conversation drivers. Each saves one message as one `turn:<command>` step
 * whose input holds the prompt and whose output holds the answer (`claude-session-run.ts`,
 * `model-session-run.ts`), so a lineage "Update this conversation" started can carry the recent
 * messages of the lineage it retired, whichever driver answered them (artifacts v2, frozen item 3).
 */
import type { HarnessRun } from '../../shared/harness.js';
import type { RunService } from './run-service.js';

/** The history bounds (draft a.3): at most the last 12 answered messages and 24,000 characters. */
export const MAX_HISTORY_TURNS = 12;
export const MAX_HISTORY_CHARS = 24_000;

/**
 * The runs a conversation keeps its messages in: a native Claude session's and a model-API
 * conversation's (`CLAUDE_SESSION_CAPABILITY`, `MODEL_CONVERSATION_CAPABILITY`). Written out here
 * so neither driver imports the other; a test holds them equal.
 */
export const CONVERSATION_CAPABILITY_IDS: readonly string[] = ['claude-native-session', 'model-api-conversation'];

/** The answer without its decision block, as a later turn is given it. */
export const spoken = (text: string) => {
  const at = text.lastIndexOf('```diomedes-decision');
  return (at >= 0 ? text.slice(0, at) : text).trim();
};

/** A bounded transcript, and how many of its messages each run gave. */
export interface BoundedHistory {
  text: string;
  /**
   * Answered messages per run id, counting one the character bound cut short. A run that gave
   * nothing inside the bounds is absent, so a lineage's evidence names a carried run only when
   * its messages were actually sent.
   */
  messages: Map<string, number>;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The answered messages in these runs, oldest run first, as one bounded transcript: the last
 * `MAX_HISTORY_TURNS` messages across all of them, then the last `MAX_HISTORY_CHARS` characters.
 * `exclude` is the step of the message being answered now, which is never its own history. The
 * cut never splits a character: a surrogate pair it would halve is left out whole.
 */
export function boundedHistory(runs: readonly HarnessRun[], exclude?: string): BoundedHistory {
  return cutHistory(answeredTurns(runs, exclude).slice(-MAX_HISTORY_TURNS), MAX_HISTORY_CHARS);
}

/** One answered message of a conversation, as history gives it. */
export interface AnsweredTurn {
  runId: string;
  stepId: string;
  /** 1-based among the answered messages read, oldest first. */
  index: number;
  prompt: string | null;
  /** The spoken answer, without its decision block. */
  answer: string | null;
  /** The block history carries for it: `Person:` and `Diomedes:` lines. */
  text: string;
}

/** Every answered message in these runs, oldest run first, except `exclude`. */
export function answeredTurns(runs: readonly HarnessRun[], exclude?: string): AnsweredTurn[] {
  const turns: AnsweredTurn[] = [];
  for (const run of runs)
    for (const step of run.steps) {
      if (!step.intent.stepId.startsWith('turn:') || step.intent.stepId === exclude || step.state !== 'succeeded') continue;
      const lines: string[] = [];
      const prompt = (step.intent.input as { prompt?: unknown } | null)?.prompt;
      const response = (step.output as { response?: { text?: unknown } | null } | null)?.response;
      const answer = typeof response?.text === 'string' ? spoken(response.text) : null;
      if (typeof prompt === 'string') lines.push(`Person: ${prompt}`);
      if (answer !== null) lines.push(`Diomedes: ${answer}`);
      // One block per message, joined as the lines always were: each line, then a blank line.
      if (lines.length)
        turns.push({
          runId: run.id,
          stepId: step.intent.stepId,
          index: turns.length + 1,
          prompt: typeof prompt === 'string' ? prompt : null,
          answer,
          text: lines.join('\n\n'),
        });
    }
  return turns;
}

/**
 * These blocks joined, then cut to their last `chars` characters, marked `…` where cut, never
 * splitting a character. `cut` is how many characters the cut removed.
 */
export function cutHistory(blocks: readonly { runId: string; text: string }[], chars: number): BoundedHistory & { cut: number } {
  let text = blocks.map((block) => block.text).join('\n\n');
  let kept = 0;
  if (text.length > chars) {
    kept = text.length - chars;
    if (isLowSurrogate(text.charCodeAt(kept))) kept += 1;
    text = `…${text.slice(kept)}`;
  }
  const messages = new Map<string, number>();
  let at = 0;
  for (const block of blocks) {
    const end = at + block.text.length;
    if (end > kept) messages.set(block.runId, (messages.get(block.runId) ?? 0) + 1);
    at = end + 2;
  }
  return { text, messages, cut: kept };
}

/** The bounded transcript alone (`boundedHistory`). */
export function conversationHistory(runs: readonly HarnessRun[], exclude?: string): string {
  return boundedHistory(runs, exclude).text;
}

/**
 * The run a lineage carries history from, or null. Only a conversation run of the same project
 * and the same thread counts: the pointer is the host's own, and this refuses anything else rather
 * than send another conversation's messages. A run that is gone, or that cannot be read (a damaged
 * file, or one a newer build wrote), carries nothing: the message is answered without it rather
 * than failed, because carrying is never required and a read of it never fails a send.
 */
export async function carriedRun(
  runs: Pick<RunService, 'get'>,
  input: { projectId: string; threadId: string; carriedFrom?: string },
): Promise<HarnessRun | null> {
  if (!input.carriedFrom) return null;
  let run: HarnessRun;
  try {
    run = await runs.get(input.carriedFrom);
  } catch {
    return null;
  }
  const scope = run.input as { projectId?: unknown; threadId?: unknown } | null;
  if (
    run.projectId !== input.projectId ||
    scope?.projectId !== input.projectId ||
    scope?.threadId !== input.threadId ||
    !CONVERSATION_CAPABILITY_IDS.includes(run.capabilityId)
  )
    return null;
  return run;
}
