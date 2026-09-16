import type { ReactNode } from 'react';
import type { Mode, Route } from '../../shared/types';
import { ENGINE_NAMES, isExternalEngine } from '../../shared/engines';
import { Button, Modal } from '../components';

/** Sending context and authorizing a later file proposal are separate decisions. */
export function SendConfirmation({
  kind, instruction, route, sources, mode, picker, disabled, onClose, onSend,
}: {
  kind: 'task' | 'message';
  instruction: string;
  route: Route;
  sources: readonly string[];
  mode: Mode;
  /** A control that changes `sources` for this send only; the line below states the result. */
  picker?: ReactNode;
  disabled?: boolean;
  onClose(): void;
  onSend(): void;
}) {
  const engine = isExternalEngine(route) ? ENGINE_NAMES[route] : route === 'codex' ? 'Codex' : route;
  return (
    <Modal title={`Send this ${kind}?`} onClose={onClose}>
      <p className="prose" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{instruction}</p>
      <p className="prose">
        Send this instruction to {engine} using its selected model and account.
        {' '}Usage is billed under that account's plan.
      </p>
      {picker}
      <p className="prose task-sources" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
        {sources.length ? `Documents included: ${sources.join(', ')}.` : 'No project documents are included.'}
      </p>
      <p className="prose">
        {mode === 'ask'
          ? 'Nothing in the project changes.'
          : mode === 'plan'
            ? 'The returned plan is saved for you to read before work begins.'
            : "File proposals follow the task's existing approval and scope requirements."}
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" disabled={disabled} onClick={onSend}>Send {kind}</Button>
      </div>
    </Modal>
  );
}
