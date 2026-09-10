/**
 * What each execution route can actually do, and what a permission option may
 * therefore truthfully offer.
 *
 * This is deliberately not a list of folders. `Full access` is a claim about an
 * *environment*, not about a wider root set, so it is answered by capability
 * facts with a recorded basis. `shared/harness.ts` ADAPTER_CAPABILITIES answers
 * "what does the run service account for"; this answers "what could this route
 * do to the machine, and can Diomedes stop it".
 *
 * Sources for every fact below are named in `evidence`. Nothing here is a
 * marketing label: `diomedes-enforced` means Diomedes' own code is the boundary
 * and a test covers it; `engine-reported` means the engine says so and Diomedes
 * checks the report; `instruction-only` means a prompt asks; `not-implemented`
 * means the route has no such thing; `not-measured` means nobody has proved it.
 */
export type CapabilityAnswer = 'yes' | 'no' | 'unknown';
export type CapabilityBasis =
  | 'diomedes-enforced'
  | 'engine-reported'
  | 'instruction-only'
  | 'not-implemented'
  | 'not-measured';
export interface CapabilityFact {
  readonly answer: CapabilityAnswer;
  readonly basis: CapabilityBasis;
  readonly evidence: string;
}
/** The questions a permission option must be able to answer before it is offered. */
export interface RouteCapabilities {
  readonly routeId: string;
  readonly name: string;
  /** Text proposals reach the project only through Store.writeRecorded. */
  readonly storeOnlyWrites: CapabilityFact;
  readonly spawnsProcesses: CapabilityFact;
  readonly runsShellCommands: CapabilityFact;
  readonly arbitraryFilesystem: CapabilityFact;
  readonly network: CapabilityFact;
  readonly receivesSecrets: CapabilityFact;
  /** Can an effect be seen and refused before it happens? */
  readonly preExecutionInterception: CapabilityFact;
  readonly revocationStopsFutureEffects: CapabilityFact;
  readonly effectProof: CapabilityFact;
  readonly osSandbox: CapabilityFact;
  readonly disposableEnvironment: CapabilityFact;
  readonly hostRootBoundary: CapabilityFact;
  /** What stays unknown after Diomedes hands the request over. */
  readonly uncertaintyAfterDispatch: string;
}

const fact = (
  answer: CapabilityAnswer,
  basis: CapabilityBasis,
  evidence: string,
): CapabilityFact => ({ answer, basis, evidence });

/**
 * No supported route runs inside an isolation boundary Diomedes owns. This
 * block is shared because the reason is identical everywhere: there is no
 * environment provider in this codebase. A worktree is edit isolation.
 */
const NO_ISOLATION = {
  osSandbox: fact(
    'no',
    'not-implemented',
    'Diomedes starts engine processes under the current user account (server/engines/process.ts, server/integrations.ts nativeEnvironment). A git worktree is edit isolation, not OS containment.',
  ),
  disposableEnvironment: fact(
    'no',
    'not-implemented',
    'There is no environment provider: no image, snapshot, container or virtual machine lifecycle exists in this codebase.',
  ),
  hostRootBoundary: fact(
    'no',
    'not-implemented',
    'Diomedes enforces project-relative paths for its own writer only (server/paths.ts). It does not confine an engine process to a host root.',
  ),
} as const;

