/**
 * Exact-model Agent profiles and routing preferences (H09): the host side.
 *
 * Profiles are the person's own configuration, kept in `<data>/agent-profiles.json`
 * beside the other person-owned files. Revisions are append-only; a routing
 * preference names profile ids, never revisions, so it always resolves the
 * current one. What an admitted run used is pinned into that run's own record
 * (`Session.agent.profile`), which is why editing or deleting a profile here
 * never changes a run that already started.
 *
 * Availability is read from host facts only: whether the route is turned on,
 * what the engine's own catalogue lists, and whether the profile's Agent can
 * work on that route. A profile that cannot run is shown with its reason and
 * never hidden, and it is never silently swapped for another.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  PROFILE_MAX_ORDER,
  PROFILE_MAX_PROFILES,
  PROFILE_MAX_RULE,
  PROFILE_MAX_RULES,
  PROFILE_MODEL,
  resolveProfileRoute,
  type AgentProfileRecord,
  type AgentProfileRevision,
  type ProfileCandidate,
  type ProfileRouting,
  type RoutingPreference,
  type RoutingSource,
} from '../shared/agent-profiles.js';
import { AUTO_AGENT, agentCompatibility } from '../shared/agents.js';
import { isRoute, routeDisplayName } from '../shared/engines.js';
import type { Conversation } from '../shared/types.js';
import type { AgentRegistry } from './agents.js';
import { payloadDigest } from './command-admission.js';
import { engineCatalog } from './models.js';
import { ApiError } from './paths.js';
import { jsonWrite, type Store } from './store.js';

/** Binds every field an admitted run pins. */
export function profileDigest(revision: AgentProfileRevision): string {
  return payloadDigest({
    type: 'agent.profile',
    protocolVersion: revision.protocolVersion,
    profileId: revision.profileId,
    revision: revision.revision,
    name: revision.name,
    engine: revision.engine,
    model: revision.model,
    effort: revision.effort,
    agentId: revision.agentId,
    rules: [...revision.rules],
  });
}

const agentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^(auto|[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)$/);
const draftSchema = z.strictObject({
  name: z.string().trim().min(2).max(60),
  engine: z
    .string()
    .refine((value) => isRoute(value) && value !== 'sample', 'Choose a route this build has.'),
  model: z.string().trim().regex(PROFILE_MODEL),
  effort: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .nullable()
    .optional(),
  agentId: agentIdSchema.optional(),
  rules: z
    .array(z.string().trim().min(1).max(PROFILE_MAX_RULE))
    .max(PROFILE_MAX_RULES)
    .optional(),
});
export type ProfileDraft = z.input<typeof draftSchema>;

const revisionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  profileId: z.string().regex(/^pr-[a-z0-9-]{1,60}$/),
  revision: z.number().int().min(1),
  name: z.string().min(1).max(60),
  engine: z.string().min(1).max(40),
  model: z.string().regex(PROFILE_MODEL),
  effort: z.string().max(40).nullable(),
  agentId: agentIdSchema,
  rules: z.array(z.string().max(PROFILE_MAX_RULE)).max(PROFILE_MAX_RULES),
  createdAt: z.string().max(40),
});
const preferenceSchema = z.strictObject({
  order: z.array(z.string().max(80)).max(PROFILE_MAX_ORDER),
  fallback: z.boolean(),
});
const fileSchema = z.strictObject({
  version: z.literal(1),
  profiles: z
    .array(
      z.strictObject({
        profileId: z.string(),
        revisions: z.array(revisionSchema).min(1),
        archivedAt: z.string().max(40).nullable(),
      }),
    )
    .max(PROFILE_MAX_PROFILES * 4),
  routing: z.record(
    z.string(),
    z.strictObject({
      project: preferenceSchema.nullable(),
      tasks: z.record(z.string(), preferenceSchema),
    }),
  ),
});
type ProfileFile = z.infer<typeof fileSchema>;

const refuse = (message: string, code = 'invalid_profile') => new ApiError(400, message, { code });
function parseDraft(value: unknown) {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw refuse(
      field === 'model'
        ? 'Enter the model id exactly as the route lists it, up to 120 characters, without spaces.'
        : field === 'engine'
          ? 'Choose a route this build has. Sample work has no models.'
          : field === 'rules'
            ? `Keep to ${PROFILE_MAX_RULES} rules of up to ${PROFILE_MAX_RULE} characters each.`
            : field === 'name'
              ? 'Name the profile in 2 to 60 characters.'
              : 'That is not a profile this build can save.',
    );
  }
  return parsed.data;
}
const preferenceInput = z.strictObject({
  order: z.array(z.string().trim().min(1).max(80)).max(PROFILE_MAX_ORDER),
  fallback: z.boolean().optional(),
});

