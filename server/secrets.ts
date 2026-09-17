/** Literal replacement shared by native Work and the harness host. */
export function secretScrubber(secrets: Iterable<string>): (text: string) => string {
  return (text) => {
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  };
}

/**
 * Pattern-based redaction for text whose secret inventory is unknown to the
 * caller — engine CLI output is the example. A child process may echo its
 * environment's keys or its user's home paths even when Diomedes holds no
 * token; this is the floor, applied before any literal scrubs.
 */
export function baselineRedact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, 'Bearer [redacted]')
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/:'"()\s]+/g, '[home]')
    .replace(/\/Users\/[^/:'"()\s]+/g, '[home]')
    .replace(/\b\/home\/[^/:'"()\s]+/g, '[home]');
}
