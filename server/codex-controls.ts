/**
 * H02: Codex native steering, resume and fork for Work runs, plugged into the
 * H08 durable controls through `DurableControls.registerDriver('codex', …)`.
 *
 * Nothing here is a second control path. Every control still arrives through
 * `DurableControls.perform`, is judged by the run's route profile and leaves an
 * H08 receipt; this module only answers the Codex side of it:
 *
 * - `ask` is the Work runs' way into Codex. It asks the installed app-server what
 *   it offers, keeps the thread when there is a resume or fork to keep it for,
 *   and records the thread on the run (`Session.nativeThread`) before any turn is
 *   sent, so a Stop or a restart still leaves the id behind.
 * - `contract` is the Codex route contract as it stands for one run: the static
 *   declaration, amended only by what the Codex that served that run advertised.
 *   A run with no recorded thread answers by the static contract unchanged.
 * - `driver` steers the running turn (`turn/steer`), resumes a stopped run's
 *   thread (`thread/resume`, else a new thread and a sentence saying so), and
 *   forks a settled run's thread (`thread/fork`, else a refusal with the reason).
 */
import type { AdapterRouteContract, CommandAvailability } from '../shared/adapter-contract.js';
import type { NativeThreadRecord } from '../shared/codex-thread.js';
import type { Session } from '../shared/types.js';
import type { ControlPerformer } from '../shared/work-control.js';
import type { StartAnswer, WorkControlDriver } from './durable-controls.js';
import { ROUTE_CONTRACTS } from './harness/route-contract.js';
import type { CodexContinuity, CodexIntegration } from './integrations.js';
import { ApiError } from './paths.js';
import { now, type Store } from './store.js';

type AskInput = Parameters<CodexIntegration['askCodex']>[0] & {
  projectId?: string;
};
type ThreadOutcome = { record: NativeThreadRecord } | { error: unknown };

const native = (note: string): CommandAvailability => ({ support: 'native', note });
const host = (note: string): CommandAvailability => ({ support: 'host', note });
const unsupported = (note: string): CommandAvailability => ({ support: 'unsupported', note });

/**
 * The Codex contract for one run. Only a run whose thread was recorded, by a
 * Codex that was asked what it offers, changes anything; every other run
 * answers by the static declaration, word for word.
 */
export function codexWorkContract(session: Session | null): AdapterRouteContract {
  const base = ROUTE_CONTRACTS.codex;
  const thread = session?.nativeThread;
  if (!thread || thread.provider !== 'codex') return base;
  const { capabilities, kept } = thread;
  const steer = !capabilities.steer
    ? unsupported(
        'This Codex build does not take input into a running turn, so a message waits for the turn to end.',
      )
    : session!.state === 'working'
      ? native('Codex takes the message into the running turn (turn/steer).')
      : unsupported(
          'This run’s Codex turn is not running now, so a message waits for the next turn.',
        );
  const resume =
    capabilities.resume && kept
      ? native(
          'Codex continues this run’s kept thread in a new run (thread/resume); if it no longer has the thread, a new one is started and the run says so.',
        )
      : host(
          'This Codex build could not keep the thread for a resume, so Resume starts a new Codex thread with the same request and says so.',
        );
  const fork =
    capabilities.fork && kept
      ? native(
          'Codex branches this run’s kept thread (thread/fork) into a new task; the origin is not changed.',
        )
      : unsupported(
          capabilities.fork
            ? 'Codex was not asked to keep this run’s thread, so there is nothing for it to fork.'
            : 'This Codex build does not offer thread fork, so a Codex run cannot be forked.',
        );
  return Object.freeze({
    ...base,
    commands: Object.freeze({ ...base.commands, steer, resume, fork }),
  }) as AdapterRouteContract;
}

const performer = (record: { version: string; model: string | null }): ControlPerformer => ({
  kind: 'engine',
  engine: 'codex',
  version: record.version,
  model: record.model,
});

const plainError = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'The Codex request failed.';

export class CodexControls {
  /** Resumes waiting for their run to reach Codex, by the Work command the control derived. */
  private readonly pending = new Map<string, CodexContinuity>();
  private readonly waiters = new Map<string, (outcome: ThreadOutcome) => void>();
  constructor(
    private readonly store: Store,
    private readonly codex: CodexIntegration,
    /** How long a Resume waits to learn whether Codex continued the thread. */
    private readonly waitMs = 45_000,
  ) {}

  contract(session: Session | null): AdapterRouteContract {
    return codexWorkContract(session);
  }

  /**
   * The Work runs' entry to Codex. A team run, or a request that names no run,
   * is passed through untouched: continuity is for a person's own Work runs.
   */
  ask = async (input: AskInput) => {
    const projectId = input.projectId;
    const requestId = input.requestId;
    const session =
      projectId && requestId && !input.team
        ? this.store.state(projectId).sessions.find((item) => item.id === requestId)
        : undefined;
    if (!projectId || !session) return this.codex.askCodex(input);
    const key = session.receipt?.commandId ?? null;
    const continuity = this.continuityFor(projectId, session, key);
    try {
      return await this.codex.askCodex({
        ...input,
        continuity,
        onThread: async (record) => {
          if (key) this.settle(key, { record });
          await this.record(projectId, session.id, record);
        },
      });
    } catch (error) {
      if (key) this.settle(key, { error });
      throw error;
    } finally {
      if (key) this.pending.delete(key);
    }
  };

