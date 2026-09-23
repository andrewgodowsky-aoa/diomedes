import type { EngineModel } from './types.js';
import { MODEL_API_ROUTES } from './model-api.js';
import { routeDisplayName } from './engines.js';
import { resolveWorkStyle, WORK_STYLES, type WorkStyle } from './work-style.js';

/**
 * Which routes can carry the Diomedes team tools, and how. Team work is not a
 * ChatGPT feature: a team member may run on any route that can reach the team
 * service, and the person picks the route and model per member or lets
 * Nectovia choose them (owner request 2026-09-23).
 *
 * - `mcp`: the engine connects to the loopback team MCP service itself, with the
 *   member's bearer token leased into its environment (Codex, Claude Code).
 * - `host`: the host runs the team tools inside its own tool loop and hands the
 *   model only their descriptors (the model-API routes).
 *
 * A route not listed here cannot carry the tools today, and is refused by name
 * rather than silently swapped for one that can.
 */
export const TEAM_ROUTES = ['codex', 'claude-code', ...MODEL_API_ROUTES] as const;
export type TeamRoute = (typeof TEAM_ROUTES)[number];
export const TEAM_CARRIAGE: Record<TeamRoute, 'mcp' | 'host'> = {
  codex: 'mcp',
  'claude-code': 'mcp',
  'aws-bedrock': 'host',
  'azure-openai': 'host',
  openrouter: 'host',
};
export function isTeamRoute(value: unknown): value is TeamRoute {
  return typeof value === 'string' && (TEAM_ROUTES as readonly string[]).includes(value);
}

/** The tool names the team service offers, identical on every carriage. */
export const TEAM_TOOL_NAMES = [
  'team_members',
  'team_send_message',
  'team_read_messages',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_list_assistants',
  'team_describe_assistant',
  'team_spawn_agent',
  'team_rename_agent',
  'team_interrupt_agent',
  'team_shutdown_agent',
  'team_clear_agent_context',
] as const;

/** "ChatGPT, Claude Code, AWS Bedrock, Azure OpenAI or OpenRouter", from the registry. */
export function teamRouteList(): string {
  const names = TEAM_ROUTES.map((route) => routeDisplayName(route));
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/**
 * Null when the route can carry the team tools; otherwise the honest sentence
 * that names it. Nothing here falls back to another route.
 */
export function teamRouteRefusal(route: string): string | null {
  if (isTeamRoute(route)) return null;
  return `${routeDisplayName(route) || route} cannot carry the Diomedes team tools yet: Diomedes does not give its sessions the team service. Choose ${teamRouteList()}.`;
}

/** What `GET /api/projects/:id/team/routes` returns, for the add-member form. */
export interface TeamRoutesView {
  routes: {
    route: TeamRoute;
    name: string;
    /** Turned on and connected; only a ready route can be picked. */
    ready: boolean;
    models: { slug: string; name: string }[];
    savedModel: string | null;
    reason?: string;
  }[];
  styles: { style: WorkStyle; label: string }[];
}

/** What the add-member form sends. `engine: 'auto'` asks Nectovia to choose. */
export interface NewTeamMember {
  name: string;
  role: 'lead' | 'member';
  engine: TeamRoute | 'auto';
  model?: string;
  style?: WorkStyle;
}

/** How a member's route and model were chosen. Recorded on the member, never inferred later. */
export interface TeamMemberSelection {
  by: 'person' | 'nectovia';
  /** The WorkStyle Nectovia resolved this member with; null when the person chose. */
  style: WorkStyle | null;
  /** One plain sentence for the roster's details line. */
  reason: string;
  /** True when the preferred model was missing and a qualified other was chosen. */
  substituted: boolean;
}

/** One step up the styles, capped at the top. A lead typically works a tier above its members. */
export function styleAbove(style: WorkStyle): WorkStyle {
  const index = WORK_STYLES.indexOf(style);
  return WORK_STYLES[Math.min(WORK_STYLES.length - 1, index + 1)];
}

/** The style a role resolves with when the team follows `style`. */
export function teamRoleStyle(role: 'lead' | 'member', style: WorkStyle): WorkStyle {
  return role === 'lead' ? styleAbove(style) : style;
}

/** One route the person has turned on and connected, with exactly what it reported. */
export interface TeamRouteCandidate {
  route: TeamRoute;
  models: readonly EngineModel[];
  savedModel: string | null;
  /** Only ChatGPT may run its own default before it has listed models. */
  routeDefaultAllowed: boolean;
}

export type TeamModelResolution =
  | {
      outcome: 'run';
      route: TeamRoute;
      model: string | null;
      effort: string | null;
      selection: TeamMemberSelection;
    }
  | { outcome: 'ask'; reason: string };

/**
 * "Nectovia chooses": the route and model for one member, from the WorkStyle
 * resolver and only the candidates given (routes the person turned on and
 * connected). A route that offers the style's preferred model wins over one
 * that only offers a qualified substitute, which wins over a route that would
 * run its own unnamed default. Candidate order breaks ties. Nothing outside a
 * route's own list is ever returned, and a style no route can serve is a
 * question for the person, never a quiet downgrade.
 */
export function resolveTeamMemberModel(input: {
  role: 'lead' | 'member';
  style: WorkStyle;
  candidates: readonly TeamRouteCandidate[];
}): TeamModelResolution {
  const style = teamRoleStyle(input.role, input.style);
  const runs = input.candidates.flatMap((candidate) => {
    const resolved = resolveWorkStyle({
      style,
      mode: 'build',
      route: candidate.route,
      availableModels: candidate.models,
      savedModel: candidate.savedModel,
      routeDefaultAllowed: candidate.routeDefaultAllowed,
      stableEffort: true,
    });
    if (resolved.outcome !== 'run') return [];
    // Every route but ChatGPT needs a named model to run at all.
    if (!resolved.model && !candidate.routeDefaultAllowed) return [];
    const rank = resolved.model ? (resolved.substituted ? 1 : 0) : 2;
    return [{ candidate, resolved, rank }];
  });
  const best = runs.sort((a, b) => a.rank - b.rank)[0];
  if (!best) {
    const routes = input.candidates.map((c) => routeDisplayName(c.route));
    return {
      outcome: 'ask',
      reason: routes.length
        ? `No connected route offers a model for ${style === input.style ? 'this' : 'the lead’s'} style (${routes.join(', ')} checked). Choose a route and model for this member.`
        : `Turn on and connect ${teamRouteList()} before Nectovia can choose a team model.`,
    };
  }
  return {
    outcome: 'run',
    route: best.candidate.route,
    model: best.resolved.model,
    effort: best.resolved.effort,
    selection: {
      by: 'nectovia',
      style,
      reason: `${best.resolved.reason} On ${routeDisplayName(best.candidate.route)}.`,
      substituted: best.resolved.substituted,
    },
  };
}
