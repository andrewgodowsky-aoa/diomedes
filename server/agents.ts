/**
 * The Agent registry and resolver.
 *
 * Built-in Agents come from `shared/agents.ts`. A person or a project may add
 * their own as JSON files, with no cloud service involved:
 *
 *   <data>/agents/*.json                 the person's own Agents
 *   <project>/.diomedes/agents/*.json    Agents that travel with a project
 *
 * A file that does not validate is skipped with a recorded reason rather than
 * failing the app: these are editable user files, not durable authority state,
 * and a malformed one must never become a weaker or a stronger Agent. Project
 * definitions cannot raise their own permission ceiling above the built-in
 * `general` Agent's, so dropping a file into a repository cannot widen what a
 * run may do. Authority still comes only from a grant the person confirmed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AGENT_ARTIFACTS,
  AGENT_CATALOG,
  AGENT_MAX_DEFINITIONS,
  AGENT_MAX_ROLE,
  AGENT_REQUIREMENTS,
  AUTO_AGENT,
  AUTO_BY_MODE,
  agentCompatibility,
  narrowerPermission,
  type AgentDefinition,
  type AgentResolution,
} from '../shared/agents.js';
import { PERMISSION_CHOICES, type PermissionChoiceId } from '../shared/permissions.js';
import type { Mode, ProjectState } from '../shared/types.js';
import { payloadDigest } from './command-admission.js';
import { ApiError } from './paths.js';

const definitionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  id: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  version: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/),
  name: z.string().trim().min(2).max(60),
  summary: z.string().trim().min(4).max(240),
  modes: z.array(z.enum(['ask', 'plan', 'build', 'fix'])).min(1).max(4),
  role: z.string().trim().min(4).max(AGENT_MAX_ROLE),
  requires: z
    .array(z.enum(Object.keys(AGENT_REQUIREMENTS) as [string, ...string[]]))
    .max(8),
  tools: z.array(z.string().min(1).max(80)).max(16),
  ruleScopes: z.array(z.string().min(1).max(80)).max(8),
  permissionCeiling: z.enum(PERMISSION_CHOICES),
  models: z.array(z.string().min(1).max(120)).max(8),
  handoff: z.strictObject({
    accepts: z.array(z.enum(AGENT_ARTIFACTS)).max(8),
    produces: z.array(z.enum(AGENT_ARTIFACTS)).min(1).max(8),
  }),
  evidence: z.array(z.enum(AGENT_ARTIFACTS)).min(1).max(8),
});

/** The digest binds every field that changes what the Agent is. */
export function agentDigest(definition: AgentDefinition): string {
  return payloadDigest({
    type: 'agent.definition',
    protocolVersion: definition.protocolVersion,
    id: definition.id,
    version: definition.version,
    name: definition.name,
    summary: definition.summary,
    origin: definition.origin,
    modes: [...definition.modes],
    role: definition.role,
    requires: [...definition.requires],
    tools: [...definition.tools],
    ruleScopes: [...definition.ruleScopes],
    permissionCeiling: definition.permissionCeiling,
    models: [...definition.models],
    handoff: { accepts: [...definition.handoff.accepts], produces: [...definition.handoff.produces] },
    evidence: [...definition.evidence],
  });
}

/** A ceiling no added definition may exceed, whatever its file says. */
const ADDED_CEILING: PermissionChoiceId =
  AGENT_CATALOG.find((item) => item.id === 'diomedes.general')!.permissionCeiling;

export interface AgentView extends AgentDefinition {
  readonly digest: string;
}
export interface AgentSkipped {
  readonly source: string;
  readonly reason: string;
}

async function loadFrom(
  directory: string,
  origin: 'user' | 'project',
  skipped: AgentSkipped[],
): Promise<AgentDefinition[]> {
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const loaded: AgentDefinition[] = [];
  for (const name of names.sort().slice(0, AGENT_MAX_DEFINITIONS)) {
    const file = path.join(directory, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (raw.length > 20_000) throw new Error('The definition file is too large.');
      const parsed = definitionSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error('The definition does not match the Agent contract.');
      loaded.push({
        ...parsed.data,
        requires: parsed.data.requires as AgentDefinition['requires'],
        origin,
        source: `${origin}:${name}`,
        // An added file names a ceiling; it never raises one.
        permissionCeiling: narrowerPermission(parsed.data.permissionCeiling, ADDED_CEILING),
      });
    } catch (error) {
      skipped.push({
        source: `${origin}:${name}`,
        reason: error instanceof Error ? error.message : 'The definition could not be read.',
      });
    }
  }
  return loaded;
}

export class AgentRegistry {
  private cache = new Map<string, { at: number; agents: AgentView[]; skipped: AgentSkipped[] }>();
  constructor(private readonly dataDir: string) {}

