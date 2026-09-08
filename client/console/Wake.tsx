import { useEffect, useRef, useState } from 'react';
import './wake.css';

export interface WakeProps {
  short?: boolean;
  failed?: boolean;
  projects?: number;
  workers?: number;
  reduced?: boolean;
  onDone(): void;
  onRetry?(): void;
}

const LETTERS = ['D', 'I', 'O', 'M', 'E', 'D', 'E', 'S'];

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

// Full wake, 1:1 with `playWake(false)` in the prototype: point at 200 ms,
// thread from 500 ms, letters from 1000 ms (one every 60 ms), status lines at
// 1200 / 1900 / 2600 ms, end at 3200 ms. Short form: letters resolved,
// `restoring context` at 200 ms, `field established` at 1000 ms, end at
// 1400 ms. Any key (capturing) or pointerdown ends early with the landing.
export function Wake({
  short = false,
  failed = false,
  projects = 0,
  workers,
  reduced = false,
  onDone,
  onRetry,
}: WakeProps) {
  const [lit, setLit] = useState<boolean[]>(() => LETTERS.map(() => short));
  const [resolved, setResolved] = useState(short);
  const [status, setStatus] = useState('');
  const [statusShown, setStatusShown] = useState(false);
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
      setStatus('field not reached');
      setStatusShown(true);
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
      at(200, () => {
        setStatus('restoring context');
        setStatusShown(true);
      });
      at(1000, () => setStatus('field established'));
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
      setStatus('recovering the field');
      setStatusShown(true);
      setSkipShown(true);
    });
    at(1900, () => {
      const ctx =
        workers === undefined
          ? `${plural(projects, 'project', 'projects')}`
          : `${plural(projects, 'project', 'projects')}   ${plural(workers, 'worker', 'workers')}`;
      setStatus(`restoring context   ${ctx}`);
    });
    at(2600, () => setStatus('field established'));
    at(3200, () => endRef.current());
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [short, failed, projects, workers, reduced]);

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

  // Reduced motion: no wake at all unless the field failed to reach.
  if (reduced && !failed) return null;

  return (
    <div
      className={ending ? 'dm-wake gone' : 'dm-wake playing'}
      aria-label="Diomedes is waking"
      onPointerDown={() => endRef.current()}
    >
      <div className="dm-wake-field">
        <span className="dm-wake-gp" ref={gpRef} />
        <span className="dm-wake-thread" />
        <div className={resolved ? 'dm-wake-letters resolved' : 'dm-wake-letters'} aria-hidden="true">
          {LETTERS.map((l, i) => (
            <span key={i} className={lit[i] ? 'on' : undefined}>
              {l}
            </span>
          ))}
        </div>
        <div className={statusShown ? 'dm-wake-status show' : 'dm-wake-status'} role="status">
          {status}
        </div>
        {failed && (
          <button type="button" className="dm-wake-retry" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
      <span className={skipShown ? 'dm-wake-skip show' : 'dm-wake-skip'}>any key skips</span>
    </div>
  );
}
