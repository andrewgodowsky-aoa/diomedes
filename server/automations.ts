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
 * The definition is derived, not stored (work order section 4): Milestone A
 * reads it from the active configuration, the output binding and the pack's
 * fixed `manual` trigger. A stored definition arrives with a schedule in B.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AUTOMATION_RESULT_TEXT,
  AUTOMATIONS_CONTRACT_VERSION,
  automationLabel,
  automationSummary,
  briefAutomationId,
  byAttention,
  occurrenceResult,
  type AutomationDetail,
  type AutomationList,
  type AutomationView,
  type OccurrenceFacts,
  type OccurrenceView,
  type RunFacts,
  type RunOnceResult,
  type SetupFacts,
  type SetupIncompleteCode,
  type StoredOccurrences,
  type TriggerOccurrence,
} from '../shared/automations.js';
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
        stored.v !== AUTOMATIONS_CONTRACT_VERSION ||
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
    await jsonWrite(target, {
      v: AUTOMATIONS_CONTRACT_VERSION,
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
function nextFor(code: string): string {
  switch (code) {
    case 'project_busy':
      return 'Wait for the work in progress to finish, then press Run once again.';
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

export class AutomationService {
  constructor(
    private readonly store: Store,
    private readonly workspaces: WorkspaceService,
    private readonly configuration: ConfigurationService,
    private readonly harness: HarnessHost,
    private readonly occurrences: AutomationOccurrences,
  ) {}

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
    return {
      facts,
      readAt,
      view: {
        occurrence,
        run: runView,
        result,
        resultText: result ? AUTOMATION_RESULT_TEXT[result] : null,
        next: admission.state === 'refused' ? nextFor(admission.code) : null,
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
    const newestFirst = [...occurrences].reverse();
    const latest = newestFirst[0] ? await this.occurrenceView(newestFirst[0]) : null;
    const status = automationLabel({
      trigger: 'manual',
      setup: setup.facts,
      latest: latest?.facts ?? null,
    });
    let lastResult: AutomationView['lastResult'] = null;
    let freshness: AutomationView['freshness'] = null;
    for (const occurrence of newestFirst) {
      const shown = occurrence === newestFirst[0] ? latest! : await this.occurrenceView(occurrence);
      if (!lastResult && shown.view.result)
        lastResult = {
          result: shown.view.result,
          text: AUTOMATION_RESULT_TEXT[shown.view.result],
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
    const schedule = manifest?.proposal.unresolved.find((item) => item.kind === 'unsupported-schedule');
    return {
      id: briefAutomationId(organization.id),
      kind: 'weekly-brief',
      name: output ? outputName(output.label) : 'Weekly brief',
      purpose:
        'Reads the approved exports and drafts a brief in which every claim names the file it came from, then saves it for review.',
      trigger: { kind: 'manual', text: 'Manual — not scheduled' },
      scheduleRecorded: schedule?.what ?? null,
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
        'Someone presses Run once. Nothing starts on a schedule.',
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
    };
  }

  /** A view is listed once something about the brief exists for this business. */
  private listed(organizationId: string, occurrences: TriggerOccurrence[]) {
    return occurrences.length > 0 || this.configuration.history(organizationId).length > 0;
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
      observedAt: now(),
      summary: automationSummary(automations.map((item) => item.status)),
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
      observedAt: now(),
      automation: await this.automationView(organization, occurrences),
      occurrences: shown,
      page: current,
      pageSize: PAGE_SIZE,
      total: occurrences.length,
    };
  }

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
    const replayed = this.occurrences.replay(organizationId, commandId, digest);
    const result = async (occurrence: TriggerOccurrence, duplicate: boolean) => ({
      occurrence,
      duplicate,
      automation: await this.automationView(organization, this.occurrences.list(organizationId)),
    });
    if (replayed) return result(replayed, true);

    const id = occurrenceIdFor(organizationId, commandId);
    const runId = runIdFor(id);
    const setup = await this.setup(organizationId);
    const base = {
      v: AUTOMATIONS_CONTRACT_VERSION,
      id,
      automationId,
      organizationId,
      tenantId: organization.tenantId,
      trigger: {
        kind: 'manual' as const,
        commandId,
        payloadDigest: digest,
        requestedBy: this.workspaces.currentPerson().id,
      },
      configuration: setup.manifest
        ? { revision: setup.manifest.revision, digest: setup.manifest.digest }
        : null,
      target: setup.target.ready
        ? { projectId: setup.target.projectId, projectName: setup.target.projectName }
        : null,
      sources: chosen,
      observedAt: now(),
    };
    const refused = async (code: string, reason: string, run?: string) =>
      result(
        await this.occurrences.put({
          ...base,
          admission: { state: 'refused', code, reason, at: now(), ...(run ? { runId: run } : {}) },
        }),
        false,
      );
    if (setup.facts.state === 'incomplete' && !setup.target.ready)
      return refused(setup.facts.code, setup.facts.message);
    const target = setup.target as Extract<Setup['target'], { ready: true }>;
    if (chosen && body.projectId !== target.projectId)
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
    // The declared overlap rule for A: one active run per output project (A09).
    if (
      this.store
        .state(target.projectId)
        .sessions.some((session) => ['queued', 'working', 'waiting'].includes(session.state))
    )
      return refused('project_busy', 'The output project already has work in progress.');

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
          at: now(),
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
