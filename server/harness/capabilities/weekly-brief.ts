/**
 * The weekly brief as a harness capability (Automations Milestone A, D1).
 *
 * Run once admits the brief through the same Task, Session and RunService path
 * every other harness run takes, so it has a durable run file, step evidence,
 * restart recovery and a recorded write — and Milestone B's scheduler will feed
 * this capability rather than a second execution path.
 *
 * The steps are fixed, so the driver is a procedure and not a model: read the
 * pinned sources, compose with the existing `composeBrief`, save the draft for
 * review. No model is called, no provider route is involved and no model is
 * named: every step carries an application origin whose executor is this
 * procedure (decision 8). The person who pressed Run once is recorded on the
 * occurrence that admitted the run.
 *
 * Authority is today's (D2): the save declares `approval: false` and needs
 * `write-project-file`, may write only to the destination the pinned
 * configuration revision names, and saves with `review: true` so the draft
 * waits as a Change the person keeps or undoes. A missing configured source
 * stops the run before anything is written (D3).
 */
import { z } from 'zod';
import type { OriginSnapshot } from '../../../shared/attribution.js';
import type { ConfigurationManifest } from '../../../shared/configuration.js';
import type {
  CapabilityManifest,
  HarnessBudget,
  HarnessPrincipal,
  Json,
} from '../../../shared/harness.js';
import { IMPORT_MAX_TOTAL_BYTES } from '../../../shared/file-imports.js';
import { outputName } from '../../../shared/packs.js';
import type { BriefTarget } from '../../../shared/workspaces.js';
import { checkExport } from '../../file-imports.js';
import { ApiError, relativeName } from '../../paths.js';
import { hash, now, type Store } from '../../store.js';
import {
  approvedScope,
  composeBrief,
  outputFor,
  prettyFor,
  slugFor,
  type BriefSource,
} from '../../weekly-brief.js';
import { digest } from '../policy.js';
import type { RunService } from '../run-service.js';
import type { ToolRegistry } from '../tools.js';

export const WEEKLY_BRIEF = {
  id: 'weekly-brief',
  version: 'v1',
  label: 'Prepare the weekly brief',
  description:
    'Read the approved exports, compose a source-linked draft and save it for review. Nothing is sent.',
  tools: ['read_brief_sources', 'compose_brief', 'save_brief_draft'],
  requestedPermissions: ['write-project-file'],
  approvalPolicy: 'show-first',
  maxTurns: 4,
  supportedPlatforms: ['win32', 'linux', 'darwin'],
} satisfies CapabilityManifest;

/** The Session engine name: a Diomedes procedure, never a model or provider. */
export const WEEKLY_BRIEF_ENGINE = 'diomedes-procedure';

/**
 * Three tool steps, each allowed its three attempts so a save interrupted by a
 * crash can be replayed against its receipt, and no model call. The budget
 * makes a model call impossible, not merely unused.
 */
export const WEEKLY_BRIEF_BUDGET: HarnessBudget = {
  units: 9,
  modelCalls: 0,
  toolCalls: 9,
  wallMs: null,
};

/** Application authorship: Diomedes ran a fixed procedure. No model authorship implied. */
export const WEEKLY_BRIEF_ORIGIN: OriginSnapshot = Object.freeze({
  protocolVersion: 1,
  mode: 'application',
  engine: null,
  model: { requested: null, reported: null, source: 'not-recorded' },
  executorId: 'diomedes:weekly-brief',
}) as OriginSnapshot;

/** The run's name for a stop before writing. Read by the projection, never shown raw. */
export const WAITING_FOR_DATA = 'waiting_for_data';

export class WaitingForData extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `Waiting for data: ${missing.join(', ')} could not be read, so nothing was written.`,
    );
    this.name = WAITING_FOR_DATA;
  }
}

/** What the host supplies: the pinned configuration and the live target, nothing broader. */
export interface WeeklyBriefHost {
  /** The exact configuration revision admission pinned, or null when it is gone or changed. */
  manifest(organizationId: string, revision: number, digest: string): ConfigurationManifest | null;
  /** Membership, binding and ownership, resolved now. Throws for someone who is not a member. */
  target(organizationId: string): Promise<BriefTarget>;
}

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const chosenSchema = z.array(z.strictObject({ path: z.string().max(1000), sha })).max(8);

