/**
 * The durable half of governed self-configuration.
 *
 * `shared/configuration.ts` decides whether a proposal is coherent; this
 * service decides whether it may become active, and makes that transition
 * survive a restart, a concurrent editor and a replayed request. The split is
 * deliberate: coherence is pure and testable without disk, while activation is
 * a compare-and-set against live authority, live Agents and the current
 * answers, so a stale screen can never talk the host into switching.
 *
 * Persistence copies `server/workspaces.ts`: one JSON file per organization
 * under the store, read on `init()`, written atomically on every change, with
 * an in-memory map as the read path. The routes already hold `store.locked()`,
 * so this service never takes the lock itself.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_REQUIREMENTS, type AgentRequirement } from '../shared/agents.js';
import type { BusinessAnswer } from '../shared/business-setup.js';
import { ROUTE_CAPABILITIES } from '../shared/capabilities.js';
import {
  ACTIVATION_CONFLICT,
  ANSWERS_MOVED,
  ROLLBACK_LIMITS,
  explainProposal,
  routeIsRemote,
  satisfiedRequirements,
  screenCandidate,
  validateProposal,
  type ConfigurationManifest,
  type ConfigurationOwner,
  type ConfigurationProposal,
  type ConfigurationView,
  type ProspectConfigurationView,
  type ReadinessReport,
  type ValidationContext,
  type ValidationResult,
} from '../shared/configuration.js';
import { ruleScopeSchema } from '../shared/connection-rules.js';
import { canConfigureOrganization, isActiveMember } from '../shared/workspaces.js';
import { payloadDigest } from './command-admission.js';
import { absent, ApiError } from './paths.js';
import { jsonWrite, readJson, type Store } from './store.js';
import { answersDigest, type WorkspaceService } from './workspaces.js';
import type { AgentRegistry } from './agents.js';
import {
  assertProspectProposal,
  type ProspectConfigurationSource,
} from './rehearsal/prospect-configuration.js';

/** One organization's durable configuration: every revision plus every activation outcome. */
interface StoredConfiguration {
  v: 1;
  owner?: ConfigurationOwner;
  organizationId: string | null;
  tenantId: string | null;
  manifests: ConfigurationManifest[];
  activations: Record<string, ActivationRecord>;
}

/**
 * What one activation id produced. Kept so a replayed request returns the
 * recorded manifest instead of preparing anything twice.
 */
export interface ActivationRecord {
  readonly activationId: string;
  readonly revision: number;
  readonly at: string;
  readonly by: string;
  readonly kind: 'activate' | 'rollback';
}

const ownerKey = (owner: ConfigurationOwner) =>
  owner.kind === 'organization'
    ? `organization:${owner.organizationId}`
    : `prospect:${owner.operatorId}:${owner.prospectId}`;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

const emptyStored = (owner: ConfigurationOwner): StoredConfiguration => ({
  v: 1,
  owner,
  organizationId: owner.kind === 'organization' ? owner.organizationId : null,
  tenantId: owner.kind === 'organization' ? owner.tenantId : null,
  manifests: [],
  activations: {},
});

const refuse = (
  status: number,
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
) => new ApiError(status, message, { code, ...extra });

/** A validation outcome as the manifest records it. */
function toReadiness(result: ValidationResult, checkedAt: string): ReadinessReport {
  return {
    ready: result.ok,
    blocking: result.problems.filter((item) => item.severity === 'blocking'),
    degraded: result.problems.filter((item) => item.severity === 'degraded'),
    degradedPlan: result.degradedPlan,
    checkedAt,
  };
}

export class ConfigurationService {
  private readonly files = new Map<string, StoredConfiguration>();

  constructor(
    private readonly store: Store,
    private readonly workspaces: WorkspaceService,
    private readonly agents: AgentRegistry,
    private readonly prospects?: ProspectConfigurationSource,
  ) {}

  private get root() {
    return path.join(this.store.dataDir, 'workspaces', 'configuration');
  }

  private get prospectRoot() {
    return path.join(this.store.dataDir, 'prospects', 'configuration');
  }

