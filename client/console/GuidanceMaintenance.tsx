import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { buildDiff } from '../../shared/text-diff';
import {
  GUIDANCE_KIND_LABELS,
  GUIDANCE_VERDICT_LABELS,
  type ChainCheck,
  type GuidanceProposal,
  type GuidanceRevision,
} from '../../shared/guidance';
import { time } from '../components';
import { AGENT_NAME } from '../../shared/agent-name';
import { DiffView } from './DiffView';
import './guidance.css';

/**
 * H10 in the instructions inspector: what Diomedes proposes for a project's
 * instruction files, and every revision applied or rolled back.
 *
 * A proposal is read, never acted on here without a person: its line, its
 * evidence, the replayed evaluation in its own words, and the P06 diff of the
 * whole file, with Approve and Decline under the diff. A revision row names
 * who made it truthfully — the application proposed and you approved, or you — and
 * offers one step back to the text before it. The chain check is shown as the
 * server reports it; a broken chain is said, and nothing is offered on it.
 */
interface GuidanceView {
  proposals: GuidanceProposal[];
  revisions: GuidanceRevision[];
  chain: ChainCheck;
}

const sha12 = (sha: string | null) => (sha ? sha.slice(0, 12) : 'none');

function authorLine(revision: GuidanceRevision): string {
  return revision.author.kind === 'proposal' ? `Proposed by ${AGENT_NAME} · approved by you` : 'You';
}

export function GuidanceMaintenance({ projectId }: { projectId: string }) {
  const [view, setView] = useState<GuidanceView | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await api<GuidanceView>(`/projects/${projectId}/guidance`));
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'Guidance could not be read.');
    }
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: Record<string, unknown>) => {
    setWorking(true);
    setProblem('');
    try {
      await api(path, 'POST', body);
      setReviewing(null);
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'That could not be done.');
    } finally {
      setWorking(false);
      await load();
    }
  };

  if (!view) return problem ? <p className="guidance-problem">{problem}</p> : null;
  const { proposals, revisions, chain } = view;
  if (!proposals.length && !revisions.length && chain.ok) return null;
  const current = new Map<string, string>();
  for (const revision of revisions) current.set(revision.path, revision.newSha);

  return (
    <>
      {proposals.length > 0 && (
        <section className="instructions-run guidance" aria-label="Proposed revisions">
          <div className="mono lc instructions-run-head">proposed revisions</div>
          <ol className="instructions-list">
            {proposals.map((proposal) => {
              const open = reviewing === proposal.id;
              return (
                <li className="guidance-proposal" key={proposal.id} data-proposal={proposal.id}>
                  <div className="instructions-file-head">
                    <span className="instructions-name" title={proposal.file.path}>
                      {proposal.file.path}
                    </span>
                    <span className="mono lc instructions-meta">
                      {GUIDANCE_KIND_LABELS[proposal.kind]} · {proposal.occurrences} of {proposal.threshold}
                    </span>
                  </div>
                  <p className="guidance-line">{proposal.line}</p>
                  <p className={`guidance-evaluation ${proposal.evaluation.verdict}`}>
                    <span className="guidance-verdict">{GUIDANCE_VERDICT_LABELS[proposal.evaluation.verdict]}</span>{' '}
                    {proposal.evaluation.summary}
                  </p>
                  <ul className="guidance-evidence" aria-label="Evidence">
                    {proposal.evidence.map((item) => (
                      <li key={item.ref} data-ref={item.ref}>
                        <span>{item.detail}</span>
                        <span className="mono lc guidance-ref" title={item.ref}>
                          {item.sessionId ? `${item.sessionId} · ` : ''}
                          {item.ref}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="cdiff-actions">
                    <button type="button" aria-expanded={open} onClick={() => setReviewing(open ? null : proposal.id)}>
                      {open ? 'Hide the change' : 'Review the change'}
                    </button>
                  </div>
                  {open && (
                    <>
                      <DiffView
                        diff={buildDiff({ path: proposal.file.path, before: proposal.before, after: proposal.after })}
                      />
                      <div className="cdiff-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={working || !chain.ok}
                          onClick={() =>
                            void act(`/projects/${projectId}/guidance/proposals/${proposal.id}/approve`, {
                              expectedSha: proposal.file.sha,
                            })
                          }
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => void act(`/projects/${projectId}/guidance/proposals/${proposal.id}/decline`, {})}
                        >
                          Decline
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {(revisions.length > 0 || !chain.ok) && (
        <section className="instructions-run guidance" aria-label="Revisions">
          <div className="mono lc instructions-run-head">
            revisions · {chain.ok ? `chain intact · ${chain.length}` : `chain broken at ${chain.brokenAt}`}
          </div>
          {!chain.ok && (
            <p className="guidance-problem" role="alert">
              {chain.reason} Nothing more can be applied or rolled back until it is looked into.
            </p>
          )}
          <ol className="instructions-list">
            {[...revisions].reverse().map((revision) => {
              const restorable =
                chain.ok && revision.previousSha !== null && current.get(revision.path) !== revision.previousSha;
              return (
                <li className="guidance-revision" key={revision.id} data-revision={revision.id}>
                  <div className="instructions-file-head">
                    <span className="mono lc instructions-rank">{revision.seq}</span>
                    <span className="instructions-name" title={revision.path}>
                      {revision.action === 'apply' ? 'Applied' : 'Rolled back'} · {revision.path}
                    </span>
                    <span className="mono lc instructions-meta">
                      {sha12(revision.previousSha)} → {sha12(revision.newSha)} · {time(revision.at)}
                    </span>
                    {restorable && (
                      <button
                        type="button"
                        className="instructions-open"
                        disabled={working}
                        onClick={() =>
                          void act(`/projects/${projectId}/guidance/revisions/${revision.id}/rollback`, {
                            expectedSha: current.get(revision.path),
                          })
                        }
                      >
                        Roll back to before this
                      </button>
                    )}
                  </div>
                  <p>
                    {authorLine(revision)}
                    {revision.rollbackOf
                      ? ` · restored the text before revision ${revisions.find((item) => item.id === revision.rollbackOf)?.seq ?? '?'}`
                      : ''}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {problem && <p className="guidance-problem">{problem}</p>}
    </>
  );
}
