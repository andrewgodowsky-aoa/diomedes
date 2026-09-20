import { useState } from 'react';
import type { IntegrationStatus, Project, Settings, UsageSnapshot } from '../../shared/types';
import { HelperLine, UsageBar, date, leftPercent, tightestWindow } from '../components';
import type { EverythingItem } from './Everything';
import { Rail, type RailItem } from './Rail';
import './console.css';
import './everything.css';
import './home.css';

const PLACEHOLDERS = {
  business: 'Ask about a supplier, plan a schedule, or say what to do',
  school: 'Ask about a reading, plan the week, or say what to do',
  software: 'Ask about the code, plan a change, or say what to do',
  personal: 'Ask a question, plan something, or say what to do',
  mix: 'Ask, plan, or say what to do',
} as const;

const EXAMPLES = {
  business: "For example: a project for a restaurant's menus, suppliers and schedules.",
  school: "For example: a project for this semester's courses, readings and deadlines.",
  software: 'For example: a project for a codebase, its plans and its history.',
  personal: "For example: a project for a renovation, a trip, or a game you're building.",
  mix: "For example: one project per thing you're working on.",
} as const;

/** Where the Projects page can take a person, beyond opening a project. */
export type HomeDestination =
  | 'new-project'
  | 'open-folder'
  | 'sample'
  | 'find'
  | 'engines'
  | 'appearance'
  | 'design-center'
  | 'permissions'
  | 'detail'
  | 'updates'
  | 'about';

const DEFAULT_PINS: HomeDestination[] = ['new-project', 'open-folder', 'engines', 'appearance'];
const PINS_KEY = 'home.rail.pins';

// The same reason Shell keeps its pins in localStorage: a new settings key is a
// server change, and which rows a person keeps in their sidebar is theirs.
function storedPins(): string[] {
  try {
    const saved = localStorage.getItem(PINS_KEY);
    if (saved === null) return DEFAULT_PINS;
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : DEFAULT_PINS;
  } catch {
    return DEFAULT_PINS;
  }
}

interface HomeProps {
  projects: Project[];
  /** The same projects, most recently opened first: the composer's default target. */
  byRecency: Project[];
  settings: Settings;
  integrations: IntegrationStatus[];
  usage: UsageSnapshot[];
  saveSettings: (s: Settings) => void | Promise<void>;
  text: string;
  onText: (value: string) => void;
  targetId: string | null;
  onTarget: (id: string) => void;
  onSend: (text: string, project: Project) => void;
  onOpenProject: (p: Project) => void;
  onGo: (destination: HomeDestination) => void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What one project is doing, read from its own status record and nothing else. */
function projectLine(p: Project): { text: string; tone?: 'attn' | 'live' } {
  if (p.status?.needsYou) return { text: 'Needs your OK', tone: 'attn' };
  if (p.status?.working)
    return { text: `Working on ${plural(p.status.working, 'task')}`, tone: 'live' };
  if (p.status?.tasksTotal)
    return { text: `${p.status.tasksDone} of ${p.status.tasksTotal} tasks done` };
  return { text: 'Ready to begin' };
}

/**
 * The Projects page: where Diomedes opens when no project is, and where the
 * "Projects" crumb leads from anywhere.
 *
 * It is the Console's own three regions (docs/implementation/
 * 2026-09-20-console-design-language.md): the rail lists projects on the spine
 * the thread rail lists threads on, with the same foot of pinned destinations
 * and the same Everything flyout; the work column is the ask box and a register
 * of every project with its readouts; the ledger reads across projects the way
 * a project's ledger reads across its threads. The spine's point marks the
 * project the ask box will send to.
 *
 * Every figure here is read from `project.status` and `project.counts`, the
 * integrations list and the usage snapshots. The page keeps no second idea of
 * what a project or an engine is doing.
 */
export function Home({
  projects,
  byRecency,
  settings,
  integrations,
  usage,
  saveSettings,
  text,
  onText,
  targetId,
  onTarget,
  onSend,
  onOpenProject,
  onGo,
}: HomeProps) {
  const [pins, setPinsState] = useState<string[]>(storedPins);
  const setPins = (next: string[]) => {
    setPinsState(next);
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
    } catch {
      // Storage is unavailable; the pins hold for this visit.
    }
  };
  const work = settings.onboarding.work ?? 'mix';
  const target = byRecency.find((p) => p.id === targetId) ?? byRecency[0];
  const send = () => {
    if (target) onSend(text, target);
  };
  // What needs the person comes first; after that, the order they last worked in.
  const listed = [...projects].sort(
    (a, b) =>
      (b.status?.needsYou ? 1 : 0) - (a.status?.needsYou ? 1 : 0) ||
      (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt),
  );
  const hasSample = projects.some((p) => p.name.toLowerCase().includes('harbor street'));
  const waiting = listed.filter((p) => p.status?.needsYou);
  const running = listed.filter((p) => p.status?.working);
  const runningTasks = running.reduce((n, p) => n + (p.status?.working ?? 0), 0);
  const changesToday = projects.reduce((n, p) => n + (p.counts?.historyToday ?? 0), 0);
  const engines = integrations.filter((i) => i.adapter === 'ready' && i.kind !== 'sample');

