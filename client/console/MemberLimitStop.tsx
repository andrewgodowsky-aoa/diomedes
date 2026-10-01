import { useId } from 'react';
import type { MemberLimitPrompt } from '../job-cap-gate';
import { Button, Modal } from '../components';

/**
 * The stop a person meets when their own monthly credit limit holds a message back. It is an alert
 * dialog like the job-cap one: the modal top layer keeps focus inside it, Escape is Cancel, and
 * nothing is asked of anyone until one of the choices is made. Cancel takes focus first because it
 * is the choice that asks no one for anything. The words of the stop are the account service's own.
 */
export function MemberLimitStop({
  prompt,
  busy = false,
  inline = false,
  onAskJob,
  onAskMonth,
  onCancel,
}: {
  prompt: MemberLimitPrompt;
  busy?: boolean;
  /** Render in place, for previews and tests; see `Modal`. */
  inline?: boolean;
  onAskJob(): void;
  onAskMonth(): void;
  onCancel(): void;
}) {
  const bodyId = useId();
  return (
    <Modal title={prompt.title} role="alertdialog" describedBy={bodyId} inline={inline} onClose={onCancel}>
      <p id={bodyId} className="prose">
        {prompt.body}
      </p>
      <div className="dialog-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={onAskJob}>
          {prompt.job}
        </Button>
        <Button tone="primary" disabled={busy} onClick={onAskMonth}>
          {prompt.month}
        </Button>
      </div>
    </Modal>
  );
}
