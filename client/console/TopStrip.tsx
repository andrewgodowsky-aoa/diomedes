import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, Settings } from '../../shared/types';
import { titleCase } from '../components';
import { NectoviaMark } from './NectoviaMark';
import { Mark as StateMark } from '../components';
import './console.css';
import './nectovia.css';

interface TopStripProps {
  /** The projects open as crumbs, in the order the person opened them. */
  projects: Project[];
  /** True while the Projects page itself is showing, so its crumb reads current. */
  onProjects: boolean;
  settingsOpen: boolean;
  settings: Settings;
  saveSettings: (s: Settings) => void | Promise<void>;
  onShowProjects: () => void;
  onOpenProject: (p: Project) => void;
  onToggleSettings: () => void;
  /** Opens the project search, which Ctrl K also opens outside a project. */
  onFind: () => void;
  /** Only said when it is news: offline, something waiting, or work running. */
  status: { state: 'fault' | 'waiting' | 'working'; text: string } | null;
  chip: ReactNode;
}

/**
 * The Console's top strip, for the screens that are not inside a project: the
 * Projects page and Settings. Same markup and the same rules as Shell's strip
 * (`.console .top`), so moving between a project, Projects and Settings never
 * changes the frame around the work. Shell keeps its own copy because its right
 * cluster carries the thread's pickers.
 */
export function TopStrip({
  projects,
  onProjects,
  settingsOpen,
  settings,
  saveSettings,
  onShowProjects,
  onOpenProject,
  onToggleSettings,
  onFind,
  status,
  chip,
}: TopStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setMenuOpen(false);
        return;
      }
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  return (
    <div className="console strip-only">
      <header className="top">
        <button
          type="button"
          className="strip-brand"
          aria-label="Nectovia projects"
          onClick={onShowProjects}
        >
          <NectoviaMark />
        </button>
        <nav className="crumb" aria-label="Open projects">
          <button
            type="button"
            className={onProjects ? 'on' : ''}
            aria-current={onProjects ? 'page' : undefined}
            onClick={onShowProjects}
          >
            {onProjects ? <b>Projects</b> : 'Projects'}
          </button>
          {projects.length > 0 && <span>/</span>}
          {projects.map((p) => (
            <button key={p.id} type="button" title={p.name} onClick={() => onOpenProject(p)}>
              {p.status?.needsYou || p.status?.working ? (
                <StateMark state={p.status.needsYou ? 'waiting' : 'working'} />
              ) : null}
              {p.name}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <div className="strip-status" role="status">
            {status && (
              <>
                <StateMark state={status.state} />
                <span>{status.text}</span>
              </>
            )}
          </div>
          {chip}
          <span
            className="mono link"
            role="button"
            tabIndex={0}
            title="Find a project by name"
            onClick={onFind}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onFind();
            }}
          >
            Ctrl K
          </span>
          <button
            type="button"
            className={settingsOpen ? 'on' : ''}
            aria-pressed={settingsOpen}
            onClick={onToggleSettings}
          >
            Settings
          </button>
          <div className="surface-menu" ref={menuRef}>
            <button
              type="button"
              aria-label="Interface detail menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              ···
            </button>
            {menuOpen && (
              <div className="pmenu open" role="menu">
                <p className="caption">Detail</p>
                {(['guided', 'standard', 'technical'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="menuitemradio"
                    aria-checked={settings.detail === d}
                    className={settings.detail === d ? 'on' : ''}
                    onClick={() => {
                      setMenuOpen(false);
                      void saveSettings({ ...settings, detail: d });
                    }}
                  >
                    {titleCase(d)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>
    </div>
  );
}