export const ROUTE_CAPABILITIES: Record<string, RouteCapabilities> = {
  codex: {
    routeId: 'codex',
    name: 'Codex, ChatGPT account',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'Work returns a text proposal; only Store.writeRecorded applies it, after an exact receipt or a scoped authorization (server/native-work.ts, server/store.ts).',
    ),
    spawnsProcesses: fact(
      'no',
      'engine-reported',
      'The thread configuration disables the shell tool, apps, plugins, hooks and every inherited MCP entry; that inventory is the runtime report, not a protocol-level proof (server/integrations.ts SAFE_CONFIG).',
    ),
    runsShellCommands: fact(
      'no',
      'engine-reported',
      'features.shell_tool=false and sandbox_mode=read-only, checked by a write-denial probe before each run (verifySandbox). That is the engine sandbox, not one Diomedes owns.',
    ),
    arbitraryFilesystem: fact(
      'no',
      'engine-reported',
      'sandbox_mode=read-only passes a Windows write-denial probe. Reads outside the project are not prevented by Diomedes.',
    ),
    network: fact(
      'unknown',
      'engine-reported',
      'web_search=disabled and the runtime echoes networkAccess=false; the app-server still reaches its provider itself and no outbound probe has been run.',
    ),
    receivesSecrets: fact(
      'no',
      'diomedes-enforced',
      'nativeEnvironment() allow-lists the child environment; no API key, token, proxy or provider endpoint is transplanted (server/integrations.ts).',
    ),
    preExecutionInterception: fact(
      'yes',
      'diomedes-enforced',
      'The only supported effect is a bounded text write, and it passes deterministic policy plus a final-effect recheck before any byte lands (server/trust/scope-grants.ts assertCurrent).',
    ),
    revocationStopsFutureEffects: fact(
      'yes',
      'diomedes-enforced',
      'Revocation clears the live lease and the write boundary refuses; provider work already dispatched may still finish (server/permission-routes.ts).',
    ),
    effectProof: fact(
      'yes',
      'diomedes-enforced',
      'Before and after content objects, an action digest and a History entry record exactly which bytes were written (server/store.ts).',
    ),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch:
      'Provider work already sent can complete and be charged after Stop. Whether the app-server reached the network for anything else is reported, not measured.',
  },
  'claude-code': {
    routeId: 'claude-code',
    name: 'Claude Code',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'The imported adapter returns text; exact Store review is required and scoped automatic writes are unsupported on this route (server/engines/claude.ts).',
    ),
    spawnsProcesses: fact(
      'unknown',
      'engine-reported',
      'Diomedes passes an empty --tools list with --strict-mcp-config and --disable-slash-commands for its own text request. Those flags bound this request; they are not a containment proof for the command-line tool.',
    ),
    runsShellCommands: fact(
      'unknown',
      'engine-reported',
      'This request asks for no tools. A no-tool flag on one invocation is not evidence that the tool cannot run commands.',
    ),
    arbitraryFilesystem: fact(
      'unknown',
      'not-measured',
      'The child runs as the current user with --safe-mode and empty setting sources. Diomedes does not confine its paths.',
    ),
    network: fact(
      'unknown',
      'not-measured',
      'The tool reaches its own provider; no egress probe has been run.',
    ),
    receivesSecrets: fact(
      'no',
      'diomedes-enforced',
      'The adapter writes its own mcp-config and settings files and passes no Diomedes credential (server/engines/claude.ts).',
    ),
    preExecutionInterception: fact(
      'yes',
      'diomedes-enforced',
      'Only an exact human-approved text proposal can write, through the same Store path.',
    ),
    revocationStopsFutureEffects: fact(
      'unknown',
      'not-measured',
      'Owned process stop has protocol fixtures; no scoped grant exists on this route to revoke.',
    ),
    effectProof: fact(
      'yes',
      'diomedes-enforced',
      'Any applied change is a Store write with before and after objects.',
    ),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch:
      'What the tool did inside its own process is not observed. Provider quota and live inference behaviour are unverified.',
  },
  opencode: {
    routeId: 'opencode',
    name: 'OpenCode',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'Text adapter over the local service; exact Store review remains required and task grants are unsupported (server/engines/opencode.ts).',
    ),
    spawnsProcesses: fact(
      'unknown',
      'engine-reported',
      'Diomedes runs the service on loopback in pure mode for its own request. That is a service mode, not a containment guarantee.',
    ),
    runsShellCommands: fact(
      'unknown',
      'not-measured',
      'No tool inventory has been proved for this route.',
    ),
    arbitraryFilesystem: fact(
      'unknown',
      'not-measured',
      'The service runs as the current user.',
    ),
    network: fact(
      'unknown',
      'not-measured',
      'Go is a provider route; no egress probe has been run.',
    ),
    receivesSecrets: fact(
      'no',
      'diomedes-enforced',
      'No Diomedes credential is passed to the service.',
    ),
    preExecutionInterception: fact(
      'yes',
      'diomedes-enforced',
      'Only an exact human-approved text proposal can write.',
    ),
    revocationStopsFutureEffects: fact(
      'unknown',
      'not-measured',
      'No scoped grant exists on this route.',
    ),
    effectProof: fact('yes', 'diomedes-enforced', 'Applied changes are Store writes.'),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch:
      'Metadata can time out, and unknown stays unready. Provider billing and live inference are unverified.',
  },
  'oh-my-pi': {
    routeId: 'oh-my-pi',
    name: 'oh-my-pi',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'RPC text adapter; exact Store review remains required and task grants are unsupported (server/engines/omp.ts).',
    ),
    spawnsProcesses: fact(
      'unknown',
      'engine-reported',
      'Diomedes passes no-tools, no-extensions, no-skills, no-rules, no-lsp and no-pty for its request. Those bound the request, not the binary.',
    ),
    runsShellCommands: fact(
      'unknown',
      'engine-reported',
      'The no-pty and no-tools flags apply to this invocation only.',
    ),
    arbitraryFilesystem: fact(
      'unknown',
      'not-measured',
      'A separate profile directory is used; paths are not confined by Diomedes.',
    ),
    network: fact('unknown', 'not-measured', 'No egress probe has been run.'),
    receivesSecrets: fact(
      'no',
      'diomedes-enforced',
      'A separate configuration overlay is written; no Diomedes credential is passed.',
    ),
    preExecutionInterception: fact(
      'yes',
      'diomedes-enforced',
      'Only an exact human-approved text proposal can write.',
    ),
    revocationStopsFutureEffects: fact(
      'unknown',
      'not-measured',
      'No scoped grant exists on this route.',
    ),
    effectProof: fact('yes', 'diomedes-enforced', 'Applied changes are Store writes.'),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch:
      'An unconfigured profile is not a working account. Quota and live inference are unverified.',
  },
  'harness-runtime': {
    routeId: 'harness-runtime',
    name: 'Diomedes Runtime harness',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'Registered tools write only through the journaled bridge and Store (server/harness/run-service.ts, server/harness/bridge.ts).',
    ),
    spawnsProcesses: fact(
      'no',
      'diomedes-enforced',
      'Only tools present in the host registry at start can run, and no process-spawn tool exists (server/harness/tools.ts).',
    ),
    runsShellCommands: fact(
      'no',
      'diomedes-enforced',
      'No shell tool is registered. A capability manifest naming an unknown tool is refused at start.',
    ),
    arbitraryFilesystem: fact(
      'no',
      'diomedes-enforced',
      'Tool intents carry a label and a destination and pass authorize() before any handler (server/harness/policy.ts).',
    ),
    network: fact(
      'no',
      'diomedes-enforced',
      'An external destination needs an egress check supplied by the trusted host; a missing label is untrusted and restricted.',
    ),
    receivesSecrets: fact(
      'no',
      'diomedes-enforced',
      'Secrets are brokered by the host; a step intent carries no credential (server/secrets.ts).',
    ),
    preExecutionInterception: fact(
      'yes',
      'diomedes-enforced',
      'authorize() is mandatory and runs before every optional hook and handler.',
    ),
    revocationStopsFutureEffects: fact(
      'yes',
      'diomedes-enforced',
      'identityGeneration invalidates approvals bound to an older grant generation.',
    ),
    effectProof: fact(
      'yes',
      'diomedes-enforced',
      'Every step has a persisted intent, observation and cursor.',
    ),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch:
      'Model calls inside a delegated engine are not steps. External-effect exactly-once is not implemented; uncertain dispatch parks for reconciliation.',
  },
  sample: {
    routeId: 'sample',
    name: 'Sample worker',
    storeOnlyWrites: fact(
      'yes',
      'diomedes-enforced',
      'Deterministic in-process worker; writes only through Store after the Need is answered (server/work.ts).',
    ),
    spawnsProcesses: fact('no', 'diomedes-enforced', 'No child process is created.'),
    runsShellCommands: fact('no', 'diomedes-enforced', 'No shell path exists.'),
    arbitraryFilesystem: fact('no', 'diomedes-enforced', 'Only project-relative Store writes.'),
    network: fact('no', 'diomedes-enforced', 'No network call is made.'),
    receivesSecrets: fact('no', 'diomedes-enforced', 'No credential is read.'),
    preExecutionInterception: fact('yes', 'diomedes-enforced', 'The Need gates every write.'),
    revocationStopsFutureEffects: fact('yes', 'diomedes-enforced', 'Stop ends the staged worker.'),
    effectProof: fact('yes', 'diomedes-enforced', 'Store history records the bytes.'),
    ...NO_ISOLATION,
    uncertaintyAfterDispatch: 'None: there is no external party, and this route has no model.',
  },
};

