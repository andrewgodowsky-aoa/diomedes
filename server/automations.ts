/**
 * Automations Milestone A: the occurrence store, admission and the overview.
 *
 *   <data>/workspaces/automations/<organizationId>.json   one organization's occurrences
 *
 * Three boundaries this module holds:
 *
 * 1. **One execution path.** Run once admits the weekly brief through the
 *    existing Task, Session and RunService path (the `weekly-brief` harness
 *    capability). This module records that a person asked and what admission
 *    made of it; it never starts a subprocess, calls a provider or writes a
 *    business file itself, and the legacy brief route converges onto it.
 *
 * 2. **References, never copies.** An occurrence holds the run's id and nothing
 *    of its state. Every label, result and link is projected on request from
 *    RunService and the project's records, so a restart rebuilds the same
 *    screen from the same records and nothing can read "Running" that is not.
 *
 * 3. **Nothing leaks past membership.** Every read and write starts with the
 *    workspace's own `mine()` check, so a non-member gets the same 404 an
 *    organization that does not exist gets: no title, count or result.
 *
 * Milestone A derived the definition from the active configuration, the output
 * binding and the pack's fixed `manual` trigger. Milestone B stores one
 * (`automation-definitions.ts`) because a schedule needs somewhere to live: a
 * scheduled slot is admitted by the same `admission` Run once uses, with a
 * `schedule` trigger whose command id is derived from the automation, the
 * definition revision and the slot, so there is still one execution path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AUTOMATION_DEFINITION_VERSION,
  AUTOMATION_RESULT_TEXT,
  AUTOMATIONS_CONTRACT_VERSION,
  OCCURRENCES_FILE_VERSION,
  SCHEDULE_BLOCKING_CODES,
  SCHEDULE_OUTCOME,
  automationLabel,
  automationSummary,
  briefAutomationId,
  byAttention,
  occurrenceResult,
  scheduleOutcome,
  type AttentionView,
  type AutomationAttention,
  type AutomationDefinition,
  type AutomationDetail,
  type AutomationList,
  type AutomationView,
  type ManualTrigger,
  type OccurrenceFacts,
  type OccurrenceView,
  type RunFacts,
  type RunOnceResult,
  type ScheduleAct,
  type ScheduleChangeResult,
  type ScheduleFacts,
  type ScheduleGrant,
  type ScheduleTrigger,
  type ScheduleView,
  type SetupFacts,
  type SetupIncompleteCode,
  type StoredOccurrences,
  type TriggerOccurrence,
} from '../shared/automations.js';
import {
  CATCH_UP_CHOICES,
  DEFAULT_CATCH_UP_MINUTES,
  checkSchedule,
  describeSchedule,
  localText,
  nextSlots,
  planDue,
  sameSchedule,
  slotText,
  type ScheduleSlot,
} from '../shared/automation-schedule.js';
import { canConfigureOrganization, isActiveMember } from '../shared/workspaces.js';
import type { OriginSnapshot } from '../shared/attribution.js';
import type { HarnessBudget } from '../shared/harness.js';
import { AutomationDefinitions, AutomationHost } from './automation-definitions.js';
import type { ConfigurationManifest } from '../shared/configuration.js';
import type { HarnessRun, Json } from '../shared/harness.js';
import type { Organization } from '../shared/workspaces.js';
import { IMPORT_MAX_TOTAL_BYTES } from '../shared/file-imports.js';
import { outputName } from '../shared/packs.js';
import { commandIdSchema, payloadDigest } from './command-admission.js';
import type { ConfigurationService } from './configuration.js';
import { checkExport, fileReferences } from './file-imports.js';
import { localHarnessPrincipal } from './harness/bridge.js';
import {
  COMPOSE_STEP,
  READ_STEP,
  SAVE_STEP,
  WAITING_FOR_DATA,
  WEEKLY_BRIEF,
  WEEKLY_BRIEF_BUDGET,
  weeklyBriefInstruction,
  type WeeklyBriefHost,
  type WeeklyBriefInput,
} from './harness/capabilities/weekly-brief.js';
import type { HarnessHost } from './harness/host.js';
import { HarnessError } from './harness/policy.js';
import { presentRun } from './harness/present.js';
import { absent, ApiError, relativeName } from './paths.js';
import { hash, jsonWrite, now, readJson, type Store } from './store.js';
import { approvedScope, outputFor } from './weekly-brief.js';
import type { WorkspaceService } from './workspaces.js';

const ORGANIZATION_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const PAGE_SIZE = 20;
const SETTLED: readonly HarnessRun['state'][] = [
  'completed',
  'failed',
  'cancelled',
  'reconcile_required',
  'waiting',
];

const hex = (value: string) => createHash('sha256').update(value).digest('hex');
/** Deterministic: the same command in the same organization always names the same occurrence. */
export const occurrenceIdFor = (organizationId: string, commandId: string) =>
  `O-${hex(`${organizationId}\n${commandId}`).slice(0, 32)}`;
/** Deterministic: recovery can find the run an interrupted admission may have created. */
export const runIdFor = (occurrenceId: string) => `R-brief-${hex(occurrenceId).slice(0, 24)}`;

const refuse = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, message, { code, ...extra });

// --- A2: the occurrence store --------------------------------------------------

/**
 * One file per organization, an in-memory map as the read path, and every
 * write through `jsonWrite`. Callers hold `store.locked()`, as the
 * configuration service's callers do. A file from another contract version is
 * refused and left alone: that organization's automations read as unavailable
 * and nothing overwrites it, while every other organization keeps working.
 */
export class AutomationOccurrences {
  private readonly files = new Map<string, TriggerOccurrence[]>();
  private readonly unreadable = new Set<string>();

  constructor(private readonly dataDir: string) {}

  private get root() {
    return path.join(this.dataDir, 'workspaces', 'automations');
  }

  private file(organizationId: string) {
    if (!ORGANIZATION_FILE.test(organizationId))
      throw refuse(404, 'That business workspace does not exist here.', 'organization_not_found');
    return path.join(this.root, `${organizationId}.json`);
  }

  async init(): Promise<void> {
    this.files.clear();
    this.unreadable.clear();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if (!absent(error)) throw error;
      names = [];
    }
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const organizationId = name.slice(0, -'.json'.length);
      let stored: StoredOccurrences | null;
      try {
        stored = await readJson<StoredOccurrences | null>(path.join(this.root, name), () => null);
      } catch {
        stored = null;
      }
      if (
        !stored ||
        (stored.v !== AUTOMATIONS_CONTRACT_VERSION && stored.v !== OCCURRENCES_FILE_VERSION) ||
        stored.organizationId !== organizationId ||
        !Array.isArray(stored.occurrences)
      ) {
        console.warn(`The automation record ${name} was written by another build and was left alone.`);
        this.unreadable.add(organizationId);
        continue;
      }
      this.files.set(organizationId, structuredClone([...stored.occurrences]));
    }
  }

  private readable(organizationId: string) {
    if (this.unreadable.has(organizationId))
      throw refuse(
        409,
        'This business’s automation record was written by another version of Diomedes, so it was left untouched.',
        'automation_record_unreadable',
      );
  }

  /** Whether this organization's file could not be read. Nothing is scheduled against it. */
  isUnreadable(organizationId: string) {
    return this.unreadable.has(organizationId);
  }

  /** Oldest first, as recorded. */
  list(organizationId: string): TriggerOccurrence[] {
    this.readable(organizationId);
    return structuredClone(this.files.get(organizationId) ?? []);
  }

  /**
   * The occurrence a command already produced, or undefined. The same command
   * with a different request is refused, matching `assertReplay`.
   */
  replay(organizationId: string, commandId: string, digest: string): TriggerOccurrence | undefined {
    const found = this.list(organizationId).find((item) => item.trigger.commandId === commandId);
    if (found && found.trigger.payloadDigest !== digest)
      throw refuse(409, 'This command already names a different request.', 'automation_command_conflict');
    return found;
  }

  /** Insert or replace one occurrence by id. Never removes one. */
  async put(occurrence: TriggerOccurrence): Promise<TriggerOccurrence> {
    const organizationId = occurrence.organizationId;
    const target = this.file(organizationId);
    const current = this.list(organizationId);
    const index = current.findIndex((item) => item.id === occurrence.id);
    const next =
      index === -1
        ? [...current, occurrence]
        : current.map((item, at) => (at === index ? occurrence : item));
    // Written as version 2 from Milestone B on: it may hold scheduled
    // occurrences, which a Milestone A build must refuse rather than misread.
    await jsonWrite(target, {
      v: OCCURRENCES_FILE_VERSION,
      organizationId,
      occurrences: next,
    } satisfies StoredOccurrences);
    this.files.set(organizationId, structuredClone(next));
    return structuredClone(occurrence);
  }

  /**
   * Settle every occurrence a stopped process left `admitting`, once, at
   * startup. It is admitted when its deterministic run exists in the pinned
   * project, and refused otherwise: no run means the write, a later step of
   * that run, cannot have happened. It is never re-admitted silently (A06).
   */
  async recover(
    findRun: (occurrence: TriggerOccurrence) => Promise<HarnessRun | null>,
  ): Promise<number> {
    let settled = 0;
    for (const organizationId of [...this.files.keys()]) {
      for (const occurrence of this.list(organizationId)) {
        if (occurrence.admission.state !== 'admitting') continue;
        const run = await findRun(occurrence);
        const at = now();
        await this.put({
          ...occurrence,
          admission:
            run && run.taskId && run.sessionId
              ? {
                  state: 'admitted',
                  runId: run.id,
                  taskId: run.taskId,
                  sessionId: run.sessionId,
                  at,
                }
              : {
                  state: 'refused',
                  code: 'interrupted_before_start',
                  reason: 'Diomedes stopped before this run started, so nothing was written.',
                  at,
                },
        });
        settled += 1;
      }
    }
    return settled;
  }
}

