/**
 * The Nectovia scheme's motion facts and its one scripted transition (contract
 * §4, "calm surfaces, loud transitions"). Everything else the scheme moves is
 * CSS in nectovia.css, where the global reduced-motion rule in styles.css
 * reaches it. A Web Animation is not reached by that rule, so the one here
 * asks the same questions itself before it runs. Tested directly in
 * tests/nectovia-motion.test.ts.
 */

export interface MotionFacts {
  /** `html[data-motion='reduced']`: the person's own setting. */
  reducedSetting: boolean;
  /** The operating system's prefers-reduced-motion. */
  reducedQuery: boolean;
  /** `html[data-motion-preset='none']`: the theme's named motion is none. */
  presetNone: boolean;
  /** The theme's --dm-motion-intensity, as a number. */
  intensity: number;
}

/** Nothing moves when any of the ways a person or a theme asks for stillness is set. */
export function motionAllowed(facts: MotionFacts): boolean {
  return (
    !facts.reducedSetting &&
    !facts.reducedQuery &&
    !facts.presetNone &&
    Number.isFinite(facts.intensity) &&
    facts.intensity > 0
  );
}

/** Read the motion facts from the page. Anything unreadable counts as stillness. */
export function readMotionFacts(): MotionFacts {
  try {
    const root = document.documentElement;
    const raw = getComputedStyle(root).getPropertyValue('--dm-motion-intensity').trim();
    const intensity = raw === '' ? 0.5 : Number(raw);
    return {
      reducedSetting: root.dataset.motion === 'reduced',
      reducedQuery:
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
      presetNone: root.dataset.motionPreset === 'none',
      intensity,
    };
  } catch {
    return { reducedSetting: true, reducedQuery: true, presetNone: true, intensity: 0 };
  }
}

/** The fractured-signal ease (nectovia.css `--nv-ease`). */
export const NV_EASE = 'cubic-bezier(.76,0,.24,1)';

/** The view change: the content shears for this long, then the header seam draws. */
export const VIEW_SHEAR_MS = 160;
export const SEAM_DRAW_MS = 260;

let seam: Animation | null = null;

/**
 * Draw the strip's registration mark again, left to right, after a view change
 * has sheared the content in (contract §4: scaleX 0 to 1 over 260 ms, after the
 * 160 ms shear). The strip is not remounted by a view change, so its CSS
 * entrance cannot replay; this replays it as a Web Animation on the rule's
 * `::after`. Only under the Nectovia scheme, only while motion is allowed, and
 * never throwing: a view change never waits on it or fails because of it.
 */
export function drawHeaderSeam(root?: ParentNode | null): Animation | null {
  try {
    if (typeof document === 'undefined') return null;
    if (document.documentElement.dataset.package !== 'nectovia') return null;
    if (!motionAllowed(readMotionFacts())) return null;
    const strip = (root ?? document).querySelector('.top');
    if (!strip || typeof (strip as HTMLElement).animate !== 'function') return null;
    seam?.cancel();
    seam = (strip as HTMLElement).animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      pseudoElement: '::after',
      duration: SEAM_DRAW_MS,
      delay: VIEW_SHEAR_MS,
      easing: NV_EASE,
      fill: 'backwards',
    });
    return seam;
  } catch {
    return null;
  }
}