/** What admission pins into the run. Read back, never re-derived from live settings. */
export const weeklyBriefInputSchema = z.strictObject({
  v: z.literal(1),
  occurrenceId: z.string().min(1).max(80),
  organizationId: z.string().min(1).max(160),
  tenantId: z.string().min(1).max(160),
  projectId: z.string().min(1).max(100),
  configuration: z.strictObject({ revision: z.number().int().positive(), digest: z.string() }),
  destination: z.string().min(1).max(1000),
  selection: z.array(z.string().max(1000)).max(64),
  chosen: chosenSchema.nullable(),
  at: stamp,
});
export type WeeklyBriefInput = z.infer<typeof weeklyBriefInputSchema>;

const readInput = z.strictObject({
  projectId: z.string(),
  selection: z.array(z.string()),
  chosen: chosenSchema.nullable(),
  destination: z.string(),
  scopeLabel: z.string(),
});
const sourceOutput = z.strictObject({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  sha,
  text: z.string(),
});
const readOutput = z.strictObject({
  sources: z.array(sourceOutput),
  missing: z.array(z.string()),
  previous: z.strictObject({ sha: sha.nullable(), text: z.string().nullable() }),
});
type ReadOutput = z.infer<typeof readOutput>;

const composeInput = z.strictObject({
  runId: z.string(),
  read: sha,
  organizationId: z.string(),
  revision: z.number().int().positive(),
  digest: z.string(),
  chosen: z.boolean(),
  at: stamp,
});
const composeOutput = z.strictObject({
  title: z.string(),
  markdown: z.string(),
  sections: z.number().int().nonnegative(),
  unused: z.array(z.string()),
  sources: z.array(z.strictObject({ id: z.string(), label: z.string(), path: z.string(), sha })),
});

const saveInput = z.strictObject({
  runId: z.string(),
  projectId: z.string(),
  organizationId: z.string(),
  revision: z.number().int().positive(),
  digest: z.string(),
  destination: z.string(),
  expected: sha.nullable(),
  text: z
    .string()
    .max(8 * 1024 * 1024)
    .refine((value) => !value.includes('\0')),
  chosen: chosenSchema.nullable(),
});

