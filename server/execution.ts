/**
 * Resolving one admitted unit of work from the services that already exist.
 *
 * There is no `ExecutionService` here, and that is the point. Membership lives
 * in `server/workspaces.ts`, the Agent in `server/agents.ts`, the setup in
 * `server/configuration.ts`, authority in `server/trust/`, rules in
 * `server/rules.ts` and the run budget in `server/harness/run-service.ts`. A
 * seventh owner that re-derived any of them would be a second answer to a
 * question that already has one, and the weaker answer is the one an attacker
 * would use. So this file is functions: it reads what those services said and
 * writes down the single record the rest of the work carries.
 *
 * The three gates are separate functions on purpose, and each says what it
 * answered. Entitlement is about a purchased feature. Trust is about an action
 * on data. Budget is about who pays. They are asked in that order and combined
 * by `admit`, which requires every gate that has something to decide — a
 * caller that forgets one gets a refusal, not free inference.
 *
 * Two of them refuse things this build genuinely cannot do, and say so in those
 * words rather than pretending. There is no entitlement service, so managed
 * inference is unavailable. There is no spend ledger — `HarnessBudget` counts
 * units, model calls and tool calls, and `shared/harness.ts` says outright that
 * money is not accounted — so company-funded inference cannot be admitted.
 * Work on the account already signed in on this machine is unaffected, which is
 * the path that actually runs today.
 */
import type { AgentResolution } from '../shared/agents.js';
import type { GoverningRecord } from '../shared/rule-authority.js';
import type { HarnessBudget } from '../shared/harness.js';
import {
  admit,
  payerFor,
  type ExecutionResolution,
  type GateResult,
  type LiveAuthority,
  type Payer,
  type ResolvedTeam,
} from '../shared/execution.js';
import {
  NO_ENTITLEMENT_REASON,
  type EntitlementView,
  type MemberRole,
  type MembershipState,
  type WorkspaceRef,
} from '../shared/workspaces.js';
import { ROUTE_CAPABILITIES } from '../shared/capabilities.js';
import {
  isDenial,
  type Authority,
  type Capability,
  type Denial,
  type Generation,
} from './trust/index.js';

// --- the gates ----------------------------------------------------------------

/**
 * Whether the business bought the feature this work needs.
 *
 * Almost nothing needs one today: the work that runs in this build runs through
 * an account the person already has. The gate exists so that the one thing that
 * *would* need an entitlement — Diomedes paying for the inference — is refused
 * in the right place, with the reason `shared/workspaces.ts` already gives,
 * rather than failing later as a mysterious budget error.
 */
export function entitlementGate(input: {
  workspace: WorkspaceRef;
  entitlement: EntitlementView;
  needsManagedInference: boolean;
}): GateResult {
  if (!input.needsManagedInference)
    return {
      gate: 'entitlement',
      verdict: 'not-required',
      required: false,
      reason: 'This work does not need a purchased entitlement.',
      answered: 'Whether an entitlement is needed for this work: no.',
    };
  if (input.workspace.kind !== 'business')
    return {
      gate: 'entitlement',
      verdict: 'refused',
      required: true,
      reason: 'Diomedes-funded model access belongs to a business, and this is personal work.',
      answered: 'Whether this workspace could hold an entitlement: no.',
    };
  if (input.entitlement.managedInference)
    return {
      gate: 'entitlement',
      verdict: 'passed',
      required: true,
      reason: 'This business has included model usage.',
      answered: 'Whether the entitlement covers managed model access: yes.',
    };
  return {
    gate: 'entitlement',
    verdict: 'refused',
    required: true,
    reason: input.entitlement.reason,
    answered: 'Whether the entitlement covers managed model access: no.',
  };
}

/**
 * Whether this principal may take this action on this data, right now.
 *
 * A denial from `server/trust/` is passed through with its own wording. Nothing
 * here re-reads a principal, softens a reason or falls back to a weaker check:
 * Trust is the authority and this only records what it said.
 */
export function trustGate(input: {
  authority: Authority | Denial;
  required: Capability;
}): GateResult {
  if (isDenial(input.authority))
    return {
      gate: 'trust',
      verdict: 'refused',
      required: true,
      reason: input.authority.reason,
      answered: `Whether this person may ${input.required}: no.`,
    };
  if (!input.authority.capabilities.has(input.required))
    return {
      gate: 'trust',
      verdict: 'refused',
      required: true,
      reason: `This work needs ${input.required}, which nobody has granted here. Approve it to continue.`,
      answered: `Whether this person may ${input.required}: no.`,
    };
  return {
    gate: 'trust',
    verdict: 'passed',
    required: true,
    reason: `Permitted to ${input.required}.`,
    answered: `Whether this person may ${input.required}: yes.`,
  };
}

/**
 * Whether somebody will pay for this, and whether the run has room left.
 *
 * The `organization` payer is refused rather than approximated. Doing anything
 * else would mean this build reporting a company allowance it has no way to
 * count, and the first person to find out would be whoever gets the bill.
 */
