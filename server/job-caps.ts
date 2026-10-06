/**
 * Parent-job check-ins on this computer: which tier each job runs under, the
 * amount it checks in at, and every one-job raise a person agreed to.
 *
 *   <data>/job-caps.json   one record per job that spent, or was raised
 *
 * A job is one thing a person asked for: a conversation message, a Work turn or
 * a team wake, named by the request id the host already gives it. Its cap is its
 * check-in amount, pinned when the job is first scoped (the business's own setting,
 * else the staff default, else `JOB_CHECK_IN_CREDITS`), or the raise recorded
 * against that exact job, whichever is higher. A step whose reservation would
 * cross the cap is refused before anything is sent, so a job is never cut off
 * mid-call: it finishes the step in progress and checks in. What the job has
 * spent is not kept here: the spend
 * ledger (`server/spend-exposure.ts`) tags every hold with the job's key and
 * counts it, so there is one record of money, not two.
 *
 * Four rules carry the weight.
 *
 * 1. **The tier is the host's.** It is read from the job's thread (its
 *    WorkStyle, else the Settings default) through `tierOf`, and pinned the
 *    first time the job is scoped. A request body never names a cap, and
 *    changing the thread's style later does not re-tier a job already running.
 * 2. **A raise is one job's.** It is recorded against one job key, with who
 *    agreed and why, and nothing else reads it. There is no standing raise, no
 *    per-thread raise and no per-person raise.
 * 3. **A raise is finite.** `oneJobRaise` decides the number: exactly one more
 *    check-in amount on top of the cap the job reached, never a figure the client sent.
 * 4. **An armed raise is single-use.** A team wake's run id is minted by the
 *    host after the person agreed, so the wake arms its raise on the member's
 *    thread for the next job scoped there, and that job consumes it. The wake
 *    route disarms it again if nothing started, and it expires on its own.
 *
 * Writes run one at a time and swap into memory only once the file on disk
 * says the same, as the spend ledger's do.
 */
import path from 'node:path';
import {
  defaultCheckIn,
  isJobTier,
  micro,
  type JobTier,
  type MicroUsd,
} from '../shared/managed-usage.js';
import { oneJobRaise } from '../shared/job-caps.js';
import { digest } from './harness/policy.js';
import { ApiError } from './paths.js';
import { jsonWrite, readJson } from './store.js';
import type { JobScope } from './spend-exposure.js';

/** How long an armed team-wake raise waits for its job before it lapses. */
export const ARMED_RAISE_MS = 10 * 60_000;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export interface JobRaise {
  /** The cap this job may now spend up to. Finite. */
  toMicroUsd: MicroUsd;
  /**
   * `estimate`: agreed before sending. `overrun`: agreed at a check-in, after an earlier job stopped at
   * its amount (the stored word predates check-ins).
   */
  basis: 'estimate' | 'overrun';
  /** What the host found the job needs (the refused step's total), or null when there was none. */
  neededMicroUsd: MicroUsd | null;
  recordedAt: string;
  /** Who agreed. On this computer, the person signed in to it. */
  by: string;
  /** For an overrun, the job that stopped. */
  fromJobId: string | null;
}

export interface JobStop {
  usedMicroUsd: MicroUsd;
  capMicroUsd: MicroUsd;
  neededMicroUsd: MicroUsd;
  at: string;
  /** The job a later "Go over this once" raised in this stop's name. Single-use. */
  consumedBy: string | null;
}

export interface JobRecord {
  projectId: string;
  jobId: string;
  /** The spend ledger's tag for this job. */
  key: string;
  tier: JobTier;
  /** The check-in amount this job was pinned with. Absent on a record written before check-ins. */
  baseMicroUsd?: MicroUsd;
  /**
   * The id the account service meters this job under, when it is metered there. A job that continues
   * one that stopped at its check-in carries the earlier job's id, so the service's count and its raised
   * cap carry over (`meteredAs`). Absent for a job the account service never saw.
   */
  meteredJobId?: string;
  pinnedAt: string;
  raise: JobRaise | null;
  stop: JobStop | null;
}

interface ArmedRaise {
  ticket: string;
  projectId: string;
  threadId: string;
  raise: Omit<JobRaise, 'recordedAt'>;
  armedAt: number;
}

