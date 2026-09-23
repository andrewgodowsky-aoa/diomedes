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
}

// The segment bar: N equal segments, one per counted unit, lit as they finish.
// Presentation lives in segment-bar.css under the `.seg-bar` prefix and reads
// the scheme's own lead, needs-you and failed colours.
export function SegmentBar({ label, caption, size = 'card', className, ...input }: SegmentBarProps) {
  const model = segmentModel(input);
  const shown = caption === undefined ? (model.indeterminate ? null : model.text) : caption;
  const classes = ['seg-bar', size, model.indeterminate ? 'indeterminate' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {model.indeterminate ? (
        <div
          className="seg-track"
          role="progressbar"
          aria-label={label}
          aria-valuetext={model.text}
        >
          <span className="seg-scan" aria-hidden="true" />
        </div>
      ) : (
        <div
          className="seg-track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={model.total}
          aria-valuenow={model.done}
          aria-valuetext={model.text}
          style={{ gridTemplateColumns: `repeat(${model.segments.length}, minmax(0, 1fr))` }}
        >
          {model.segments.map((state, index) => (
            <span key={index} className={`seg ${state}`} aria-hidden="true" />
          ))}
        </div>
      )}
      {shown && (
        <span className="seg-caption" aria-hidden="true">
          {shown}
        </span>
      )}
    </div>
  );
}
