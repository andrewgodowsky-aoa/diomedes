import './nectovia-mark.css';

interface NectoviaMarkProps {
  /** Draw the NECTOVIA wordmark beside the glyph. */
  word?: boolean;
  /** Rendered size of the 24-unit glyph, in CSS pixels. */
  size?: number;
}

/** At this size and below the trail seam is under a pixel wide, so it is left out (contract §3). */
export const TRAIL_MIN_SIZE = 18;

/**
 * The Nectovia mark: three plates and two seams on a 24-unit grid, taken
 * exactly from the owner-approved geometry (contract §3). The plates are the
 * scheme's silver and graphite (--t1 and --t3) and the seams its lead and
 * trail, so the glyph reads in every appearance scheme; it is the product's
 * name, not part of the Nectovia skin (contract A2).
 *
 * The one `[data-mark-point]` sits where the lead seam ends: the wake's
 * travelling point settles onto it (Wake.tsx). It is a registration point, not
 * a drawn shape, so it paints nothing and the approved drawing stays exact.
 *
 * The desktop app icon draws this geometry in the site favicon's fixed colours
 * (scripts/app-icon.mjs; tests/app-icon.test.ts holds it to this file).
 * Mark.tsx, the Diomedes spear, is no longer drawn anywhere.
 */
export function NectoviaMark({ word = true, size = 20 }: NectoviaMarkProps) {
  return (
    <span className="dm-nmark">
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <polygon className="dm-nmark-plate" points="3,3 7.6,3 7.6,21 3,21" />
        <polygon className="dm-nmark-plate dim" points="8.9,3 12.9,3 15.3,21 11.3,21" />
        <polygon className="dm-nmark-plate" points="16.5,3 21,3 21,21 16.5,21" />
        <line className="dm-nmark-seam lead" x1="8.5" y1="3.4" x2="9.8" y2="12.6" />
        {size > TRAIL_MIN_SIZE && (
          <line className="dm-nmark-seam trail" x1="21.9" y1="15.5" x2="21.9" y2="21" />
        )}
        <circle className="dm-nmark-point" cx="9.8" cy="12.6" r="0.65" data-mark-point />
      </svg>
      {word && <span className="dm-nmark-word">Nectovia</span>}
    </span>
  );
}

/** The glyph alone, for places that already carry the name in words. */
export function NectoviaGlyph({ size = 18 }: { size?: number }) {
  return <NectoviaMark word={false} size={size} />;
}