interface StoredJobs {
  v: 1;
  jobs: JobRecord[];
}

/** A job's tag in the spend ledger: bounded, and the same for the same project and request. */
export const jobKeyFor = (projectId: string, jobId: string): string =>
  `job-${digest({ projectId, jobId }).slice(0, 40)}`;

const refuse = (status: number, message: string, code: string) =>
  new ApiError(status, message, { code });

function jobIdOf(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value))
    throw refuse(400, 'Provide the job this is for.', 'invalid_job');
  return value;
}

function readRecord(value: unknown): JobRecord {
  const bad = () => new Error('The job caps file cannot be trusted, so nothing was loaded.');
  if (!value || typeof value !== 'object') throw bad();
  const row = value as Record<string, unknown>;
  if (
    typeof row.projectId !== 'string' ||
    typeof row.jobId !== 'string' ||
    !JOB_ID.test(row.jobId) ||
    row.key !== jobKeyFor(row.projectId, row.jobId) ||
    !isJobTier(row.tier) ||
    typeof row.pinnedAt !== 'string'
  )
    throw bad();
  const money = (amount: unknown) => {
    try {
      return micro(amount as number);
    } catch {
      throw bad();
    }
  };
  let raise: JobRaise | null = null;
  if (row.raise !== null && row.raise !== undefined) {
    const r = row.raise as Record<string, unknown>;
    if ((r.basis !== 'estimate' && r.basis !== 'overrun') || typeof r.recordedAt !== 'string' || typeof r.by !== 'string')
      throw bad();
    raise = {
      toMicroUsd: money(r.toMicroUsd),
      basis: r.basis,
      neededMicroUsd: r.neededMicroUsd === null ? null : money(r.neededMicroUsd),
      recordedAt: r.recordedAt,
      by: r.by,
      fromJobId: typeof r.fromJobId === 'string' ? r.fromJobId : null,
    };
  }
  let stop: JobStop | null = null;
  if (row.stop !== null && row.stop !== undefined) {
    const s = row.stop as Record<string, unknown>;
    if (typeof s.at !== 'string') throw bad();
    stop = {
      usedMicroUsd: money(s.usedMicroUsd),
      capMicroUsd: money(s.capMicroUsd),
      neededMicroUsd: money(s.neededMicroUsd),
      at: s.at,
      consumedBy: typeof s.consumedBy === 'string' ? s.consumedBy : null,
    };
  }
  return {
    projectId: row.projectId,
    jobId: row.jobId,
    key: row.key as string,
    tier: row.tier,
    ...(row.baseMicroUsd === undefined || row.baseMicroUsd === null ? {} : { baseMicroUsd: money(row.baseMicroUsd) }),
    ...(typeof row.meteredJobId === 'string' && JOB_ID.test(row.meteredJobId) ? { meteredJobId: row.meteredJobId } : {}),
    pinnedAt: row.pinnedAt,
    raise,
    stop,
  };
}

/** A job's cap: the check-in amount it was pinned with, or the one raise recorded for it, whichever is higher. */
export function capOf(record: Pick<JobRecord, 'tier' | 'raise'> & { baseMicroUsd?: MicroUsd }): MicroUsd {
  const base = record.baseMicroUsd ?? defaultCheckIn(record.tier);
  return record.raise && record.raise.toMicroUsd > base ? record.raise.toMicroUsd : base;
}

export interface JobCapsOptions {
  /** The tier a job on this thread runs under: its WorkStyle, else the Settings default. */
  tierOf(projectId: string, threadId: string | null): JobTier;
  /**
   * The check-in amount a new job of this tier in this project's account runs to: the business's own
   * setting, else the staff default, else the code default, as the account service resolved it. Absent,
   * or when it cannot say, the code default.
   */
  checkInOf?(projectId: string, tier: JobTier): MicroUsd | null | Promise<MicroUsd | null>;
  clock?: () => Date;
}