/** The file, its validation and its one writer. Every mutation is serialized. */
export class AgentProfileStore {
  private data: ProfileFile = { version: 1, profiles: [], routing: {} };
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when the file on disk could not be read, so a save never overwrites it. */
  private unreadable: string | null = null;
  constructor(private readonly dataDir: string) {}
  get file() {
    return path.join(this.dataDir, 'agent-profiles.json');
  }
  async load() {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      this.data = fileSchema.parse(JSON.parse(raw));
    } catch {
      // A damaged file is kept for the person to inspect; nothing replaces it.
      this.unreadable =
        'agent-profiles.json could not be read. Fix or remove it, then restart to edit profiles.';
    }
  }
  private write<T>(change: () => T): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.unreadable) throw new ApiError(409, this.unreadable, { code: 'profiles_unreadable' });
      const before = structuredClone(this.data);
      try {
        const result = change();
        await jsonWrite(this.file, this.data);
        return result;
      } catch (error) {
        this.data = before;
        throw error;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  list(): AgentProfileRevision[] {
    return this.data.profiles
      .filter((record) => record.archivedAt === null)
      .map((record) => structuredClone(record.revisions.at(-1)!));
  }
  get(profileId: string): AgentProfileRecord | undefined {
    const found = this.data.profiles.find((record) => record.profileId === profileId);
    return found ? structuredClone(found) : undefined;
  }
  private current(profileId: string) {
    const found = this.data.profiles.find((record) => record.profileId === profileId);
    if (!found || found.archivedAt !== null)
      throw new ApiError(404, 'This profile was not found.', { code: 'profile_not_found' });
    return found;
  }
  async create(value: unknown): Promise<AgentProfileRevision> {
    const draft = parseDraft(value);
    return this.write(() => {
      if (this.list().length >= PROFILE_MAX_PROFILES)
        throw refuse(`Keep to ${PROFILE_MAX_PROFILES} profiles.`);
      const profileId = `pr-${crypto.randomUUID().slice(0, 13)}`;
      const revision = this.revision(profileId, 1, draft);
      this.data.profiles.push({
        profileId,
        revisions: [{ ...revision, rules: [...revision.rules] }],
        archivedAt: null,
      });
      return structuredClone(revision);
    });
  }
  /** Appends a revision. `expectedRevision` is the one the editor read. */
  async update(profileId: string, expectedRevision: unknown, value: unknown): Promise<AgentProfileRevision> {
    const draft = parseDraft(value);
    return this.write(() => {
      const record = this.current(profileId);
      const latest = record.revisions.at(-1)!;
      if (expectedRevision !== latest.revision)
        throw new ApiError(
          409,
          `This profile changed since it was opened: revision ${latest.revision} is current. Reopen it, then save again.`,
          { code: 'profile_stale', current: latest.revision },
        );
      const revision = this.revision(profileId, latest.revision + 1, draft);
      record.revisions.push({ ...revision, rules: [...revision.rules] });
      return structuredClone(revision);
    });
  }
  archive(profileId: string): Promise<void> {
    return this.write(() => {
      const record = this.current(profileId);
      record.archivedAt = new Date().toISOString();
    });
  }
  private revision(
    profileId: string,
    revision: number,
    draft: ReturnType<typeof parseDraft>,
  ): AgentProfileRevision {
    return {
      protocolVersion: 1,
      profileId,
      revision,
      name: draft.name,
      engine: draft.engine,
      model: draft.model,
      effort: draft.effort ?? null,
      agentId: draft.agentId ?? AUTO_AGENT,
      rules: draft.rules ?? [],
      createdAt: new Date().toISOString(),
    };
  }
  /** The effective preference for a task: its own override, else the project's. */
  routing(projectId: string, taskId: string | null): RoutingPreference & { source: RoutingSource } {
    const project = this.data.routing[projectId];
    const task = taskId ? project?.tasks[taskId] : undefined;
    if (task) return { ...structuredClone(task), source: 'task' };
    return {
      order: [...(project?.project?.order ?? [])],
      fallback: project?.project?.fallback ?? false,
      source: 'project',
    };
  }
  /** The saved preferences, as they are stored, for the settings screen. */
  savedRouting(projectId: string) {
    return structuredClone(this.data.routing[projectId] ?? { project: null, tasks: {} });
  }
  private preference(value: unknown): RoutingPreference {
    const parsed = preferenceInput.safeParse(value);
    if (!parsed.success)
      throw refuse(`List up to ${PROFILE_MAX_ORDER} profiles in order, and say whether fallback is on.`, 'invalid_routing');
    const order = [...new Set(parsed.data.order)];
    for (const profileId of order) this.current(profileId);
    // Fallback is off unless the person says otherwise, every time they save.
    return { order, fallback: parsed.data.fallback ?? false };
  }
  setRouting(projectId: string, value: unknown): Promise<RoutingPreference> {
    return this.write(() => {
      let preference: RoutingPreference;
      try {
        preference = this.preference(value);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          throw refuse('Choose profiles that exist.', 'invalid_routing');
        throw error;
      }
      const entry = (this.data.routing[projectId] ??= { project: null, tasks: {} });
      entry.project = { order: [...preference.order], fallback: preference.fallback };
      return preference;
    });
  }
  /** Null clears the override, so the task follows the project again. */
  setTaskRouting(projectId: string, taskId: string, value: unknown): Promise<RoutingPreference | null> {
    return this.write(() => {
      const entry = (this.data.routing[projectId] ??= { project: null, tasks: {} });
      if (value === null) {
        delete entry.tasks[taskId];
        return null;
      }
      let preference: RoutingPreference;
      try {
        preference = this.preference(value);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          throw refuse('Choose profiles that exist.', 'invalid_routing');
        throw error;
      }
      entry.tasks[taskId] = { order: [...preference.order], fallback: preference.fallback };
      return preference;
    });
  }
}