/**
 * An execution environment Diomedes could hand unrestricted authority to.
 * Nothing in this codebase constructs one; `server/trust/environments.ts` is
 * the single source and it returns an empty list with its reason. The shape
 * exists so the Full access predicate is a real check rather than a promise.
 */
export interface IsolatedEnvironment {
  readonly id: string;
  readonly name: string;
  /** How the boundary is implemented. Only `os-sandbox` and `virtual-machine` can contain a shell. */
  readonly kind: 'os-sandbox' | 'container' | 'virtual-machine';
  /** Restoring the environment must undo every effect inside it. */
  readonly disposable: boolean;
  /** The host path tree the environment may reach at all. */
  readonly hostRoot: string | null;
  /** Diomedes must be able to see an effect before it happens. */
  readonly interceptsEffects: boolean;
  /** Revocation must stop future effects inside the environment. */
  readonly revocable: boolean;
  /** A recorded, checkable statement of which effects actually happened. */
  readonly effectLedger: boolean;
  /** Which check proved the boundary, and when. Never a prompt or a flag name. */
  readonly attestation: { readonly method: string; readonly checkedAt: string } | null;
}

export const FULL_ACCESS_PREREQUISITES = [
  {
    id: 'isolated-environment',
    requirement: 'A named execution environment with an OS, process or virtual-machine boundary.',
    why: 'Unrestricted commands need a boundary that is not a prompt, a flag or a worktree.',
  },
  {
    id: 'attested-boundary',
    requirement: 'A recorded check that proved that boundary, not a configuration claim.',
    why: 'A disabled-tools flag on one invocation does not contain the tool that reads it.',
  },
  {
    id: 'disposable',
    requirement: 'Restoring the environment must undo every effect made inside it.',
    why: 'Without restore, an unrestricted mistake has no recovery path.',
  },
  {
    id: 'host-root-boundary',
    requirement: 'A host path tree the environment cannot reach past.',
    why: 'Full access to a project must not mean full access to the machine.',
  },
  {
    id: 'pre-execution-interception',
    requirement: 'Diomedes must be able to see an effect before it happens.',
    why: 'Policy, budgets and revocation are meaningless after the fact.',
  },
  {
    id: 'revocation-stops-effects',
    requirement: 'Revocation must stop future effects inside the environment.',
    why: 'A grant that cannot be withdrawn is not a grant.',
  },
  {
    id: 'effect-ledger',
    requirement: 'A recorded, checkable statement of which effects actually happened.',
    why: 'History and restore are how a person recovers from an unattended run.',
  },
  {
    id: 'route-effect-proof',
    requirement: 'The chosen route must be able to prove which effect it applied.',
    why: 'An engine that cannot say what it did cannot be audited.',
  },
] as const;
export type FullAccessPrerequisiteId = (typeof FULL_ACCESS_PREREQUISITES)[number]['id'];

