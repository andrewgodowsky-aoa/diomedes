import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { explainProposal } from '../../shared/configuration';
import type { ConfigurationView, ProposalChange } from '../../shared/configuration';
import { api } from '../api';
import { Button, Modal } from '../components';
import './workspace.css';

/**
 * The screen between a finished questionnaire and a setup that runs.
 *
 * It draws exactly what the host computed and nothing else. `canActivate` and
 * `whyNot` come from the response rather than from a rule repeated here,
 * because a renderer that decided readiness for itself could offer a button the
 * host would refuse — or hide one it would have accepted.
 *
 * Two details are load-bearing and easy to lose in a refactor.
 *
 * `expectedActiveRevision` is sent straight back from the view that was drawn.
 * That is what makes activation a compare-and-set: if a second administrator
 * activated something while this was open, the host refuses instead of
 * overwriting their work.
 *
 * `activationId` is generated once per attempt and reused across retries. A
 * retried request is then a replay, which the host answers with the result it
 * already recorded, rather than a second activation that would mint a second
 * revision.
 */

interface Props {
  organizationId: string;
  onClose(): void;
  /** Send the person back to change an answer. */
  onRevise(): void;
  report(error: unknown): void;
}

/**
 * Removals and unsupported parts come first. Someone skimming this screen reads
 * the top of it, and those are the two groups that change what they should
 * expect to happen.
 */
const KIND_ORDER: readonly ProposalChange['kind'][] = [
  'unsupported',
  'removed',
  'new',
  'changed',
  'inherited',
];

const KIND_HEADING: Record<ProposalChange['kind'], string> = {
  new: 'New',
  changed: 'Changed',
  removed: 'Gone',
  inherited: 'Carried over',
  unsupported: 'Not available yet',
};

const KIND_REASON: Record<ProposalChange['kind'], string> = {
  new: 'Set up for the first time from what you told us.',
  changed: 'Different from the setup that is running now.',
  removed: 'Part of the setup running now, and not part of this one.',
  inherited: 'The same as the setup that is running now.',
  unsupported: 'Recorded, but this build does not do it. Nothing here is pretending to work.',
};

export function Configuration({ organizationId, onClose, onRevise, report }: Props) {
  const [view, setView] = useState<ConfigurationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/workspace/organizations/${organizationId}/configuration`;

  // Held across retries on purpose: see the note about replay above.
  const attempt = useRef<string | null>(null);

  const load = useCallback(async () => {
    setView(await api<ConfigurationView>(base));
  }, [base]);

  useEffect(() => {
    load().catch((e) => {
      setError(e instanceof Error ? e.message : 'This setup could not be opened.');
      report(e);
    });
  }, [load, report]);

  const act = useCallback(
    async (run: () => Promise<ConfigurationView>) => {
      setBusy(true);
      setError('');
      try {
        setView(await run());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That did not go through.');
        report(e);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );

  const compile = () =>
    act(async () => {
      // A new candidate is a new attempt; an activation id from a previous one
      // would make the host replay that instead of activating this.
      attempt.current = null;
      return api<ConfigurationView>(`${base}/compile`, 'POST', {});
    });

  const activate = () =>
    act(async () => {
      attempt.current ??= crypto.randomUUID();
      return api<ConfigurationView>(`${base}/activate`, 'POST', {
        revision: view?.staged?.revision,
        expectedActiveRevision: view?.expectedActiveRevision ?? null,
        activationId: attempt.current,
      });
    });

  /**
   * With something staged, this screen is a comparison and the groups are the
   * comparison's answer. With nothing staged it is not a comparison at all: it
   * is the setup that is running, and grouping it as "new" or "carried over"
   * would answer a question nobody asked. An earlier pass showed the diff in
   * both cases, so turning a setup on left a person looking at an empty panel.
   */
  const grouped = useMemo(() => {
    if (!view) return [];
    if (view.staged)
      return KIND_ORDER.map((kind) => ({
        kind,
        heading: KIND_HEADING[kind],
        reason: KIND_REASON[kind],
        rows: view.changes.filter((row) => row.kind === kind),
      })).filter((group) => group.rows.length > 0);
    if (!view.active) return [];
    const rows = explainProposal(null, view.active.proposal);
    const running = rows.filter((row) => row.kind !== 'unsupported');
    const unsupported = rows.filter((row) => row.kind === 'unsupported');
    return [
      {
        kind: 'unsupported' as const,
        heading: KIND_HEADING.unsupported,
        reason: KIND_REASON.unsupported,
        rows: unsupported,
      },
      {
        kind: 'inherited' as const,
        heading: 'What is running',
        reason: 'The setup you turned on, and why each part of it is there.',
        rows: running,
      },
    ].filter((group) => group.rows.length > 0);
  }, [view]);

  const blocking = view?.staged?.readiness.blocking ?? [];
  const degradedPlan = view?.staged?.readiness.degradedPlan ?? null;

  return (
    <Modal title="Your setup, before it runs" onClose={onClose}>
      <div className="ws-setup ws-config">
        {!view ? (
          <p className="caption">Reading this setup.</p>
        ) : !view.staged && !view.active ? (
          <>
            <h3 className="ws-question">Nothing has been prepared yet</h3>
            <p className="caption ws-reason">
              Your answers are saved. Preparing turns them into a setup you can read before anything
              runs.
            </p>
            <div className="ws-actions">
              <Button tone="quiet" disabled={busy} onClick={onRevise}>
                Change an answer
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void compile()}>
                Prepare the setup
              </Button>
            </div>
          </>
        ) : (
          <>
            {view.active && (
              <p className="ws-current">
                Running now: version {view.active.revision}
                {view.staged ? '. What follows is what would replace it.' : '.'}
              </p>
            )}

            {grouped.map((group) => (
              <section key={group.kind} className="ws-section">
                <h3 className="ws-question">{group.heading}</h3>
                <p className="caption ws-reason">{group.reason}</p>
                <dl className={`ws-facts ${group.kind === 'unsupported' ? 'ws-unsupported' : ''}`}>
                  {group.rows.map((row) => (
                    <div key={row.field}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.now}
                        {row.kind === 'changed' && row.was && (
                          <span className="ws-was"> was {row.was}</span>
                        )}
                      </dd>
                      {/* The recorded explanation for this field, not a reasoning trace. */}
                      <dd className="ws-why">{row.why}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}

            {blocking.length > 0 && (
              <section className="ws-section">
                <h3 className="ws-question">This cannot run yet</h3>
                <ul className="ws-problems">
                  {blocking.map((problem) => (
                    <li key={`${problem.code}:${problem.field}`}>{problem.message}</li>
                  ))}
                </ul>
              </section>
            )}

            {degradedPlan && <p className="caption ws-degraded">{degradedPlan}</p>}

            {view.whyNot && <p className="caption ws-boundary">{view.whyNot}</p>}

            {error && (
              <p className="ws-error" role="alert">
                {error}
              </p>
            )}

            <div className="ws-actions">
              <Button tone="quiet" disabled={busy} onClick={onRevise}>
                Change an answer
              </Button>
              <Button tone="quiet push-right" disabled={busy} onClick={() => void compile()}>
                Prepare it again
              </Button>
              <Button
                tone="primary"
                disabled={busy || !view.canActivate}
                onClick={() => void activate()}
              >
                Turn it on
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