  private filePath(owner: ConfigurationOwner) {
    return owner.kind === 'organization'
      ? path.join(this.root, `${owner.organizationId}.json`)
      : path.join(this.prospectRoot, owner.operatorId, `${owner.prospectId}.json`);
  }

  /**
   * Load every organization's file. A missing directory is a fresh install.
   * A file from another contract version is refused loudly rather than
   * migrated silently, so no revision is ever reinterpreted under new rules.
   */
  async init(): Promise<void> {
    this.files.clear();
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if (!absent(error)) throw error;
      names = [];
    }
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const stored = await readJson<StoredConfiguration>(path.join(this.root, name), () => {
        throw new Error(`The stored configuration ${name} could not be read.`);
      });
      if (stored.v !== 1 || stored.organizationId !== name.slice(0, -'.json'.length))
        throw new Error(
          `The stored configuration ${name} was written by another build and was left alone.`,
        );
      stored.owner ??= {
        kind: 'organization',
        organizationId: stored.organizationId!,
        tenantId: stored.tenantId!,
      };
      stored.manifests ??= [];
      stored.activations ??= {};
      this.files.set(ownerKey(stored.owner), stored);
    }
    let operators: string[] = [];
    try {
      operators = await fs.readdir(this.prospectRoot);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    for (const operatorId of operators.sort()) {
      const directory = path.join(this.prospectRoot, operatorId);
      for (const name of (await fs.readdir(directory))
        .filter((item) => item.endsWith('.json'))
        .sort()) {
        const stored = await readJson<StoredConfiguration>(path.join(directory, name), () => {
          throw new Error(`The stored prospect configuration ${name} could not be read.`);
        });
        if (
          stored.v !== 1 ||
          stored.owner?.kind !== 'prospect' ||
          stored.owner.operatorId !== operatorId ||
          stored.owner.prospectId !== name.slice(0, -'.json'.length) ||
          stored.organizationId !== null ||
          stored.tenantId !== null
        )
          throw new Error(`The stored prospect configuration ${name} was left alone.`);
        this.files.set(ownerKey(stored.owner), stored);
      }
    }
  }

  private ownerFrom(input: string | ConfigurationOwner): ConfigurationOwner {
    if (typeof input !== 'string') {
      if (input.kind === 'organization') {
        const organization = this.workspaces.organization(input.organizationId);
        if (!organization || organization.tenantId !== input.tenantId)
          throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
      }
      if (
        input.kind === 'prospect' &&
        (!OWNER_ID.test(input.prospectId) || !OWNER_ID.test(input.operatorId))
      )
        throw refuse(404, 'That prospect is not available to this operator.', 'unknown_prospect');
      return input;
    }
    const organization = this.workspaces.organization(input);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    return { kind: 'organization', organizationId: input, tenantId: organization.tenantId };
  }

  history(input: string | ConfigurationOwner): ConfigurationManifest[] {
    const stored = this.files.get(ownerKey(this.ownerFrom(input)));
    return [...(stored?.manifests ?? [])].sort((a, b) => b.revision - a.revision);
  }

  active(input: string | ConfigurationOwner): ConfigurationManifest | null {
    return (
      this.files
        .get(ownerKey(this.ownerFrom(input)))
        ?.manifests.find((item) => item.state === 'active') ?? null
    );
  }

  staged(input: string | ConfigurationOwner): ConfigurationManifest | null {
    return (
      this.files
        .get(ownerKey(this.ownerFrom(input)))
        ?.manifests.find((item) => item.state === 'staged') ?? null
    );
  }

  /**
   * The validation context, built from live registries every time. Stored
   * configuration is never consulted: an Agent that changed since staging
   * must fail the next activation, not ride on an old reading.
   */
  async prospectSnapshot(owner: Extract<ConfigurationOwner, { kind: 'prospect' }>) {
    if (!this.prospects)
      throw refuse(
        409,
        'Prospect configuration is not connected in this build.',
        'prospect_unavailable',
      );
    const snapshot = await this.prospects.resolve(owner);
    if (
      snapshot.owner.prospectId !== owner.prospectId ||
      snapshot.owner.operatorId !== owner.operatorId ||
      snapshot.overlay.prospectId !== owner.prospectId
    )
      throw refuse(404, 'That prospect is not active for this operator.', 'unknown_prospect');
    return snapshot;
  }

  async context(input: string | ConfigurationOwner): Promise<ValidationContext> {
    const owner = this.ownerFrom(input);
    const organization =
      owner.kind === 'organization' ? this.workspaces.organization(owner.organizationId) : null;
    if (owner.kind === 'organization' && !organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    if (owner.kind === 'prospect') await this.prospectSnapshot(owner);
    const { agents } = await this.agents.list();
    const knownAgents: ValidationContext['knownAgents'] = new Map(
      agents.map((item) => [
        item.id,
        {
          version: item.version,
          digest: item.digest,
          requires: item.requires,
          permissionCeiling: item.permissionCeiling,
        },
      ]),
    );
    // Read the keys from the schema itself so a new scope never needs a second list.
    const knownRuleScopeKeys: ValidationContext['knownRuleScopeKeys'] = new Set(
      Object.keys(ruleScopeSchema.shape),
    );
    // Both readings come from the contract rather than from a rule repeated
    // here. They were written twice during this slice and disagreed about what
    // `unknown` means, which is precisely the kind of difference that decides
    // whether a local-only business stays local.
    const routeRequirements = new Map<string, ReadonlySet<AgentRequirement>>();
    const remoteRoutes = new Set<string>();
    for (const [routeId, capabilities] of Object.entries(ROUTE_CAPABILITIES)) {
      routeRequirements.set(routeId, satisfiedRequirements(capabilities));
      if (routeIsRemote(capabilities)) remoteRoutes.add(routeId);
    }
    return {
      owner,
      tenantId: owner.kind === 'organization' ? owner.tenantId : null,
      organizationId: owner.kind === 'organization' ? owner.organizationId : null,
      knownAgents,
      knownRuleScopeKeys,
      routeRequirements,
      remoteRoutes,
      // This build has no live business connections, so the honest answer is
      // that nothing is connected rather than an optimistic guess.
      connectedConnections: new Set(),
      maxBudgetUsd: 1_000_000,
      // Team execution would need a runner that actually carries a handoff
      // from one Agent to another; no such runner is installed here.
      teamExecutionAvailable: false,
    };
  }

  /**
   * Refuse anyone who may not change this business's setup, before any other
   * check runs.
   *
   * It is public so a route can ask first. The intake helper it would otherwise
   * fall through to answers "switch to that workspace first" — which is the
   * right answer for an owner in the wrong place, and a misleading one for
   * somebody who is not in the business at all.
   */
  assertMayConfigure(organizationId: string): void {
    this.configurer(organizationId);
  }

  private configurer(organizationId: string) {
    const organization = this.workspaces.organization(organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    if (!canConfigureOrganization(this.workspaces.membershipOf(organizationId)))
      throw refuse(
        403,
        'Only an owner or administrator may change this business setup.',
        'not_a_configurer',
      );
    return organization;
  }

  /** The intake owns the answers; configuration only compares against them. */
  private async currentAnswersDigest(owner: ConfigurationOwner): Promise<string> {
    if (owner.kind === 'prospect') return (await this.prospectSnapshot(owner)).answersDigest;
    // Read the stored intake directly so activation cannot outrun an edit the
    // in-memory view has not picked up yet. No intake means no answers.
    const setup = await readJson<{ answers?: Record<string, BusinessAnswer> } | null>(
      path.join(this.store.dataDir, 'workspaces', 'setup', `${owner.organizationId}.json`),
      () => null,
    );
    return answersDigest(setup?.answers ?? {});
  }

  private async persist(owner: ConfigurationOwner, stored: StoredConfiguration) {
    await jsonWrite(this.filePath(owner), stored);
    this.files.set(ownerKey(owner), stored);
  }

  async stage(
    input: string | ConfigurationOwner,
    proposal: ConfigurationProposal,
  ): Promise<ConfigurationManifest> {
    const owner = this.ownerFrom(input);
    if (owner.kind === 'organization') this.configurer(owner.organizationId);
    const prospect = owner.kind === 'prospect' ? await this.prospectSnapshot(owner) : null;
    if (
      owner.kind === 'organization' &&
      (proposal.organizationId !== owner.organizationId || proposal.tenantId !== owner.tenantId)
    )
      throw refuse(
        400,
        'This proposal belongs to a different business and cannot be staged here.',
        'tenant_mismatch',
      );
    if (prospect) assertProspectProposal(proposal, prospect);
    // Screening runs before anything is written: an unsafe candidate leaves no
    // trace on disk, not even an empty file for the organization.
    const refusals = screenCandidate(proposal);
    if (refusals.length > 0)
      throw refuse(
        400,
        `This setup cannot be staged: ${refusals.map((item) => `${item.field} — ${item.message}`).join(' ')}`,
        'unsafe_candidate',
        { fields: refusals.map((item) => item.field) },
      );
    const readiness = toReadiness(
      validateProposal(proposal, await this.context(owner)),
      new Date().toISOString(),
    );
    // A proposal that fails validation is still staged, with ready false and
    // its blocking problems recorded, because a person needs to see why.
    const at = new Date().toISOString();
    const stored = this.files.get(ownerKey(owner)) ?? emptyStored(owner);
    const manifests = stored.manifests.map((item) =>
      // Only one manifest may be staged: the newcomer supersedes its
      // predecessor in the same write.
      item.state === 'staged' ? { ...item, state: 'superseded' as const, supersededAt: at } : item,
    );
    const manifest: ConfigurationManifest = {
      v: 1,
      owner,
      organizationId: owner.kind === 'organization' ? owner.organizationId : null,
      tenantId: owner.kind === 'organization' ? owner.tenantId : null,
      revision: manifests.reduce((highest, item) => Math.max(highest, item.revision), 0) + 1,
      digest: payloadDigest(proposal),
      state: 'staged',
      proposal,
      readiness,
      stagedAt: at,
      stagedBy:
        owner.kind === 'organization' ? this.workspaces.currentPerson().id : owner.operatorId,
      activatedAt: null,
      activatedBy: null,
      activationId: null,
      supersededAt: null,
      failureReason: null,
    };
    manifests.push(manifest);
    if (owner.kind === 'prospect')
      assertProspectProposal(proposal, await this.prospectSnapshot(owner));
    await this.persist(owner, { ...stored, owner, manifests });
    return manifest;
  }

  async activate(
    ownerInput: string | ConfigurationOwner,
    input: { revision: number; expectedActiveRevision: number | null; activationId: string },
  ): Promise<ConfigurationManifest> {
    // Authority gates every path, replay included: a replay still hands back a
    // manifest, and someone who has lost membership must not receive one.
    const owner = this.ownerFrom(ownerInput);
    if (owner.kind === 'organization') this.configurer(owner.organizationId);
    const prospect = owner.kind === 'prospect' ? await this.prospectSnapshot(owner) : null;
    // Then replay: a recorded activation id returns its manifest unchanged,
    // without a second revision, a second preparation or any write at all.
    const replayed = this.recorded(owner, input.activationId);
    if (replayed) return replayed;
    const stored = this.files.get(ownerKey(owner)) ?? emptyStored(owner);
    const current = stored.manifests.find((item) => item.state === 'active') ?? null;
    if (input.expectedActiveRevision !== (current ? current.revision : null))
      throw refuse(409, ACTIVATION_CONFLICT, 'stale_configuration', {
        expectedActiveRevision: current ? current.revision : null,
      });
    const target = stored.manifests.find((item) => item.revision === input.revision) ?? null;
    if (!target || target.state !== 'staged')
      throw refuse(409, 'That setup is no longer staged, so it cannot be activated.', 'not_staged');
    // Re-validate against a freshly built context: an Agent that changed
    // revision since staging fails here as a stale-agent problem.
    const checkedAt = new Date().toISOString();
    if (prospect) assertProspectProposal(target.proposal, prospect);
    const result = validateProposal(target.proposal, await this.context(owner));
    if (!result.ok) {
      const blocking = result.problems.filter((item) => item.severity === 'blocking');
      throw refuse(
        409,
        `This setup is not ready to activate: ${blocking.map((item) => item.message).join(' ')}`,
        'not_ready',
        { blocking },
      );
    }
    if (target.proposal.answersDigest !== (await this.currentAnswersDigest(owner)))
      throw refuse(409, ANSWERS_MOVED, 'answers_moved');
    if (owner.kind === 'prospect')
      assertProspectProposal(target.proposal, await this.prospectSnapshot(owner));
    // Only now, in a single write: the previous active setup is superseded and
    // this one becomes active. Every refusal above leaves it untouched.
    const by =
      owner.kind === 'organization' ? this.workspaces.currentPerson().id : owner.operatorId;
    const readiness = toReadiness(result, checkedAt);
    const manifests = stored.manifests.map((item) => {
      if (item.revision === target.revision)
        return {
          ...item,
          state: 'active' as const,
          readiness,
          activatedAt: checkedAt,
          activatedBy: by,
          activationId: input.activationId,
        };
      if (item.state === 'active')
        return { ...item, state: 'superseded' as const, supersededAt: checkedAt };
      return item;
    });
    const activations = {
      ...stored.activations,
      [input.activationId]: {
        activationId: input.activationId,
        revision: target.revision,
        at: checkedAt,
        by,
        kind: 'activate' as const,
      },
    };
    await this.persist(owner, { ...stored, owner, manifests, activations });
    return manifests.find((item) => item.revision === target.revision)!;
  }

  async rollback(
    ownerInput: string | ConfigurationOwner,
    input: { toRevision: number; expectedActiveRevision: number | null; activationId: string },
  ): Promise<ConfigurationManifest> {
    // Same order as `activate`: authority first, then replay. Rolling back is
    // still a read of this organization's history.
    const owner = this.ownerFrom(ownerInput);
    if (owner.kind === 'organization') this.configurer(owner.organizationId);
    const prospect = owner.kind === 'prospect' ? await this.prospectSnapshot(owner) : null;
    const replayed = this.recorded(owner, input.activationId);
    if (replayed) return replayed;
    const stored = this.files.get(ownerKey(owner)) ?? emptyStored(owner);
    const current = stored.manifests.find((item) => item.state === 'active') ?? null;
    if (input.expectedActiveRevision !== (current ? current.revision : null))
      throw refuse(409, ACTIVATION_CONFLICT, 'stale_configuration', {
        expectedActiveRevision: current ? current.revision : null,
      });
    const target = stored.manifests.find((item) => item.revision === input.toRevision) ?? null;
    if (!target || target.state === 'failed')
      throw refuse(409, 'That setup cannot be brought back.', 'not_staged');
    if (target.state === 'active') throw refuse(409, 'That setup is already active.', 'not_staged');
    // A configuration that was valid before may not be valid now: rolling back
    // must not smuggle a stale Agent revision back into service.
    const checkedAt = new Date().toISOString();
    if (prospect) assertProspectProposal(target.proposal, prospect);
    const result = validateProposal(target.proposal, await this.context(owner));
    if (!result.ok) {
      const blocking = result.problems.filter((item) => item.severity === 'blocking');
      throw refuse(
        409,
        `That earlier setup is no longer valid: ${blocking.map((item) => item.message).join(' ')}`,
        'not_ready',
        { blocking },
      );
    }
    if (target.proposal.answersDigest !== (await this.currentAnswersDigest(owner)))
      throw refuse(409, ANSWERS_MOVED, 'answers_moved');
    if (owner.kind === 'prospect')
      assertProspectProposal(target.proposal, await this.prospectSnapshot(owner));
    const by =
      owner.kind === 'organization' ? this.workspaces.currentPerson().id : owner.operatorId;
    // Going back restores the setup on this computer only. Say so on the
    // manifest itself, where the person approving the rollback will read it.
    const checked = toReadiness(result, checkedAt);
    const readiness: ReadinessReport = {
      ...checked,
      degradedPlan: checked.degradedPlan
        ? `${checked.degradedPlan}\n\n${ROLLBACK_LIMITS}`
        : ROLLBACK_LIMITS,
    };
    const manifests = stored.manifests.map((item) => {
      if (item.revision === target.revision)
        return {
          ...item,
          state: 'active' as const,
          readiness,
          activatedAt: checkedAt,
          activatedBy: by,
          activationId: input.activationId,
        };
      if (item.state === 'active')
        return { ...item, state: 'superseded' as const, supersededAt: checkedAt };
      return item;
    });
    const activations = {
      ...stored.activations,
      [input.activationId]: {
        activationId: input.activationId,
        revision: target.revision,
        at: checkedAt,
        by,
        kind: 'rollback' as const,
      },
    };
    await this.persist(owner, { ...stored, owner, manifests, activations });
    return manifests.find((item) => item.revision === target.revision)!;
  }

  /**
   * The manifest one activation id produced *in this organization*.
   *
   * Scoped deliberately. An earlier pass searched every stored file, which made
   * an activation id a bearer token: replay is checked before anything else, so
   * quoting an id recorded under another business returned that business's
   * manifest — its rules, budget and approvers included. An id is an
   * idempotency key, not a capability, and it means nothing outside the
   * organization it was recorded against.
   */
  private recorded(owner: ConfigurationOwner, activationId: string): ConfigurationManifest | null {
    const stored = this.files.get(ownerKey(owner));
    const record = stored?.activations[activationId];
    if (!record) return null;
    return stored?.manifests.find((item) => item.revision === record.revision) ?? null;
  }

  /**
   * What one business's setup looks like to somebody who works in it.
   *
   * Reading is gated on active membership, not on the right to change things: a
   * member should be able to see the configuration their work runs under, and
   * only an owner or administrator may stage or activate one. The check is here
   * rather than in the route because this returns the whole proposal — its
   * rules, budget and approvers — and an earlier pass that checked only whether
   * the organization existed handed all of that to anyone who knew its id.
   */
  view(organizationId: string): ConfigurationView {
    const organization = this.workspaces.organization(organizationId);
    if (!organization)
      throw refuse(404, 'That business workspace does not exist here.', 'unknown_organization');
    if (!isActiveMember(this.workspaces.membershipOf(organizationId)))
      throw refuse(403, 'You are not a member of this business workspace.', 'not_a_member');
    const active = this.active(organizationId);
    const staged = this.staged(organizationId);
    const canActivate = staged !== null && staged.readiness.ready;
    return {
      organization: { id: organization.id, name: organization.name },
      active,
      staged,
      changes: staged ? explainProposal(active?.proposal ?? null, staged.proposal) : [],
      expectedActiveRevision: active ? active.revision : null,
      canActivate,
      whyNot: canActivate
        ? null
        : staged === null
          ? 'There is no staged setup to activate yet.'
          : 'The staged setup is not ready to activate. Read its blocking problems first.',
    };
  }

  /** Fresh FD02 ownership is checked before returning any prospect configuration bytes. */
  async prospectView(
    owner: Extract<ConfigurationOwner, { kind: 'prospect' }>,
  ): Promise<ProspectConfigurationView> {
    const snapshot = await this.prospectSnapshot(owner);
    const active = this.active(owner);
    const staged = this.staged(owner);
    const canActivate = staged !== null && staged.readiness.ready;
    return {
      owner,
      prospect: { id: owner.prospectId, name: snapshot.name },
      active,
      staged,
      changes: staged ? explainProposal(active?.proposal ?? null, staged.proposal) : [],
      expectedActiveRevision: active?.revision ?? null,
      canActivate,
      whyNot: canActivate
        ? null
        : staged === null
          ? 'There is no staged prospect rehearsal setup to activate yet.'
          : 'The staged prospect rehearsal setup is not ready to activate.',
    };
  }
}