// --- A4: admission and the overview -------------------------------------------

/** What a refusal code tells a person to do next. Said once, beside the reason. */
function nextFor(code: string, scheduled = false): string {
  switch (code) {
    case 'project_busy':
      return scheduled
        ? 'The next slot runs as usual once the work in progress has finished.'
        : 'Wait for the work in progress to finish, then press Run once again.';
    case 'interrupted_before_start':
      return 'Press Run once again.';
    case 'source_changed':
    case 'output_project_changed':
      return 'Choose the files again, then run it again.';
    case 'no_output_project':
    case 'output_project_missing':
    case 'output_project_ownership_unresolved':
    case 'no_active_configuration':
    case 'brief_not_ready':
    case 'brief_no_destination':
      return 'Finish the setup under Change workspace, then press Run once again.';
    case 'missed_host_off':
      return 'Nothing to do: the next slot runs as usual while this computer is on.';
    case 'schedule_paused':
      return 'An owner or admin resumes the schedule to let slots start again.';
    case 'schedule_authority_lost':
    case 'schedule_owner_not_signed_in':
    case 'configuration_changed':
    case 'assigned_to_another_computer':
    case 'schedule_budget_unbounded':
      return 'An owner or admin turns the schedule on again after checking it.';
    default:
      return 'Fix what the reason names, then press Run once again.';
  }
}

/** The HTTP status the legacy brief route keeps for a refusal it used to throw. */
export function refusalStatus(code: string): number {
  if (code === 'sources_too_large') return 413;
  if (code === 'unsupported_source') return 415;
  return 409;
}

interface Setup {
  facts: SetupFacts;
  manifest: ConfigurationManifest | null;
  target: Awaited<ReturnType<WorkspaceService['briefTarget']>>;
}

/** Application authorship for what the scheduler records. No model is implied. */
const SCHEDULER_ORIGIN: OriginSnapshot = Object.freeze({
  protocolVersion: 1,
  mode: 'application',
  engine: null,
  model: { requested: null, reported: null, source: 'not-recorded' as const },
  executorId: 'diomedes:automation-scheduler',
});

/** The heartbeat is stale after this long: the screen then says "unknown", never "offline". */
export const HOST_STALE_MS = 5 * 60_000;

/**
 * A scheduled run must have a hard bound it cannot exceed on its own: finite
 * units and tool calls, and no model call, so nobody's money can be spent by a
 * clock (A22). The brief's procedure meets it; anything else is refused at
 * admission rather than trusted.
 */
export const scheduledBudgetBounded = (budget: HarnessBudget) =>
  budget.modelCalls === 0 &&
  Number.isSafeInteger(budget.units) &&
  Number.isSafeInteger(budget.toolCalls);

const compactInstant = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
/** Deterministic: the same automation, revision and slot always name the same command. */
export const scheduleCommandId = (revision: number, slot: string) =>
  `schedule:${revision}:${compactInstant(slot)}`;

interface ServiceOptions {
  /** The scheduler's clock. Tests inject one; production reads the system clock. */
  clock?: () => number;
  host?: AutomationHost;
}

type Gate = () => { code: string; reason: string } | null;

export class AutomationService {
  private readonly clock: () => number;
  readonly host: AutomationHost;
  /** Set by the scheduler while it runs. Without it the host reads as unknown. */
  schedulerRunning = false;

  constructor(
    private readonly store: Store,
    private readonly workspaces: WorkspaceService,
    private readonly configuration: ConfigurationService,
    private readonly harness: HarnessHost,
    private readonly occurrences: AutomationOccurrences,
    private readonly definitions: AutomationDefinitions = new AutomationDefinitions(store.dataDir),
    options: ServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.host = options.host ?? new AutomationHost(store.dataDir);
  }

  /** Now, from the injected clock, as ISO. Every schedule record uses it. */
  private at() {
    return new Date(this.clock()).toISOString();
  }

  /** What the weekly brief procedure reads from the host: nothing broader. */
  static host(workspaces: WorkspaceService, configuration: ConfigurationService): WeeklyBriefHost {
    return {
      manifest: (organizationId, revision, digest) =>
        configuration
          .history(organizationId)
          .find((item) => item.revision === revision && item.digest === digest) ?? null,
      target: (organizationId) => workspaces.briefTarget(organizationId),
    };
  }

  /** Load the files, then settle anything a stopped process left admitting. Call after the harness. */
  async init() {
    await this.occurrences.init();
    await this.definitions.init();
    await this.host.init(this.at());
    await this.store.locked(() => this.occurrences.recover((occurrence) => this.findRun(occurrence)));
  }

  private async findRun(occurrence: TriggerOccurrence): Promise<HarnessRun | null> {
    const runId = occurrence.admission.runId;
    if (!runId || !occurrence.target) return null;
    try {
      const run = await this.harness.runs.get(runId);
      return run.projectId === occurrence.target.projectId && run.capabilityId === WEEKLY_BRIEF.id
        ? run
        : null;
    } catch {
      return null;
    }
  }

  /** The one authority check: a non-member reads the same as nothing at all. */
  private organization(organizationId: string): Organization {
    this.workspaces.assertMine(organizationId);
    return this.workspaces.organization(organizationId)!;
  }

  private async setup(organizationId: string): Promise<Setup> {
    const target = await this.workspaces.briefTarget(organizationId);
    const manifest = this.configuration.active(organizationId);
    const incomplete = (code: SetupIncompleteCode, message: string): Setup => ({
      facts: { state: 'incomplete', code, message },
      manifest,
      target,
    });
    // The legacy route's order, so a refusal reads the same from either door.
    if (!target.ready) return incomplete(target.code.replace(/-/g, '_') as SetupIncompleteCode, target.message);
    if (!manifest)
      return incomplete(
        'no_active_configuration',
        'This business has no setup running, so there is nothing to prepare a brief from. Turn a setup on first.',
      );
    if (!manifest.readiness.ready)
      return incomplete(
        'brief_not_ready',
        'This setup is not ready, so no brief was prepared from it. Read its blocking problems first.',
      );
    if (!outputFor(manifest))
      return incomplete(
        'brief_no_destination',
        'This setup names nowhere to put the brief, so nothing was prepared.',
      );
    return { facts: { state: 'ready' }, manifest, target };
  }

