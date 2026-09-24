import { useEffect, useState } from 'react';
import { api } from '../api';
import type {
  PatternGrantView,
  RememberOffer,
  RememberedApprovalsView,
} from '../../shared/permissions';
import { offerQuestion } from '../../shared/remembered-approvals';
import './remembered-approvals.css';

/**
 * The learned offer (D5, route 2), asked once where the approval was given.
 * It sits in the Needs area in the Need's own register: a question, what it
 * covers, and two verbs. Answering it is the only way it becomes a grant, and
 * the declined answer is kept so it does not come back.
 */
export function RememberOfferBlock({
  offer,
  answer,
}: {
  offer: RememberOffer;
  answer: (accept: boolean) => void;
}) {
  return (
    <section className="need remember-offer" aria-label="Offer to stop asking">
      <div className="who">
        <b>Diomedes</b>
        <span>asks once</span>
      </div>
      <p className="ask">{offerQuestion(offer.what, offer.approvals)}</p>
      <p className="why">
        It would cover exactly this, in this project, until you revoke it. Anything different still
        asks.
      </p>
      <div className="verbs">
        <button type="button" className="verb go" onClick={() => answer(true)}>
          Stop asking
        </button>
        <button type="button" className="verb" onClick={() => answer(false)}>
          Keep asking
        </button>
      </div>
    </section>
  );
}

const day = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The one place remembered approvals are listed and revoked, inside the
 * permissions dialog beside the task scope. A revoked one stays listed: its
 * record is evidence, and revoking prunes nothing.
 */
export function RememberedApprovalsList({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange(): void;
}) {
  const [grants, setGrants] = useState<PatternGrantView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/projects/${encodeURIComponent(projectId)}/permissions/remembered`;
  useEffect(() => {
    let current = true;
    api<RememberedApprovalsView>(base).then(
      (view) => {
        if (current) setGrants(view.grants);
      },
      (failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error ? failure.message : 'Could not read remembered approvals.',
          );
      },
    );
    return () => {
      current = false;
    };
  }, [base]);
  async function revoke(grantId: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/${encodeURIComponent(grantId)}/revoke`, 'POST', {});
      setGrants((await api<RememberedApprovalsView>(base)).grants);
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not revoke this.');
    } finally {
      setBusy(false);
    }
  }
  const listed = [...(grants ?? [])].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <section className="remembered-approvals" aria-label="Remembered approvals">
      <h3>Remembered approvals</h3>
      {grants && !grants.length && <p>Nothing is remembered in this project.</p>}
      {listed.map((record) => (
        <div
          className={`remembered-approval${record.active ? '' : ' is-revoked'}`}
          key={record.grant.id}
        >
          <div className="remembered-approval-head">
            <strong title={record.grant.what}>{record.grant.what}</strong>
            {record.active ? (
              <button
                type="button"
                className="verb"
                disabled={busy}
                onClick={() => void revoke(record.grant.id)}
              >
                Revoke
              </button>
            ) : (
              <span className="mono lc">revoked</span>
            )}
          </div>
          <p>
            {record.grant.route === 'learned-offer'
              ? `You accepted the offer to stop asking on ${day(record.grant.createdAt)}.`
              : `You chose Go ahead and remember on ${day(record.grant.createdAt)}.`}{' '}
            {record.active ? record.reason : `Revoked on ${day(record.revokedAt!)}.`}
          </p>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
