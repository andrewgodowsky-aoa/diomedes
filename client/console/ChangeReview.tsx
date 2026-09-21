import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type {
  ChangeEntry,
  ChangeReviewManifest,
  ReviewCheck,
} from '../../shared/change-manifest';
import { api, ApiError } from '../api';
import './change-review.css';

/**
 * Automatic Change Review in the thread: what changed while the task ran, what
 * deserves attention, which checks ran, and the evidence underneath — in that
 * order, so the plain reading comes first and the proof is one click deeper.
 *
 * Every sentence on screen was rendered server-side from facts that name their
 * evidence; this component only lays them out. The deterministic manifest is
 * fetched fresh whenever `refreshKey` moves (a run starts, ends, or a change
 * settles), so the review a person reads is the review the records prove. The
 * last review stays on screen while the next one loads, and nothing renders for
 * a task until its first answer arrives, so no empty state flashes before a review.
 */

const CHECK_ICON: Record<ReviewCheck['state'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-run': 'Not run',
  skipped: 'Skipped',
  error: 'Error',
};

const KIND_TEXT: Record<ChangeEntry['kind'], string> = {
  added: 'added',
  modified: 'changed',
  deleted: 'deleted',
  renamed: 'renamed',
  unchanged: 'unchanged',
};

const EXAMPLES = [
  { id: 'restaurant-weekly-report', label: 'a restaurant report' },
  { id: 'automation-invoice-reminder', label: 'a business automation' },
] as const;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function outcomeCaption(manifest: ChangeReviewManifest): string {
  switch (manifest.outcome) {
    case 'active':
      return 'The run is still in progress — this review updates as work lands.';
    case 'waiting-review':
      return 'The run is waiting on a decision.';
    case 'declined':
      return 'The proposal was declined.';
    case 'failed':
      return 'The run failed.';
    case 'stopped':
      return 'The run was stopped.';
    case 'no-writes':
      return 'The run finished without recorded changes.';
    default:
      return '';
  }
}

const TEXT_EVIDENCE_REASON: Record<string, string> = {
  binary: 'Binary file — evidence is metadata only; content is never rendered.',
  'no-before': 'No earlier content was retained — nothing to compare against.',
  'evidence-limit': "Exact text evidence for this file exceeded the manifest's evidence budget.",
  unreadable: 'Content could not be shown — unreadable or larger than the evidence bound.',
};

