/**
 * An engine's mid-turn question as a Diomedes Need (H05). A kept ACP
 * conversation asks here when the agent requests a permission this route can
 * honour once allowed, or presents a plan for approval
 * (`server/engines/acp-session.ts` decides which questions reach a person).
 *
 * The Need is the one durable record of the question and its answer, and it
 * lives where every other Need lives, so the person sees it with the rest. The
 * running turn waits on it in this process:
 *
 * - a person's go-ahead or decline is written to the Need and sent back to the
 *   engine, which then continues the same turn;
 * - nobody answering before `expiresAt` expires the Need, the engine is told
 *   the question was cancelled and the turn stops;
 * - a Stop, or the turn ending for any other reason, expires the Need the same way;
 * - after a restart no turn is waiting any more, so every open question is expired.
 *
 * Nothing here answers on a person's behalf. A remembered approval, a task-wide
 * allowance and the model reviewer never decide one of these: `allowForTask` is
 * refused, and no scope grant is consulted, because each question covers one
 * call or one plan in one running turn and nothing else.
 */
import type { Need } from '../../shared/types.js';
import { ApiError } from '../paths.js';
import { identifier, now, type Store } from '../store.js';
import type { EngineAsk, EngineAskAnswer } from './contract.js';

/** How long a question waits for a person before the turn is stopped safely. */
export const ENGINE_ASK_TIMEOUT_MS = 10 * 60_000;

const NAMES: Record<string, string> = { cursor: 'Cursor', devin: 'Devin' };

export interface EngineAskScope {
  projectId: string;
  runId: string;
  threadId: string;
  requestId: string;
}

export class EngineAskNeeds {
  private readonly waiting = new Map<string, (answer: EngineAskAnswer) => void>();
  private readonly timeoutMs: number;
  constructor(
    private readonly store: Store,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? ENGINE_ASK_TIMEOUT_MS;
  }

  /** Raise the Need and wait for its answer. Resolves; never rejects on a person's answer. */
  async ask(scope: EngineAskScope, ask: EngineAsk, signal: AbortSignal): Promise<EngineAskAnswer> {
    if (signal.aborted) return 'cancelled';
    const name = NAMES[ask.engine] ?? ask.engine;
    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + this.timeoutMs).toISOString();
    const need: Need = {
      id: identifier('need-'),
      sessionId: scope.runId,
      taskId: '',
      what:
        ask.kind === 'plan'
          ? `${name} asks you to approve its plan: ${ask.title}`
          : `${name} asks to ${ask.title.charAt(0).toLowerCase()}${ask.title.slice(1)}`,
      why:
        ask.kind === 'plan'
          ? `${name} presented this plan in the conversation and waits for your answer before it continues.`
          : `${name} needs your permission for this one ${ask.toolKind ?? 'tool'} call, which the conversation's read access does not cover.`,
      consequence:
        ask.kind === 'plan'
          ? `Go ahead lets ${name} continue with this plan in the same answer, still in ask mode with its tools denied. Decline tells ${name} no. Nobody answering by ${expiresAt} stops the answer.`
          : `Go ahead allows exactly this call once. Decline tells ${name} no and it continues without it. Nobody answering by ${expiresAt} stops the answer.`,
      files: [],
      state: 'open',
      createdAt,
      decidedAt: null,
      decidedFrom: '',
      allowForTask: false,
      engineAsk: {
        runId: scope.runId,
        threadId: scope.threadId,
        requestId: scope.requestId,
        engine: ask.engine,
        kind: ask.kind,
        ...(ask.toolKind ? { toolKind: ask.toolKind } : {}),
        expiresAt,
      },
    };
    const answer = new Promise<EngineAskAnswer>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => void this.close(scope.projectId, need.id, 'expired'), this.timeoutMs);
      timer.unref?.();
      const onAbort = () => void this.close(scope.projectId, need.id, 'cancelled');
      this.waiting.set(need.id, (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting.delete(need.id);
        resolve(value);
      });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await this.store.locked(async () => {
        const state = this.store.state(scope.projectId);
        state.needs.push(need);
        await this.store.persist(state);
      });
    } catch (error) {
      this.waiting.get(need.id)?.('cancelled');
      throw error;
    }
    if (signal.aborted) void this.close(scope.projectId, need.id, 'cancelled');
    return answer;
  }

  /** Expire an open question nobody answered, and tell the waiting turn. */
  private async close(projectId: string, needId: string, answer: 'expired' | 'cancelled') {
    const finish = this.waiting.get(needId);
    try {
      await this.store.locked(async () => {
        const state = this.store.state(projectId);
        const need = state.needs.find((item) => item.id === needId);
        if (!need || need.state !== 'open') return;
        need.state = 'expired';
        need.decidedAt = now();
        await this.store.persist(state);
      });
    } finally {
      finish?.(answer);
    }
  }

  /**
   * A person's answer. The Need records it first; then the running turn receives it.
   * The caller owns `Store.locked`, as the Needs route does for every resolution.
   */
  async resolve(
    projectId: string,
    needId: string,
    resolution: 'go-ahead' | 'declined',
    allowForTask: boolean,
  ): Promise<Need> {
    if (allowForTask)
      throw new ApiError(
        400,
        'This question covers one call in one answer. Answer it once; it cannot be allowed for the task.',
      );
    const finish = this.waiting.get(needId);
    const need = await (async () => {
      const state = this.store.state(projectId);
      const need = state.needs.find((item) => item.id === needId);
      if (!need?.engineAsk) throw new ApiError(404, 'This request was not found.');
      if (need.state !== 'open') throw new ApiError(409, 'This request has already been decided.');
      if (!finish || Date.parse(need.engineAsk.expiresAt) <= Date.now()) {
        // The turn that asked is gone (a restart) or its time ran out: nothing may be sent now.
        need.state = 'expired';
        need.decidedAt = now();
        await this.store.persist(state);
        throw new ApiError(
          409,
          'The answer this question belonged to has ended, so nothing was sent. Ask again in the conversation.',
          { code: 'approval_expired' },
        );
      }
      need.state = resolution;
      need.decidedAt = now();
      need.decidedFrom = 'desktop';
      await this.store.persist(state);
      return structuredClone(need);
    })();
    finish!(resolution);
    return need;
  }

  /** At startup no turn is waiting, so no open question can still be answered. */
  async expireOpen() {
    for (const project of await this.store.projects()) {
      await this.store.locked(async () => {
        const state = this.store.state(project.id);
        let changed = false;
        for (const need of state.needs)
          if (need.engineAsk && need.state === 'open' && !this.waiting.has(need.id)) {
            need.state = 'expired';
            need.decidedAt = now();
            changed = true;
          }
        if (changed) await this.store.persist(state);
      });
    }
  }
}