  /**
   * Which thread a run's request continues: the one a Resume named for it, else,
   * for the first Codex run of a forked task, the branch Codex made. Otherwise a
   * new thread, kept when this Codex can resume or fork it later.
   */
  private continuityFor(projectId: string, session: Session, key: string | null): CodexContinuity {
    const asked = key ? this.pending.get(key) : undefined;
    if (asked) return asked;
    const state = this.store.state(projectId);
    const branch = (state.controlReceipts ?? []).find(
      (receipt) =>
        receipt.control === 'fork' &&
        receipt.outcome === 'applied' &&
        receipt.result.taskId === session.taskId &&
        receipt.result.nativeThreadId,
    );
    const continued = state.sessions.some(
      (item) => item.taskId === session.taskId && item.id !== session.id && item.nativeThread,
    );
    if (branch?.result.nativeThreadId && !continued)
      return {
        resume: {
          threadId: branch.result.nativeThreadId,
          kept: true,
          origin: 'forked',
          branchOf:
            state.sessions.find((item) => item.id === branch.lineage?.originSessionId)?.nativeThread
              ?.id ?? null,
        },
      };
    return {};
  }

  private settle(key: string, outcome: ThreadOutcome) {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    waiter(outcome);
  }

  /** Written onto the run with its evidence, whatever state the run has reached since. */
  private async record(projectId: string, sessionId: string, record: NativeThreadRecord) {
    await this.store.locked(async () => {
      const state = this.store.state(projectId);
      const session = state.sessions.find((item) => item.id === sessionId);
      if (!session || session.nativeThread) return;
      session.nativeThread = structuredClone(record);
      const sentence =
        record.origin === 'resumed'
          ? `Codex continued thread ${record.from}.`
          : record.origin === 'forked'
            ? `Codex continued thread ${record.id}, its branch of ${record.from ?? 'an earlier thread'}.`
            : record.origin === 'restarted-fresh'
              ? record.detail!
              : `Codex started thread ${record.id}${record.kept ? ', kept so this run can be resumed' : ''}.`;
      session.engine.events += 1;
      session.log.push({
        time: now(),
        sentence,
        level: record.origin === 'started' ? 'technical' : 'plain',
      });
      await this.store.persist(state);
    });
  }

  driver(): WorkControlDriver {
    return {
      steer: async ({ session, text }) => {
        const answer = await this.codex.steerCodex(session.id, text);
        if (answer.state === 'rejected') return { state: 'rejected', detail: answer.detail };
        session.engine.events += 1;
        session.log.push({
          time: now(),
          sentence: 'Codex took your message into the running turn.',
          level: 'plain',
        });
        return { state: 'delivered', detail: answer.detail, performedBy: performer(answer) };
      },

      resume: async (context): Promise<StartAnswer> => {
        const thread = context.session.nativeThread;
        if (!thread)
          return {
            refused: {
              code: 'unsupported',
              reason: 'This run has no Codex thread recorded, so there is nothing to resume.',
            },
          };
        const key = context.workCommandId;
        this.pending.set(key, {
          resume: { threadId: thread.id, kept: thread.kept, origin: 'resumed' },
        });
        // Registered before the start, so an answer that arrives at once is not missed.
        const reached = new Promise<ThreadOutcome | null>((resolve) => {
          const timer = setTimeout(() => {
            this.waiters.delete(key);
            resolve(null);
          }, this.waitMs);
          timer.unref?.();
          this.waiters.set(key, (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
          });
        });
        let next: Session;
        try {
          next = await context.start();
        } catch (error) {
          this.pending.delete(key);
          this.settle(key, { error });
          throw error;
        }
        const outcome = await reached;
        if (!outcome)
          return {
            sessionId: next.id,
            detail: `Started ${next.id}; Codex had not yet said whether it continued thread ${thread.id}. The run records what it did.`,
            performedBy: { kind: 'diomedes' },
            support: 'host',
          };
        if ('error' in outcome)
          return {
            sessionId: next.id,
            detail: `Started ${next.id}, but it failed before Codex opened a thread: ${plainError(outcome.error)}`,
            performedBy: { kind: 'diomedes' },
            support: 'host',
          };
        const { record } = outcome;
        if (record.origin === 'resumed')
          return {
            sessionId: next.id,
            detail: `Codex continued thread ${record.id} in a new run (${next.id}).`,
            performedBy: performer(record),
            support: 'native',
            nativeThreadId: record.id,
          };
        return {
          sessionId: next.id,
          detail: `${record.detail ?? `Couldn't resume Codex thread ${thread.id}; started a new Codex thread.`} The new run is ${next.id}.`,
          performedBy: { kind: 'diomedes' },
          support: 'host',
          nativeThreadId: record.id,
        };
      },

      fork: async (context): Promise<StartAnswer> => {
        const thread = context.session.nativeThread;
        if (!thread?.kept)
          return {
            refused: {
              code: 'unsupported',
              reason: thread
                ? 'Codex was not asked to keep this run’s thread, so there is nothing for it to fork.'
                : 'This run has no Codex thread recorded, so there is nothing for Codex to fork.',
            },
          };
        let answer: Awaited<ReturnType<CodexIntegration['forkCodexThread']>>;
        try {
          answer = await this.codex.forkCodexThread({ threadId: thread.id });
        } catch (error) {
          // The process could not start, sign in or answer: nothing was forked.
          throw new ApiError(409, `Codex could not fork thread ${thread.id}: ${plainError(error)}`);
        }
        if (answer.state === 'refused')
          return { refused: { code: 'route-refused', reason: answer.reason } };
        return {
          detail: `Codex forked thread ${answer.from} into ${answer.threadId}; the new task’s first run continues it.`,
          performedBy: performer(answer),
          nativeThreadId: answer.threadId,
        };
      },
    };
  }
}
