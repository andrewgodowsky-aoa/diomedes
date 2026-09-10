import type { Need, Session } from '../../shared/types';
import { ApprovalStatus } from '../components';
import { formatOrigin, originForNeed } from '../../shared/attribution';

/**
 * The needs-you moment in the Console's own register.
 *
 * The Workbook renders this as a card (`.notice`: well background, a box, a
 * 4 px amber bar, reading-size prose, 36 px buttons), and the Console imported
 * that card straight into its transcript — so the one moment the app most
 * needs to look like itself looked like the other surface. This is the same
 * block in the transcript's rhythm: an attention point in the gutter where a
 * turn's point sits, the request in the reading register, the reason beneath
 * it, and verbs in the board's verb language.
 *
 * The verbs, their order, their wording, the decision they carry and the
 * receipt below them are the Workbook's exactly. This is a change of register,
 * not of contract.
 */
export function NeedBlock({
  need,
  decide,
  show,
  onScope,
  session,
}: {
  need: Need;
  decide: (resolution: 'go-ahead' | 'declined', allow?: boolean) => void;
  show: () => void;
  onScope?: () => void;
  session?: Session;
}) {
  const why = [need.why, need.consequence].filter(Boolean).join(' ');
  const actor = formatOrigin(originForNeed(need, session));
  return (
    <section className="need" aria-label="Needs your OK">
      <div className="who">
        <b>{actor.primary}</b>
        <span>{actor.secondary} · needs you</span>
      </div>
      <p className="ask">
        {actor.primary} proposes to {need.what}.
      </p>
      {why && <p className="why">{why}</p>}
      {need.authorizationBoundary && (
        <p className="why">Approval needed: {need.authorizationBoundary}</p>
      )}
      <div className="verbs">
        <button type="button" className="verb go" onClick={() => decide('go-ahead')}>
          Go ahead
        </button>
        {!need.approval && (
          <button type="button" className="verb" onClick={() => decide('go-ahead', true)}>
            Go ahead for this whole task
          </button>
        )}
        {onScope &&
          need.origin?.engine?.id === 'codex' &&
          !need.harness &&
          need.preview?.every((change) => change.after !== null) && (
            <button type="button" className="verb" onClick={onScope}>
              Allow creates and updates for this task
            </button>
          )}
        <button type="button" className="verb" onClick={() => decide('declined')}>
          Don't do this
        </button>
        <button type="button" className="verb" onClick={show}>
          Show me first
        </button>
      </div>
      <ApprovalStatus need={need} />
    </section>
  );
}
