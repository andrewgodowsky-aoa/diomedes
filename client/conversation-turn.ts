import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id';

/**
 * The id of the transcript turn that answers one command, derived the way the server names it.
 * Null when this browser cannot hash, which reads as "not found": no outcome is shown under a
 * turn that cannot be proved to be its own.
 */
export async function answerTurnId(runId: string, commandId: string): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(turnIdentityText(runId, commandId)),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return projectedTurnIds(hex).assistant;
  } catch {
    return null;
  }
}
