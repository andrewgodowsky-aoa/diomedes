import { useEffect, useId, useRef, useState } from 'react';
import { AGENT_NAME } from '../../shared/agent-name';
import type { ConversationUpdate } from '../../shared/conversation';
import type { CloudSharingPolicy } from '../../shared/types';
import { api, updateConversation } from '../api';
import { Button, Modal } from '../components';
import { mintCommandId } from '../work-start';
import './thread-menu.css';

/**
 * The conversation's own "···" menu, at the end of its head beside the title, in the thread view
 * and on the home page. It holds one item, "Update this conversation" (artifacts v2, frozen item
 * 3), which opens a confirmation and does nothing until the person confirms. The same
 * `.surface-menu` and `.pmenu` as the top strip's menu, closed by a click outside or Escape.
 */
export function ThreadMenu({
  projectId,
  threadId,
  route,
  routeLabel,
  onUpdated,
}: {
  projectId: string;
  threadId: string;
  /** The route the conversation is on, whose history sharing decides what the update carries. */
  route: string;
  /** That route as the person reads it. */
  routeLabel: string;
  /** The update happened: the thread now ends with its note. */
  onUpdated(result: ConversationUpdate): void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <>
      <div className="surface-menu thread-menu" ref={menuRef}>
        <button
          type="button"
          aria-label="Conversation menu"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          ···
        </button>
        {open && (
          <div className="pmenu open" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
            >
              Update this conversation
            </button>
          </div>
        )}
      </div>
      {confirming && (
        <UpdateConversation
          projectId={projectId}
          threadId={threadId}
          route={route}
          routeLabel={routeLabel}
          onClose={() => setConfirming(false)}
          onUpdated={onUpdated}
        />
      )}
    </>
  );
}

type Sharing = 'on' | 'off' | 'unknown';

/** The sentence about memory, for the sharing setting as it stands now. */
export function memorySentence(sharing: Sharing | null, routeLabel: string): string {
  if (sharing === 'on')
    return `History sharing is on for ${routeLabel}, so ${AGENT_NAME} will carry over your most recent messages.`;
  if (sharing === 'off')
    return `History sharing is off for ${routeLabel}, so your earlier messages stay on screen but ${AGENT_NAME} won't remember them. Updating doesn't turn sharing on.`;
  if (sharing === 'unknown')
    return `${AGENT_NAME} couldn't read your sharing setting. If history sharing is off, your earlier messages stay on screen but it won't remember them.`;
  return 'Checking your sharing setting…';
}

/**
 * The confirmation. One command id per confirmation, so pressing Update again after a lost
 * response reads back what the first press did. A refusal keeps the dialog open with the reason
 * the server gave, and Update can be pressed again once that has passed.
 */
function UpdateConversation({
  projectId,
  threadId,
  route,
  routeLabel,
  onClose,
  onUpdated,
}: {
  projectId: string;
  threadId: string;
  route: string;
  routeLabel: string;
  onClose(): void;
  onUpdated(result: ConversationUpdate): void;
}) {
  const bodyId = useId();
  const command = useRef(mintCommandId());
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [current, setCurrent] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api<CloudSharingPolicy>(
      `/projects/${encodeURIComponent(projectId)}/cloud-sharing`,
      'GET',
      undefined,
      controller.signal,
    ).then(
      (policy) =>
        setSharing(
          policy.shareConversationHistory && (policy.routes as string[]).includes(route) ? 'on' : 'off',
        ),
      () => {
        if (!controller.signal.aborted) setSharing('unknown');
      },
    );
    return () => controller.abort();
  }, [projectId, route]);

  async function update() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await updateConversation(projectId, threadId, command.current);
      if (result.updated) {
        onUpdated(result);
        onClose();
        return;
      }
      setCurrent(true);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'The conversation could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Update this conversation?" role="alertdialog" describedBy={bodyId} onClose={onClose}>
      <div id={bodyId}>
        <p className="prose">
          {AGENT_NAME} will start this conversation fresh on its current instructions, so its answers can
          include diagrams, pictures and documents you open in the side panel. Your messages stay on screen.
        </p>
        <p className="prose thread-update-memory" aria-live="polite">
          {memorySentence(sharing, routeLabel)}
        </p>
      </div>
      {refusal && (
        <p className="caption thread-update-refusal" role="alert">
          {refusal}
        </p>
      )}
      {current ? (
        <>
          <p className="caption" role="status">
            This conversation already uses the current instructions. Nothing changed.
          </p>
          <div className="dialog-actions">
            <Button autoFocus onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <div className="dialog-actions">
          <Button autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || sharing === null} onClick={() => void update()}>
            {busy ? 'Updating…' : 'Update'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