  private projectState(projectId: string) {
    try {
      return this.store.state(projectId);
    } catch {
      return null;
    }
  }

  // --- the definition ---------------------------------------------------------

  /** The stored definition, or the unsaved default: no schedule, off. */
  private definition(organization: Organization): AutomationDefinition {
    const id = briefAutomationId(organization.id);
    return (
      this.definitions.get(organization.id, id) ?? {
        v: AUTOMATION_DEFINITION_VERSION,
        id,
        organizationId: organization.id,
        tenantId: organization.tenantId,
        kind: 'weekly-brief',
        generation: 0,
        revisions: [],
        control: { state: 'off' },
        acts: [],
        attention: [],
      }
    );
  }

  private hostState(): 'available' | 'unknown' {
    if (!this.schedulerRunning || !this.host.ready) return 'unknown';
    const age = this.clock() - Date.parse(this.host.current.lastSeenAt);
    return age >= 0 && age <= HOST_STALE_MS ? 'available' : 'unknown';
  }

  private assignedHere(definition: AutomationDefinition) {
    return (
      definition.control.state === 'off' ||
      (this.host.ready && definition.control.grant.hostId === this.host.current.hostId)
    );
  }

  /** The newest scheduled slot, when it was blocked after the current enable. */
  private scheduleBlocked(
    definition: AutomationDefinition,
    occurrences: readonly TriggerOccurrence[],
  ): ScheduleFacts['blocked'] {
    if (definition.control.state === 'off') return null;
    const newest = [...occurrences]
      .reverse()
      .find((item) => item.automationId === definition.id && item.trigger.kind === 'schedule');
    if (
      !newest ||
      newest.admission.state !== 'refused' ||
      !SCHEDULE_BLOCKING_CODES.includes(newest.admission.code) ||
      // A block recorded before (or at) the latest enable or resume was answered by it.
      newest.observedAt <= definition.control.since
    )
      return null;
    return { code: newest.admission.code, reason: newest.admission.reason };
  }

  private scheduleView(
    organization: Organization,
    definition: AutomationDefinition,
    setup: Setup | null,
    recorded: string | null,
  ): ScheduleView {
    const current = definition.revisions.at(-1) ?? null;
    const control = definition.control;
    const now = this.clock();
    const catchUp = current?.catchUpMinutes ?? DEFAULT_CATCH_UP_MINUTES;
    return {
      state: control.state,
      text: current ? describeSchedule(current.schedule) : null,
      current,
      generation: definition.generation,
      next: current
        ? nextSlots(current.schedule, now, 3).map((slot) => ({
            at: slot.at,
            text: slotText(current.schedule, slot),
          }))
        : [],
      catchUpText:
        catchUp === 0
          ? 'A run missed while this computer is off is recorded and never run later.'
          : `A run missed while this computer is off is recorded. Only the most recent one still runs, and only within ${
              catchUp % 60 === 0 ? `${catchUp / 60} hour${catchUp === 60 ? '' : 's'}` : `${catchUp} minutes`
            } of its time; older ones never run.`,
      since: control.state === 'off' ? null : control.since,
      by:
        control.state === 'paused'
          ? control.by
          : control.state === 'enabled'
            ? control.grant.personId
            : null,
      pauseReason: control.state === 'paused' ? control.reason : null,
      host: {
        name: this.host.ready ? this.host.current.name : 'This computer',
        lastSeenAt: this.host.ready ? this.host.current.lastSeenAt : null,
        state: this.hostState(),
        here: this.assignedHere(definition),
      },
      mayControl: canConfigureOrganization(this.workspaces.membershipOf(organization.id)),
      enableBlocked: !current
        ? 'Save a schedule first.'
        : setup && setup.facts.state === 'incomplete'
          ? setup.facts.message
          : null,
      recorded,
      acts: [...definition.acts].reverse().slice(0, 20),
    };
  }

  private attentionViews(definition: AutomationDefinition, name: string): AttentionView[] {
    return definition.attention
      .filter((item) => item.resolved === null)
      .map((item) => ({
        id: item.id,
        automationId: definition.id,
        automationName: name,
        organizationId: definition.organizationId,
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        count: item.occurrenceIds.length,
        openedAt: item.openedAt,
        lastSeenAt: item.lastSeenAt,
      }))
      .reverse();
  }

  private async occurrenceView(occurrence: TriggerOccurrence): Promise<{
    view: OccurrenceView;
    facts: OccurrenceFacts;
    /** When the run's source read finished, for the freshness line. */
    readAt: string | null;
  }> {
    const admission = occurrence.admission;
    let run: HarnessRun | null = null;
    if (admission.state === 'admitted') run = await this.findRun(occurrence);
    let runFacts: RunFacts | null = null;
    let runView: OccurrenceView['run'] = null;
    let readAt: string | null = null;
    if (run) {
      const state = this.projectState(run.projectId);
      const step = (id: string) => run!.steps.find((item) => item.intent.stepId === id);
      const read = step(READ_STEP);
      const readOutput =
        read?.state === 'succeeded' && read.output && typeof read.output === 'object'
          ? (read.output as { sources?: { path: string; sha: string }[]; missing?: string[] })
          : null;
      const save = step(SAVE_STEP);
      const saved =
        save?.state === 'succeeded' && save.output && typeof save.output === 'object'
          ? (save.output as { entryId?: string; path?: string })
          : null;
      const written =
        saved && typeof saved.entryId === 'string' && typeof saved.path === 'string'
          ? { entryId: saved.entryId, path: saved.path }
          : null;
      const change = written
        ? (state?.changes.find((item) => item.entryId === written.entryId)?.state ?? null)
        : null;
      if (readOutput) readAt = read?.endedAt ?? run.updatedAt;
      const missing = readOutput?.missing ?? [];
      const sources = (readOutput?.sources ?? []).map((source) => ({
        path: source.path,
        sha: source.sha,
      }));
      runFacts = {
        state: run.state,
        waitingApproval: run.steps.some((item) => item.state === 'waiting_approval'),
        uncertain: run.steps.some((item) => item.state === 'reconcile_required'),
        waitingForData: run.state === 'failed' && run.failure?.name === WAITING_FOR_DATA,
        missing,
        written,
        change,
      };
      const denominator = sources.length + missing.length;
      runView = {
        id: run.id,
        state: run.state,
        sentence: presentRun(run).sentence,
        taskId: run.taskId,
        sessionId: run.sessionId,
        taskExists: !!state?.tasks.some((task) => task.id === run!.taskId && !task.deletedAt),
        stages: [
          {
            name: 'Sources read',
            done: read?.state === 'succeeded' && missing.length === 0,
            detail: readOutput
              ? `${sources.length} of ${denominator} read`
              : read
                ? 'Reading'
                : 'Not started',
          },
          {
            name: 'Draft composed',
            done: step(COMPOSE_STEP)?.state === 'succeeded',
            detail:
              step(COMPOSE_STEP)?.state === 'succeeded'
                ? 'Every claim names its source'
                : missing.length > 0
                  ? 'Stopped: a source is missing'
                  : 'Not yet',
          },
          {
            name: 'Saved for review',
            done: written !== null,
            detail: written ? written.path : 'Nothing written',
          },
          {
            name: 'Reviewed by a person',
            done: change === 'kept' || change === 'undone',
            detail:
              change === 'kept'
                ? 'Kept'
                : change === 'undone'
                  ? 'Undone'
                  : written
                    ? 'Waiting for someone to keep or undo it'
                    : 'Nothing to review',
          },
        ],
        sources,
        missing,
        written,
        change,
        failure:
          run.state === 'failed' || run.state === 'cancelled'
            ? (run.failure?.message ?? run.cancelReason ?? null)
            : null,
        updatedAt: run.updatedAt,
      };
    }
    const facts: OccurrenceFacts = {
      admission: admission.state,
      refusalCode: admission.state === 'refused' ? admission.code : null,
      run: runFacts,
    };
    const result = occurrenceResult(facts);
    const trigger = occurrence.trigger;
    return {
      facts,
      readAt,
      view: {
        occurrence,
        run: runView,
        result,
        resultText: result ? AUTOMATION_RESULT_TEXT[result] : null,
        next:
          admission.state === 'refused' ? nextFor(admission.code, trigger.kind === 'schedule') : null,
        note: scheduleOutcome(occurrence),
        slotText:
          trigger.kind === 'schedule'
            ? `${localText(trigger.timezone, Date.parse(trigger.slot))}${
                trigger.shifted === 'gap' ? ' (moved by the clock change)' : ''
              }${trigger.late ? ' · caught up late' : ''}`
            : null,
      },
    };
  }

