import type { Project, WaitingItem } from '../../shared/types';
import { SegmentBar } from './SegmentBar';
import { homeBrief, quietLine, type BriefState } from './home-brief';

const POINT: Record<BriefState, string> = { attn: 'attn', live: 'live', done: 'done' };
/** The one button a waiting item carries, named for what the person does there. */
const ACTION: Record<WaitingItem['kind'], string> = {
  approval: 'Review',
  review: 'Review',
  failed: 'Check',
};

interface HomeBriefProps {
  projects: readonly Project[];
  /** Open the project a row is about. */
  onOpen(projectId: string): void;
  /** Open one waiting item where it is decided. Without it, the item opens its project. */
  onOpenWaiting?(projectId: string, item: WaitingItem): void;
  /** The moment the report is read at; the clock is the caller's. */
  now?: Date;
}

/**
 * The agent home's report, in plain words (Home.dc.html): the date, a greeting
 * whose one accent phrase says what most needs saying, and a row for each
 * project with something to report. Each row is a sentence from the project's
 * own counts, its task tally as a segment bar, and a way into the project.
 * Drawn only in the Nectovia scheme (DiomedesHome decides).
 */
export function HomeBrief({ projects, onOpen, onOpenWaiting, now = new Date() }: HomeBriefProps) {
  const model = homeBrief(projects, now);
  const closing = quietLine(model);
  return (
    <div className="nv-brief">
      <p className="nv-date">{model.date}</p>
      <h2 className="nv-greeting">
        {model.greeting} <span className="nv-accent">{model.accent}</span>
      </h2>
      {model.waiting.length > 0 && (
        <section className="nv-report">
          <h3>Waiting on you</h3>
          <ul>
            {model.waiting.map(({ projectId, projectName, item }) => {
              const tone = item.kind === 'failed' ? 'fail' : 'attn';
              return (
                <li key={`${projectId}:${item.id}`} className={`nv-row ${tone}`}>
                  <span className={`pt ${tone}`} aria-hidden="true" />
                  <span className="nv-label">
                    {item.kind === 'failed' ? 'Failed' : 'Needs you'}
                  </span>
                  <span className="nv-what">
                    <b>{item.label}</b>
                    <span className="nv-sub">
                      {item.detail} · {projectName}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="nv-open"
                    aria-label={`${ACTION[item.kind]} ${item.label} in ${projectName}`}
                    onClick={() =>
                      onOpenWaiting ? onOpenWaiting(projectId, item) : onOpen(projectId)
                    }
                  >
                    {ACTION[item.kind]}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {(model.rows.length > 0 || closing) && (
        // Named by its heading alone: a region and a heading answering to the
        // same words would read as two places to a screen reader.
        <section className="nv-report">
          <h3>Across your projects</h3>
          {model.rows.length > 0 && (
            <ul>
              {model.rows.map((row) => (
                <li key={row.projectId} className={`nv-row ${row.state}`}>
                  <span className={`pt ${POINT[row.state]}`} aria-hidden="true" />
                  <span className="nv-label">{row.label}</span>
                  <span className="nv-what">
                    <b>{row.name}</b> {row.sentence}
                  </span>
                  <button
                    type="button"
                    className="nv-open"
                    aria-label={`Open ${row.name}`}
                    onClick={() => onOpen(row.projectId)}
                  >
                    Open
                  </button>
                  {row.progress && (
                    <SegmentBar
                      {...row.progress}
                      className="nv-bar"
                      label={`${row.name} tasks`}
                      // A finished project's sentence already says every task is
                      // done; the bar still says it to assistive technology.
                      caption={row.state === 'done' ? null : undefined}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {closing && <p className="nv-quiet">{closing}</p>}
        </section>
      )}
    </div>
  );
}
