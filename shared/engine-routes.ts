import type { ExternalEngine } from './types.js';

/**
 * What one adapter route actually is, said where a person chooses it. "I have
 * OpenCode", "I pay for an OpenCode service" and "I hold the account route this
 * adapter accepts" are three different statements; a bare tool name reads as
 * the first and promises the third.
 *
 * Every sentence here is checked against the adapter it describes
 * (`server/engines/<engine>.ts`), not against the tool's marketing.
 *
 * All five are text routes. The adapter asks the native tool for text and
 * Diomedes's own writer turns that text into proposals its approvals and
 * History already govern. None of them is the tool's own coding experience:
 * tools, plugins and MCP are disabled or denied, and a tool event stops the
 * request instead of running it.
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

/**
 * The environment allowlist in `server/engines/process.ts` is why every route
 * below says the same thing about environment variables: a child process gets
 * paths, the user profile locations, the temp directories and
 * `NODE_EXTRA_CA_CERTS`, and nothing else. Provider keys, proxy settings and
 * custom variables do not reach the tool.
 */
const ENVIRONMENT = 'Most environment variables, including provider keys and proxy settings';
/** Every adapter runs in Diomedes's own per-route directory, never in a project. */
const WORKING_DIRECTORY = 'The folder you are working in';

export const ENGINE_ROUTE_PROFILES: Record<ExternalEngine, EngineRouteProfile> = {
  'claude-code': {
    routeLabel: 'Claude subscription, signed in to Claude Code',
    taskScope: 'Text answers and reviewed proposals. Tools, MCP and slash commands are off.',
    reuses: ['The Claude Code installation on this computer', 'Its own Claude account sign-in'],
    doesNotReuse: [
      'Your Claude Code settings files and setting sources',
      'Plugins and hooks',
      'MCP servers and slash commands',
      ENVIRONMENT,
      WORKING_DIRECTORY,
    ],
    billing:
      'Usage is billed to the Claude account signed in to Claude Code. The adapter refuses an API-key sign-in, and Diomedes cannot see how much of the allowance is left.',
  },
  opencode: {
    routeLabel: 'OpenCode Go',
    taskScope: 'Text answers and reviewed proposals. Tools, plugins and MCP are off.',
    reuses: [
      'The OpenCode installation on this computer',
      'Its native sign-in data folder, which stays where OpenCode keeps it',
    ],
    doesNotReuse: [
      'Your OpenCode config, cache and state folders',
      'Project config and external skills',
      'Plugins, instructions and MCP servers',
      'Providers other than OpenCode Go, including Zen',
      ENVIRONMENT,
      WORKING_DIRECTORY,
    ],
    billing:
      'Usage is billed to your OpenCode Go account, and the adapter never switches to Zen or another provider. OpenCode documents an account-side "Use balance" setting that can continue usage from Zen balance once Go limits are reached, so pinning the route here does not decide what you are charged.',
  },
  'oh-my-pi': {
    routeLabel: 'OpenAI API key, in a separate oh-my-pi profile',
    taskScope: 'Text answers and reviewed proposals. Tools, extensions and skills are off.',
    reuses: ['The oh-my-pi installation on this computer'],
    doesNotReuse: [
      'Your own oh-my-pi profile: this route uses a separate one',
      'Extensions, skills, rules and LSP',
      'Saved sessions',
      'Retry and model-fallback settings, which are forced off',
      ENVIRONMENT,
      WORKING_DIRECTORY,
    ],
    billing:
      'Usage is billed to the OpenAI API key you write into that separate profile. That is API billing, not a ChatGPT subscription, and Diomedes neither reads the file nor sees the balance.',
  },
  cursor: {
    routeLabel: 'Cursor account, signed in through the Cursor CLI',
    taskScope: 'Text answers and reviewed proposals in ask mode. A tool event stops the request.',
    reuses: [
      'The Cursor CLI installation on this computer',
      'Its own sign-in, which stays in the native credential location',
    ],
    doesNotReuse: [
      'Your Cursor CLI config and data folders',
      'Your global rules, skills and commands',
      'MCP servers',
      ENVIRONMENT,
      WORKING_DIRECTORY,
    ],
    billing:
      'Usage is billed to the Cursor account signed in to its CLI. Diomedes cannot see the plan or the quota left, and it never selects a substitute model.',
  },
  devin: {
    routeLabel: 'Devin account, signed in through its browser flow',
    taskScope: 'Text answers and reviewed proposals in ask mode. A tool event stops the request.',
    reuses: [
      'The Devin CLI installation on this computer',
      'Your Devin account, through the browser sign-in you complete',
    ],
    doesNotReuse: [
      'The Devin CLI sign-in: each session authenticates on its own',
      'Your Devin configuration; the session workspace is new each time',
      ENVIRONMENT,
      WORKING_DIRECTORY,
    ],
    billing:
      'Usage is billed to the Devin account that completes the browser sign-in for that session. Diomedes cannot see the plan or the usage left.',
  },
};

/** "OpenCode Go · Text and reviewed proposals": the line shown beside a route. */
export function routeCaption(engine: ExternalEngine): string {
  const profile = ENGINE_ROUTE_PROFILES[engine];
  return `${profile.routeLabel} · ${profile.taskScope}`;
}
