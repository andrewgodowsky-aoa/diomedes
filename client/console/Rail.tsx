import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Everything, type EverythingItem } from './Everything';

export interface RailItem {
  id: string;
  name: string;
  time: string;
  sub: string;
  /** Colours the sub line when it carries a state: waiting on the person, or running. */
  tone?: 'attn' | 'live';
}

interface RailProps {
  /** Rendered above the thread head: the workspace a thread belongs to. */
  top?: ReactNode;
  items: RailItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  /** Everything the Console can open, in the order Everything should read them. */
  destinations: EverythingItem[];
  /** The ids showing in the rail's own foot, in the person's chosen order. */
  pinned: string[];
  /** The destination open right now, so both the rail and the flyout mark it. */
  currentId?: string;
  onDestination(id: string): void;
  onTogglePin(id: string): void;
  /** Headings for the flyout. Without them it groups unavailable rows last. */
  groups?: { heading: string; ids: string[] }[];
  /** What the spine lists. The Projects page lists projects on the same spine. */
  title?: string;
  navLabel?: string;
}

/**
 * The thread rail: mono head, the spine with its sliding point, and a foot of
 * destinations.
 *
 * The foot used to be a fixed set: four view buttons and four more for Files,
 * the Workbook, History and Engines. Every one of them was a decision made for
 * everybody, and two of them left the Console altogether. It is now whatever
 * this person pinned, with Everything holding the rest. A rail that carries
 * nothing still works: Everything is always the last row, so nothing can be
 * pinned away into being unreachable.
 */
export function Rail({
  top,
  items,
  selectedId,
  onSelect,
  onNew,
  destinations,
  pinned,
  currentId,
  onDestination,
  onTogglePin,
  groups,
  title = 'Threads',
  navLabel,
}: RailProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [pointTop, setPointTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = selectedId ? buttons.current.get(selectedId) : undefined;
    setPointTop(el ? el.offsetTop + 12 : null);
  }, [selectedId, items.length]);
  const byId = new Map(destinations.map((item) => [item.id, item]));
  // A pinned id that names nothing is skipped rather than drawn empty: pins
  // outlive the build that wrote them, and a destination can be withdrawn.
  const shown = pinned.map((id) => byId.get(id)).filter((item): item is EverythingItem => !!item);
  // The pinned entry whose reason is showing. A pin that cannot open is never
  // silently inert: pressing it says why, in the place the person pressed.
  const [why, setWhy] = useState<string | null>(null);
  const reasonId = useId();
  return (
    <nav className="rail" aria-label={navLabel ?? 'Threads and views'}>
      {top}
      <div className="rail-head">
        <h2>{title}</h2>
        <button type="button" onClick={onNew}>
          New
        </button>
      </div>
      <ul className="spine console-threads">
        {pointTop !== null && <span className="gp" style={{ top: pointTop }} />}
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              ref={(el) => {
                if (el) buttons.current.set(item.id, el);
                else buttons.current.delete(item.id);
              }}
              className={`console-thread ${item.id === selectedId ? 'on' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <span className="tick" />
              <span className="row">
                <span className="nm">{item.name}</span>
                <span className="mono lc when">{item.time}</span>
              </span>
              <small className={item.tone}>{item.sub}</small>
            </button>
          </li>
        ))}
      </ul>
      <div className="foot">
        {shown.map((item) =>
          item.unavailableReason ? (
            // A place held for work that is not built yet. It keeps its position
            // so wiring it up later moves nothing, stays in the tab order so its
            // reason can be read, and never reaches `onDestination`.
            <button
              key={item.id}
              type="button"
              className="held"
              aria-disabled="true"
              aria-describedby={why === item.id ? `${reasonId}-${item.id}` : undefined}
              title={item.unavailableReason}
              onClick={() => setWhy(why === item.id ? null : item.id)}
            >
              <span className="lbl">{item.label}</span>
              <span className="mono">Not ready</span>
              {why === item.id && (
                <small id={`${reasonId}-${item.id}`} role="status">
                  {item.unavailableReason}
                </small>
              )}
            </button>
          ) : (
            <button
              key={item.id}
              type="button"
              className={currentId === item.id ? 'on' : ''}
              aria-current={currentId === item.id ? 'true' : undefined}
              onClick={() => onDestination(item.id)}
            >
              {item.label}
              {item.badge && <span className="mono">{item.badge}</span>}
            </button>
          ),
        )}
        <Everything
          items={destinations}
          pinned={pinned}
          currentId={currentId}
          groups={groups}
          onSelect={onDestination}
          onTogglePin={onTogglePin}
        />
      </div>
    </nav>
  );
}
