import type { Need } from '../../shared/types';
import { ApprovalStatus } from '../components';

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
}: {
  need: Need;
  decide: (resolution: 'go-ahead' | 'declined', allow?: boolean) => void;
  show: () => void;
}) {
  const why = [need.why, need.consequence].filter(Boolean).join(' ');
  return (
    <section className="need" aria-label="Needs your OK">
      <div className="who">
        <b>Diomedes</b>
        <span className="mono">needs you</span>
      </div>
      <p className="ask">Diomedes wants to {need.what}.</p>
      {why && <p className="why">{why}</p>}
      <div className="verbs">
        <button type="button" className="verb go" onClick={() => decide('go-ahead')}>
          Go ahead
        </button>
        {!need.approval && (
          <button type="button" className="verb" onClick={() => decide('go-ahead', true)}>
            Go ahead for this whole task
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