  private async automationView(
    organization: Organization,
    occurrences: TriggerOccurrence[],
  ): Promise<AutomationView> {
    const setup = await this.setup(organization.id);
    // What it is: the active setup, else the newest recorded one, so a setup
    // that was switched off still says what it was.
    const manifest = setup.manifest ?? this.configuration.history(organization.id)[0] ?? null;
    const output = manifest ? outputFor(manifest) : null;
    const scope = manifest ? approvedScope(manifest) : null;
    const binding = this.workspaces.outputBinding(organization.id);
    const definition = this.definition(organization);
    const newestFirst = [...occurrences].reverse();
    // Missed and skipped slots are the schedule's to show; the label reads the
    // newest occurrence that is a run or a person's press.
    const labelled = newestFirst.find(
      (item) => !(item.trigger.kind === 'schedule' && item.admission.state === 'refused'),
    );
    const latest = newestFirst[0] ? await this.occurrenceView(newestFirst[0]) : null;
    const forLabel =
      labelled === undefined
        ? null
        : labelled === newestFirst[0]
          ? latest
          : await this.occurrenceView(labelled);
    const hostState = this.hostState();
    const here = this.assignedHere(definition);
    const blocked = this.scheduleBlocked(definition, occurrences);
    const status = automationLabel({
      trigger: definition.control.state === 'off' ? 'manual' : 'schedule',
      setup: setup.facts,
      latest: forLabel?.facts ?? null,
      schedule: { state: definition.control.state, host: hostState, here, blocked },
    });
    let lastResult: AutomationView['lastResult'] = null;
    let freshness: AutomationView['freshness'] = null;
    for (const occurrence of newestFirst) {
      const shown =
        occurrence === newestFirst[0]
          ? latest!
          : occurrence === labelled && forLabel
            ? forLabel
            : await this.occurrenceView(occurrence);
      if (!lastResult && shown.view.result)
        lastResult = {
          result: shown.view.result,
          text: shown.view.note ?? AUTOMATION_RESULT_TEXT[shown.view.result],
          at:
            shown.view.run?.updatedAt ??
            (occurrence.admission.state === 'refused' ? occurrence.admission.at : occurrence.observedAt),
        };
      if (!freshness && shown.readAt && shown.view.run)
        freshness = {
          at: shown.readAt,
          sources: shown.view.run.sources,
          missing: shown.view.run.missing,
        };
      if (lastResult && freshness) break;
    }
    const projectId = setup.target.ready ? setup.target.projectId : null;
    const busy =
      projectId !== null &&
      !!this.projectState(projectId)?.sessions.some((session) =>
        ['queued', 'working', 'waiting'].includes(session.state),
      );
    const person = this.workspaces.currentPerson();
    const recorded =
      manifest?.proposal.unresolved.find((item) => item.kind === 'unsupported-schedule')?.what ?? null;
    const schedule = this.scheduleView(organization, definition, setup, recorded);
    const name = output ? outputName(output.label) : 'Weekly brief';
    const on = definition.control.state === 'enabled' && schedule.text;
    return {
      id: definition.id,
      kind: 'weekly-brief',
      name,
      purpose:
        'Reads the approved exports and drafts a brief in which every claim names the file it came from, then saves it for review.',
      trigger:
        definition.control.state !== 'off' && schedule.text
          ? { kind: 'schedule', text: schedule.text }
          : { kind: 'manual', text: 'Manual — not scheduled' },
      scheduleRecorded: definition.control.state === 'off' ? recorded : null,
      project: setup.target.ready
        ? { id: setup.target.projectId, name: setup.target.projectName }
        : null,
      owner: {
        personId: organization.createdBy,
        you: organization.createdBy === person.id,
        identitySource: organization.identitySource,
      },
      configuration: manifest
        ? {
            revision: manifest.revision,
            digest: manifest.digest,
            activatedAt: manifest.activatedAt,
          }
        : null,
      reads: { label: scope?.label ?? 'Approved exports', paths: [...(scope?.selection ?? [])] },
      writes: output
        ? {
            path: output.destination,
            projectName: setup.target.ready ? setup.target.projectName : (binding?.projectName ?? null),
          }
        : null,
      reviewedBy: output?.reviewedBy ?? null,
      doesNot: 'It sends nothing, and changes nothing but its own draft.',
      manual: [
        on
          ? 'It starts on its own only while this computer is on and Diomedes is running. Nobody is alerted while it is off: a missed run is recorded when it starts again.'
          : 'Someone presses Run once. Nothing starts on a schedule.',
        'The exports it reads are put into the project by hand, with Files > Import files.',
        'A person reads the draft and keeps or undoes it.',
        'Sharing the brief with anyone is done by hand.',
      ],
      status,
      lastResult,
      freshness,
      run:
        setup.facts.state !== 'ready'
          ? { allowed: false, reason: setup.facts.message }
          : status.label === 'running'
            ? { allowed: false, reason: 'It is running now.' }
            : busy
              ? {
                  allowed: false,
                  reason: `${setup.target.ready ? setup.target.projectName : 'The output project'} already has work in progress.`,
                }
              : { allowed: true, reason: null },
      usefulness: 'not-measured',
      occurrences: occurrences.length,
      latest: latest?.view ?? null,
      schedule,
      attention: this.attentionViews(definition, name),
    };
  }

  /** A view is listed once something about the brief exists for this business. */
  private listed(organizationId: string, occurrences: TriggerOccurrence[]) {
    return (
      occurrences.length > 0 ||
      this.configuration.history(organizationId).length > 0 ||
      this.definitions.list(organizationId).length > 0
    );
  }

  /** Whether the list's summary may count this row as starting on its own. */
  private static startsOnItsOwn(view: AutomationView) {
    return (
      view.schedule.state === 'enabled' &&
      view.schedule.host.state === 'available' &&
      view.schedule.host.here &&
      view.status.label !== 'needs-investigation' &&
      view.status.label !== 'setup-incomplete'
    );
  }

  async list(organizationId: string): Promise<AutomationList> {
    const organization = this.organization(organizationId);
    const occurrences = this.occurrences.list(organizationId);
    const automations = this.listed(organizationId, occurrences)
      ? [await this.automationView(organization, occurrences)]
      : [];
    return {
      v: AUTOMATIONS_CONTRACT_VERSION,
      organization: {
        id: organization.id,
        name: organization.name,
        identitySource: organization.identitySource,
      },
      observedAt: this.at(),
      summary: automationSummary(
        automations.map((item) => ({
          label: item.status.label,
          scheduled: AutomationService.startsOnItsOwn(item),
          attention: item.attention.length,
        })),
      ),
      automations: byAttention(automations),
    };
  }

  private known(organizationId: string, automationId: string) {
    if (automationId !== briefAutomationId(organizationId))
      throw refuse(404, 'That automation does not exist here.', 'automation_not_found');
  }

