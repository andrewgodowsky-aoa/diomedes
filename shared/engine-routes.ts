import type { ExternalEngine } from './types.js';

/**
 * What one adapter route actually is, said where a person chooses it. "I have
 * OpenCode", "I pay for an OpenCode service" and "I hold the account route this
 * adapter accepts" are three different statements; a bare tool name reads as
 * the first and promises the third.
 *
 * Every sentence here is checked against the adapter it describes
 * (`server/engines/<engine>.ts`), not against the tool's marketing.
 */
export interface EngineRouteProfile {
  /** The exact account route the adapter accepts. */
  routeLabel: string;
  /** What a task sent through this route can do. */
  taskScope: string;
  /** What Diomedes reuses from the person's own setup. */
  reuses: string[];
  /** What it deliberately does not carry over. */
  doesNotReuse: string[];
  /** The billing boundary, including what Diomedes cannot see or control. */
  billing: string;
}

export const ENGINE_ROUTE_PROFILES: Record<ExternalEngine, EngineRouteProfile> = {
  'claude-code': {
    routeLabel: 'Claude subscription',
    taskScope: 'Text and reviewed proposals',
    reuses: [],
    doesNotReuse: [],
    billing: '',
  },
  opencode: {
    routeLabel: 'OpenCode Go',
    taskScope: 'Text and reviewed proposals',
    reuses: [],
    doesNotReuse: [],
    billing: '',
  },
  'oh-my-pi': {
    routeLabel: 'OpenAI API key',
    taskScope: 'Text and reviewed proposals',
    reuses: [],
    doesNotReuse: [],
    billing: '',
  },
  cursor: {
    routeLabel: 'Cursor account',
    taskScope: 'Text and reviewed proposals',
    reuses: [],
    doesNotReuse: [],
    billing: '',
  },
  devin: {
    routeLabel: 'Devin account',
    taskScope: 'Text and reviewed proposals',
    reuses: [],
    doesNotReuse: [],
    billing: '',
  },
};

/** "OpenCode Go · Text and reviewed proposals": the line shown beside a route. */
export function routeCaption(engine: ExternalEngine): string {
  const profile = ENGINE_ROUTE_PROFILES[engine];
  return `${profile.routeLabel} · ${profile.taskScope}`;
}
