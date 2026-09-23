import type { CSSProperties } from 'react';
import { segmentModel, type SegmentInput } from './segment-bar-model';
import './segment-bar.css';

export interface SegmentBarProps extends SegmentInput {
  /** Accessible name for the bar, usually the work's own title. */
  label: string;
  /**
   * The source's own words for where the work stands ("12.3 of 80.0 MB"),
   * never made up here. A bar drawn from a share, or an indeterminate bar
   * given a detail (null counts), captions itself with the label and then
   * this, and a screen reader hears the same words as its value.
   */
  detail?: string | null;
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
  /**
   * Whose numbers these are. A record's (the default: plan steps, child runs,
   * bytes a download received) may take any form. A reply's (a model's
   * `progress` visual) is only ever a share or indeterminate, never counted
   * segments; it is outlined apart (`data-source="reply"`) and never moves,
   * because it is words a model wrote, not work the Console is watching
   * (contract A15). Its caption stays the reply's own words.
   */
  source?: 'record' | 'reply';
}

// The segment bar: N equal segments, one per counted unit, lit as they finish;
// or, where the source reported a share rather than a count, one continuous
// track filled that far. Presentation lives in segment-bar.css under the
// `.seg-bar` prefix and reads the scheme's own lead, needs-you and failed
// colours.
export function SegmentBar({
  label,
  detail,
  caption,
  size = 'card',
  className,
  decorative = false,
  source = 'record',
  ...given
}: SegmentBarProps) {
  const reply = source === 'reply';
  // A reply's bar is read from its share alone: no steps, count or state of its own.
  const input: SegmentInput = reply ? { fraction: given.fraction } : given;
  const model = segmentModel(input);
  const share = model.fraction;
  const percent = share === null ? null : Math.round(share * 100);
  // The source's words: its label, and its detail when it gave one. Never a
  // "k of n" the source did not write.
  const sourceWords = detail ? `${label} · ${detail}` : label;
  const spoken =
    share !== null || (model.indeterminate && detail !== undefined) ? sourceWords : null;
  const shown =
    caption !== undefined
      ? caption
      : share !== null
        ? sourceWords
        : model.indeterminate
          ? spoken
          : model.text;
  // A share keeps the state colours a count has: failed red, needs-you amber.
  const tone = input.failed ? 'failed' : input.blocked ? 'blocked' : '';
  const classes = [
    'seg-bar',
    size,
    model.indeterminate ? 'indeterminate' : '',
    share !== null ? `fraction${tone ? ` ${tone}` : ''}` : '',
    spoken !== null && shown === spoken ? 'words' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  // A decorative track says nothing to assistive technology; a real one is the
  // progressbar, and its caption is then hidden so it is read once.
  const track = decorative
    ? { 'aria-hidden': true as const }
    : share !== null
      ? {
          role: 'progressbar',
          'aria-label': label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent!,
          'aria-valuetext': detail ? `${percent}%, ${detail}` : `${percent}%`,
        }
      : model.indeterminate
        ? {
            role: 'progressbar',
            'aria-label': label,
            'aria-valuetext': detail ? detail : model.text,
          }
        : {
            role: 'progressbar',
            'aria-label': label,
            'aria-valuemin': 0,
            'aria-valuemax': model.total,
            'aria-valuenow': model.done,
            'aria-valuetext': model.text,
          };

  return (
    <div className={classes} data-source={reply ? 'reply' : undefined}>
      {share !== null ? (
        <div className="seg-track" {...track}>
          <span
            className="seg-fill"
            aria-hidden="true"
            style={{ '--seg-share': share } as CSSProperties}
          />
        </div>
      ) : model.indeterminate ? (
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
