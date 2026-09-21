import type { EngineModel, ExternalEngine, Route } from './types.js';
import type {
  Candidate,
  CandidateSource,
  RepairReason,
  SelectedBinding,
  SetupAction,
} from './connection-policy.js';

export const EXTERNAL_ENGINES = ['claude-code', 'opencode', 'oh-my-pi', 'cursor', 'devin'] as const;
/**
 * The reserved identity a host-initiated test runs under. A test is the host's
 * own evidence, not a person's work, so it names no project of theirs and
 * writes into no thread, task or document. It is never a project a person can
 * make or open: every project id is generated, and the store refuses a saved
 * registry row that names this one.
 */
export const HOST_TEST_PROJECT = 'diomedes-host-tests';
export const ROUTES = ['sample', 'codex', ...EXTERNAL_ENGINES] as const;
export function isExternalEngine(value: unknown): value is ExternalEngine {
  return EXTERNAL_ENGINES.some((id) => id === value);
}
export function isRoute(value: unknown): value is Route {
  return ROUTES.some((id) => id === value);
}
export const ENGINE_NAMES: Record<ExternalEngine, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
  cursor: 'Cursor',
  devin: 'Devin',
};
/**
 * Where an installation lives. A WSL copy or a desktop application is named as
 * what it is, never presented as a native Windows command-line account.
 */
export type InstallationContext = 'windows-native' | 'posix-native' | 'wsl' | 'desktop-app';

/** One installation the host observed. Every field is host-produced. */
export interface EngineCandidate extends Candidate {
  engine: ExternalEngine;
  /**
   * `reviewed-release`: the bytes match the digest Diomedes pinned for its
   * private copy. `unverified`: the person's own installation, whose identity is
   * recorded for change detection and whose publisher Diomedes did not prove.
   */
  provenance: 'reviewed-release' | 'unverified';
  context: InstallationContext;
  compatibility: 'supported' | 'unsupported' | 'unknown';
  /** Why this candidate cannot be used, when it cannot. Sanitised, no secrets. */
  issue?: string;
}

/** The installation a person chose for a route. Non-secret, and persisted. */
export interface EngineBinding extends SelectedBinding {
  engine: ExternalEngine;
  source: CandidateSource;
  boundAt: string;
  /** `adopted`: carried once from a selection made before bindings existed. */
  origin: 'explicit' | 'adopted';
}

/**
 * The native tool answered, and the account it reported is not the one route
 * this adapter accepts. Identifiers only. It never says the person is signed
 * out, and it never infers what they paid for.
 */
export interface AccountRouteIssue {
  required: string;
  connected: string[];
}

/** Where in a connection attempt a failure happened. */
export const SETUP_STAGES = [
  'discovery',
  'runtime-verification',
  'launch',
  'local-handshake',
  'provider-auth',
  'model-list',
  'dispatch',
  'stream',
  'cleanup',
] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

/** One host-produced failure record. Identifiers and codes; never a token, prompt or output. */
export interface SetupDiagnostic {
  buildId: string;
  engine: ExternalEngine;
  candidateSource: CandidateSource | null;
  installedVersion: string | null;
  accountRoute: string | null;
  /**
   * The model the binding's revision was recorded against — what a receipt for
   * this route would name. `null` means no binding holds a model, which is a
   * different fact from the model chosen on the settings screen: that one is
   * the settings value, and the support bundle is where it is read from.
   */
  selectedModel: string | null;
  stage: SetupStage;
  code: string;
  correlationId: string;
  lastVerifiedAt: string | null;
  at: string;
}

/**
 * Host-issued proof that one real, consented request answered through this
 * exact binding revision. It is history: it never authorises a later run and
 * never stands in for the live admission check at dispatch.
 */
export interface ConnectionReceipt {
  engine: ExternalEngine;
  revision: number;
  candidateId: string;
  version: string;
  accountRoute: string;
  model: string;
  runId: string;
  buildId: string;
  verifiedAt: string;
}

export interface EngineConnection {
  engine: ExternalEngine;
  /** `corrupt`: the selected or only installation failed its integrity check and is never launched. */
  installation: 'not-checked' | 'missing' | 'found' | 'corrupt';
  compatibility: 'unknown' | 'supported' | 'unsupported';
  authentication: 'unknown' | 'signed-in' | 'signed-out';
  accountRoute: string | null;
  models: EngineModel[];
  checkedAt: string | null;
  detail: string;
  version?: string;
  location?: string;
  /** Provider metadata only; never inferred from token counts. */
  usage: { state: 'unknown'; checkedAt: null };
  /**
   * The fields below arrived with candidate binding (2026-09-20). They are
   * optional on the wire so an older fixture still parses; the host always
   * sends them, and a reader treats an absent one as its empty value.
   */
  /** Every installation observed for this route, usable or not. */
  candidates?: EngineCandidate[];
  /** The installation the person chose. `null` until a selection binds one. */
  binding?: EngineBinding | null;
  /** The usable candidate Diomedes would offer when nothing is bound. */
  recommendedCandidateId?: string | null;
  /** Why the bound or only installation needs repair, when it does. */
  repair?: RepairReason | null;
  /** Moves only when the binding, account route or selected model changes. */
  revision?: number;
  /** The last real result through this route, if its revision still matches. */
  verification?: ConnectionReceipt | null;
  routeIssue?: AccountRouteIssue | null;
  /** The last failure, by stage. Cleared by the next success at that stage. */
  diagnostic?: SetupDiagnostic | null;
  /** Host-derived. A screen renders this action; it does not compute its own. */
  nextAction?: SetupAction;
  /**
   * Whether a native sign-in window Diomedes opened for this route is still
   * open. The window closing is never read as signed in: the host rechecks,
   * and the recheck's answer is what `authentication` then says.
   */
  signInWindow?: 'idle' | 'running';
}
export interface InstallOffer {
  engine: ExternalEngine;
  publisher: string;
  source: string;
  version: string;
  destination: string;
  dependencies: string[];
  privileges: string;
  account: string;
  available: boolean;
  detail: string;
}
export const TEXT_ROUTE_CONTROLS: {
  control: string;
  level: 'enforced' | 'observed' | 'instructional' | 'unsupported';
  detail: string;
}[] = [
  {
    control: 'File proposals',
    level: 'enforced',
    detail:
      'Diomedes applies only the exact approved proposal through its existing History transaction.',
  },
  {
    control: 'Input scope',
    level: 'enforced',
    detail: 'Diomedes submits the instruction and explicitly selected, bounded document text.',
  },
  {
    control: 'Engine tools',
    level: 'observed',
    detail:
      'Native configuration disables or denies tools; Cursor and Devin use deny rules and stop on tool events. This does not restrict operating-system access.',
  },
  {
    control: 'Task instructions',
    level: 'instructional',
    detail: 'Instructions guide the model and are not a security boundary.',
  },
  {
    control: 'Operating-system sandbox',
    level: 'unsupported',
    detail: 'These text adapters do not claim Codex sandbox parity.',
  },
  {
    control: 'Native resume',
    level: 'unsupported',
    detail:
      'Each request starts a fresh native session. Diomedes retains its own thread and history.',
  },
];
