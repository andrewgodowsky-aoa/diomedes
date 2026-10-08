/**
 * The one sentence a person reads when a provider route cannot take their work right now:
 * its account is not connected, its model is not offered, its key has lapsed or it cannot be
 * reached. Customers do not set up providers, so the sentence names the provider only, never a
 * model id or a setup screen, and points them to support. Every route-unavailable refusal a
 * customer can reach is built here, so the wording stays the same everywhere.
 */
export function routeUnavailable(provider: string): string {
  return `${provider} is unavailable right now. Check your connection and credits, then contact support if it still fails.`;
}