  async detail(organizationId: string, automationId: string, page = 1): Promise<AutomationDetail> {
    const organization = this.organization(organizationId);
    this.known(organizationId, automationId);
    const occurrences = this.occurrences.list(organizationId);
    if (!this.listed(organizationId, occurrences))
      throw refuse(404, 'That automation does not exist here.', 'automation_not_found');
    const current = Number.isSafeInteger(page) && page >= 1 ? page : 1;
    const newestFirst = [...occurrences].reverse();
    const slice = newestFirst.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
    const shown: OccurrenceView[] = [];
    for (const occurrence of slice) shown.push((await this.occurrenceView(occurrence)).view);
    return {
      v: AUTOMATIONS_CONTRACT_VERSION,
      observedAt: this.at(),
      automation: await this.automationView(organization, occurrences),
      occurrences: shown,
      page: current,
      pageSize: PAGE_SIZE,
      total: occurrences.length,
    };
  }

  // --- admission: one path for a press and a slot -------------------------------

  /**
   * Run once. The caller holds `store.locked()`, which `bridge.start` needs.
   *
   * In order: authority, replay by command identity, the pinned target and
   * configuration, the occurrence written as `admitting`, the run started
   * through the bridge with its deterministic id, and the occurrence settled
   * as `admitted` or `refused` in the server's own words.
   */
  async admit(
    organizationId: string,
    automationId: string,
    body: Record<string, unknown>,
  ): Promise<RunOnceResult> {
    const organization = this.organization(organizationId);
    this.known(organizationId, automationId);
    const command = commandIdSchema.safeParse(body.commandId);
    if (!command.success)
      throw refuse(400, 'Send a command id with each press of Run once.', 'invalid_command');
    const commandId = command.data;
    let chosen: { path: string; sha: string }[] | null = null;
    if (body.sources !== undefined) {
      // Choosing what a run reads replaces the configured scope: an owner or
      // admin choice, checked as editing that configuration is.
      this.configuration.assertMayConfigure(organizationId);
      chosen = fileReferences(body.sources).map((ref) => ({
        path: relativeName(ref.path),
        sha: ref.sha,
      }));
    }
    const digest = payloadDigest({
      automationId,
      sources: chosen,
      projectId: chosen ? String(body.projectId ?? '') : null,
    });
    const trigger: ManualTrigger = {
      kind: 'manual',
      commandId,
      payloadDigest: digest,
      requestedBy: this.workspaces.currentPerson().id,
    };
    const { occurrence, duplicate } = await this.admission(
      organization,
      automationId,
      trigger,
      chosen,
      body.projectId,
    );
    return {
      occurrence,
      duplicate,
      automation: await this.automationView(organization, this.occurrences.list(organizationId)),
    };
  }

  /**
   * The one admission. A manual press and a scheduled slot differ only in the
   * trigger they record and, for a slot, the `gate` that rechecks the recorded
   * authority first; everything after is the same code.
   */
  private async admission(
    organization: Organization,
    automationId: string,
    trigger: ManualTrigger | ScheduleTrigger,
    chosen: { path: string; sha: string }[] | null,
    projectId: unknown,
    gate?: Gate,
  ): Promise<{ occurrence: TriggerOccurrence; duplicate: boolean }> {
    const organizationId = organization.id;
    const replayed = this.occurrences.replay(organizationId, trigger.commandId, trigger.payloadDigest);
    const scheduled = trigger.kind === 'schedule';
    const result = (occurrence: TriggerOccurrence, duplicate: boolean) => ({ occurrence, duplicate });
    if (replayed) return result(replayed, true);

    const id = occurrenceIdFor(organizationId, trigger.commandId);
    const runId = runIdFor(id);
    const blocked = gate?.() ?? null;
    let setup: Setup | null = null;
    if (!blocked)
      try {
        setup = await this.setup(organizationId);
      } catch (error) {
        if (!scheduled || !(error instanceof ApiError)) throw error;
      }
    const base = {
      v: AUTOMATIONS_CONTRACT_VERSION,
      id,
      automationId,
      organizationId,
      tenantId: organization.tenantId,
      trigger,
      configuration: setup?.manifest
        ? { revision: setup.manifest.revision, digest: setup.manifest.digest }
        : null,
      target: setup?.target.ready
        ? { projectId: setup.target.projectId, projectName: setup.target.projectName }
        : null,
      sources: chosen,
      observedAt: this.at(),
    };
    const refused = async (code: string, reason: string, run?: string) =>
      result(
        await this.occurrences.put({
          ...base,
          admission: { state: 'refused', code, reason, at: this.at(), ...(run ? { runId: run } : {}) },
        }),
        false,
      );
    if (blocked) return refused(blocked.code, blocked.reason);
    if (!setup)
      return refused(
        'schedule_owner_not_signed_in',
        'The person signed in on this computer is not a member of this business, so nothing ran.',
      );
    if (setup.facts.state === 'incomplete' && !setup.target.ready)
      return refused(setup.facts.code, setup.facts.message);
    const target = setup.target as Extract<Setup['target'], { ready: true }>;
    if (chosen && projectId !== target.projectId)
      return refused(
        'output_project_changed',
        'The output project changed. Reopen the workspace and choose its files again.',
      );
    if (setup.facts.state === 'incomplete') return refused(setup.facts.code, setup.facts.message);
    const manifest = setup.manifest!;
    let destination: string;
    try {
      destination = relativeName(outputFor(manifest)!.destination);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return refused('invalid_destination', 'This setup names a destination outside the project.');
    }
    const scope = approvedScope(manifest);
    if (chosen) {
      if (!scope)
        return refused('no_approved_files', 'This setup does not accept approved export files.');
      if (chosen.some((ref) => ref.path.toLowerCase() === destination.toLowerCase()))
        return refused('destination_is_source', 'The brief destination cannot also be a source.');
      let total = 0;
      for (const ref of chosen) {
        const text = await this.store.current(target.projectId, ref.path);
        if (text === null || hash(text) !== ref.sha)
          return refused(
            'source_changed',
            `${ref.path} changed or disappeared. Choose it again before preparing the brief.`,
          );
        try {
          checkExport(ref.path, text);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return refused(error.status === 413 ? 'sources_too_large' : 'unsupported_source', error.message);
        }
        total += Buffer.byteLength(text);
      }
      if (total > IMPORT_MAX_TOTAL_BYTES)
        return refused('sources_too_large', 'Choose no more than 4 MB of exports for one brief.');
    }
    // The declared overlap rule: one active run per output project (A09). A
    // slot that finds it busy is skipped and recorded, never queued.
    const busySession = this.store
      .state(target.projectId)
      .sessions.find((session) => ['queued', 'working', 'waiting'].includes(session.state));
    if (busySession)
      return refused(
        'project_busy',
        scheduled
          ? this.ownRun(organizationId, busySession?.id ?? null)
            ? 'The previous run was still active, so this scheduled run did not start.'
            : 'The output project had other work in progress, so this scheduled run did not start.'
          : 'The output project already has work in progress.',
      );

    let occurrence = await this.occurrences.put({
      ...base,
      admission: { state: 'admitting', runId },
    });
    const input: WeeklyBriefInput = {
      v: 1,
      occurrenceId: id,
      organizationId,
      tenantId: target.tenantId,
      projectId: target.projectId,
      configuration: { revision: manifest.revision, digest: manifest.digest },
      destination,
      selection: [...(scope?.selection ?? [])],
      chosen,
      at: base.observedAt,
    };
    try {
      const session = await this.harness.bridge.start(
        target.projectId,
        null,
        WEEKLY_BRIEF.id,
        weeklyBriefInstruction({
          outputLabel: outputFor(manifest)?.label ?? null,
          organizationName: organization.name,
          chosen: chosen !== null,
        }),
        localHarnessPrincipal(target.projectId),
        undefined,
        { runId, input: input as unknown as Json },
      );
      occurrence = await this.occurrences.put({
        ...occurrence,
        admission: {
          state: 'admitted',
          runId,
          taskId: session.taskId,
          sessionId: session.id,
          at: this.at(),
        },
      });
      return result(occurrence, false);
    } catch (error) {
      // Whatever stopped the start, the occurrence is settled now rather than
      // left admitting, and a run the bridge created and then stopped is named.
      const created = await this.findRun(occurrence);
      const busy =
        error instanceof ApiError && error.status === 409 && /work in progress/.test(error.message);
      const code = busy
        ? 'project_busy'
        : error instanceof ApiError && typeof error.details.code === 'string'
          ? error.details.code
          : error instanceof HarnessError
            ? error.code
            : 'run_could_not_start';
      return refused(
        code,
        busy
          ? 'The output project already has work in progress.'
          : error instanceof Error
            ? error.message
            : 'The run could not start.',
        created?.id,
      );
    }
  }

