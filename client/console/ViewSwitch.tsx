import { useEffect, useRef } from 'react';
import type { ConsoleView } from '../../shared/types';
import type { AccountPlanView } from '../../shared/accounts';
import { AskIcon } from './AskRow';
import { PlansLink, usePlanNoticeChoice } from './FreePlanNotice';
import { NECTOVIA_PAID_LINE, NECTOVIA_PAID_TITLE, VIEW_LABELS } from './work-view';
import './view-switch.css';

/**
 * The top switch, "Nectovia | Work" (round 2 boards BD1 to BD3). It replaced the View radios in the
 * "···" menu. On the free version the Nectovia tab carries a lock and opens a short notice instead
 * of the view, with the free version's three choices; the person's own engines stay in Work.
 */
export function ViewSwitch({
  view,
  free,
  notice,
  onChoose,
  onCloseNotice,
}: {
  view: ConsoleView;
  free: AccountPlanView | null;
  notice: boolean;
  onChoose(view: ConsoleView): void;
  onCloseNotice(): void;
}) {
  const { busy, error, choose } = usePlanNoticeChoice();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notice) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node))
        onCloseNotice();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [notice, onCloseNotice]);
  const tab = (id: ConsoleView) => {
    const locked = id === 'conversation' && free !== null;
    const on = view === id;
    return (
      <button
        key={id}
        type="button"
        className={`view-tab${on ? ' on' : ''}${locked ? ' locked' : ''}`}
        aria-pressed={on}
        aria-haspopup={locked ? 'dialog' : undefined}
        aria-expanded={locked ? notice : undefined}
        onClick={() => onChoose(id)}
      >
        {VIEW_LABELS[id]}
        {locked && <AskIcon name="lock" size={13} stroke={2} />}
      </button>
    );
  };
  return (
    <div className="view-switch" ref={box}>
      <nav className="views" aria-label="View">
        {tab('conversation')}
        {tab('architect')}
      </nav>
      {notice && free && (
        <div className="view-notice" role="dialog" aria-labelledby="view-notice-title">
          <p id="view-notice-title" className="vn-title">
            {NECTOVIA_PAID_TITLE}
          </p>
          <p className="vn-line">{NECTOVIA_PAID_LINE}</p>
          {error && (
            <p className="vn-error" role="alert">
              {error}
            </p>
          )}
          <div className="vn-acts">
            <PlansLink plan={free} className="send ready" />
            <button
              type="button"
              className="send"
              aria-disabled={busy || undefined}
              onClick={() => void choose('later').then((ok) => ok && onCloseNotice())}
            >
              Remind me later
            </button>
            <button
              type="button"
              className="send"
              aria-disabled={busy || undefined}
              onClick={() => void choose('never').then((ok) => ok && onCloseNotice())}
            >
              Don't remind me again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
