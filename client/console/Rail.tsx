import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Everything, type EverythingItem } from './Everything';
import { SegmentBar } from './SegmentBar';
import type { SegmentInput } from './segment-bar-model';

export interface RailItem {
  id: string;
  name: string;
  time: string;
  sub: string;
  /** Colours the sub line when it carries a state: waiting on the person, or running. */
  tone?: 'attn' | 'live';
  /**
   * A count the item's own record keeps (a project's tasks), drawn as a small
   * segment bar ahead of the sub line. The sub line stays the words: the bar is
   * inside the row's button, so it is drawn for the eye only.
   */
  progress?: SegmentInput | null;
}

/**
 * One group of the Nectovia home's rail (round 2 reskin, N1): Needs your input, Working or
 * Finished, with its count and the jobs under it. A row opens where the job is followed.
 */
export interface RailSection {
  id: string;
  heading: string;
  count: number;
  rows: { id: string; name: string; sub: string; tone?: 'attn' | 'live' | 'fail' }[];
}

/** Finished starts folded, as the boards draw it; the groups that ask for something start open. */
const FOLDED_AT_FIRST = ['finished'];

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
  /** The New button's words. "New" unless the page says what it makes. */
  newLabel?: string;
  /**
   * Groups of jobs in place of the spine (the Nectovia home). Each group with its count and a
   * fold; a group the caller leaves out is simply not drawn.
   */
  sections?: RailSection[];
  /** Opens one row of `sections`. */
  onOpenRow?(id: string): void;
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
  newLabel = 'New',
  sections,
  onOpenRow,
}: RailProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(FOLDED_AT_FIRST));
  const fold = (id: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // The selected row's place on the spine. Its `li` is positioned, so the
  // button's own offsetTop is always 0 and the point used to sit on the first
  // row whatever was selected; the row's offset in the spine is the li's.
  const [row, setRow] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const li = selectedId ? buttons.current.get(selectedId)?.parentElement : undefined;
    setRow(li ? { top: li.offsetTop, height: li.offsetHeight } : null);
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
          {newLabel}
        </button>
      </div>
      {sections ? (
        <div className="rail-groups">
          {sections.map((section) => {
            const open = !folded.has(section.id);
            return (
              <section key={section.id} className="rail-group" aria-label={section.heading}>
                <button
                  type="button"
                  className="grp"
                  aria-expanded={open}
                  onClick={() => fold(section.id)}
                >
                  <svg className="chev" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="hd">{section.heading}</span>
                  <span className="ct mono">{section.count}</span>
                </button>
                {open && (
                  <ul className="spine rail-jobs">
                    {section.rows.map((row) => (
                      <li key={row.id}>
                        <button type="button" className="console-thread" onClick={() => onOpenRow?.(row.id)}>
                          <span className="tick" />
                          <span className="row">
                            <span className="nm" title={row.name}>
                              {row.name}
                            </span>
                          </span>
                          <small className={row.tone} title={row.sub}>
                            {row.sub}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : (
      <ul
        className="spine console-threads"
        style={
          row
            ? ({ '--row-top': `${row.top}px`, '--row-h': `${row.height}px` } as CSSProperties)
            : undefined
        }
      >
        {row && (
          <span className="gp" aria-hidden="true" style={{ top: row.top + 12 }}>
            {/* The seam's step beside the selected row. Only the Nectovia scheme
                draws it (nectovia.css); every other scheme shows the point. */}
            <svg
              key={selectedId}
              className="seam"
              aria-hidden="true"
              focusable="false"
              width="6"
              height={row.height + 10}
              viewBox={`0 0 6 ${row.height + 10}`}
            >
              <polyline className="seam-lead" points={`0.5,0 4.5,6 4.5,${row.height - 6}`} />
              <polyline
                className="seam-trail"
                points={`4.5,${row.height - 6} 0.5,${row.height} 0.5,${row.height + 10}`}
              />
            </svg>
          </span>
        )}
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
              {item.progress ? (
                <span className="rail-progress">
                  <SegmentBar {...item.progress} label={item.name} caption={null} decorative />
                  <small className={item.tone}>{item.sub}</small>
                </span>
              ) : (
                <small className={item.tone}>{item.sub}</small>
              )}
            </button>
          </li>
        ))}
      </ul>
      )}
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
