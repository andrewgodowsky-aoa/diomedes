import type { IntegrationStatus, Project, Settings } from '../../shared/types';
import { HelperLine, Mark, date } from '../components';
import './console.css';
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

interface HomeProps {
  projects: Project[];
  /** The same projects, most recently opened first: the composer's default target. */
  byRecency: Project[];
  settings: Settings;
  integrations: IntegrationStatus[];
  saveSettings: (s: Settings) => void | Promise<void>;
  text: string;
  onText: (value: string) => void;
  targetId: string | null;
  onTarget: (id: string) => void;
  onSend: (text: string, project: Project) => void;
  onOpenProject: (p: Project) => void;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onSample: () => void;
}

/**
 * The Projects page: where Diomedes opens when no project is, and where the
 * "Projects" crumb leads from anywhere. It is drawn in the Console's language
 * (docs/implementation/2026-09-20-console-design-language.md): the composer is
 * the thread composer's box, the list is rows that light on hover rather than
 * ruled lines, and `.console .col` owns the measure (standing decision 6).
 *
 * Everything a row says is read from the project's own status record. Nothing
 * here keeps a second idea of what a project is doing.
 */
export function Home({
  projects,
  byRecency,
  settings,
  integrations,
  saveSettings,
  text,
  onText,
  targetId,
  onTarget,
  onSend,
  onOpenProject,
  onNewProject,
  onOpenFolder,
  onSample,
}: HomeProps) {
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

  return (
    <main className="console home">
      <div className="home-scroll">
        <div className="col home-col">
          <header className="home-head">
            <h1>Projects</h1>
            {/* With no projects yet the page below offers these same two acts,
                with a sentence each; the header does not say them twice. */}
            {projects.length > 0 && (
              <div className="home-actions">
                <button type="button" className="home-btn" onClick={onOpenFolder}>
                  Open a folder as a project
                </button>
                <button type="button" className="home-btn go" onClick={onNewProject}>
                  New project
                </button>
              </div>
            )}
          </header>

          {projects.length ? (
            <>
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

              <section className="home-projects" aria-label="Your projects">
                <h2>Your projects</h2>
                <ul className="home-list">
                  {listed.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="home-row" onClick={() => onOpenProject(p)}>
                        <span className="home-name">
                          <strong>{p.name}</strong>
                          {settings.detail === 'technical' && (
                            <span className="mono lc home-path" title={p.folder}>
                              {p.folder}
                            </span>
                          )}
                        </span>
                        <span className={`home-status${p.status?.needsYou ? ' attn' : ''}`}>
                          {p.status?.needsYou ? (
                            <>
                              <Mark state="waiting" />
                              Needs your OK
                            </>
                          ) : p.status?.working ? (
                            <>
                              <Mark state="working" />
                              Working on {p.status.working}{' '}
                              {p.status.working === 1 ? 'task' : 'tasks'}
                            </>
                          ) : p.status?.tasksTotal ? (
                            `${p.status.tasksDone} of ${p.status.tasksTotal} tasks done`
                          ) : (
                            'Ready to begin'
                          )}
                        </span>
                        <span className="mono lc home-when">
                          {date(p.lastOpenedAt || p.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="home-note">
                  Projects are ordinary folders on this computer.
                  {!hasSample && (
                    <>
                      {' '}
                      <button type="button" className="home-link" onClick={onSample}>
                        Try the sample project.
                      </button>
                    </>
                  )}
                </p>
              </section>
            </>
          ) : (
            <section className="home-first" aria-label="Start here">
              <h2>Start with a project</h2>
              <p className="home-note">{EXAMPLES[work]}</p>
              <ul className="home-list">
                <li>
                  <button type="button" className="home-row first" onClick={onNewProject}>
                    <span className="home-name">
                      <strong>New project</strong>
                      <span className="home-sub">Start from an empty folder.</span>
                    </span>
                  </button>
                </li>
                <li>
                  <button type="button" className="home-row first" onClick={onOpenFolder}>
                    <span className="home-name">
                      <strong>Open a folder as a project</strong>
                      <span className="home-sub">Use documents you already have.</span>
                    </span>
                  </button>
                </li>
                <li>
                  <button type="button" className="home-row first" onClick={onSample}>
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
          )}
        </div>
      </div>
    </main>
  );
}
