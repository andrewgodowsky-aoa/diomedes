import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AUTOMATION_SUMMARY_CAPTIONS,
  type AutomationDetail,
  type AutomationLabel,
  type AutomationList,
  type AutomationSummary,
  type AutomationView,
  type OccurrenceView,
} from '../../shared/automations';
import type { WorkspaceView } from '../../shared/workspaces';
import { api, automationDetail, listAutomations, runAutomation } from '../api';
import { Mark } from '../components';
import './automations.css';

/**
 * Automations (Milestone A).
 *
 * What runs for the active business, what it last did, and what needs a
 * person, read from the host's records and never inferred here. The only
 * automation this build has is the weekly brief, and it is manual: this screen
 * says so on every row until something runs on its own.
 *
 * Modelled on Readiness: an abort-and-epoch loader, loading, error and status
 * states, and evidence behind a disclosure. The run is followed through the
 * host's state events, never a timer.
 */

export interface AutomationsPageProps {
  /** The project this Console is showing. Links open records here directly. */
  projectId: string;
  /** Opens a Task's thread, where its run and its Change to keep or undo are. */
  onOpenTask(taskId: string): void;
  onOpenBoard(taskId: string): void;
  onOpenDocument(path: string): void;
  /** Opens another project by id; the output project may not be the one showing. */
  onOpenProject(projectId: string): void;
}

const MARK: Readonly<Record<AutomationLabel, string>> = {
  manual: 'todo',
  running: 'working',
  'needs-approval': 'waiting',
  'waiting-for-data': 'waiting',
  'setup-incomplete': 'waiting',
  'needs-investigation': 'fault',
};

const SUMMARY: readonly { key: keyof AutomationSummary; label: string }[] = [
  { key: 'configured', label: 'Configured' },
  { key: 'running', label: 'Running' },
  { key: 'needsAttention', label: 'Needs attention' },
  { key: 'notReady', label: 'Not ready' },
];

const when = (at: string) =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const shortSha = (sha: string) => sha.slice(0, 12);

type Loaded =
  | { kind: 'personal' }
  | { kind: 'business'; organizationId: string; list: AutomationList; readAt: string };

function Status({ view }: { view: Pick<AutomationView, 'status'> }) {
  return (
    <span className={`auto-state ${view.status.label}`}>
      <Mark state={MARK[view.status.label]} />
      {view.status.text}
    </span>
  );
}

