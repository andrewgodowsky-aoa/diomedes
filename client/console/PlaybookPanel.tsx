import { Modal } from '../components';
import { shortDigest, type LoadedContribution } from '../../shared/pack-contributions';

/**
 * One pack playbook, read exactly as a request would carry it (P04).
 *
 * The body is not in the Console until a person opens the playbook: opening it
 * asks the host to load that one contribution (`readSkill` in the Shell), which it does
 * only while the pack is on in this project, checks against the digest
 * registered when the pack was turned on, and records in History. The load
 * happens once, in the click that opens it, never in a render or an effect.
 * The panel names the pack version and the digest it read, so what a person
 * reads here is what a run would use.
 */
export function PlaybookPanel({
  title,
  loaded,
  onClose,
}: {
  title: string;
  loaded: LoadedContribution;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="playbook-panel" data-testid="playbook-panel">
        <p className="playbook-meta">
          <span>version {loaded.packVersion}</span>
          <span className="playbook-digest" title={loaded.digest}>
            {shortDigest(loaded.digest)}
          </span>
          <span>{Math.max(1, Math.round(loaded.bytes / 1024))} KB</span>
        </p>
        <pre className="playbook-body">{loaded.body}</pre>
      </div>
    </Modal>
  );
}
