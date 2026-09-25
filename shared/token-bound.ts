/**
 * The input-token ceiling a request can reach, from its bytes. Dependency-free on purpose: the
 * managed inference gateway (services/control-plane) and the desktop both hold calls to this one
 * bound, and the gateway's Worker bundle must not pull in the desktop's job, work-style or engine
 * code to get it.
 */

/**
 * A token never covers less than one byte, so a byte count is an upper bound on tokens. The
 * constant and the per-message allowance cover framing the provider adds.
 * `server/engines/model-api-core.ts` holds every call to this same bound.
 */
export function inputTokenBound(bytes: number, messages: number): number {
  return bytes + 1_024 + messages * 16;
}