  /** Whether a busy Session is this automation's own earlier run. */
  private ownRun(organizationId: string, sessionId: string | null) {
    if (!sessionId) return true;
    return this.occurrences
      .list(organizationId)
      .some((item) => item.admission.state === 'admitted' && item.admission.sessionId === sessionId);
  }

  /**
   * What a slot is checked against before anything else, in this order: the
   * computer it is assigned to, the recorded authority of whoever turned it on
   * (a removed member is never impersonated, A15), who is signed in here, the
   * setup it was turned on for (A13), and a hard spending bound (A22).
   */
  private scheduleGate(organization: Organization, definition: AutomationDefinition): Gate {
    return () => {
      const control = definition.control;
      if (control.state === 'off') return { code: 'schedule_paused', reason: 'The schedule is off.' };
      const grant = control.grant;
      if (!this.host.ready || grant.hostId !== this.host.current.hostId)
        return {
          code: 'assigned_to_another_computer',
          reason:
            'This schedule was turned on for another computer, so this one did not run it. An owner or admin can turn it on here instead.',
        };
      const membership = this.workspaces.membershipOf(organization.id, grant.personId);
      if (!canConfigureOrganization(membership))
        return {
          code: 'schedule_authority_lost',
          reason: `${grant.personId} turned this schedule on and is no longer ${
            isActiveMember(membership) ? 'an owner or administrator' : 'a member'
          } of ${organization.name}, so it did not run under their name. An owner or admin must turn it on again.`,
        };
      if (this.workspaces.currentPerson().id !== grant.personId)
        return {
          code: 'schedule_owner_not_signed_in',
          reason: `This computer is signed in as ${this.workspaces.currentPerson().id}, not ${grant.personId}, who turned the schedule on, so it did not run.`,
        };
      const active = this.configuration.active(organization.id);
      if (
        active &&
        (active.revision !== grant.configuration.revision || active.digest !== grant.configuration.digest)
      )
        return {
          code: 'configuration_changed',
          reason: `The setup changed from version ${grant.configuration.revision} to version ${active.revision} after the schedule was turned on, so it did not run. An owner or admin must check it and turn the schedule on again.`,
        };
      if (!scheduledBudgetBounded(WEEKLY_BRIEF_BUDGET))
        return {
          code: 'schedule_budget_unbounded',
          reason: 'This procedure has no hard spending bound, so it cannot start on a schedule.',
        };
      return null;
    };
  }

  private scheduleTrigger(
    definition: AutomationDefinition,
    slot: ScheduleSlot,
    late: boolean,
  ): ScheduleTrigger {
    const revision = definition.revisions.at(-1)!;
    const grant = definition.control.state === 'off' ? null : definition.control.grant;
    return {
      kind: 'schedule',
      commandId: scheduleCommandId(revision.revision, slot.at),
      payloadDigest: payloadDigest({
        automationId: definition.id,
        slot: slot.at,
        definitionRevision: revision.revision,
      }),
      slot: slot.at,
      local: slot.local,
      timezone: revision.schedule.timezone,
      shifted: slot.shifted,
      definitionRevision: revision.revision,
      enabledBy: grant?.personId ?? '',
      hostId: grant?.hostId ?? (this.host.ready ? this.host.current.hostId : ''),
      late,
    };
  }

  /**
   * Admit one due slot through the same admission as Run once. A duplicate
   * dispatch of the same slot replays to the same occurrence (A05).
   */
  async admitScheduled(
    organizationId: string,
    slot: ScheduleSlot,
    late: boolean,
  ): Promise<{ occurrence: TriggerOccurrence; duplicate: boolean } | null> {
    const organization = this.workspaces.organization(organizationId);
    if (!organization) return null;
    const definition = this.definitions.get(organizationId, briefAutomationId(organizationId));
    if (!definition || definition.control.state !== 'enabled' || !definition.revisions.length) return null;
    return this.admission(
      organization,
      definition.id,
      this.scheduleTrigger(definition, slot, late),
      null,
      undefined,
      this.scheduleGate(organization, definition),
    );
  }

  /** Record a slot that did not start, under the slot's own identity, so it is never started later. */
  private async recordSlot(
    organization: Organization,
    definition: AutomationDefinition,
    slot: ScheduleSlot,
    code: string,
    reason: string,
  ): Promise<TriggerOccurrence> {
    const trigger = this.scheduleTrigger(definition, slot, false);
    const existing = this.occurrences.replay(organization.id, trigger.commandId, trigger.payloadDigest);
    if (existing) return existing;
    const manifest = this.configuration.active(organization.id);
    const binding = this.workspaces.outputBinding(organization.id);
    return this.occurrences.put({
      v: AUTOMATIONS_CONTRACT_VERSION,
      id: occurrenceIdFor(organization.id, trigger.commandId),
      automationId: definition.id,
      organizationId: organization.id,
      tenantId: organization.tenantId,
      trigger,
      configuration: manifest ? { revision: manifest.revision, digest: manifest.digest } : null,
      target: binding ? { projectId: binding.projectId, projectName: binding.projectName } : null,
      sources: null,
      observedAt: this.at(),
      admission: { state: 'refused', code, reason, at: this.at() },
    });
  }

  // --- History and attention ------------------------------------------------------

  /** One History entry in the output project, when there is one. Evidence, never pruned. */
  private async history(organizationId: string, sentence: string, actor: 'you' | 'diomedes') {
    const binding = this.workspaces.outputBinding(organizationId);
    const state = binding ? this.projectState(binding.projectId) : null;
    if (!state) return;
    this.store.addEntry(state, {
      kind: 'automation',
      sentence,
      actor,
      ...(actor === 'diomedes' ? { origin: SCHEDULER_ORIGIN } : {}),
    });
    await this.store.persist(state);
  }

  /**
   * Raise, or add to, the one open item for an issue (A31). A second missed
   * slot joins the open "missed" item rather than making another, so a poll
   * or a week of missed days is one thing to read, not seven.
   */
  private raise(
    definition: AutomationDefinition,
    item: Pick<AutomationAttention, 'kind' | 'code' | 'title' | 'detail'>,
    occurrenceIds: readonly string[],
  ): { definition: AutomationDefinition; opened: AutomationAttention | null } {
    const at = this.at();
    const open = definition.attention.find(
      (existing) => existing.resolved === null && existing.kind === item.kind && existing.code === item.code,
    );
    if (open) {
      const ids = [...new Set([...open.occurrenceIds, ...occurrenceIds])];
      if (ids.length === open.occurrenceIds.length) return { definition, opened: null };
      return {
        definition: {
          ...definition,
          attention: definition.attention.map((existing) =>
            existing === open
              ? { ...existing, detail: item.detail, occurrenceIds: ids, lastSeenAt: at }
              : existing,
          ),
        },
        opened: null,
      };
    }
    const opened: AutomationAttention = {
      id: `N-${hex(`${definition.id}\n${item.kind}\n${item.code}\n${at}\n${occurrenceIds.join(',')}`).slice(0, 20)}`,
      ...item,
      occurrenceIds: [...occurrenceIds],
      openedAt: at,
      lastSeenAt: at,
      resolved: null,
    };
    return { definition: { ...definition, attention: [...definition.attention, opened] }, opened };
  }

  private resolveOpen(
    definition: AutomationDefinition,
    how: 'seen' | 'recovered' | 'addressed',
    by: string,
    which: (item: AutomationAttention) => boolean,
  ): AutomationDefinition {
    const at = this.at();
    return {
      ...definition,
      attention: definition.attention.map((item) =>
        item.resolved === null && which(item) ? { ...item, resolved: { at, how, by } } : item,
      ),
    };
  }

