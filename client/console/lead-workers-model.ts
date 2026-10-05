/**
 * The words the Team view's lead and workers panel (`LeadWorkers.tsx`) says about a lead's roles.
 * Pure, so they are checked without a browser.
 */
import { routeDisplayName } from '../../shared/engines';
import { nectoviaTierName } from '../../shared/escalation-roles';
import type { TeamLeadView, TeamRole } from '../../shared/team-delegation';

/** Where a role runs. A Nectovia role under another lead is named by its tier, never its model. */
export function roleLine(role: TeamRole): string {
  const where = role.tier
    ? nectoviaTierName(role.tier)
    : role.profile
      ? `${role.profile.name} (revision ${role.profile.revision})`
      : role.route === 'native-fixture'
        ? 'a fixed local script'
        : `${routeDisplayName(role.route) || role.route}${role.model ? ` · ${role.model}` : ''}`;
  return `${role.agent.name} · ${where}`;
}

/**
 * What a lead's Nectovia roles cost (DIO-216), and for the roles a local lead took by default,
 * which joined and which were left out, with why.
 */
export function nectoviaRolesNote(team: Pick<TeamLeadView, 'worker' | 'advisor' | 'origin' | 'escalation'>): string[] {
  const lines: string[] = [];
  if (team.origin === 'escalation-default' && team.escalation) {
    for (const item of team.escalation.attached)
      lines.push(`${nectoviaTierName(item.tier)} joined as ${item.role === 'worker' ? 'a worker' : 'an advisor'} by default.`);
    for (const item of team.escalation.leftOut) lines.push(`${nectoviaTierName(item.tier)} was left out. ${item.reason}`);
  }
  const names = [...new Set([team.worker, team.advisor].flatMap((role) => (role?.tier ? [nectoviaTierName(role.tier)] : [])))];
  if (names.length) lines.push(`${names.join(' and ')} ${names.length > 1 ? 'use' : 'uses'} your account’s credits.`);
  return lines;
}