export class JobCaps {
  private jobs = new Map<string, JobRecord>();
  private armed: ArmedRaise[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly clock: () => Date;

  constructor(
    private readonly dataDir: string,
    private readonly options: JobCapsOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  private get file() {
    return path.join(this.dataDir, 'job-caps.json');
  }

  async init(): Promise<void> {
    const stored = await readJson<StoredJobs>(this.file, () => ({ v: 1, jobs: [] }));
    if (!stored || stored.v !== 1 || !Array.isArray(stored.jobs))
      throw new Error('The job caps file was written by another build and was left alone.');
    const jobs = new Map<string, JobRecord>();
    for (const row of stored.jobs) {
      const record = readRecord(row);
      jobs.set(record.key, record);
    }
    this.jobs = jobs;
  }

  private now() {
    return this.clock().toISOString();
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Write the next set of records, then swap it in. A failed write changes nothing. */
  private async commit(record: JobRecord): Promise<JobRecord> {
    const next = new Map(this.jobs);
    next.set(record.key, record);
    await jsonWrite(this.file, { v: 1, jobs: [...next.values()] } satisfies StoredJobs);
    this.jobs = next;
    return structuredClone(record);
  }

  get(projectId: string, jobId: string): JobRecord | null {
    const record = this.jobs.get(jobKeyFor(projectId, jobIdOf(jobId)));
    return record ? structuredClone(record) : null;
  }

  /** The tier a new job on this thread would run under, from the host's own records. */
  tierFor(projectId: string, threadId: string | null): JobTier {
    return this.options.tierOf(projectId, threadId);
  }

  /** The check-in amount a job of this tier runs to in this project's account. */
  async checkInFor(projectId: string, tier: JobTier): Promise<MicroUsd> {
    try {
      return (await this.options.checkInOf?.(projectId, tier)) ?? defaultCheckIn(tier);
    } catch {
      // The account service not answering never stops a job from being scoped: the code default applies.
      return defaultCheckIn(tier);
    }
  }

  /**
   * The job the account service meters this one under, when an earlier job already named one. A job that
   * continues one that stopped at its check-in (Keep going) is metered under that job, so the service's cap
   * and its count carry over. Follows the chain of continued jobs to the first that was metered, so a second
   * Keep going names the first job. Null when nothing was metered before: the job is its own.
   */
  meteredAs(projectId: string, jobId: string): string | null {
    let current = jobId;
    let named: string | null = null;
    for (let hops = 0; hops < 64; hops++) {
      const record = this.jobs.get(jobKeyFor(projectId, current));
      if (!record) break;
      if (record.meteredJobId) named = record.meteredJobId;
      const from = record.raise?.basis === 'overrun' ? record.raise.fromJobId : null;
      if (!from) break;
      // The earlier job's name is the one the service knows first; keep walking to find it.
      current = from;
    }
    return named;
  }

  /**
   * Record the id the account service meters this job under. The first one recorded stays: a job is
   * metered under one id for its whole life, however many times it is admitted.
   */
  noteMetered(projectId: string, jobId: string, meteredJobId: string): Promise<void> {
    const id = jobIdOf(jobId);
    const to = jobIdOf(meteredJobId);
    return this.exclusive(async () => {
      const record = this.jobs.get(jobKeyFor(projectId, id));
      if (!record || record.meteredJobId) return;
      await this.commit({ ...record, meteredJobId: to });
    });
  }

  /**
   * The account service stopped this job at its check-in before the local ledger did, which is the same
   * stop: nothing of the step was sent. Record it at the cap this job holds, so Keep going can answer it.
   * A stop already open stays as it is.
   */
  noteManagedStop(projectId: string, jobId: string): Promise<void> {
    const id = jobIdOf(jobId);
    return this.exclusive(async () => {
      const record = this.jobs.get(jobKeyFor(projectId, id));
      if (!record || (record.stop && record.stop.consumedBy === null)) return;
      const cap = capOf(record);
      await this.commit({ ...record, stop: { usedMicroUsd: cap, capMicroUsd: cap, neededMicroUsd: micro(0), at: this.now(), consumedBy: null } });
    });
  }

  private liveArmed(projectId: string, threadId: string): ArmedRaise | undefined {
    const now = this.clock().getTime();
    this.armed = this.armed.filter((item) => now - item.armedAt < ARMED_RAISE_MS);
    return this.armed.find((item) => item.projectId === projectId && item.threadId === threadId);
  }

  /**
   * The scope a job spends under. The first call pins the job's tier from its
   * thread and writes the record, so the tier cannot move under a running job;
   * a raise armed on the thread is consumed by this job and no other. A caller
   * that names the tier pins that one instead: a Nectovia role under another
   * lead runs at its own tier, under its own job. A job already pinned at
   * another tier is refused, never moved.
   */
  scope(projectId: string, jobId: string, threadId: string | null, tier?: JobTier): Promise<JobScope & { tier: JobTier }> {
    const id = jobIdOf(jobId);
    return this.exclusive(async () => {
      const key = jobKeyFor(projectId, id);
      let record = this.jobs.get(key);
      if (record && tier !== undefined && record.tier !== tier)
        throw refuse(409, 'This job already runs under another tier.', 'job_tier_pinned');
      if (!record) {
        const armed = threadId ? this.liveArmed(projectId, threadId) : undefined;
        if (armed) this.armed = this.armed.filter((item) => item !== armed);
        const at = this.now();
        const pinned = tier ?? this.options.tierOf(projectId, threadId);
        record = await this.commit({
          projectId,
          jobId: id,
          key,
          tier: pinned,
          baseMicroUsd: await this.checkInFor(projectId, pinned),
          pinnedAt: at,
          raise: armed ? { ...armed.raise, recordedAt: at } : null,
          stop: null,
        });
      }
      return { id: record.key, capMicroUsd: capOf(record), tier: record.tier };
    });
  }

  /**
   * Record the one raise a person agreed to before sending, for this job only:
   * one more check-in amount (`oneJobRaise`), so the job runs twice as far before
   * it first asks. Asking again for the same job returns the raise already
   * recorded; a job that already holds a raise is never raised twice by the same
   * agreement.
   */
  async raiseBeforeSend(input: {
    projectId: string;
    jobId: string;
    threadId: string | null;
    neededMicroUsd: MicroUsd | null;
    by: string;
  }): Promise<JobRecord> {
    const id = jobIdOf(input.jobId);
    if (!OWNER_ID.test(input.by)) throw refuse(400, 'Say who agreed to go over.', 'invalid_request');
    return this.exclusive(async () => {
      const key = jobKeyFor(input.projectId, id);
      const existing = this.jobs.get(key);
      if (existing?.raise) return structuredClone(existing);
      const tier = existing?.tier ?? this.options.tierOf(input.projectId, input.threadId);
      const at = this.now();
      const amount = await this.checkInFor(input.projectId, tier);
      const base = existing?.baseMicroUsd ?? amount;
      const cap = existing ? capOf(existing) : base;
      return this.commit({
        projectId: input.projectId,
        jobId: id,
        key,
        tier,
        baseMicroUsd: base,
        pinnedAt: existing?.pinnedAt ?? at,
        raise: {
          toMicroUsd: oneJobRaise({ capMicroUsd: cap, checkInMicroUsd: amount }),
          basis: 'estimate',
          neededMicroUsd: input.neededMicroUsd,
          recordedAt: at,
          by: input.by,
          fromJobId: null,
        },
        stop: existing?.stop ?? null,
      });
    });
  }

  /**
   * Record, for a new job, the raise a person agreed to at a check-in (Keep going),
   * after an earlier job stopped at its amount. The earlier job's recorded stop
   * decides what it is raised from: the cap it reached plus exactly one more
   * check-in amount. A stop raises exactly one later job: a second attempt in
   * its name is refused. The new job continues the earlier one (`meteredAs`).
   */
  async raiseAfterStop(input: {
    projectId: string;
    jobId: string;
    fromJobId: string;
    threadId: string | null;
    by: string;
  }): Promise<JobRecord> {
    const id = jobIdOf(input.jobId);
    const from = jobIdOf(input.fromJobId);
    if (!OWNER_ID.test(input.by)) throw refuse(400, 'Say who agreed to go over.', 'invalid_request');
    if (id === from) throw refuse(409, 'A stopped job is not resumed; the message is sent again as a new job.', 'job_stopped');
    return this.exclusive(async () => {
      const stopped = this.jobs.get(jobKeyFor(input.projectId, from));
      if (!stopped?.stop)
        throw refuse(409, 'That job did not stop at its cap, so there is nothing to go over.', 'no_stop');
      const key = jobKeyFor(input.projectId, id);
      if (stopped.stop.consumedBy !== null) {
        const existing = this.jobs.get(key);
        if (stopped.stop.consumedBy === id && existing) return structuredClone(existing);
        throw refuse(409, 'Going over for that stop was already agreed for another job.', 'stop_consumed');
      }
      if (this.jobs.get(key))
        throw refuse(409, 'That job has already started, so its cap is not raised now.', 'job_started');
      const at = this.now();
      const tier = stopped.tier;
      const amount = await this.checkInFor(input.projectId, tier);
      const record = await this.commit({
        projectId: input.projectId,
        jobId: id,
        key,
        tier,
        baseMicroUsd: stopped.baseMicroUsd ?? amount,
        pinnedAt: at,
        raise: {
          toMicroUsd: oneJobRaise({ capMicroUsd: stopped.stop.capMicroUsd, checkInMicroUsd: amount }),
          basis: 'overrun',
          neededMicroUsd: stopped.stop.neededMicroUsd,
          recordedAt: at,
          by: input.by,
          fromJobId: from,
        },
        stop: null,
      });
      await this.commit({ ...stopped, stop: { ...stopped.stop, consumedBy: id } });
      return record;
    });
  }

  /**
   * Keep going on a job that stopped at its check-in and is resumed as itself, which is how work
   * nobody was watching continues (it pauses into Needs you rather than being sent again). The same
   * job's cap rises by exactly one more check-in amount, recorded, and its open stop is closed.
   * Answering a stop that was already answered returns the record unchanged: a second press adds nothing.
   */
  async raiseInPlace(input: { projectId: string; jobId: string; by: string }): Promise<JobRecord> {
    const id = jobIdOf(input.jobId);
    if (!OWNER_ID.test(input.by)) throw refuse(400, 'Say who agreed to keep going.', 'invalid_request');
    return this.exclusive(async () => {
      const record = this.jobs.get(jobKeyFor(input.projectId, id));
      if (!record?.stop) throw refuse(409, 'That job did not stop to check in, so there is nothing to keep going.', 'no_stop');
      if (record.stop.consumedBy !== null) return structuredClone(record);
      const amount = await this.checkInFor(input.projectId, record.tier);
      return this.commit({
        ...record,
        raise: {
          toMicroUsd: oneJobRaise({ capMicroUsd: record.stop.capMicroUsd, checkInMicroUsd: amount }),
          basis: 'overrun',
          neededMicroUsd: record.stop.neededMicroUsd,
          recordedAt: this.now(),
          by: input.by,
          fromJobId: null,
        },
        stop: { ...record.stop, consumedBy: id },
      });
    });
  }

  /** Record that a job stopped at a step boundary because its next step would pass its cap. */
  noteStop(key: string, stop: Omit<JobStop, 'at' | 'consumedBy'>): Promise<void> {
    return this.exclusive(async () => {
      const record = this.jobs.get(key);
      if (!record) return;
      await this.commit({ ...record, stop: { ...stop, at: this.now(), consumedBy: null } });
    });
  }

  /**
   * Arm a raise for the next job scoped on a thread, for a request whose job id
   * the host has not minted yet (a team wake). Returns the ticket that disarms it.
   */
  async arm(input: {
    projectId: string;
    threadId: string;
    neededMicroUsd: MicroUsd | null;
    by: string;
  }): Promise<string> {
    if (!OWNER_ID.test(input.by)) throw refuse(400, 'Say who agreed to go over.', 'invalid_request');
    const tier = this.options.tierOf(input.projectId, input.threadId);
    const amount = await this.checkInFor(input.projectId, tier);
    const ticket = `armed-${digest({ ...input, at: this.clock().getTime(), n: Math.random() }).slice(0, 24)}`;
    this.liveArmed(input.projectId, input.threadId);
    this.armed = this.armed.filter(
      (item) => !(item.projectId === input.projectId && item.threadId === input.threadId),
    );
    this.armed.push({
      ticket,
      projectId: input.projectId,
      threadId: input.threadId,
      armedAt: this.clock().getTime(),
      raise: {
        toMicroUsd: oneJobRaise({ capMicroUsd: amount, checkInMicroUsd: amount }),
        basis: 'estimate',
        neededMicroUsd: input.neededMicroUsd,
        by: input.by,
        fromJobId: null,
      },
    });
    return ticket;
  }

  /** Withdraw an armed raise that no job consumed. */
  disarm(ticket: string): void {
    this.armed = this.armed.filter((item) => item.ticket !== ticket);
  }
}
