/** Literal replacement shared by native Work and the harness host. */
export function secretScrubber(secrets: Iterable<string>): (text: string) => string {
  return (text) => {
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  };
}