export function registerWeeklyBrief(
  tools: ToolRegistry,
  store: Store,
  runs: RunService,
  host: WeeklyBriefHost,
) {
  const base = {
    version: 'v1',
    permission: null,
    approval: false,
    destination: 'local',
    trustedInputRequired: false,
    cost: 1,
  } as const;

  const pinned = (organizationId: string, revision: number, manifestDigest: string) => {
    const manifest = host.manifest(organizationId, revision, manifestDigest);
    if (!manifest)
      throw new ApiError(
        409,
        'The setup revision this run was admitted under is no longer recorded, so nothing was written.',
        { code: 'configuration_revision_missing' },
      );
    return manifest;
  };

  tools.register({
    ...base,
    name: 'read_brief_sources',
    description: 'Read the pinned sources and the previous brief, each with its SHA-256.',
    effect: 'pure',
    schema: readInput,
    execute: async ({ input }): Promise<ReadOutput> => {
      // `store.current` is the side-effect-free read: a brief leaves one recorded
      // write behind it, not a trail of first-seen observations.
      const sources: ReadOutput['sources'] = [];
      const missing: string[] = [];
      if (input.chosen) {
        for (const [index, ref] of input.chosen.entries()) {
          const text = await store.current(input.projectId, ref.path);
          if (text === null) {
            missing.push(ref.path);
            continue;
          }
          if (hash(text) !== ref.sha)
            throw new ApiError(
              409,
              `${ref.path} changed after it was chosen. Choose it again before preparing the brief.`,
              { code: 'source_changed' },
            );
          checkExport(ref.path, text);
          sources.push({
            id: `${slugFor(ref.path)}-${index + 1}`,
            label: `${input.scopeLabel}: ${prettyFor(ref.path)}`,
            path: ref.path,
            sha: ref.sha,
            text,
          });
        }
      } else {
        const seen = new Map<string, number>();
        for (const selection of input.selection) {
          let text: string | null;
          try {
            text = await store.current(input.projectId, selection);
          } catch {
            text = null;
          }
          if (text === null) {
            missing.push(selection);
            continue;
          }
          const slug = slugFor(selection);
          const count = seen.get(slug) ?? 0;
          seen.set(slug, count + 1);
          sources.push({
            id: count === 0 ? slug : `${slug}-${count + 1}`,
            label: `${input.scopeLabel}: ${prettyFor(selection)}`,
            path: selection,
            sha: hash(text)!,
            text,
          });
        }
      }
      if (sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0) > IMPORT_MAX_TOTAL_BYTES)
        throw new ApiError(413, 'Choose no more than 4 MB of exports for one brief.', {
          code: 'sources_too_large',
        });
      const previous = await store.current(input.projectId, input.destination);
      return { sources, missing, previous: { sha: hash(previous), text: previous } };
    },
  });

  tools.register({
    ...base,
    name: 'compose_brief',
    description: 'Compose the source-linked draft from what the read step recorded.',
    effect: 'pure',
    schema: composeInput,
    execute: async ({ input }) => {
      const run = await runs.get(input.runId);
      const step = run.steps.find((item) => item.intent.stepId === READ_STEP);
      if (step?.state !== 'succeeded' || step.outputHash !== input.read)
        throw new ApiError(409, 'The sources this draft reads were not recorded.');
      const read = readOutput.parse(step.output);
      let manifest = pinned(input.organizationId, input.revision, input.digest);
      const scope = approvedScope(manifest);
      if (input.chosen && scope)
        // A per-run choice by an owner or admin. No saved configuration changes.
        manifest = {
          ...manifest,
          proposal: {
            ...manifest.proposal,
            contextScopes: manifest.proposal.contextScopes.map((item) =>
              item === scope ? { ...item, selection: read.sources.map((source) => source.path) } : item,
            ),
          },
        };
      const draft = composeBrief({
        manifest,
        sources: read.sources as BriefSource[],
        previous: read.previous.text,
        at: input.at,
      });
      return {
        title: draft.title,
        markdown: draft.markdown,
        sections: draft.sections.length,
        unused: [...draft.unused],
        sources: draft.sources.map((source) => ({ ...source })),
      };
    },
  });

  tools.register({
    ...base,
    name: 'save_brief_draft',
    description: 'Save the draft to the pinned destination for review. Nothing is sent.',
    effect: 'idempotent',
    permission: 'write-project-file',
    // D2: today's authority. The draft waits as a Change to keep or undo.
    approval: false,
    schema: saveInput,
    execute: (context) =>
      store.locked(async () => {
        context.signal.throwIfAborted();
        const input = context.input;
        const run = await runs.get(input.runId);
        const step = run.steps.find(
          (item) =>
            item.intent.stepId === SAVE_STEP &&
            digest({ runId: run.id, stepId: item.intent.stepId, intentHash: item.intentHash }) ===
              context.idempotencyKey,
        );
        if (
          run.projectId !== input.projectId ||
          run.state !== 'running' ||
          step?.state !== 'running' ||
          digest(step.intent.input) !== digest(input) ||
          !run.taskId ||
          !run.sessionId
        )
          throw new ApiError(409, 'The brief save is not the active step of its run.');
        // Membership, the output binding and project ownership, checked now and
        // not at admission only (A14, A15). `target` refuses a non-member.
        const target = await host.target(input.organizationId);
        if (!target.ready)
          throw new ApiError(409, target.message, { code: target.code.replace(/-/g, '_') });
        if (target.projectId !== input.projectId)
          throw new ApiError(
            409,
            'This business now writes somewhere else, so this run wrote nothing. Run it again.',
            { code: 'output_project_changed' },
          );
        const manifest = pinned(input.organizationId, input.revision, input.digest);
        const output = outputFor(manifest);
        if (!output || relativeName(output.destination) !== input.destination)
          throw new ApiError(409, 'The destination is not the one this run was admitted with.', {
            code: 'destination_changed',
          });
        // A36: per-run sources are bound by SHA and checked again before the write.
        for (const ref of input.chosen ?? [])
          if (hash(await store.current(input.projectId, ref.path)) !== ref.sha)
            throw new ApiError(
              409,
              `${ref.path} changed while the brief was being prepared. Choose it again.`,
              { code: 'source_changed' },
            );
        const state = store.state(input.projectId);
        const prior = state.history.find((entry) => entry.label === context.idempotencyKey);
        if (prior) {
          // Recovery after a crash between the write and the step's commit: the
          // same entry is returned, and anything else needs a person.
          if (
            prior.kind !== 'weekly-brief' ||
            prior.files.length !== 1 ||
            prior.files[0].path !== input.destination ||
            prior.files[0].before !== input.expected ||
            prior.files[0].after !== hash(input.text)
          )
            throw new ApiError(409, 'The recovered brief needs inspection in History before continuing.');
          return { entryId: prior.id, path: input.destination, sha: prior.files[0].after };
        }
        await store.writeRecorded(
          input.projectId,
          [{ path: input.destination, text: input.text, expected: input.expected }],
          {
            actor: 'diomedes',
            kind: 'weekly-brief',
            origin: WEEKLY_BRIEF_ORIGIN,
            sessionId: run.sessionId,
            taskId: run.taskId,
            sample: false,
            review: true,
            merge: false,
            label: context.idempotencyKey,
          },
        );
        const entry = store
          .state(input.projectId)
          .history.find((item) => item.label === context.idempotencyKey);
        if (!entry) throw new Error('The recorded brief has no History receipt.');
        return { entryId: entry.id, path: input.destination, sha: entry.files[0].after };
      }),
  });

  /** Run one tool through RunService, with the registry's declared authority. */
  const step = <T extends Json>(
    runId: string,
    owner: string,
    principal: HarnessPrincipal,
    id: string,
    name: string,
    input: Json,
  ) => {
    const tool = tools.get(name);
    return runs.step<T>(
      runId,
      owner,
      {
        id,
        version: tool.version,
        kind: 'tool',
        effect: tool.effect,
        name: tool.name,
        cost: tool.cost,
        permission: tool.permission,
        approval: tool.approval,
        destination: tool.destination,
        trustedInputRequired: tool.trustedInputRequired,
        label: tool.label ?? null,
        origin: WEEKLY_BRIEF_ORIGIN,
        input: tools.validate(name, input) as Json,
      },
      (context) => tool.execute({ ...context, input: context.input }) as T | Promise<T>,
      principal,
    );
  };

  return {
    capability: WEEKLY_BRIEF,
    engine: WEEKLY_BRIEF_ENGINE,
    origin: WEEKLY_BRIEF_ORIGIN,
    budget: WEEKLY_BRIEF_BUDGET,
    /** The fixed procedure. Replays saved observations; never calls a model. */
    async run(runId: string, owner: string, principal: HarnessPrincipal) {
      const run = await runs.get(runId);
      const input = weeklyBriefInputSchema.parse(run.input);
      const manifest = pinned(
        input.organizationId,
        input.configuration.revision,
        input.configuration.digest,
      );
      const scope = approvedScope(manifest);
      const read = readOutput.parse(
        await step(runId, owner, principal, READ_STEP, 'read_brief_sources', {
          projectId: input.projectId,
          selection: input.selection,
          chosen: input.chosen,
          destination: input.destination,
          scopeLabel: scope?.label ?? 'Approved exports',
        }),
      );
      // D3: missing coverage stops the run before anything is written. The
      // read step keeps the names as durable evidence, not only as prose.
      if (read.missing.length > 0) {
        await runs.fail(runId, owner, new WaitingForData(read.missing));
        return;
      }
      const readHash = (await runs.get(runId)).steps.find(
        (item) => item.intent.stepId === READ_STEP,
      )!.outputHash!;
      const draft = composeOutput.parse(
        await step(runId, owner, principal, COMPOSE_STEP, 'compose_brief', {
          runId,
          read: readHash,
          organizationId: input.organizationId,
          revision: input.configuration.revision,
          digest: input.configuration.digest,
          chosen: input.chosen !== null,
          at: input.at,
        }),
      );
      const saved = await step<{ entryId: string; path: string; sha: string }>(
        runId,
        owner,
        principal,
        SAVE_STEP,
        'save_brief_draft',
        {
          runId,
          projectId: input.projectId,
          organizationId: input.organizationId,
          revision: input.configuration.revision,
          digest: input.configuration.digest,
          destination: input.destination,
          expected: read.previous.sha,
          text: draft.markdown,
          chosen: input.chosen,
        },
      );
      await runs.complete(runId, owner, {
        entryId: saved.entryId,
        path: saved.path,
        sha: saved.sha,
        title: draft.title,
        sections: draft.sections,
        completedAt: now(),
      });
    },
  };
}

export const READ_STEP = 'brief:read';
export const COMPOSE_STEP = 'brief:compose';
export const SAVE_STEP = 'brief:save';

/** The Task description a run is admitted with, so the Board says what it is in plain words. */
export function weeklyBriefInstruction(input: {
  outputLabel: string | null;
  organizationName: string;
  chosen: boolean;
}) {
  const name = input.outputLabel ? outputName(input.outputLabel) : 'the weekly brief';
  return `Prepare ${name} for ${input.organizationName} from ${
    input.chosen ? 'the files chosen for this run' : 'the approved exports'
  } and save it for review. Nothing is sent.`;
}
