import { useId } from 'react';
import type { CapWarningCopy } from '../../shared/job-caps';
import { Button, Modal } from '../components';

/**
 * The job-cap decision, before a send or after a job stopped at its cap. It is
 * an alert dialog: the modal top layer keeps focus inside it, Escape is Cancel,
 * and nothing is sent until one of the three is chosen. Cancel takes focus
 * first because it is the choice that spends nothing.
 */
export function JobCapWarning({
  copy,
  busy = false,
  inline = false,
  onUpgrade,
  onGoOver,
  onCancel,
}: {
  copy: CapWarningCopy;
  busy?: boolean;
  /** Render in place, for previews and tests; see `Modal`. */
  inline?: boolean;
  onUpgrade(): void;
  onGoOver(): void;
  onCancel(): void;
}) {
  const bodyId = useId();
  return (
    <Modal title={copy.title} role="alertdialog" describedBy={bodyId} inline={inline} onClose={onCancel}>
      <p id={bodyId} className="prose">
        {copy.body}
      </p>
      <p className="caption">{copy.raise}</p>
      <div className="dialog-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={onGoOver}>
          Go over this once
        </Button>
        {copy.upgrade && (
          <Button tone="primary" disabled={busy} onClick={onUpgrade}>
            {copy.upgrade.label}
          </Button>
        )}
      </div>
    </Modal>
  );
}