export function budgetGate(input: {
  payer: Payer;
  harnessBudget: HarnessBudget | null;
  entitlement: EntitlementView;
}): GateResult {
  if (input.payer.kind === 'organization' && !input.entitlement.managedInference)
    return {
      gate: 'budget',
      verdict: 'refused',
      required: true,
      reason: `This would be charged to the business, and there is no allowance to charge it against. ${NO_ENTITLEMENT_REASON}`,
      answered: 'Who pays and whether there is room: nobody could be charged.',
    };
  if (input.payer.kind === 'local-machine')
    return {
      gate: 'budget',
      verdict: 'passed',
      required: true,
      reason: 'This runs on your machine, so nothing is spent.',
      answered: 'Who pays and whether there is room: nobody is charged.',
    };
  if (!input.harnessBudget)
    return {
      gate: 'budget',
      verdict: 'refused',
      required: true,
      reason: 'This work has no limit set on it, so it was not started.',
      answered: 'Who pays and whether there is room: no limit was set.',
    };
  if (input.harnessBudget.modelCalls <= 0 || input.harnessBudget.units <= 0)
    return {
      gate: 'budget',
      verdict: 'refused',
      required: true,
      reason:
        'This work has already used everything it was allowed. Start it again to give it more.',
      answered: 'Who pays and whether there is room: no room left.',
    };
  return {
    gate: 'budget',
    verdict: 'passed',
    required: true,
    reason: input.payer.reason,
    answered: `Who pays and whether there is room: the account on this computer, within ${input.harnessBudget.modelCalls} model calls.`,
  };
}

// --- the resolution -----------------------------------------------------------

export interface ResolveExecutionInput {
  readonly principal: Authority | Denial;
  readonly workspace: WorkspaceRef;
  readonly membership: { readonly role: MemberRole; readonly state: MembershipState } | null;
  readonly configuration: {
    readonly organizationId: string;
    readonly revision: number;
    readonly digest: string;
  } | null;
  readonly entitlement: EntitlementView;
  readonly agent: AgentResolution;
  readonly team: ResolvedTeam | null;
  readonly rules: { readonly revision: string; readonly governing: readonly GoverningRecord[] };
  readonly context: { readonly scopeIds: readonly string[]; readonly instructionRevision: string };
  readonly harnessBudget: HarnessBudget | null;
  readonly requiredCapability: Capability;
  /** True only where Diomedes itself would be paying for the inference. */
  readonly needsManagedInference: boolean;
  readonly at: string;
}

/**
 * Write down what was true when this work was admitted.
 *
 * The record is never consulted again as authority — `recheckAtEffect` asks the
 * live services instead. It is kept so attribution stays truthful: which
 * worker, which model choice, whose setup, whose money, and what each gate
 * actually said, even after somebody switches workspace or edits an Agent.
 */
export function resolveExecution(input: ResolveExecutionInput): ExecutionResolution {
  const denied = isDenial(input.principal);
  const payer = payerFor({
    routeId: input.agent.routeId,
    workspace: input.workspace,
    managedInference: input.entitlement.managedInference,
  });
  const gates: GateResult[] = [
    entitlementGate({
      workspace: input.workspace,
      entitlement: input.entitlement,
      needsManagedInference: input.needsManagedInference,
    }),
    trustGate({ authority: input.principal, required: input.requiredCapability }),
    budgetGate({
      payer,
      harnessBudget: input.harnessBudget,
      entitlement: input.entitlement,
    }),
  ];
  return {
    v: 1,
    resolvedAt: input.at,
    principal: denied
      ? {
          kind: 'unknown',
          id: 'unknown',
          tenantId: null,
          assurance: 'none',
        }
      : {
          kind: input.principal.principal.kind,
          id: input.principal.principal.id,
          tenantId: input.principal.principal.tenantId,
          assurance: input.principal.assurance,
        },
    workspace: input.workspace,
    membership: input.membership,
    configuration: input.configuration,
    agent: {
      agentId: input.agent.agentId,
      agentVersion: input.agent.agentVersion,
      agentDigest: input.agent.agentDigest,
      agentName: input.agent.agentName,
      agentSelection: input.agent.agentSelection,
      effectivePermission: input.agent.policy.effective,
    },
    team: input.team,
    route: {
      routeId: input.agent.routeId,
      requestedModel: input.agent.requestedModel,
      modelSelection: input.agent.modelSelection,
    },
    rules: input.rules,
    context: input.context,
    payer,
    // Money is not accounted anywhere in this build, so there is no reservation
    // to record. A null here means "nothing was reserved", never "nothing costs".
    budget: null,
    gates: Object.freeze(gates),
    admitted: admit(gates).admitted,
  };
}

// --- what is true now ---------------------------------------------------------

/**
 * Gather the live values the effect-boundary recheck compares against.
 *
 * Every field is read from something current: Trust for the generation,
 * `server/workspaces.ts` for membership, `server/configuration.ts` for the
 * active revision, `server/agents.ts` for the digest on disk. Nothing is copied
 * out of the resolution, because a recheck that reads the snapshot cannot
 * detect that the snapshot is stale.
 */
export interface LiveAuthorityInput {
  readonly authority: Authority | Denial;
  /** The generation captured when the reference was minted. */
  readonly mintedGeneration: Generation;
  readonly membershipState: MembershipState | null;
  readonly activeConfigurationRevision: number | null;
  readonly currentAgentDigest: string | null;
  readonly grantRevoked: boolean;
  readonly routeId: string;
  readonly budgetRemainingUsd: number | null;
}

export function liveAuthorityFor(input: LiveAuthorityInput): LiveAuthority {
  const denied = isDenial(input.authority);
  const route = ROUTE_CAPABILITIES[input.routeId];
  return {
    tenantId: denied ? null : input.authority.principal.tenantId,
    membershipState: input.membershipState,
    configurationRevision: input.activeConfigurationRevision,
    agentDigest: input.currentAgentDigest,
    grantRevoked: input.grantRevoked,
    generationAdvanced: denied
      ? true
      : input.authority.generation.identity !== input.mintedGeneration.identity ||
        input.authority.generation.principal !== input.mintedGeneration.principal,
    budgetRemainingUsd: input.budgetRemainingUsd,
    // An unmeasured route is reported as unproven, not as safe.
    revocationProven: route?.revocationStopsFutureEffects.answer === 'yes',
  };
}