export interface FullAccessEligibility {
  readonly available: boolean;
  readonly routeId: string;
  readonly environmentId: string | null;
  readonly unmet: readonly { readonly id: FullAccessPrerequisiteId; readonly detail: string }[];
  /** Effect classes this route cannot express at all, whatever the environment. */
  readonly unsupportedEffects: readonly string[];
  readonly summary: string;
}

/**
 * The only place that may answer "is Full access offerable". It refuses by
 * default: a missing environment is an unmet prerequisite, never a pass. It
 * takes no flag, preference or request field, so no setting can turn it on.
 */
export function fullAccessEligibility(
  routeId: string,
  environment: IsolatedEnvironment | null,
): FullAccessEligibility {
  const route = ROUTE_CAPABILITIES[routeId];
  const unmet: { id: FullAccessPrerequisiteId; detail: string }[] = [];
  if (!route)
    return {
      available: false,
      routeId,
      environmentId: environment?.id ?? null,
      unmet: FULL_ACCESS_PREREQUISITES.map(({ id, requirement }) => ({ id, detail: requirement })),
      unsupportedEffects: ['unknown route'],
      summary: 'Full access is unavailable: this is not a known execution route.',
    };
  if (!environment) {
    unmet.push({
      id: 'isolated-environment',
      detail: 'No isolated execution environment is available on this installation.',
    });
    unmet.push({
      id: 'attested-boundary',
      detail: 'There is no environment to attest.',
    });
    unmet.push({ id: 'disposable', detail: 'There is no environment to restore.' });
    unmet.push({
      id: 'host-root-boundary',
      detail: 'No host root boundary is enforced for an engine process.',
    });
    unmet.push({
      id: 'revocation-stops-effects',
      detail: 'Revocation covers Diomedes writes only; it cannot stop effects it never sees.',
    });
    unmet.push({
      id: 'effect-ledger',
      detail: 'Only Diomedes writes are recorded. Arbitrary effects have no ledger.',
    });
  } else {
    if (environment.kind === 'container')
      unmet.push({
        id: 'isolated-environment',
        detail: 'Container isolation has not been accepted as a boundary for this option.',
      });
    if (!environment.attestation)
      unmet.push({
        id: 'attested-boundary',
        detail: 'This environment has no recorded boundary check.',
      });
    if (!environment.disposable)
      unmet.push({ id: 'disposable', detail: 'This environment cannot be restored.' });
    if (!environment.hostRoot)
      unmet.push({ id: 'host-root-boundary', detail: 'This environment names no host root.' });
    if (!environment.interceptsEffects)
      unmet.push({
        id: 'pre-execution-interception',
        detail: 'This environment cannot show an effect before it happens.',
      });
    if (!environment.revocable)
      unmet.push({
        id: 'revocation-stops-effects',
        detail: 'This environment cannot stop future effects on revocation.',
      });
    if (!environment.effectLedger)
      unmet.push({
        id: 'effect-ledger',
        detail: 'This environment records no effect ledger.',
      });
  }
  // The route must be able to prove its own effects even inside a boundary.
  if (route.effectProof.answer !== 'yes' || route.effectProof.basis !== 'diomedes-enforced')
    unmet.push({
      id: 'route-effect-proof',
      detail: `${route.name} cannot prove which effect it applied: ${route.effectProof.evidence}`,
    });
  if (route.preExecutionInterception.answer !== 'yes')
    unmet.push({
      id: 'pre-execution-interception',
      detail: `${route.name} cannot show an effect before it happens.`,
    });
  const unsupportedEffects = [
    'arbitrary command execution',
    'file deletion',
    'software installation',
    'external destinations, messages and payments',
    'credential and secret access',
  ];
  const seen = new Set<string>();
  const distinct = unmet.filter((item) => !seen.has(item.id) && seen.add(item.id));
  return {
    available: distinct.length === 0,
    routeId,
    environmentId: environment?.id ?? null,
    unmet: distinct,
    unsupportedEffects,
    summary: distinct.length
      ? `Full access is unavailable for ${route.name}: ${distinct.length} prerequisite${distinct.length === 1 ? '' : 's'} unmet.`
      : `Full access could be offered for ${route.name} in ${environment?.name}.`,
  };
}
