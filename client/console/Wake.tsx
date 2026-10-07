import { useEffect, useRef, useState } from 'react';
import './wake.css';

export interface WakeProps {
  short?: boolean;
  failed?: boolean;
  /** Still passed by the app. The waking screen no longer counts projects (board D07): a new person has none. */
  projects?: number;
  workers?: number;
  reduced?: boolean;
  onDone(): void;
  onRetry?(): void;
}

const LETTERS = ['N', 'E', 'C', 'T', 'O', 'V', 'I', 'A'];

/** One of the field's words. A word that gives way to the next fades in, holds and fades out. */
interface Line {
  text: string;
  hold?: 'mid' | 'mid slow';
}

// Full wake, on the approved prototype's timings: point at 200 ms, thread from 500 ms, letters
// from 1000 ms (one every 60 ms), the field's words at 1200 / 1900 / 2600 ms, end at 3200 ms.
// Short form after a reconnect: letters resolved, `reconnecting` at 200 ms, `ready` at 1000 ms,
// end at 1400 ms. Any key (capturing) or pointerdown ends early with the landing. When the first
// load fails, the field stops and says so (board D07, Didn't start).
export function Wake({ short = false, failed = false, reduced = false, onDone, onRetry }: WakeProps) {
  const [lit, setLit] = useState<boolean[]>(() => LETTERS.map(() => short));
  const [resolved, setResolved] = useState(short);
  const [line, setLine] = useState<Line | null>(null);
  const [skipShown, setSkipShown] = useState(false);
  const [ending, setEnding] = useState(false);
  const gpRef = useRef<HTMLSpanElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const endingRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const end = () => {
    if (endingRef.current || failed) return;
    endingRef.current = true;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const gp = gpRef.current;
    if (gp && !reduced) {
      const target = document.querySelector('[data-mark-point]');
      if (target) {
        const a = gp.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        const dx = b.left + b.width / 2 - (a.left + a.width / 2);
        const dy = b.top + b.height / 2 - (a.top + a.height / 2);
        gp.classList.add('settle');
        gp.style.transform = `translate(${dx}px, ${dy}px) scale(0.8)`;
        gp.style.opacity = '0';
      }
    }
    setEnding(true);
    // The layer fades over 320 ms (plus the 120 ms exit delay); unmount after.
    timers.current.push(setTimeout(() => onDoneRef.current(), 460));
  };
  const endRef = useRef(end);
  endRef.current = end;

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    endingRef.current = false;
    if (failed) {
      setLit(LETTERS.map(() => true));
      setResolved(true);
      setLine(null);
      setSkipShown(false);
      return () => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
      };
    }
    const at = (ms: number, fn: () => void) => {
      timers.current.push(setTimeout(fn, reduced ? 0 : ms));
    };
    if (short) {
      setLit(LETTERS.map(() => true));
      setResolved(true);
      at(200, () => setLine({ text: 'reconnecting', hold: 'mid slow' }));
      at(1000, () => setLine({ text: 'ready' }));
      at(1400, () => endRef.current());
      return () => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
      };
    }
    LETTERS.forEach((_, i) =>
      at(1000 + i * 60, () =>
        setLit((prev) => {
          if (prev[i]) return prev;
          const next = [...prev];
          next[i] = true;
          return next;
        }),
      ),
    );
    at(1050, () => setResolved(true));
    at(1200, () => {
      setLine({ text: 'opening nectovia', hold: 'mid' });
      setSkipShown(true);
    });
    at(1900, () => setLine({ text: 'loading your projects', hold: 'mid' }));
    at(2600, () => setLine({ text: 'ready' }));
    at(3200, () => endRef.current());
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [short, failed, reduced]);

  useEffect(() => {
    if (failed) return;
    const onKey = () => endRef.current();
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [failed]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  // Reduced motion: no wake at all unless the first load didn't finish.
  if (reduced && !failed) return null;

  const letters = (
    <div className={resolved ? 'dm-wake-letters resolved' : 'dm-wake-letters'} aria-hidden="true">
      {LETTERS.map((l, i) => (
        <span key={i} className={lit[i] ? 'on' : undefined}>
          {l}
        </span>
      ))}
    </div>
  );

  if (failed)
    return (
      <div className="dm-wake failed" aria-label="Nectovia didn't finish opening">
        <div className="dm-wake-field">
          <span className="dm-wake-gp" ref={gpRef} />
          <span className="dm-wake-thread" />
          {letters}
          <p className="dm-wake-message" role="alert">
            Nectovia didn&apos;t finish opening.
          </p>
          <div className="dm-wake-actions">
            <button type="button" className="button dm-wake-retry" onClick={onRetry}>
              Try again
            </button>
          </div>
          <p className="dm-wake-hint">If it happens again, close Nectovia and open it again.</p>
        </div>
      </div>
    );

  return (
    <div
      className={ending ? 'dm-wake gone' : 'dm-wake playing'}
      aria-label={short ? 'Nectovia is reconnecting' : 'Nectovia is opening'}
      onPointerDown={() => endRef.current()}
    >
      <div className="dm-wake-field">
        <span className="dm-wake-gp" ref={gpRef} />
        <span className="dm-wake-thread" />
        {letters}
        <div className="dm-wake-status" role="status">
          {line && (
            <span key={line.text} className={line.hold ? `dm-wake-line ${line.hold}` : 'dm-wake-line'}>
              {line.text}
            </span>
          )}
        </div>
      </div>
      <span className={skipShown ? 'dm-wake-skip show' : 'dm-wake-skip'}>Press any key to skip</span>
    </div>
  );
}