  // --- the pass ---------------------------------------------------------------------

  /** Write this computer's heartbeat. The scheduler calls it on every pass. */
  async beat() {
    await this.host.beat(this.at());
  }

  /**
   * One scheduler pass, with the store lock held: the same lock every route
   * takes, which is the atomic boundary between a pause and a due slot (A10).
   * For each enabled definition, slots that passed unseen are recorded as
   * missed, the most recent may still start within its catch-up window, and a
   * paused definition records its suppressed slots. Then scheduled runs that
   * failed raise one attention item each, and a later clean run clears them.
   */
  async schedulePass(): Promise<{ admitted: number; recorded: number }> {
    let admitted = 0;
    let recorded = 0;
    for (const organizationId of this.definitions.organizations()) {
      if (this.definitions.isUnreadable(organizationId) || this.occurrences.isUnreadable(organizationId))
        continue;
      const organization = this.workspaces.organization(organizationId);
      if (!organization) continue;
      for (const stored of this.definitions.list(organizationId)) {
        let definition = stored;
        const before = JSON.stringify(definition);
        const revision = definition.revisions.at(-1);
        const control = definition.control;
        if (revision && control.state !== 'off') {
          const mine = this.occurrences
            .list(organizationId)
            .filter((item) => item.automationId === definition.id && item.trigger.kind === 'schedule');
          const covered = new Set(mine.map((item) => (item.trigger as ScheduleTrigger).slot));
          const newestCovered = Math.max(
            0,
            ...mine.map((item) => Date.parse((item.trigger as ScheduleTrigger).slot)),
          );
          const plan = planDue({
            schedule: revision.schedule,
            afterMs: Math.max(Date.parse(control.since), Date.parse(revision.at), newestCovered),
            nowMs: this.clock(),
            covered,
            catchUpMinutes: revision.catchUpMinutes,
          });
          if (control.state === 'paused') {
            for (const slot of [...plan.missed, ...(plan.due ? [plan.due] : [])]) {
              await this.recordSlot(
                organization,
                definition,
                slot,
                'schedule_paused',
                `The schedule was paused (${control.reason}), so the ${slotText(revision.schedule, slot)} run did not start.`,
              );
              recorded += 1;
            }
          } else {
            const seen = this.host.previousSeenAt;
            const missedIds: string[] = [];
            for (const slot of plan.missed) {
              const occurrence = await this.recordSlot(
                organization,
                definition,
                slot,
                'missed_host_off',
                `Diomedes was not running on this computer at ${slotText(revision.schedule, slot)} (it was off, asleep or closed), so this run did not start${
                  seen ? `. This computer was last seen ${localText(revision.schedule.timezone, Date.parse(seen))}` : ''
                }.`,
              );
              missedIds.push(occurrence.id);
              recorded += 1;
            }
            if (missedIds.length) {
              const raised = this.raise(
                definition,
                {
                  kind: 'missed',
                  code: 'missed_host_off',
                  title: 'Missed while this computer was off',
                  detail: `The ${slotText(revision.schedule, plan.missed.at(-1)!)} run did not start because Diomedes was not running. Missed runs are recorded, never run later.`,
                },
                missedIds,
              );
              definition = raised.definition;
              if (raised.opened)
                await this.history(
                  organizationId,
                  `Diomedes recorded ${missedIds.length === 1 ? 'a missed run' : `${missedIds.length} missed runs`} of the weekly brief: this computer was off.`,
                  'diomedes',
                );
            }
            if (plan.due) {
              const outcome = await this.admitScheduled(organizationId, plan.due, plan.late);
              if (outcome && !outcome.duplicate) {
                const occurrence = outcome.occurrence;
                const when = slotText(revision.schedule, plan.due);
                if (occurrence.admission.state === 'admitted') {
                  admitted += 1;
                  await this.history(
                    organizationId,
                    `Diomedes started the weekly brief on schedule for ${when}${plan.late ? ', late, because this computer was off at that time' : ''}.`,
                    'diomedes',
                  );
                } else if (occurrence.admission.state === 'refused') {
                  recorded += 1;
                  const code = occurrence.admission.code;
                  const title =
                    SCHEDULE_OUTCOME[code] ?? 'A scheduled run could not start';
                  const raised = this.raise(
                    definition,
                    {
                      kind: code === 'project_busy' ? 'skipped' : 'blocked',
                      code,
                      title,
                      detail: occurrence.admission.reason,
                    },
                    [occurrence.id],
                  );
                  definition = raised.definition;
                  if (raised.opened)
                    await this.history(
                      organizationId,
                      `Diomedes did not start the weekly brief for ${when}: ${occurrence.admission.reason}`,
                      'diomedes',
                    );
                }
              }
            }
          }
        }
        definition = await this.followScheduledRuns(organizationId, definition);
        if (JSON.stringify(definition) !== before) await this.definitions.put(definition);
      }
    }
    return { admitted, recorded };
  }

  /**
   * Scheduled runs that ended badly raise one item per issue; the newest
   * scheduled run that completed clears the failed and skipped items before it.
   */
  private async followScheduledRuns(
    organizationId: string,
    start: AutomationDefinition,
  ): Promise<AutomationDefinition> {
    let definition = start;
    const scheduled = this.occurrences
      .list(organizationId)
      .filter(
        (item) =>
          item.automationId === definition.id &&
          item.trigger.kind === 'schedule' &&
          item.admission.state === 'admitted',
      )
      .slice(-10);
    const known = new Set(definition.attention.flatMap((item) => item.occurrenceIds));
    let clean: TriggerOccurrence | null = null;
    for (const occurrence of scheduled) {
      const run = await this.findRun(occurrence);
      if (!run) continue;
      if (run.state === 'completed') {
        clean = occurrence;
        continue;
      }
      if (known.has(occurrence.id)) continue;
      const waiting = run.state === 'failed' && run.failure?.name === WAITING_FOR_DATA;
      const unsure = run.state === 'reconcile_required' || run.steps.some((step) => step.state === 'reconcile_required');
      if (!waiting && !unsure && run.state !== 'failed') continue;
      const code = waiting ? 'waiting_for_data' : unsure ? 'needs_check' : 'run_failed';
      const raised = this.raise(
        definition,
        {
          kind: 'failed',
          code,
          title: waiting
            ? 'A scheduled run is waiting for data'
            : unsure
              ? 'A scheduled run needs a check'
              : 'A scheduled run failed',
          detail: waiting
            ? `${run.failure?.message ?? 'A source could not be read'} Nothing was written.`
            : unsure
              ? 'It may have done something it could not confirm. Check it before it runs again.'
              : (run.failure?.message ?? 'It stopped because something went wrong.'),
        },
        [occurrence.id],
      );
      definition = raised.definition;
      if (raised.opened)
        await this.history(organizationId, `Diomedes: ${raised.opened.title.toLowerCase()} (the weekly brief).`, 'diomedes');
    }
    if (clean) {
      const after = clean.observedAt;
      definition = this.resolveOpen(
        definition,
        'recovered',
        'diomedes',
        // Missed runs stay until a person has seen them: a later clean run does
        // not make the days that never ran disappear. Blocks are answered by an
        // owner turning the schedule on again.
        (item) => item.lastSeenAt <= after && (item.kind === 'failed' || item.kind === 'skipped'),
      );
    }
    return definition;
  }

  // --- schedule controls ------------------------------------------------------------

