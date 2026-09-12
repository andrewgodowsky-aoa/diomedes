import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ShellView } from './types';

export interface RailItem {
  id: string;
  name: string;
  time: string;
  sub: string;
}

interface RailProps {
  /** Rendered above the thread head: the workspace a thread belongs to. */
  top?: ReactNode;
  items: RailItem[];
  selectedId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  view: ShellView;
  onView(view: ShellView): void;
  openTasks: number;
  workerCount: number;
  /** Whether the Files pane is showing; the foot toggle states it. */
  filesOpen: boolean;
  onFiles(): void;
  onHome(): void;
  onHistory(): void;
  onEngines(): void;
}

/**
 * The thread rail: mono head, the spine with its sliding point, the three
 * views, and the files/workbook/engine foot. 1:1 with the prototype rail,
 * plus the Files pane toggle: the pane is not a view, so it is not in the
 * view switch.
 */
export function Rail({
  top,
  items,
  selectedId,
  onSelect,
  onNew,
  view,
  onView,
  openTasks,
  workerCount,
  filesOpen,
  onFiles,
  onHome,
  onHistory,
  onEngines,
}: RailProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [pointTop, setPointTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = selectedId ? buttons.current.get(selectedId) : undefined;
    setPointTop(el ? el.offsetTop + 12 : null);
  }, [selectedId, items.length]);
  return (
    <nav className="rail" aria-label="Threads and views">
      {top}
      <div className="rail-head">
        <h2>Threads</h2>
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
              <small>{item.sub}</small>
            </button>
          </li>
        ))}
      </ul>
      <div className="views">
        {(['Thread', 'Board', 'Team', 'Connections'] as ShellView[]).map((v) => (
          <button
            key={v}
            type="button"
            className={view === v ? 'on' : ''}
            onClick={() => onView(v)}
          >
            {v}
            {v === 'Board' && <span className="mono">{openTasks}</span>}
            {v === 'Team' && <span className="mono">{workerCount} workers</span>}
          </button>
        ))}
      </div>
      <div className="foot">
        <button type="button" aria-pressed={filesOpen} className={filesOpen ? 'on' : ''} onClick={onFiles}>
          Files
        </button>
        <button type="button" onClick={onHome}>
          Workbook
        </button>
        <button type="button" onClick={onHistory}>
          History
        </button>
        <button type="button" onClick={onEngines}>
          Engines
        </button>
      </div>
    </nav>
  );
}