function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const [open, setOpen] = useState(false);
  const stat =
    entry.addedLines !== null || entry.removedLines !== null
      ? `+${entry.addedLines ?? 0} −${entry.removedLines ?? 0}`
      : null;
  const evidence = entry.textEvidence;
  const evidenceCaption =
    evidence.kind === 'excerpt'
      ? entry.kind === 'deleted'
        ? 'Content before it was deleted'
        : entry.kind === 'added'
          ? 'Added content'
          : 'Current content — the earlier version was not retained for comparison'
      : null;
  return (
    <li className={`crev-row ${entry.kind}`}>
      <button
        type="button"
        className="crev-path"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={entry.path}
      >
        <span className="crev-kind">{KIND_TEXT[entry.kind]}</span>
        <span className="crev-name">{entry.path}</span>
        {stat && <span className="mono">{stat}</span>}
        {entry.binary && <span className="crev-observed">binary</span>}
        {entry.modeBefore !== entry.modeAfter && (
          <span className="crev-observed" title="Git file mode">
            {entry.modeBefore ?? 'untracked'} → {entry.modeAfter ?? 'gone'}
          </span>
        )}
        {entry.attribution === 'observed' && (
          <span className="crev-observed" title="Changed while the task ran; no recorded Diomedes write">
            observed
          </span>
        )}
      </button>
      {open && (
        <div className="crev-evidence">
          {entry.renamedFrom && <p>Renamed from {entry.renamedFrom}</p>}
          {entry.modeBefore !== entry.modeAfter && (
            <p className="crev-note">
              Git file mode: {entry.modeBefore ?? 'untracked'} → {entry.modeAfter ?? 'gone'}
            </p>
          )}
          {entry.binary && (
            <p className="crev-note">
              Binary file — {entry.sizeAfter ?? entry.sizeBefore ?? 0} bytes; evidence is
              metadata, never raw bytes.
            </p>
          )}
          {evidence.kind !== 'none' && evidence.text !== null && (
            <>
              {evidenceCaption && <p className="crev-note">{evidenceCaption}</p>}
              <pre className="crev-patch">{evidence.text}</pre>
            </>
          )}
          {evidence.truncated && (
            <p className="crev-note">
              {evidence.kind === 'diff'
                ? `Showing the first changed lines — ${evidence.truncatedLines} more changed ${evidence.truncatedLines === 1 ? 'line was' : 'lines were'} cut at the bound.`
                : `Truncated — ${evidence.truncatedLines} more ${evidence.truncatedLines === 1 ? 'line was' : 'lines were'} not shown.`}
            </p>
          )}
          {evidence.kind === 'none' && evidence.reason && evidence.reason !== 'binary' && (
            <p className="crev-note">{TEXT_EVIDENCE_REASON[evidence.reason] ?? evidence.reason}</p>
          )}
          {entry.fields.length > 0 && (
            <ul className="crev-fields">
              {entry.fields.map((field) => (
                <li key={field.path}>
                  <b>{field.label}</b>{' '}
                  {field.kind === 'unchanged' ? (
                    <span className="crev-dim">unchanged</span>
                  ) : field.kind === 'collection' ? (
                    <span>
                      {field.before} → {field.after}
                      {field.added.length > 0 &&
                        ` · added ${field.added.join(', ')}${field.addedTotal > field.added.length ? ` (+${field.addedTotal - field.added.length} more)` : ''}`}
                      {field.removed.length > 0 &&
                        ` · removed ${field.removed.join(', ')}${field.removedTotal > field.removed.length ? ` (+${field.removedTotal - field.removed.length} more)` : ''}`}
                    </span>
                  ) : (
                    <span>
                      {field.before ?? '—'} → {field.after ?? '—'}
                      {field.valueTruncated ? ' …' : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ul className="crev-refs">
            {entry.evidence.slice(0, 6).map((ref, index) => (
              <li key={index} className="mono lc">
                {ref.kind}
                {'entryId' in ref && ` · ${ref.entryId}`}
                {'sha' in ref && ` · ${ref.sha.slice(0, 12)}`}
                {'beforeSha' in ref && ref.beforeSha && ` · was ${ref.beforeSha.slice(0, 12)}`}
                {'afterSha' in ref && ref.afterSha && ` · now ${ref.afterSha.slice(0, 12)}`}
                {'listingDigest' in ref && ref.listingDigest && ` · ${ref.listingDigest.slice(7, 19)}`}
                {'ruleId' in ref && ` · ${ref.ruleId}`}
                {'checkId' in ref && ` · ${ref.checkId}`}
                {'recordId' in ref && ` · ${ref.recordId} · ${ref.fieldPath}`}
                {'record' in ref && ref.kind === 'git-record' && ` · ${ref.record}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function ChangeReview({
  projectId,
  taskId,
  refreshKey,
}: {
  projectId: string;
  taskId: string | null;
  refreshKey: string;
}) {
  const headingId = useId();
  // Everything fetched is keyed to the task it belongs to, so another task's review
  // never shows and a refresh keeps the current review until the next one arrives.
  const key = taskId ? `${projectId}/${taskId}` : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    manifest: ChangeReviewManifest | null;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [details, setDetails] = useState(false);
  const [example, setExample] = useState<{ id: string; manifest: ChangeReviewManifest } | null>(
    null,
  );
  const [exampleFailed, setExampleFailed] = useState(false);
  // Opening an example replaces the link that opened it, and closing one removes the
  // Close button, so focus moves to the control that takes their place.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const exampleButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!key || !taskId) return;
    let live = true;
    api<{ manifest: ChangeReviewManifest | null }>(
      `/projects/${encodeURIComponent(projectId)}/change-review/task/${encodeURIComponent(taskId)}`,
    )
      .then((result) => {
        if (!live) return;
        setLoaded({ key, manifest: result.manifest });
        setFailedKey(null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) {
          setLoaded({ key, manifest: null });
          setFailedKey(null);
        } else {
          setFailedKey(key);
        }
      });
    return () => {
      live = false;
    };
  }, [key, projectId, taskId, refreshKey, attempt]);

  useEffect(() => {
    setExample(null);
    setExampleFailed(false);
  }, [key]);

  useEffect(() => {
    if (focusTarget === null) return;
    (focusTarget === 'close'
      ? closeButton.current
      : exampleButtons.current.get(focusTarget)
    )?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const settled = loaded !== null && loaded.key === key;
  const manifest = settled ? loaded.manifest : null;
  const failed = key !== null && failedKey === key;
  const shown = manifest ?? example?.manifest ?? null;

  const loadExample = (id: string) => {
    setExampleFailed(false);
    api<{ manifest: ChangeReviewManifest }>(
      `/projects/${encodeURIComponent(projectId)}/change-review/examples/${encodeURIComponent(id)}`,
    )
      .then((result) => {
        setExample({ id, manifest: result.manifest });
        setFocusTarget('close');
      })
      .catch(() => setExampleFailed(true));
  };
  const closeExample = () => {
    const id = example?.id ?? null;
    setExample(null);
    setFocusTarget(id);
  };
  const exampleLinks = (lead: string) => (
    <>
      <p className="crev-note crev-examples">
        {lead}{' '}
        {EXAMPLES.map((item, index) => (
          <Fragment key={item.id}>
            {index > 0 && ' · '}
            <button
              type="button"
              ref={(node) => {
                if (node) exampleButtons.current.set(item.id, node);
                else exampleButtons.current.delete(item.id);
              }}
              onClick={() => loadExample(item.id)}
            >
              {item.label}
            </button>
          </Fragment>
        ))}
      </p>
      {exampleFailed && (
        <p className="crev-note" role="status">
          The example could not be loaded.
        </p>
      )}
    </>
  );

  // Plain threads carry no review: only the example affordance, not an empty section.
  if (!taskId && !example) return exampleLinks('See what a change review looks like:');
  // A task's section waits for its first answer rather than flashing the empty state.
  if (taskId && !settled && !failed && !example) return null;

  return (
    <section className="crev" aria-labelledby={headingId}>
      <header className="crev-head">
        <h2 id={headingId}>What changed</h2>
        <span className="caption">Deterministic · no AI model wrote this</span>
      </header>
      {failed && (
        <p className="crev-note" role="status">
          The change review could not be loaded.{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {!shown && settled && !failed && (
        <div className="crev-empty">
          <p className="crev-note">No change review exists for this task yet.</p>
          {exampleLinks('See what a review looks like:')}
        </div>
      )}
      {shown && (
        <>
          {example && !manifest && (
            <p className="crev-note">
              Example review — {shown.subject.label}.{' '}
              <button type="button" ref={closeButton} onClick={closeExample}>
                Close
              </button>
            </p>
          )}
          {outcomeCaption(shown) && <p className="crev-note">{outcomeCaption(shown)}</p>}
          {shown.baselineReason && <p className="crev-note">{shown.baselineReason}</p>}
          <ul className="crev-sentences">
            {shown.summary.whatChanged.map((line) => (
              <li key={line.id} data-template={line.templateId} data-facts={line.factIds.join(' ')}>
                {line.text}
              </li>
            ))}
          </ul>
          {shown.summary.attention.length > 0 && (
            <div className="crev-attention">
              <h3>Needs your attention</h3>
              <ul>
                {shown.summary.attention.map((line) => (
                  <li key={line.id} className="crev-flag">
                    {line.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shown.checks.length > 0 && (
            <div className="crev-checks">
              <h3>Checks</h3>
              <ul>
                {shown.checks.map((check) => {
                  const detail = check.detail ?? (check.state !== 'passed' ? check.reason : null);
                  return (
                    <li key={check.id} className={`crev-check ${check.state}`}>
                      <span className={`crev-check-state ${check.state}`}>
                        {CHECK_ICON[check.state]}
                      </span>
                      <span className="crev-check-text">
                        <span className="crev-check-label">{check.label}</span>
                        {detail && <span className="crev-check-detail">{detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {shown.changes.length > 0 && (
            <div className="crev-changes">
              <h3>Changes</h3>
              <ul>
                {shown.changes.map((entry) => (
                  <ChangeRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            className="crev-details"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            Technical details
          </button>
          {details && (
            <div className="crev-technical">
              <dl>
                <dt>Manifest</dt>
                <dd className="mono lc">{shown.id}</dd>
                <dt>Digest</dt>
                <dd className="mono lc">{shown.digest}</dd>
                <dt>Rules</dt>
                <dd className="mono lc">{shown.rulesVersion}</dd>
                <dt>Built</dt>
                <dd className="mono lc">{shown.generatedAt}</dd>
                {shown.baseline && (
                  <>
                    <dt>Baseline</dt>
                    <dd className="mono lc">
                      {count(shown.baseline.files.length, 'file', 'files')} ·{' '}
                      {shown.baseline.listingDigest.slice(7, 19)} · {shown.baseline.capturedAt}
                    </dd>
                  </>
                )}
                {shown.baseline?.git && (
                  <>
                    <dt>Git baseline</dt>
                    <dd className="mono lc">
                      {shown.baseline.git.captured
                        ? `HEAD ${shown.baseline.git.head ?? 'none'} · ${shown.baseline.git.statusDigest?.slice(7, 19)}`
                        : `not captured — ${shown.baseline.git.reason ?? 'unavailable'}`}
                    </dd>
                  </>
                )}
                <dt>Inspected</dt>
                <dd>
                  {count(shown.coverage.inspected, 'file', 'files')}
                  {shown.coverage.skipped.length > 0 &&
                    ` · ${shown.coverage.skipped.length} not inspected`}
                  {shown.coverage.blocked.length > 0 &&
                    ` · ${shown.coverage.blocked.length} blocked`}
                  {shown.coverage.unavailable.length > 0 &&
                    ` · ${shown.coverage.unavailable.length} unreadable`}
                </dd>
              </dl>
              {shown.coverage.limits.length > 0 && (
                <ul className="crev-limits">
                  {shown.coverage.limits.map((limit, index) => (
                    <li key={index} className="crev-note">
                      Coverage is partial — {limit.detail}
                    </li>
                  ))}
                </ul>
              )}
              {shown.coverage.skipped.length > 0 && (
                <p className="crev-note">
                  Not inspected:{' '}
                  {shown.coverage.skipped
                    .slice(0, 8)
                    .map((note) => note.path)
                    .join(', ')}
                  {shown.coverage.skipped.length > 8 ? '…' : ''}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