function Stages({ run }: { run: NonNullable<OccurrenceView['run']> }) {
  return (
    <ol className="auto-stages" aria-label="What this run did">
      {run.stages.map((stage) => (
        <li key={stage.name} className={stage.done ? 'done' : ''}>
          <span className="auto-stage-name">
            <span className="auto-hidden">{stage.done ? 'Done: ' : 'Not done: '}</span>
            {stage.name}
          </span>
          <span className="auto-stage-detail">{stage.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function Occurrence({
  item,
  here,
  projectName,
  props,
}: {
  item: OccurrenceView;
  here: boolean;
  projectName: string | null;
  props: AutomationsPageProps;
}) {
  const occurrence = item.occurrence;
  const run = item.run;
  const admission = occurrence.admission;
  const outcome = item.resultText ?? run?.sentence ?? 'Starting.';
  return (
    <li className="auto-occurrence">
      <div className="auto-occurrence-head">
        <span className="auto-occurrence-time">{when(occurrence.observedAt)}</span>
        <span className="auto-occurrence-outcome">{outcome}</span>
      </div>
      {admission.state === 'refused' && (
        <p className="auto-refusal">
          {admission.reason} {item.next}
        </p>
      )}
      {run && run.missing.length > 0 && (
        <p className="auto-missing">
          Could not read: <span className="mono lc">{run.missing.join(', ')}</span>
        </p>
      )}
      {run && <Stages run={run} />}
      {run && (
        <div className="auto-links">
          {here ? (
            <>
              {run.taskExists && run.taskId && (
                <button type="button" onClick={() => props.onOpenTask(run.taskId!)}>
                  {run.change === 'waiting' ? 'Keep or undo the draft' : 'Open its task'}
                </button>
              )}
              {run.taskExists && run.taskId && (
                <button type="button" onClick={() => props.onOpenBoard(run.taskId!)}>
                  Show on Board
                </button>
              )}
              {run.written && run.change !== 'undone' && (
                <button type="button" onClick={() => props.onOpenDocument(run.written!.path)}>
                  Open the draft
                </button>
              )}
            </>
          ) : (
            occurrence.target && (
              <button type="button" onClick={() => props.onOpenProject(occurrence.target!.projectId)}>
                Open {projectName ?? occurrence.target.projectName}
              </button>
            )
          )}
        </div>
      )}
      <details className="auto-evidence">
        <summary>Record</summary>
        <dl>
          <div>
            <dt>Occurrence</dt>
            <dd className="mono lc">{occurrence.id}</dd>
          </div>
          <div>
            <dt>Asked by</dt>
            <dd className="mono lc">{occurrence.trigger.requestedBy}</dd>
          </div>
          <div>
            <dt>Setup revision</dt>
            <dd>
              {occurrence.configuration ? `Version ${occurrence.configuration.revision}` : 'None'}
            </dd>
          </div>
          {run && (
            <div>
              <dt>Run</dt>
              <dd className="mono lc">
                {run.id} · {run.state}
              </dd>
            </div>
          )}
          {run && run.sources.length > 0 && (
            <div>
              <dt>Sources read</dt>
              <dd>
                <ul>
                  {run.sources.map((source) => (
                    <li key={source.path}>
                      <span className="mono lc">{source.path}</span>{' '}
                      <span className="mono lc auto-sha">SHA-256 {shortSha(source.sha)}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {run?.failure && (
            <div>
              <dt>Stopped</dt>
              <dd>{run.failure}</dd>
            </div>
          )}
        </dl>
      </details>
    </li>
  );
}

function Detail({
  organizationId,
  automation,
  here,
  refresh,
  props,
}: {
  organizationId: string;
  automation: AutomationView;
  here: boolean;
  refresh: number;
  props: AutomationsPageProps;
}) {
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    const request = new AbortController();
    const started = ++epoch.current;
    automationDetail(organizationId, automation.id, page, request.signal)
      .then((result) => {
        if (started === epoch.current) {
          setDetail(result);
          setError('');
        }
      })
      .catch((failure: unknown) => {
        if (started === epoch.current && !request.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'The runs could not be read.');
      });
    return () => request.abort();
  }, [organizationId, automation.id, page, refresh]);
  const pages = detail ? Math.max(1, Math.ceil(detail.total / detail.pageSize)) : 1;
  const owner = automation.owner;
  return (
    <div className="auto-detail">
      <section aria-label="What it does">
        <h3>What it does</h3>
        <dl className="auto-facts">
          <div>
            <dt>Reads</dt>
            <dd>
              {automation.reads.label}
              {automation.reads.paths.length > 0 && (
                <ul>
                  {automation.reads.paths.map((item) => (
                    <li key={item} className="mono lc">
                      {item}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Writes</dt>
            <dd>
              {automation.writes ? (
                <>
                  <span className="mono lc">{automation.writes.path}</span>
                  {automation.writes.projectName && <> in {automation.writes.projectName}</>}, saved
                  for review
                </>
              ) : (
                'Nowhere yet'
              )}
            </dd>
          </div>
          <div>
            <dt>Reviewed by</dt>
            <dd>
              {automation.reviewedBy === 'person-after-reviewer'
                ? 'A person, who keeps or undoes it. The setup asks for a reviewer first; this build does not run one for the brief.'
                : 'A person, who keeps or undoes it.'}
            </dd>
          </div>
          <div>
            <dt>Never</dt>
            <dd>{automation.doesNot}</dd>
          </div>
        </dl>
      </section>
      <section aria-label="What stays manual">
        <h3>What stays manual</h3>
        <ul className="auto-manual">
          {automation.manual.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section aria-label="Rules and access">
        <h3>Rules and access</h3>
        <dl className="auto-facts">
          <div>
            <dt>Owner</dt>
            <dd>
              {owner.you ? 'You' : <span className="mono lc">{owner.personId}</span>}
              {owner.identitySource === 'development-fixture' && (
                <span className="auto-fixture"> · a local development identity, not a verified account</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Who may run it</dt>
            <dd>Any active member, with the files the setup approved.</dd>
          </div>
          <div>
            <dt>Approvals</dt>
            <dd>Saving the draft asks for none: it waits for review instead. Nothing is remembered.</dd>
          </div>
          <div>
            <dt>Setup</dt>
            <dd>
              {automation.configuration
                ? `Version ${automation.configuration.revision}${
                    automation.configuration.activatedAt
                      ? `, turned on ${when(automation.configuration.activatedAt)}`
                      : ''
                  }`
                : 'None is turned on'}
            </dd>
          </div>
          <div>
            <dt>Usefulness</dt>
            <dd>Not measured</dd>
          </div>
        </dl>
      </section>
      <section aria-label="Runs" className="auto-runs">
        <h3>Runs</h3>
        {error && <p role="alert">{error}</p>}
        {!detail && !error && <p className="auto-quiet">Reading runs...</p>}
        {detail && detail.total === 0 && <p className="auto-quiet">It has not run yet.</p>}
        {detail && detail.occurrences.length > 0 && (
          <ol className="auto-occurrences">
            {detail.occurrences.map((item) => (
              <Occurrence
                key={item.occurrence.id}
                item={item}
                here={here}
                projectName={automation.project?.name ?? null}
                props={props}
              />
            ))}
          </ol>
        )}
        {pages > 1 && (
          <nav className="auto-pages" aria-label="Runs pages">
            <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Newer
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Older
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}

function Row({
  organizationId,
  automation,
  open,
  onToggle,
  onRun,
  pressing,
  refresh,
  props,
}: {
  organizationId: string;
  automation: AutomationView;
  open: boolean;
  onToggle(): void;
  onRun(): void;
  pressing: boolean;
  refresh: number;
  props: AutomationsPageProps;
}) {
  const detailId = useId();
  const reasonId = useId();
  const here = automation.project?.id === props.projectId;
  const blocked = !automation.run.allowed || pressing;
  return (
    <li className={`auto-row ${automation.status.label}`}>
      <article aria-label={automation.name}>
        <div className="auto-row-head">
          <div className="auto-row-name">
            <h2>{automation.name}</h2>
            <p>{automation.purpose}</p>
          </div>
          <Status view={automation} />
        </div>
        <p className="auto-reason">{automation.status.reason}</p>
        {automation.scheduleRecorded && <p className="auto-quiet">{automation.scheduleRecorded}</p>}
        <dl className="auto-meta">
          {automation.status.label !== 'manual' && (
            <div>
              <dt>Trigger</dt>
              <dd>{automation.trigger.text}</dd>
            </div>
          )}
          <div>
            <dt>Project</dt>
            <dd className="auto-cut" title={automation.project?.name}>
              {automation.project?.name ?? 'Not chosen'}
            </dd>
          </div>
          <div>
            <dt>Last result</dt>
            <dd>
              {automation.lastResult
                ? `${automation.lastResult.text}, ${when(automation.lastResult.at)}`
                : 'Not run yet'}
            </dd>
          </div>
          <div>
            <dt>Sources</dt>
            <dd>
              {automation.freshness
                ? automation.freshness.missing.length > 0
                  ? `${automation.freshness.missing.length} missing, checked ${when(automation.freshness.at)}`
                  : `${automation.freshness.sources.length} read ${when(automation.freshness.at)}`
                : 'Not read yet'}
            </dd>
          </div>
        </dl>
        <div className="auto-actions">
          <button
            type="button"
            className="button primary"
            aria-disabled={blocked}
            aria-describedby={!automation.run.allowed ? reasonId : undefined}
            onClick={() => {
              if (!blocked) onRun();
            }}
          >
            {pressing ? 'Starting...' : 'Run once'}
          </button>
          <button
            type="button"
            className="auto-toggle"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={onToggle}
          >
            {open ? 'Hide details' : 'Details'}
          </button>
          {!automation.run.allowed && automation.run.reason && (
            <span id={reasonId} className="auto-blocked">
              {automation.run.reason}
            </span>
          )}
        </div>
        <div id={detailId} hidden={!open}>
          {open && (
            <Detail
              organizationId={organizationId}
              automation={automation}
              here={here}
              refresh={refresh}
              props={props}
            />
          )}
        </div>
      </article>
    </li>
  );
}

export function AutomationsPage(props: AutomationsPageProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState('');
  const [announce, setAnnounce] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pressing, setPressing] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const targets = useRef<Set<string>>(new Set());
  const shown = useRef(false);
  // The occurrence a press on this screen started, so its outcome is said once it settles.
  const watching = useRef<string | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const started = ++epoch.current;
    setLoading(true);
    try {
      const workspace = await api<WorkspaceView>('/workspace', 'GET', undefined, request.signal);
      if (workspace.active.kind !== 'business') {
        if (started === epoch.current) {
          shown.current = true;
          setLoaded({ kind: 'personal' });
          setError('');
          setStale('');
        }
        return;
      }
      const organizationId = workspace.active.organizationId;
      const list = await listAutomations(organizationId, request.signal);
      if (started === epoch.current && !request.signal.aborted) {
        targets.current = new Set(
          list.automations.flatMap((item) => (item.project ? [item.project.id] : [])),
        );
        shown.current = true;
        setLoaded({ kind: 'business', organizationId, list, readAt: list.observedAt });
        const watched = list.automations.find(
          (item) => item.latest?.occurrence.id === watching.current,
        );
        if (watched && watched.status.label !== 'running') {
          watching.current = null;
          setAnnounce(
            watched.status.label === 'manual' && watched.latest?.resultText
              ? `Finished: ${watched.latest.resultText}.`
              : `${watched.status.text}: ${watched.status.reason}`,
          );
        }
        setError('');
        setStale('');
        setRefresh((value) => value + 1);
      }
    } catch (failure) {
      if (started !== epoch.current || request.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : 'Automations could not be read.';
      // A list already on screen stays, marked with when it was read: a
      // failed refresh is not an empty list.
      if (shown.current) setStale(message);
      else setError(message);
    } finally {
      if (started === epoch.current && !request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      epoch.current += 1;
    };
  }, [load]);

  // Follow runs through the host's own state events for the output project.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: Event) => {
      let projectId: unknown;
      try {
        projectId = (JSON.parse((event as MessageEvent).data) as { projectId?: unknown }).projectId;
      } catch {
        return;
      }
      if (typeof projectId !== 'string' || !targets.current.has(projectId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    };
    for (const name of ['session', 'review', 'history']) es.addEventListener(name, changed);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [load]);

  async function run(organizationId: string, automation: AutomationView) {
    setPressing(automation.id);
    setAnnounce('');
    try {
      const result = await runAutomation(organizationId, automation.id);
      const admission = result.occurrence.admission;
      if (admission.state === 'admitted' && !result.duplicate) watching.current = result.occurrence.id;
      setAnnounce(
        result.duplicate
          ? 'That press was already received. Nothing new was started.'
          : admission.state === 'refused'
            ? `Not started: ${admission.reason}`
            : 'Started.',
      );
      setOpen((current) => ({ ...current, [automation.id]: true }));
    } catch (failure) {
      setAnnounce(failure instanceof Error ? failure.message : 'It could not be started.');
    } finally {
      setPressing(null);
      await load();
    }
  }

  const list = loaded?.kind === 'business' ? loaded.list : null;
  const single = list?.automations.length === 1;

  return (
    <div className="col automations-page">
      <header className="auto-page-head">
        <div>
          <h1>Automations</h1>
          <p>
            {list
              ? `What runs for ${list.organization.name}, what it last did, and what needs you.`
              : 'What runs for a business, what it last did, and what needs you.'}
          </p>
        </div>
        <button
          type="button"
          className="auto-refresh"
          aria-disabled={loading}
          onClick={() => {
            if (!loading) void load();
          }}
        >
          {loading ? 'Reading...' : 'Refresh'}
        </button>
      </header>
      <p className="auto-announce" role="status" aria-live="polite">
        {announce}
      </p>
      {error && !loaded && (
        <div className="auto-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {loading && !loaded && !error && <p role="status">Reading automations...</p>}
      {loaded?.kind === 'personal' && (
        <div className="auto-empty">
          <h2>Personal has no automations</h2>
          <p>
            Automations are set up per business workspace. Switch to a business under Change
            workspace to see what runs for it.
          </p>
        </div>
      )}
      {list && (
        <>
          {stale && loaded?.kind === 'business' && (
            <p className="auto-stale" role="alert">
              Could not refresh: {stale} Showing what was read {when(loaded.readAt)}.
            </p>
          )}
          <dl className="auto-summary" aria-label="Summary">
            {SUMMARY.map(({ key, label }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  <strong>{list.summary[key]}</strong>
                  <span>{AUTOMATION_SUMMARY_CAPTIONS[key]}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="auto-meta-line">
            {list.organization.identitySource === 'development-fixture'
              ? `${list.organization.name} is a local development workspace. `
              : ''}
            Read {when(list.observedAt)}.
          </p>
          {list.automations.length === 0 ? (
            <div className="auto-empty">
              <h2>Nothing is set up to run yet</h2>
              <p>
                The weekly brief appears here once {list.organization.name} has a setup, under Change
                workspace.
              </p>
            </div>
          ) : (
            <ul className="auto-list" aria-label="Automations">
              {list.automations.map((automation) => (
                <Row
                  key={automation.id}
                  organizationId={list.organization.id}
                  automation={automation}
                  open={open[automation.id] ?? single}
                  onToggle={() =>
                    setOpen((current) => ({
                      ...current,
                      [automation.id]: !(current[automation.id] ?? single),
                    }))
                  }
                  onRun={() => void run(list.organization.id, automation)}
                  pressing={pressing === automation.id}
                  refresh={refresh}
                  props={props}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