  const railItems: RailItem[] = listed.map((p) => {
    const line = projectLine(p);
    return {
      id: p.id,
      name: p.name,
      time: date(p.lastOpenedAt || p.createdAt),
      sub: line.text,
      tone: line.tone,
    };
  });

  const destinations: EverythingItem[] = [
    { id: 'new-project', label: 'New project', hint: 'Start from an empty folder.' },
    {
      id: 'open-folder',
      label: 'Open a folder',
      hint: 'Make a project of documents you already have.',
    },
    ...(hasSample
      ? []
      : [
          {
            id: 'sample',
            label: 'Sample project',
            hint: 'Three example documents to explore on this computer.',
          },
        ]),
    { id: 'find', label: 'Find a project', hint: 'Search every project by name.', badge: 'Ctrl K' },
    {
      id: 'engines',
      label: 'AI engines',
      hint: 'Which engines are installed, signed in, and switched on.',
    },
    { id: 'appearance', label: 'Appearance', hint: 'Colour scheme, text size and motion.' },
    {
      id: 'design-center',
      label: 'Design Center',
      hint: 'Make and apply a theme of your own.',
    },
    {
      id: 'permissions',
      label: 'Permissions',
      hint: 'What Diomedes may do on its own, and what always asks first.',
    },
    { id: 'detail', label: 'Interface detail', hint: 'How much each change spells out.' },
    { id: 'updates', label: 'App updates', hint: 'The version you run, and what is newer.' },
    { id: 'about', label: 'About', hint: 'Version, licences and where your data lives.' },
  ];
  const groups = [
    { heading: 'Projects', ids: ['new-project', 'open-folder', 'sample', 'find'] },
    {
      heading: 'Diomedes',
      ids: ['engines', 'appearance', 'design-center', 'permissions', 'detail', 'updates', 'about'],
    },
  ];

