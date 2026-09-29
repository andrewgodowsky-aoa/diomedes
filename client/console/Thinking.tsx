import { useState } from 'react';
import { thoughtFor } from './engine-reasoning';

/**
 * An engine's thinking, above its reply. While it streams and no answer has started, it is open
 * and muted. Once the answer starts, and on a saved reply, it folds to one line that opens on
 * click. Nothing shows when there is no thinking.
 */
export function Thinking({
  text,
  ms,
  live = false,
  shortened = false,
}: {
  text: string;
  /** How long it ran, or null while it is still running. */
  ms: number | null;
  live?: boolean;
  shortened?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  if (live && ms === null)
    return (
      <div className="thinking thinking-live" role="status" aria-live="polite">
        <span className="thinking-label">Thinking</span>
        <p className="thinking-text">{text}</p>
      </div>
    );
  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {thoughtFor(ms ?? 0)}
      </button>
      {open && (
        <p className="thinking-text">
          {text}
          {shortened ? <span className="thinking-note"> Shortened to fit.</span> : null}
        </p>
      )}
    </div>
  );
}
