import type { ActivityRow, ProjectActivity } from './activity';
import { date, time } from '../components';

/**
 * The four human headings over the project's current work: Working, Needs you,
 * Ready for review, Finished recently.
 *
 * It renders the projection in `activity.ts` and decides nothing itself. An
 * empty section is left out rather than shown as "none" (decision 4), and the
 * component renders nothing at all when every section is empty, so the screen
 * keeps the sentence it has today.
 */

type Section = { heading: string; rows: ActivityRow[]; point: string };

function when(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  return Date.now() - ms < 24 * 60 * 60 * 1000 ? time(at).toLowerCase() : date(at).toLowerCase();
}

export function activitySections(activity: ProjectActivity): Section[] {
  return [
    { heading: 'Working', rows: activity.working, point: 'live' },
    { heading: 'Needs you', rows: activity.needsYou, point: 'attn' },
    { heading: 'Ready for review', rows: activity.readyForReview, point: 'attn' },
    { heading: 'Finished recently', rows: activity.finishedRecently, point: 'done' },
  ].filter((section) => section.rows.length > 0);
}

export function ActivityOverview({
  activity,
  onOpenRow,
}: {
  activity: ProjectActivity;
  onOpenRow(row: ActivityRow): void;
}) {
  const sections = activitySections(activity);
  if (!sections.length) return null;
  return (
    <div className="activity" aria-label="Project activity">
      {sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          <ul>
            {section.rows.map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => onOpenRow(row)}>
                  <span className={`pt ${section.point}`} />
                  <span className="nm">{row.label}</span>
                  <span className="sub">{row.detail}</span>
                  <span className="mono when">{when(row.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
