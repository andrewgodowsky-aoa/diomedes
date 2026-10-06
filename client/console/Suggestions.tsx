import type { Suggestion } from './home-rail';

interface SuggestionsProps {
  items: readonly Suggestion[];
  /** The suggestion an Accept is in flight for, so its buttons wait. */
  busyId: string | null;
  /** One plain sentence about the last Accept that failed, or null. */
  error: string | null;
  onAccept(item: Suggestion): void;
  onNotNow(item: Suggestion): void;
}

/**
 * "Nectovia suggests" (round 2 reskin, N1; slice 2 decision 2, option A): tasks a Nectovia run
 * proposed that wait in the Inbox for an OK. With none there is no section at all.
 *
 * Accept moves the task out of the Inbox and onto the Board, where it starts only when the person
 * starts it. Not now hides the card on this computer. Neither runs anything.
 */
export function Suggestions({ items, busyId, error, onAccept, onNotNow }: SuggestionsProps) {
  if (items.length === 0) return null;
  return (
    <section className="nv-suggests" aria-labelledby="nv-suggests-head">
      <h2 id="nv-suggests-head">Nectovia suggests</h2>
      <ul>
        {items.map((item) => (
          <li key={item.taskId} className="nv-suggest">
            <b>{item.name}</b>
            {item.line && <p>{item.line}</p>}
            <div className="nv-suggest-do">
              <button
                type="button"
                className="send ready"
                aria-disabled={busyId !== null || undefined}
                onClick={() => {
                  if (busyId === null) onAccept(item);
                }}
              >
                {busyId === item.taskId ? 'Accepting' : 'Accept'}
              </button>
              <button
                type="button"
                className="send"
                aria-disabled={busyId !== null || undefined}
                onClick={() => {
                  if (busyId === null) onNotNow(item);
                }}
              >
                Not now
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p className="nv-suggest-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
