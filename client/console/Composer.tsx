import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation, Mode, Route } from '../../shared/types';
import { reducedMotion, spring } from './motion';
import { SendConfirmation } from './SendConfirmation';

const MODE_ORDER: Mode[] = ['ask', 'plan', 'build', 'fix'];
const CAPS: Record<Mode, string> = {
  ask: 'Nothing in the project changes.',
  plan: 'A plan you read before work begins.',
  build: 'Applied only on your go-ahead.',
  fix: 'The smallest change that clears the failure.',
};
const PLACEHOLDERS: Record<Mode, string> = {
  ask: 'Ask or think out loud',
  plan: 'What should the plan cover?',
  build: 'What should be done?',
  fix: 'What went wrong?',
};
/** Trailing line per mode: width in px; plan draws dashed. */
const LINE_FOR: Record<Mode, [number, boolean]> = {
  ask: [0, false],
  plan: [22, true],
  build: [34, false],
  fix: [12, false],
};

interface ComposerProps {
  thread: Conversation;
  mode: Mode;
  onMode(mode: Mode): void;
  busy: boolean;
  online: boolean;
  route: Route;
  confirmSend: boolean;
  prepareSources(text: string, failingDocument: string): Promise<string[]>;
  onSend(text: string, failingDocument: string, failingText: string, sources: string[]): void;
}

/**
 * The prototype composer 1:1: autosizing box, the mode strip with its
 * point-and-line indicator, the caption, Send and the Enter hint, plus the
 * Build/Fix aux rows.
 */
