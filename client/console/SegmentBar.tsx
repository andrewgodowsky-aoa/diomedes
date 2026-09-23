import { segmentModel, type SegmentInput } from './segment-bar-model';
import './segment-bar.css';

export interface SegmentBarProps extends SegmentInput {
  /** Accessible name for the bar, usually the work's own title. */
  label: string;
  /** Visible line under the bar. Defaults to the counted words; null hides it. */
  caption?: string | null;
  /** 3 px inside cards and rows, 4 px in panes and larger contexts. */
  size?: 'card' | 'panel';
  className?: string;
  /**
   * Drawn for the eye only: no progressbar role, and the track is hidden from
   * assistive technology. For a bar inside a control whose own words already
   * say what it counts (a progressbar inside a button is flattened into the
   * button's name anyway), or beside a word that already says the work is
   * running. A visible caption stays ordinary readable text, because then it
   * is the only thing saying the count.
   */
  decorative?: boolean;
}

// The segment bar: N equal segments, one per counted unit, lit as they finish.
// Presentation lives in segment-bar.css under the `.seg-bar` prefix and reads
// the scheme's own lead, needs-you and failed colours.
export function SegmentBar({
  label,
  caption,
  size = 'card',
  className,
  decorative = false,
  ...input
}: SegmentBarProps) {
  const model = segmentModel(input);
  const shown = caption === undefined ? (model.indeterminate ? null : model.text) : caption;
  const classes = ['seg-bar', size, model.indeterminate ? 'indeterminate' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  // A decorative track says nothing to assistive technology; a real one is the
  // progressbar, and its caption is then hidden so the count is read once.
  const track = decorative
    ? { 'aria-hidden': true as const }
    : model.indeterminate
      ? { role: 'progressbar', 'aria-label': label, 'aria-valuetext': model.text }
      : {
          role: 'progressbar',
          'aria-label': label,
          'aria-valuemin': 0,
          'aria-valuemax': model.total,
          'aria-valuenow': model.done,
          'aria-valuetext': model.text,
        };

  return (
    <div className={classes}>
      {model.indeterminate ? (
        <div className="seg-track" {...track}>
          <span className="seg-scan" aria-hidden="true" />
        </div>
      ) : (
        <div
          className="seg-track"
          {...track}
          style={{ gridTemplateColumns: `repeat(${model.segments.length}, minmax(0, 1fr))` }}
        >
          {model.segments.map((state, index) => (
            <span key={index} className={`seg ${state}`} aria-hidden="true" />
          ))}
        </div>
      )}
      {shown && (
        <span className="seg-caption" aria-hidden={decorative ? undefined : 'true'}>
          {shown}
        </span>
      )}
    </div>
  );
}
