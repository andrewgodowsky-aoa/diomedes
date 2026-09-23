/**
 * The job-cap decisions a send can stop for, and the calls behind them.
 *
 * Before a send: the host estimates the job. When the estimate warns, nothing
 * is sent until the person chooses: the tier above (the thread's style changes
 * and the job is estimated again), going over this once (a one-job raise
 * recorded against the exact command id the message is then sent under), or
 * Cancel. After a job stops at its cap: the same two choices, and either one
 * sends the message again as a new job.
 *
 * Nothing here sizes a cap or a raise. The client names the job and the
 * message; every number comes back from the host.
 */
import type { CapWarningCopy, JobEstimateView, JobStatusView, JobTier } from '../shared/job-caps';
import type { Mode } from '../shared/types';
import { api, ApiError } from './api';

export type CapChoice = 'upgrade' | 'over' | 'cancel';

export interface CapPrompt {
  kind: 'before' | 'overrun';
  copy: CapWarningCopy;
}

/** What a gate decided: send (under this command id, when one was issued for a raise), or not. */
export type GateResult = { send: true; commandId?: string } | { send: false };

export interface BeforeSendDeps {
  /** The host's estimate for this message. Null when it could not be read: the send decides. */
  estimate(): Promise<JobEstimateView | null>;
  ask(prompt: CapPrompt): Promise<CapChoice>;
  /** Move the thread to a higher tier. The next estimate reads it from the thread. */
  upgrade(tier: JobTier): Promise<void>;
  /** Record the one-job raise for exactly this command id. */
  goOver(commandId: string): Promise<void>;
  mint(): string;
}

/**
 * The pre-send gate. A higher tier is estimated again, and asked about again
 * if it still warns; the tier above Thorough does not exist, so the loop ends.
 */
export async function beforeSend(deps: BeforeSendDeps): Promise<GateResult> {
  for (let round = 0; round < 3; round++) {
    const view = await deps.estimate();
    if (!view?.warning) return { send: true };
    const choice = await deps.ask({ kind: 'before', copy: view.warning });
    if (choice === 'cancel') return { send: false };
    if (choice === 'over') {
      const commandId = deps.mint();
      await deps.goOver(commandId);
      return { send: true, commandId };
    }
    if (!view.warning.upgrade) return { send: false };
    await deps.upgrade(view.warning.upgrade.tier);
  }
  return { send: false };
}

/**
 * The same gate for a team wake, whose job id the host mints during the wake:
 * going over is agreed by waking through `wake-over-cap`, which arms the raise
 * on the member's thread for that wake's job.
 */
export async function beforeWake(
  deps: Pick<BeforeSendDeps, 'estimate' | 'ask' | 'upgrade'>,
): Promise<'wake' | 'over' | 'cancel'> {
  const gate = await beforeSend({ ...deps, goOver: async () => undefined, mint: () => 'over' });
  return !gate.send ? 'cancel' : gate.commandId ? 'over' : 'wake';
}

export interface OverrunDeps {
  status(): Promise<JobStatusView | null>;
  ask(prompt: CapPrompt): Promise<CapChoice>;
  upgrade(tier: JobTier): Promise<void>;
  /** Record, for this new command id, the raise the stop allows. */
  goOverAfter(commandId: string): Promise<void>;
  mint(): string;
}

/**
 * After a job stopped at its cap. `send` with no command id means send the
 * message again as a new job through the whole send path, estimate included.
 */
export async function afterStop(deps: OverrunDeps): Promise<GateResult> {
  const status = await deps.status();
  if (!status?.overrun) return { send: false };
  const choice = await deps.ask({ kind: 'overrun', copy: status.overrun });
  if (choice === 'cancel') return { send: false };
  if (choice === 'upgrade') {
    if (!status.overrun.upgrade) return { send: false };
    await deps.upgrade(status.overrun.upgrade.tier);
    return { send: true };
  }
  const commandId = deps.mint();
  await deps.goOverAfter(commandId);
  return { send: true, commandId };
}

/** The person chose Cancel (or Stop) at a job-cap question: nothing was sent, and the words are theirs. */
export class CapDeclined extends Error {
  constructor() {
    super('Nothing was sent.');
    this.name = 'CapDeclined';
  }
}

/** A send the host refused because its job reached its cap at a step boundary. */
export const isJobCapStop = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 402 && error.data.code === 'job_cap_reached';

// --- the calls --------------------------------------------------------------------------

const threadPath = (projectId: string, threadId: string) =>
  `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

export interface Draft {
  text: string;
  mode: Mode;
  sources: { path: string; sha: string }[];
}

/** The estimate, or null when it cannot be read: the send itself then says what is wrong. */
export const estimateMessage = (projectId: string, threadId: string, draft: Draft) =>
  api<JobEstimateView>(`${threadPath(projectId, threadId)}/job-estimate`, 'POST', draft).catch(() => null);

export const goOverBeforeSend = (projectId: string, threadId: string, commandId: string, draft: Draft) =>
  api<JobStatusView>(
    `${threadPath(projectId, threadId)}/jobs/${encodeURIComponent(commandId)}/go-over`,
    'POST',
    draft,
  ).then(() => undefined);

export const goOverAfterStop = (projectId: string, threadId: string, commandId: string, fromJobId: string) =>
  api<JobStatusView>(
    `${threadPath(projectId, threadId)}/jobs/${encodeURIComponent(commandId)}/go-over`,
    'POST',
    { fromJobId },
  ).then(() => undefined);

export const jobStatus = (projectId: string, jobId: string) =>
  api<JobStatusView>(`/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`).catch(() => null);

export const setThreadTier = (projectId: string, threadId: string, tier: JobTier) =>
  api(threadPath(projectId, threadId), 'PUT', { workStyle: tier }).then(() => undefined);

const memberPath = (projectId: string, slotId: string) =>
  `/projects/${encodeURIComponent(projectId)}/team/members/${encodeURIComponent(slotId)}`;

export const estimateWake = (projectId: string, slotId: string) =>
  api<JobEstimateView>(`${memberPath(projectId, slotId)}/job-estimate`, 'POST', {}).catch(() => null);

export const wakeOverCap = (projectId: string, slotId: string) =>
  api(`${memberPath(projectId, slotId)}/wake-over-cap`, 'POST', {});