  /** Built-ins first; an added definition may not replace a built-in id. */
  async list(projectFolder?: string | null) {
    const key = projectFolder ?? '';
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 5_000) return cached;
    const skipped: AgentSkipped[] = [];
    const added = [
      ...(await loadFrom(path.join(this.dataDir, 'agents'), 'user', skipped)),
      ...(projectFolder
        ? await loadFrom(path.join(projectFolder, '.diomedes', 'agents'), 'project', skipped)
        : []),
    ];
    const agents: AgentView[] = AGENT_CATALOG.map((definition) => ({
      ...definition,
      digest: agentDigest(definition),
    }));
    const taken = new Set(agents.map((item) => item.id));
    for (const definition of added) {
      if (taken.has(definition.id)) {
        skipped.push({
          source: definition.source,
          reason: `The identifier ${definition.id} is already used by another Agent.`,
        });
        continue;
      }
      taken.add(definition.id);
      agents.push({ ...definition, digest: agentDigest(definition) });
    }
    const result = { at: Date.now(), agents, skipped };
    this.cache.set(key, result);
    return result;
  }

  async find(id: string, projectFolder?: string | null) {
    return (await this.list(projectFolder)).agents.find((item) => item.id === id);
  }

  /**
   * Resolve one execution snapshot. It reads the current grant to record what
   * is permitted; it never issues, widens or refreshes one.
   */
  async resolve(input: {
    requestedAgentId?: string | null;
    mode: Mode;
    routeId: string;
    requestedModel?: string | null;
    state: ProjectState;
    taskId: string;
    /** Whether the model came from an explicit pick or a saved default. */
    modelSelection?: AgentResolution['modelSelection'];
  }): Promise<AgentResolution> {
    const requested = input.requestedAgentId?.trim() || null;
    const automatic = !requested || requested === AUTO_AGENT;
    const wanted = automatic ? AUTO_BY_MODE[input.mode] : requested;
    const { agents } = await this.list(input.state.project.folder);
    const definition =
      agents.find((item) => item.id === wanted) ??
      (automatic ? agents.find((item) => item.id === 'diomedes.general') : undefined);
    if (!definition)
      throw new ApiError(404, `No Agent named ${wanted} is available in this project.`, {
        code: 'agent_not_found',
      });
    const compatibility = agentCompatibility(definition, input.routeId);
    // What the person has actually granted for this task, read live.
    const record = [...(input.state.scopeGrants ?? [])]
      .reverse()
      .find(
        (item) =>
          item.grant.taskId === input.taskId && item.generation === 0 && item.revokedAt === null,
      );
    const granted: PermissionChoiceId = !record
      ? 'review'
      : record.grant.review === 'model-reviewer'
        ? 'auto-review'
        : 'project';
    return {
      protocolVersion: 1,
      agentId: definition.id,
      agentVersion: definition.version,
      agentName: definition.name,
      agentOrigin: definition.origin,
      agentDigest: definition.digest,
      agentSelection: automatic ? 'automatic' : 'manual',
      requestedAgentId: requested,
      mode: input.mode,
      routeId: input.routeId,
      requestedModel: input.requestedModel?.trim() || null,
      modelSelection:
        input.modelSelection ?? (input.requestedModel ? 'manual' : 'runtime-default'),
      compatible: compatibility.ok,
      unmet: compatibility.unmet.map((item) => ({
        requirement: item.requirement,
        detail: item.detail,
      })),
      policy: {
        agentCeiling: definition.permissionCeiling,
        granted,
        effective: narrowerPermission(definition.permissionCeiling, granted),
        grantId: record?.grant.id ?? null,
        grantsAuthority: false,
      },
      resolvedAt: new Date().toISOString(),
    };
  }
}

const timeSchema = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
/** Strict persisted shape: an unknown or widened field fails closed. */
export const resolutionSchema = z.strictObject({
  protocolVersion: z.literal(1),
  agentId: z.string().min(1).max(80),
  agentVersion: z.string().min(1).max(20),
  agentName: z.string().min(1).max(60),
  agentOrigin: z.enum(['built-in', 'user', 'project']),
  agentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  agentSelection: z.enum(['manual', 'automatic']),
  requestedAgentId: z.string().min(1).max(80).nullable(),
  mode: z.enum(['ask', 'plan', 'build', 'fix']),
  routeId: z.string().min(1).max(40),
  requestedModel: z.string().min(1).max(120).nullable(),
  modelSelection: z.enum(['manual', 'automatic', 'runtime-default']),
  compatible: z.boolean(),
  unmet: z
    .array(z.strictObject({ requirement: z.string().max(80), detail: z.string().max(1000) }))
    .max(8),
  policy: z.strictObject({
    agentCeiling: z.enum(PERMISSION_CHOICES),
    granted: z.enum(PERMISSION_CHOICES),
    effective: z.enum(PERMISSION_CHOICES),
    grantId: z.string().min(1).max(100).nullable(),
    // A saved snapshot can never say it granted anything.
    grantsAuthority: z.literal(false),
  }),
  resolvedAt: timeSchema,
});

/**
 * Validates persisted resolutions at load and recovery. A snapshot is history:
 * it is checked for coherence, never re-resolved, and never used as authority.
 */
export function validateAgentResolutions(state: ProjectState) {
  const fail = () => {
    throw new Error(
      'A saved Agent resolution is incompatible or inconsistent. Project state was not rewritten.',
    );
  };
  for (const session of state.sessions) {
    if (session.agent === undefined) continue;
    const parsed = resolutionSchema.safeParse(session.agent);
    if (!parsed.success) return fail();
    const snapshot = parsed.data;
    if (
      snapshot.policy.effective !==
        narrowerPermission(snapshot.policy.agentCeiling, snapshot.policy.granted) ||
      (snapshot.agentSelection === 'automatic' &&
        snapshot.requestedAgentId !== null &&
        snapshot.requestedAgentId !== AUTO_AGENT) ||
      (snapshot.agentSelection === 'manual' && snapshot.requestedAgentId !== snapshot.agentId)
    )
      fail();
  }
}