  return (
    <main className="console home">
      <div className="stage home-stage">
        <Rail
          title="All projects"
          navLabel="Projects and destinations"
          items={railItems}
          selectedId={target?.id ?? null}
          onSelect={(id) => {
            const p = projects.find((x) => x.id === id);
            if (p) onOpenProject(p);
          }}
          onNew={() => onGo('new-project')}
          destinations={destinations}
          groups={groups}
          pinned={pins}
          onDestination={(id) => onGo(id as HomeDestination)}
          onTogglePin={(id) =>
            setPins(pins.includes(id) ? pins.filter((item) => item !== id) : [...pins, id])
          }
        />

        <section className="screen on home-screen" aria-label="Projects">
          <div className="work home-work">
            <div className="col head home-head">
              <h1>Projects</h1>
              {/* With no projects yet the page below offers these same acts,
                  with a sentence each; the header does not say them twice. */}
              {projects.length > 0 && (
                <div className="home-actions">
                  <button type="button" className="home-btn" onClick={() => onGo('open-folder')}>
                    Open a folder as a project
                  </button>
                  <button type="button" className="home-btn go" onClick={() => onGo('new-project')}>
                    New project
                  </button>
                </div>
              )}
            </div>
            {projects.length > 0 && (
              <div className="col instr" aria-label="Across your projects">
                <span>
                  projects <b>{projects.length}</b>
                </span>
                <span className={waiting.length ? 'attn' : ''}>
                  need you <b>{waiting.length}</b>
                </span>
                <span>
                  running <b>{runningTasks}</b>
                </span>
                <span>
                  changes today <b>{changesToday}</b>
                </span>
              </div>
            )}

            <div className="home-scroll">
              {projects.length ? (
                <div className="col home-col">
                  <section className="home-ask" aria-label="Start here">
                    <h2>What do you want to do?</h2>
                    <div className="composer">
                      <textarea
                        rows={2}
                        aria-label="Ask, plan, or say what to do"
                        placeholder={PLACEHOLDERS[work]}
                        value={text}
                        onChange={(e) => onText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            send();
                          }
                        }}
                      />
                      <div className="bar">
                        <label className="home-target">
                          <span>In project</span>
                          <select
                            aria-label="In project"
                            value={target?.id ?? ''}
                            onChange={(e) => onTarget(e.target.value)}
                          >
                            {byRecency.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className={`send${text.trim() ? ' ready' : ''}`}
                          disabled={!text.trim()}
                          onClick={send}
                        >
                          Send
                        </button>
                        <span className="hint" aria-hidden="true">
                          Enter
                        </span>
                      </div>
                    </div>
                    <HelperLine
                      integrations={integrations}
                      settings={settings}
                      saveSettings={saveSettings}
                    />
                  </section>

                  <section className="home-register" aria-label="Your projects">
                    <div className="home-reg-head mono" aria-hidden="true">
                      <span>Project</span>
                      <span>Tasks</span>
                      <span>Waiting</span>
                      <span>Running</span>
                      <span>Today</span>
                      <span>Opened</span>
                    </div>
                    <ul className="home-list">
                      {listed.map((p) => {
                        const line = projectLine(p);
                        const total = p.status?.tasksTotal ?? 0;
                        const done = p.status?.tasksDone ?? 0;
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              className="home-row"
                              onClick={() => onOpenProject(p)}
                            >
                              <span className="home-name">
                                <span className="home-title">
                                  <span
                                    className={`pt${line.tone === 'attn' ? ' attn' : line.tone === 'live' ? ' live' : ''}`}
                                    aria-hidden="true"
                                  />
                                  <strong>{p.name}</strong>
                                </span>
                                <span className={`home-sub${line.tone ? ` ${line.tone}` : ''}`}>
                                  {line.text}
                                </span>
                                {settings.detail === 'technical' && (
                                  <span className="mono lc home-path" title={p.folder}>
                                    {p.folder}
                                  </span>
                                )}
                              </span>
                              <span className="home-cell home-tasks">
                                <span className="home-meter" aria-hidden="true">
                                  <i style={{ width: total ? `${(done / total) * 100}%` : '0%' }} />
                                </span>
                                <span className="mono lc">
                                  {done}/{total}
                                </span>
                              </span>
                              <span
                                className={`home-cell mono lc${p.status?.needsYou ? ' attn' : ''}`}
                              >
                                {p.status?.needsYou ?? 0}
                              </span>
                              <span
                                className={`home-cell mono lc${p.status?.working ? ' live' : ''}`}
                              >
                                {p.status?.working ?? 0}
                              </span>
                              <span className="home-cell mono lc">
                                {p.counts?.historyToday ?? 0}
                              </span>
                              <span className="home-cell mono lc home-when">
                                {date(p.lastOpenedAt || p.createdAt)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="home-note">
                      Projects are ordinary folders on this computer.
                      {!hasSample && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="home-link"
                            onClick={() => onGo('sample')}
                          >
                            Try the sample project.
                          </button>
                        </>
                      )}
                    </p>
                  </section>
                </div>
              ) : (
                <div className="col home-col">
                  <section className="home-first" aria-label="Start here">
                    <h2>Start with a project</h2>
                    <p className="home-note">{EXAMPLES[work]}</p>
                    <ul className="home-list">
                      <li>
                        <button
                          type="button"
                          className="home-row first"
                          onClick={() => onGo('new-project')}
                        >
                          <span className="home-name">
                            <strong>New project</strong>
                            <span className="home-sub">Start from an empty folder.</span>
                          </span>
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          className="home-row first"
                          onClick={() => onGo('open-folder')}
                        >
                          <span className="home-name">
                            <strong>Open a folder as a project</strong>
                            <span className="home-sub">Use documents you already have.</span>
                          </span>
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          className="home-row first"
                          onClick={() => onGo('sample')}
                        >
                          <span className="home-name">
                            <strong>Try the sample project</strong>
                            <span className="home-sub">
                              Three example documents to explore on this computer.
                            </span>
                          </span>
                        </button>
                      </li>
                    </ul>
                    <p className="home-note">Projects are ordinary folders on this computer.</p>
                  </section>
                </div>
              )}
            </div>
          </div>

          <aside className="ledger" aria-label="Across your projects">
            <h2>Across projects</h2>
            <p className="sub">
              {projects.length
                ? `${plural(projects.length, 'project')}, ${plural(
                    projects.reduce((n, p) => n + (p.status?.tasksTotal ?? 0), 0),
                    'task',
                  )}`
                : 'Nothing here yet'}
            </p>

            <section>
              <h3>
                Needs you <span className="mono">{waiting.length} waiting</span>
              </h3>
              <ul>
                {waiting.length ? (
                  waiting.map((p) => (
                    <li key={p.id}>
                      <span className="pt attn" />
                      <span className="home-ledger-name">{p.name}</span>
                      <button type="button" onClick={() => onOpenProject(p)}>
                        Review
                      </button>
                    </li>
                  ))
                ) : (
                  <li className="quiet">Nothing right now</li>
                )}
              </ul>
            </section>

            <section className={running.length ? '' : 'dim'}>
              <h3>
                Working <span className="mono">{runningTasks} running</span>
              </h3>
              <ul>
                {running.length ? (
                  running.map((p) => (
                    <li key={p.id}>
                      <span className="pt live" />
                      <span className="home-ledger-name">{p.name}</span>
                      <span className="mono">{plural(p.status.working, 'task')}</span>
                    </li>
                  ))
                ) : (
                  <li className="quiet">Nothing running</li>
                )}
              </ul>
            </section>

            <section>
              <h3>
                Engines{' '}
                <span className="mono">
                  {engines.filter((i) => i.available && settings.services?.[i.id]).length} on
                </span>
              </h3>
              <ul>
                {engines.length ? (
                  engines.map((i) => {
                    const on = i.available && !!settings.services?.[i.id];
                    const snapshot = usage.find((u) => u.engine === i.id);
                    const tight = snapshot ? tightestWindow(snapshot) : null;
                    return (
                      <li key={i.id} className="home-engine">
                        <span className={`pt${on ? ' live' : ''}`} />
                        <span className="home-ledger-name">{i.name}</span>
                        <span className="mono">
                          {on ? 'On' : i.available ? 'Off' : 'Unavailable'}
                        </span>
                        {on && tight && (
                          <span className="sub home-engine-usage">
                            <UsageBar window={tight} />
                            {tight.label}, {leftPercent(tight)}% left
                          </span>
                        )}
                      </li>
                    );
                  })
                ) : (
                  <li className="quiet">No engine found on this computer</li>
                )}
              </ul>
              <button type="button" className="home-ledger-link" onClick={() => onGo('engines')}>
                Open AI engines
              </button>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
