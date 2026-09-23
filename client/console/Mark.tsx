export type MarkState = '' | 'live' | 'attn';

interface MarkProps {
  state?: MarkState;
  word?: boolean;
  size?: number;
}

// The Diomedes mark: an open D drawn as a spear-line (shaft + blade) with the
// guiding point ahead of its tip. Geometry is 1:1 with the approved prototype
// (05-instrumented-density-prototype.html, top strip). Presentation lives in
// wake.css under the `.dm-mark` prefix.
export function Mark({ state = '', word = true, size = 20 }: MarkProps) {
  return (
    <span className="dm-mark">
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
      >
        <line x1="5" y1="3" x2="5" y2="21" />
        <path d="M5 3 C 14 3, 18 7.5, 18 12 C 18 16.5, 14 20.2, 9 21" />
        <circle
          cx="20.5"
          cy="12"
          r="1.6"
          data-mark-point
          className={state ? `dm-mark-point ${state}` : 'dm-mark-point'}
        />
      </svg>
      {word && <span className="dm-mark-word">Diomedes</span>}
    </span>
  );
}

// The mark alone (no wordmark) for favicon-sized use, e.g. the 10 px gutter
// marker of a Diomedes turn.
export function MarkGlyph({ state = '', size = 10 }: { state?: MarkState; size?: number }) {
  return <Mark state={state} word={false} size={size} />;
}