  /**
   * Edit, turn on, pause, resume or turn off a schedule. Each is an owner or
   * admin's explicit, recorded act; nothing else changes a schedule, and a
   * setup answer, a pack or a restart never turns one on (A01, A12). The
   * change is refused when the definition moved since the person read it (A24).
   */
  async changeSchedule(
    organizationId: string,
    automationId: string,
    body: Record<string, unknown>,
  ): Promise<ScheduleChangeResult> {
    const organization = this.organization(organizationId);
    this.known(organizationId, automationId);
    this.configuration.assertMayConfigure(organizationId);
    const person = this.workspaces.currentPerson().id;
    const current = this.definition(organization);
    if (body.expectedGeneration !== current.generation)
      throw refuse(
        409,
        'Someone changed this schedule since it was read. Read it again, then decide.',
        'automation_definition_conflict',
      );
    const revision = current.revisions.at(-1) ?? null;
    const at = this.at();
    const control = current.control;
    let next: AutomationDefinition;
    let act: ScheduleAct;
    let sentence: string;
    let inFlight: OccurrenceView | null = null;
    const grant = async (): Promise<ScheduleGrant> => {
      const setup = await this.setup(organizationId);
      if (setup.facts.state === 'incomplete')
        throw refuse(409, setup.facts.message, 'setup_incomplete');
      return {
        personId: person,
        at,
        configuration: { revision: setup.manifest!.revision, digest: setup.manifest!.digest },
        hostId: this.host.current.hostId,
      };
    };
    const description = (text: string | null) => text ?? 'no schedule';
    switch (body.action) {
      case 'edit': {
        const checked = checkSchedule(body.schedule);
        if (!checked.ok) throw refuse(400, checked.message, 'invalid_schedule');
        const catchUpMinutes =
          body.catchUpMinutes === undefined
            ? (revision?.catchUpMinutes ?? DEFAULT_CATCH_UP_MINUTES)
            : body.catchUpMinutes;
        if (!CATCH_UP_CHOICES.includes(catchUpMinutes as (typeof CATCH_UP_CHOICES)[number]))
          throw refuse(400, 'Choose how long a missed run may still catch up.', 'invalid_catch_up');
        if (
          revision &&
          sameSchedule(revision.schedule, checked.schedule) &&
          revision.catchUpMinutes === catchUpMinutes
        )
          throw refuse(409, 'That is already the schedule.', 'schedule_unchanged');
        const added = {
          revision: (revision?.revision ?? 0) + 1,
          at,
          by: person,
          schedule: checked.schedule,
          catchUpMinutes: catchUpMinutes as number,
        };
        act = { at, by: person, kind: 'edited', revision: added.revision };
        next = { ...current, revisions: [...current.revisions, added] };
        sentence = `You changed the weekly brief’s schedule to ${describeSchedule(added.schedule)} (revision ${added.revision})${
          control.state === 'enabled' ? '. It stays on, from the next slot' : ''
        }.`;
        break;
      }
      case 'enable': {
        if (control.state !== 'off')
          throw refuse(409, 'The schedule is already on. Resume it if it is paused.', 'schedule_not_off');
        if (!revision) throw refuse(409, 'Save a schedule before turning it on.', 'no_schedule');
        const granted = await grant();
        next = { ...current, control: { state: 'enabled', since: at, grant: granted } };
        next = this.resolveOpen(next, 'addressed', person, (item) => item.kind === 'blocked');
        act = { at, by: person, kind: 'enabled', revision: revision.revision };
        sentence = `You turned on the weekly brief’s schedule: ${describeSchedule(revision.schedule)}. It starts on its own on this computer.`;
        break;
      }
      case 'pause': {
        if (control.state !== 'enabled') throw refuse(409, 'Only a schedule that is on can be paused.', 'schedule_not_on');
        const reason =
          typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : 'Paused by you';
        const running = await this.inFlight(organizationId, current.id);
        inFlight = running;
        next = { ...current, control: { state: 'paused', since: at, by: person, reason, grant: control.grant } };
        act = {
          at,
          by: person,
          kind: 'paused',
          revision: revision?.revision ?? 0,
          reason,
          inFlight: running?.occurrence.id ?? null,
        };
        sentence = `You paused the weekly brief’s schedule: ${reason}.${
          running ? ' The run already started keeps going; pausing does not stop it.' : ''
        }`;
        break;
      }
      case 'resume': {
        if (control.state !== 'paused') throw refuse(409, 'Only a paused schedule can be resumed.', 'schedule_not_paused');
        // Resuming is an explicit act with fresh authority, checked now: the
        // pause's old grant is not revived (A12).
        const granted = await grant();
        next = { ...current, control: { state: 'enabled', since: at, grant: granted } };
        next = this.resolveOpen(next, 'addressed', person, (item) => item.kind === 'blocked');
        act = { at, by: person, kind: 'resumed', revision: revision?.revision ?? 0 };
        sentence = `You resumed the weekly brief’s schedule: ${description(revision ? describeSchedule(revision.schedule) : null)}. Slots from now on start on their own; the paused ones do not.`;
        break;
      }
      case 'turn-off': {
        if (control.state === 'off') throw refuse(409, 'The schedule is already off.', 'schedule_not_on');
        next = { ...current, control: { state: 'off' } };
        next = this.resolveOpen(next, 'addressed', person, (item) => item.kind === 'blocked');
        act = { at, by: person, kind: 'turned-off', revision: revision?.revision ?? 0 };
        sentence = 'You turned off the weekly brief’s schedule. It runs only when someone presses Run once.';
        break;
      }
      default:
        throw refuse(400, 'Choose edit, enable, pause, resume or turn-off.', 'invalid_schedule_action');
    }
    next = { ...next, generation: current.generation + 1, acts: [...current.acts, act] };
    await this.definitions.put(next);
    await this.history(organizationId, sentence, 'you');
    return {
      automation: await this.automationView(organization, this.occurrences.list(organizationId)),
      act,
      inFlight,
    };
  }

  /** The scheduled occurrence whose run is still going, for a pause's receipt. */
  private async inFlight(organizationId: string, automationId: string): Promise<OccurrenceView | null> {
    const newest = [...this.occurrences.list(organizationId)]
      .reverse()
      .find(
        (item) =>
          item.automationId === automationId &&
          item.trigger.kind === 'schedule' &&
          item.admission.state === 'admitted',
      );
    if (!newest) return null;
    const run = await this.findRun(newest);
    if (!run || !['queued', 'running', 'waiting'].includes(run.state)) return null;
    return (await this.occurrenceView(newest)).view;
  }

  /** Any active member may say they have seen an item. It changes no authority. */
  async markSeen(organizationId: string, automationId: string, attentionId: string) {
    const organization = this.organization(organizationId);
    this.known(organizationId, automationId);
    const current = this.definition(organization);
    const item = current.attention.find((existing) => existing.id === attentionId);
    if (!item) throw refuse(404, 'That item does not exist here.', 'attention_not_found');
    if (item.resolved === null) {
      const next = this.resolveOpen(
        current,
        'seen',
        this.workspaces.currentPerson().id,
        (existing) => existing.id === attentionId,
      );
      await this.definitions.put({ ...next, generation: current.generation + 1 });
    }
    return this.automationView(organization, this.occurrences.list(organizationId));
  }

  /**
   * The open attention items for a project's Needs you, from every business
   * this person is an active member of whose output project it is.
   */
  attentionForProject(projectId: string): AttentionView[] {
    const out: AttentionView[] = [];
    for (const organizationId of this.definitions.organizations()) {
      if (this.definitions.isUnreadable(organizationId)) continue;
      if (!isActiveMember(this.workspaces.membershipOf(organizationId))) continue;
      if (this.workspaces.outputBinding(organizationId)?.projectId !== projectId) continue;
      const manifest = this.configuration.active(organizationId);
      const output = manifest ? outputFor(manifest) : null;
      for (const definition of this.definitions.list(organizationId))
        out.push(...this.attentionViews(definition, output ? outputName(output.label) : 'Weekly brief'));
    }
    return out;
  }

  /**
   * Wait, outside the store lock, for an admitted run to stop moving, then for
   * its mirror to reach the project. Only the legacy brief route needs this:
   * its client expects the draft in the response. The Automations screen
   * follows the run through the state events instead.
   */
  async settled(occurrence: TriggerOccurrence, timeoutMs = 30_000): Promise<HarnessRun | null> {
    if (occurrence.admission.state !== 'admitted') return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.harness.runs.get(occurrence.admission.runId);
      if (SETTLED.includes(run.state)) {
        await this.harness.bridge.flush();
        return run;
      }
      if (Date.now() >= deadline) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
