import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaletteEntry, PaletteProps } from './types';
import { noteRecent } from './paletteEntries';
import './palette.css';

/**
 * Ctrl+K: find a thing and act on it in its current state. 1:1 with the
 * palette script section of 05-instrumented-density-prototype.html: Up/Down
 * move the selection, Tab cycles the row's actions, Enter runs the
 * highlighted one, Escape closes. Actions marked `stay` run without closing.
 */
export function Palette({ open, entries, onClose, query: controlled, onQuery }: PaletteProps) {
  const [innerQuery, setInnerQuery] = useState('');
  const query = controlled ?? innerQuery;
  const setQuery = onQuery ?? setInnerQuery;
  const [sel, setSel] = useState(0);
  const [selAct, setSelAct] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => entries(query), [entries, query]);
  const clamped = Math.min(sel, Math.max(rows.length - 1, 0));
  const current = rows[clamped] ?? null;
  const actIndex = current ? Math.min(selAct, current.actions.length - 1) : 0;

  // Opening clears the selection; the Shell clears the query and any pending
  // confirm when it opens the palette.
  useEffect(() => {
    if (open) {
      setSel(0);
      setSelAct(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, Math.max(rows.length - 1, 0)));
        setSelAct(0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
        setSelAct(0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const row = rows[clamped];
        if (row && row.actions.length) {
          setSelAct((a) => (a + (e.shiftKey ? row.actions.length - 1 : 1)) % row.actions.length);
        }
      } else if (e.key === 'Enter') {
        const row = rows[clamped];
        if (row && (e.target === inputRef.current || e.target instanceof HTMLBodyElement)) {
          e.preventDefault();
          run(row, actIndex);
        } else if (row && e.target instanceof HTMLElement && e.target.closest('.palette')) {
          // Enter on a focused action button: let the button click run it.
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, rows, clamped, actIndex]);

  function focusComposer() {
    window.setTimeout(() => {
      const box =
        document.querySelector<HTMLTextAreaElement>('.console .composer textarea') ??
        document.querySelector<HTMLTextAreaElement>('.console textarea');
      box?.focus();
    }, 0);
  }

  function requestClose() {
    onClose();
    focusComposer();
  }

  function run(entry: PaletteEntry | null, j: number) {
    if (!entry) return;
    const action = entry.actions[j] ?? entry.actions[0];
    if (!action) return;
    if (action.stay) {
      void action.run();
      return;
    }
    noteRecent(entry.name);
    onClose();
    focusComposer();
    void action.run();
  }

  if (!open) return null;

  let group = '';
  return (
    <div
      className="veil"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Find and act">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
            setSelAct(0);
          }}
          placeholder="Task, worker, model, project, or a verb like pause"
          autoComplete="off"
          aria-label="Find a task, worker, model, project or action"
        />
        <ul>
          {rows.map((entry, i) => {
            const head = entry.group !== group ? ((group = entry.group), true) : false;
            return [
              head ? (
                <div className="group" key={`g:${entry.group}:${entry.id}`}>
                  {entry.group}
                </div>
              ) : null,
              <li
                key={entry.id}
                className={i === clamped ? 'sel' : ''}
                onClick={() => run(entry, 0)}
              >
                <span className={`pt ${entry.point}`.trimEnd()} />
                <span>{entry.name}</span>
                <span className="sub">{entry.sub}</span>
                <span className="acts">
                  {entry.actions.map((a, j) => (
                    <button
                      key={a.label}
                      type="button"
                      className={`${i === clamped && j === actIndex ? 'act' : ''} ${a.light ? 'light' : ''} ${a.stay ? 'stay' : ''}`.trim()}
                      onClick={(e) => {
                        e.stopPropagation();
                        run(entry, j);
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </span>
              </li>,
            ];
          })}
          {!rows.length && <li className="none">Nothing matches</li>}
        </ul>
        <div className="hint">
          <span className="mono">Up Down</span>
          <span className="mono">Tab picks the action</span>
          <span className="mono">Enter runs it</span>
          <span className="mono">Esc</span>
        </div>
      </div>
    </div>
  );
}
