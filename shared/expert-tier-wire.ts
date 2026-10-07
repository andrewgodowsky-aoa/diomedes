/**
 * Only four-tier clients receive Expert properties in strict tier records. Historical desktops
 * reject unknown fields in policy and check-in replies. This shapes a response, never a stored
 * record, entitlement, admission, or provider request.
 */
export function tierResponse<T>(value: T, includeExpert: boolean): T {
  if (includeExpert) return value;
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (key === 'expert') return undefined;
    // Qualification and escalation tier arrays also use strict enums in old clients.
    if (key === 'tiers' && Array.isArray(item)) return item.filter(tier => tier !== 'expert');
    return item;
  })) as T;
}
