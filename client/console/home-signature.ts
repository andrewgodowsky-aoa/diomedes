/**
 * The agent home's signature: once per session, the bust arrives as the
 * fractured signal (B) and resolves to the networked oracle (A) (contract §4).
 * Whether it plays is decided here, from things passed in, so it is tested
 * directly (tests/home-brief.test.ts).
 */
import { motionAllowed, type MotionFacts } from './nectovia-motion';

/** The session key that says the signature has played (the brief's storage key). */
export const SIGNATURE_KEY = 'console.nectovia.signature';

/** The stepped bands B arrives in: 5, inside the contract's 4 to 6. */
export const SIGNATURE_BANDS = 5;

/** How far each band starts displaced, in px (8 to 24, alternating sides). */
export const BAND_OFFSETS = [-18, 12, -24, 8, -14] as const;

/**
 * Where the bands divide the bust, in percent of its height from the top:
 * band i runs from edge i to edge i + 1. Uneven, so the split reads as a
 * fracture and not a grid.
 */
export const BAND_EDGES = [0, 17, 38, 61, 79, 100] as const;

/**
 * The order the bands land in: band i starts `BAND_STEPS[i]` steps late, one
 * step being nectovia.css's `--nv-sig-step`. Out of order on purpose, the way
 * a signal locks, not the way a blind drops.
 */
export const BAND_STEPS = [1, 3, 0, 4, 2] as const;

/**
 * Whole signature, in ms: inside the contract's 900 to 1450. It is
 * nectovia.css's `--nv-sig-rest`, the resolve of A, which is the last thing to
 * finish (tests/home-brief.test.ts holds the two together).
 */
export const SIGNATURE_MS = 1300;

/** The animation whose end means the signature is over: A has resolved. */
export const SIGNATURE_END = 'nv-rest-in';

interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Play now? Only when motion is allowed and this session has not seen it. A
 * store that cannot be read or written counts as seen: the signature is a
 * welcome, never a thing that repeats on every visit because storage failed.
 */
export function takeSignature(store: SessionStore | null, facts: MotionFacts): boolean {
  if (!motionAllowed(facts) || !store) return false;
  try {
    if (store.getItem(SIGNATURE_KEY)) return false;
    store.setItem(SIGNATURE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