/** Whether a thread made its own model choice, which a project list does not override. */
export function threadChoosesItsOwnModel(thread: Conversation | null | undefined): boolean {
  return Boolean(thread?.requested?.model || thread?.workStyle);
}

/**
 * Resolution against live host facts. It reads settings, the engine's own
 * catalogue and the Agent registry; it writes nothing.
 */
export class AgentProfileService {
  constructor(
    readonly profiles: AgentProfileStore,
    private readonly store: Store,
    private readonly agents: AgentRegistry,
  ) {}

  /** Null when the revision can run now; otherwise the sentence that says why not. */
  async unavailable(revision: AgentProfileRevision, projectFolder: string | null): Promise<string | null> {
    const route = routeDisplayName(revision.engine);
    if (!isRoute(revision.engine) || revision.engine === 'sample')
      return `${revision.engine} is not a route this build has.`;
    if (this.store.settings.services?.[revision.engine] !== true)
      return `${route} is off in Settings > Engines.`;
    // Every route but Codex dispatches through the account AI setup connected; without
    // one the run would be refused after admission, past the point a fallback could help.
    if (
      revision.engine !== 'codex' &&
      typeof this.store.settings.services?.[`${revision.engine}AccountRoute`] !== 'string'
    )
      return `${route} is not connected in AI setup.`;
    const catalog = engineCatalog(revision.engine);
    // An engine that reports its list is held to it. One that does not is sent the
    // model as named, and the runtime's own report is what the run records.
    if (catalog.models.length) {
      const listed = catalog.models.find((model) => model.slug === revision.model);
      if (!listed) return `${revision.model} is not in the list ${route} reports for this account.`;
      if (revision.effort !== null && listed.efforts.length && !listed.efforts.some((e) => e.id === revision.effort))
        return `${revision.model} does not offer the ${revision.effort} reasoning level.`;
    }
    if (revision.agentId !== AUTO_AGENT) {
      const agent = await this.agents.find(revision.agentId, projectFolder);
      if (!agent) return `The ${revision.agentId} Agent is not available in this project.`;
      const fit = agentCompatibility(agent, revision.engine);
      if (!fit.ok) return fit.unmet[0]?.detail ?? `${agent.name} cannot work through ${route}.`;
    }
    return null;
  }

  async candidates(projectFolder: string | null): Promise<Map<string, ProfileCandidate>> {
    const rows = new Map<string, ProfileCandidate>();
    for (const revision of this.profiles.list())
      rows.set(revision.profileId, {
        revision,
        digest: profileDigest(revision),
        unavailable: await this.unavailable(revision, projectFolder),
      });
    return rows;
  }