export function Composer({
  thread, mode, onMode, busy, online, route, confirmSend, prepareSources, onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [failingDocument, setFailingDocument] = useState('');
  const [failingText, setFailingText] = useState('');
  const [pending, setPending] = useState<{ text: string; sources: string[]; send(): void } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const preparingRef = useRef(false);
  const preparation = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const modes = useRef<HTMLDivElement>(null);
  const ind = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const sources = [...new Set(thread.turns.flatMap((t) => t.sources ?? []))];
  const fixReady = failingDocument.trim() !== '' || failingText.trim() !== '';
  const ready = text.trim() !== '' && (mode !== 'fix' || fixReady);

  // A pending send belongs to this thread, mode and route. Late listing results
  // cannot open a confirmation after navigation or reuse a different route.
  useEffect(() => {
    setPending(null);
    setPreparing(false);
    setError('');
    return () => {
      preparation.current += 1;
      preparingRef.current = false;
    };
  }, [thread.id, mode, route]);

  useEffect(() => {
    setText('');
    setFailingDocument('');
    setFailingText('');
  }, [thread.id]);
  useEffect(() => {
    if (mode !== 'fix') {
      setFailingDocument('');
      setFailingText('');
    }
  }, [mode]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  // The mode strip's point rides a small spring (stiffness 210, damping 22,
  // relative exit test, 267 ms budget) and its line scales, never resizes. Interruptible:
  // a new mode cancels the running animation and springs from the current
  // computed position. The CSS transition this replaces is removed in
  // console.css; motion.ts owns the movement now.
  const indAnim = useRef<Animation | null>(null);
  const lineAnim = useRef<Animation | null>(null);
  const indX = useRef<number | null>(null);
  const lineS = useRef<number | null>(null);
  useLayoutEffect(() => {
    const active = mode === 'ask' || mode === 'plan' || mode === 'build' || mode === 'fix'
      ? buttons.current.get(mode)
      : undefined;
    const bar = ind.current;
    if (!active || !bar) return;
    const toX = active.offsetLeft + 10;
    const [width, dashed] = LINE_FOR[mode];
    const toS = width / 34;
    const rail = line.current;
    if (rail) rail.classList.toggle('dash', dashed);
    if (indX.current === toX && lineS.current === toS) return;
    if (reducedMotion() || indX.current === null) {
      bar.style.transform = `translateX(${toX}px)`;
      if (rail) rail.style.transform = `scaleX(${toS})`;
      indX.current = toX;
      lineS.current = toS;
      return;
    }
    // Read the current computed position first, then cancel: the spring
    // starts where the eye is, not where the last trip was heading.
    let curX = indX.current;
    try {
      const m = new DOMMatrix(getComputedStyle(bar).transform);
      if (Number.isFinite(m.m41)) curX = m.m41;
    } catch {
      // Keep the last target; the spring still lands true.
    }
    let curS = lineS.current ?? 0;
    try {
      if (rail) {
        const ml = new DOMMatrix(getComputedStyle(rail).transform);
        if (Number.isFinite(ml.m11)) curS = ml.m11;
      }
    } catch {
      // Keep the last scale; the spring still lands true.
    }
    try {
      indAnim.current?.cancel();
    } catch {
      // The previous run already finished; the new trip still starts.
    }
    try {
      lineAnim.current?.cancel();
    } catch {
      // The previous run already finished; the new trip still starts.
    }
    indAnim.current = null;
    lineAnim.current = null;
    const fx = spring(curX, toX);
    const move = bar.animate(
      fx.map((x) => ({ transform: `translateX(${x}px)` })),
      {
        duration: Math.max(1, Math.round((fx.length * 1000) / 120)),
        easing: 'linear',
        fill: 'forwards',
      },
    );
    indAnim.current = move;
    move.onfinish = () => {
      bar.style.transform = `translateX(${toX}px)`;
      try {
        move.cancel();
      } catch {
        // Already done; the end state is committed above.
      }
      if (indAnim.current === move) indAnim.current = null;
    };
    if (rail) {
      const fs = spring(curS, toS);
      const grow = rail.animate(
        fs.map((s) => ({ transform: `scaleX(${s})` })),
        {
          duration: Math.max(1, Math.round((fs.length * 1000) / 120)),
          easing: 'linear',
          fill: 'forwards',
        },
      );
      lineAnim.current = grow;
      grow.onfinish = () => {
        rail.style.transform = `scaleX(${toS})`;
        try {
          grow.cancel();
        } catch {
          // Already done; the end state is committed above.
        }
        if (lineAnim.current === grow) lineAnim.current = null;
      };
    }
    indX.current = toX;
    lineS.current = toS;
  }, [mode]);

  function dispatch(send: () => void) {
    if (!preparingRef.current || busy || !online) return;
    preparingRef.current = false;
    setPending(null);
    send();
    setText('');
    setFailingDocument('');
    setFailingText('');
  }

  async function submit() {
    const value = text.trim();
    if (!value || busy || !online || preparingRef.current) return;
    if (mode === 'fix' && !fixReady) return;
    preparingRef.current = true;
    setPreparing(true);
    setError('');
    const attempt = ++preparation.current;
    const doc = failingDocument.trim();
    const failure = failingText.trim();
    try {
      const selected = await prepareSources(value, doc);
      if (preparation.current !== attempt) return;
      const send = () => onSend(value, doc, failure, selected);
      if (confirmSend) setPending({ text: value, sources: selected, send });
      else dispatch(send);
    } catch (e) {
      if (preparation.current !== attempt) return;
      preparingRef.current = false;
      setError(e instanceof Error ? e.message : 'The project documents could not be listed.');
    } finally {
      if (preparation.current === attempt) setPreparing(false);
    }
  }

  return (
    <div className="col compose">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={box}
          rows={1}
          aria-label="Message this thread"
          placeholder={PLACEHOLDERS[mode]}
          value={text}
          disabled={preparing || pending !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {/* Named documents are worth stating; the approval promise is already on
            the caption below, so an empty scope says nothing at all. */}
        {mode === 'build' && sources.length > 0 && (
          <div className="aux show">
            <span className="mono">in scope</span>
            <span className="mono lc names" style={{ color: 'var(--t1)' }} title={sources.join(', ')}>
              {sources.join(', ')}
            </span>
          </div>
        )}
        {mode === 'fix' && (
          <div className="aux show">
            <span>What is failing</span>
            <select
              aria-label="What is failing"
              value={failingDocument}
              onChange={(e) => setFailingDocument(e.target.value)}
            >
              <option value="">Not a document</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Paste what went wrong"
              placeholder="Paste what went wrong..."
              value={failingText}
              onChange={(e) => setFailingText(e.target.value)}
              rows={1}
            />
            <span style={{ marginLeft: 'auto' }}>Up to three tries.</span>
          </div>
        )}
        <div className="bar">
          <div className="modes" ref={modes} role="radiogroup" aria-label="Mode">
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                ref={(el) => {
                  if (el) buttons.current.set(m, el);
                  else buttons.current.delete(m);
                }}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? 'on' : ''}
                onClick={() => onMode(m)}
              >
                {m}
              </button>
            ))}
            <span className="ind" ref={ind}>
              <i />
              <b ref={line} />
            </span>
          </div>
          <span className="cap">
            {mode === 'fix' && !fixReady
              ? 'Pick the document or paste what went wrong to send.'
              : CAPS[mode]}
          </span>
          <button
            type="submit"
            className={`send ${ready ? 'ready' : ''}`}
            aria-disabled={!ready || busy || !online || preparing || pending !== null}
            disabled={busy || !online || preparing || pending !== null}
          >
            Send
          </button>
          <span className="hint">Enter</span>
        </div>
      </form>
      {error && <p className="caption" role="alert">{error}</p>}
      {pending && (
        <SendConfirmation
          kind="message"
          instruction={pending.text}
          route={route}
          sources={pending.sources}
          mode={mode}
          disabled={busy || !online}
          onClose={() => {
            preparingRef.current = false;
            setPending(null);
          }}
          onSend={() => dispatch(pending.send)}
        />
      )}
    </div>
  );
}
