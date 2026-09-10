import type { EngineModel, ExternalEngine, Route } from './types.js';

export const EXTERNAL_ENGINES = ['claude-code', 'opencode', 'oh-my-pi'] as const;
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
};
export interface EngineConnection {
  engine: ExternalEngine;
  installation: 'not-checked' | 'missing' | 'found';
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
      'Native configuration disables tools; unexpected tool events stop the request. This does not restrict operating-system access.',
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
