import { useId } from 'react';
import type { CapWarningCopy } from '../../shared/job-caps';
import { Button, Modal } from '../components';

/**
 * The job-cap decision, before a send or at a job's check-in. It is an alert
 * dialog: the modal top layer keeps focus inside it, Escape is the choice that
 * spends nothing, and nothing is sent until one is chosen. That choice takes
 * focus first. Before a send it reads Cancel, Go over this once and, where a
 * higher tier exists, Use that tier. At a check-in it reads Stop here and
 * Keep going, with no tier to switch to: the job has run and is asking.
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
      {copy.body && (
        <p id={bodyId} className="prose">
          {copy.body}
        </p>
      )}
      <p id={copy.body ? undefined : bodyId} className="caption">{copy.raise}</p>
      <div className="dialog-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>
          {copy.actions?.cancel ?? 'Cancel'}
        </Button>
        <Button disabled={busy} onClick={onGoOver}>
          {copy.actions?.goOver ?? 'Go over this once'}
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