  /**
   * Whether a profile decides this run. Cheap and synchronous, so a caller can
   * skip its own route-default lookup that a profile would replace.
   */
  applies(projectId: string, taskId: string | null, thread: Conversation | null | undefined): boolean {
    if (thread?.requested?.profile) return true;
    if (threadChoosesItsOwnModel(thread)) return false;
    return this.profiles.routing(projectId, taskId).order.length > 0;
  }

  /**
   * The resolution table against live facts. The thread's own pick leads; the
   * task or project list follows it only when fallback is on there. A thread
   * that chose its own model or WorkStyle is left to that choice.
   */
  async resolve(input: {
    projectId: string;
    taskId: string | null;
    thread: Conversation | null | undefined;
    projectFolder: string | null;
  }): Promise<ProfileRouting> {
    if (!this.applies(input.projectId, input.taskId, input.thread)) return { outcome: 'none' };
    const preference = this.profiles.routing(input.projectId, input.taskId);
    const pick = input.thread?.requested?.profile ?? null;
    return resolveProfileRoute({
      source: pick ? 'thread' : preference.source,
      order: pick ? [pick, ...preference.order.filter((id) => id !== pick)] : preference.order,
      fallback: preference.fallback,
      candidates: await this.candidates(input.projectFolder),
    });
  }
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};

export function mountAgentProfileRoutes(app: Express, store: Store, service: AgentProfileService) {
  const route =
    (action: (req: Request) => Promise<unknown>, locked = true) =>
    async (req: Request, res: Response, next: (error?: unknown) => void) => {
      try {
        res.json(locked ? await store.locked(() => action(req)) : await action(req));
      } catch (error) {
        next(error);
      }
    };
  const profiles = service.profiles;
  const view = (revision: AgentProfileRevision) => ({
    ...revision,
    digest: profileDigest(revision),
    revisions: profiles.get(revision.profileId)?.revisions.length ?? 1,
  });

  app.get(
    '/api/agent-profiles',
    route(async () => ({ profiles: profiles.list().map(view) }), false),
  );
  app.get(
    '/api/agent-profiles/:profileId',
    route(async (req) => {
      const record = profiles.get(String(req.params.profileId));
      if (!record) throw new ApiError(404, 'This profile was not found.', { code: 'profile_not_found' });
      return { ...record, revisions: record.revisions.map((item) => ({ ...item, digest: profileDigest(item) })) };
    }, false),
  );
  app.post('/api/agent-profiles', route(async (req) => view(await profiles.create(body(req)))));
  app.put(
    '/api/agent-profiles/:profileId',
    route(async (req) => {
      const { expectedRevision, ...draft } = body(req);
      return view(await profiles.update(String(req.params.profileId), expectedRevision, draft));
    }),
  );
  app.delete(
    '/api/agent-profiles/:profileId',
    route(async (req) => {
      await profiles.archive(String(req.params.profileId));
      return { ok: true };
    }),
  );
  /**
   * Every profile with whether it can run here now, and the routing that would
   * apply. Unavailable profiles are listed with their reason, never left out.
   */
  app.get(
    '/api/projects/:id/agent-profiles',
    route(async (req) => {
      const projectId = String(req.params.id);
      const state = store.state(projectId);
      const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : null;
      const candidates = await service.candidates(state.project.folder);
      return {
        profiles: [...candidates.values()].map((row) => ({
          ...row.revision,
          digest: row.digest,
          available: row.unavailable === null,
          reason: row.unavailable,
        })),
        routing: profiles.routing(projectId, taskId),
        saved: profiles.savedRouting(projectId),
      };
    }, false),
  );
  app.put(
    '/api/projects/:id/agent-routing',
    route(async (req) => {
      const projectId = String(req.params.id);
      store.state(projectId);
      return profiles.setRouting(projectId, body(req));
    }),
  );
  app.put(
    '/api/projects/:id/tasks/:taskId/agent-routing',
    route(async (req) => {
      const projectId = String(req.params.id);
      const taskId = String(req.params.taskId);
      if (!store.state(projectId).tasks.some((task) => task.id === taskId && !task.deletedAt))
        throw new ApiError(404, 'This task was not found.');
      return profiles.setTaskRouting(projectId, taskId, req.body === null || body(req).clear === true ? null : body(req));
    }),
  );
}
