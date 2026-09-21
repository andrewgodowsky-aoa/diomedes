/**
 * How one answered message is named in a thread's transcript. The server projects a message into
 * two turns, the person's and the answer, and names both from the run and the command. The page
 * reads an outcome by command and has to find that command's answer in the transcript it shows,
 * so both sides derive the names here. Answer prose is never an identity: two commands can be
 * answered in the same words, and an outcome read carries no prose at all.
 */

/** The text whose SHA-256 names the pair of turns. */
export const turnIdentityText = (runId: string, commandId: string) =>
  JSON.stringify([runId, commandId]);

/** The two turn ids, from the lowercase hex SHA-256 of `turnIdentityText`. */
export const projectedTurnIds = (sha256Hex: string) => ({
  user: `Uclaude-${sha256Hex.slice(0, 32)}`,
  assistant: `Aclaude-${sha256Hex.slice(0, 32)}`,
});
