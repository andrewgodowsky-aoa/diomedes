/**
 * The one check a team run's MCP configuration passes before any engine is
 * given it: a loopback team endpoint for one project, a helper slot and role,
 * and a populated token variable in the dedicated `DIOMEDES_TEAM_` namespace.
 * Codex and Claude Code both read their bearer token from that variable, so
 * the token never appears on a command line or in a configuration file.
 */
export interface TeamCarriageOptions {
  url: string;
  tokenEnv: string;
  slotId: string;
  role: 'lead' | 'member';
  roleInstructions: string;
}

/** The leased token, or null when the configuration is not a valid team carriage. */
export function teamCarriageToken(team: TeamCarriageOptions): string | null {
  if (typeof team.url !== 'string' || !URL.canParse(team.url)) return null;
  const url = new URL(team.url);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/mcp\/team\/[^/]+$/.test(url.pathname) ||
    !/^DIOMEDES_TEAM_[A-Z0-9_]+$/.test(team.tokenEnv) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(team.slotId) ||
    team.slotId === 'owner' ||
    !['lead', 'member'].includes(team.role) ||
    typeof team.roleInstructions !== 'string' ||
    !team.roleInstructions.trim()
  )
    return null;
  // A dedicated namespace prevents tokenEnv from reintroducing provider keys,
  // proxy routing, NODE_OPTIONS, or native task-control variables.
  const token = process.env[team.tokenEnv];
  if (!token || !/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}
