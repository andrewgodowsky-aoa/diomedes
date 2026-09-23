import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { AGENT_NAME } from '../../shared/agent-name';
import type { ConversationUpdate, ConversationUpdatePreview } from '../../shared/conversation';
import { ApiError, conversationUpdatePreview, updateConversation } from '../api';
import { Button, Modal } from '../components';
import {
  canUpdate,
  CHECK_UNANSWERED,
  memorySentence,
  UNANSWERED,
  updateAnswered,
  updateCommand,
  updateUnanswered,
  updateUnconfirmed,
} from './conversation-update';
import './thread-menu.css';

/**
 * The conversation's own "···" menu, at the end of its head beside the title, in the thread view
 * and on the home page. It holds one item, "Update this conversation" (artifacts v2, frozen item
 * 3), which opens a confirmation and does nothing until the person confirms. The same
 * `.surface-menu` and `.pmenu` as the top strip's menu, closed by a click outside or Escape.
 *
 * It shows only where the update can act: where the server's dry run says it would start a
 * conversation fresh, or where an update was sent whose answer never arrived and can be asked
 * again. It asks again whenever `revision` changes, which the caller moves with the thread's turns.
 */
export function ThreadMenu({
  projectId,
  threadId,
  revision,
  onUpdated,
}: {
  projectId: string;
  threadId: string;
  /** Changes whenever the thread's turns do: a message answered, a note written. Zero asks nothing. */
  revision: number;
  /** The update happened: the thread now ends with its note. */
  onUpdated(result: ConversationUpdate): void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The last dry run, with the thread it was for, so another thread never shows it and a new
  // revision keeps it until the next one arrives.
  const thread = JSON.stringify([projectId, threadId]);
  const [read, setRead] = useState<{ thread: string; preview: ConversationUpdatePreview } | null>(null);
  const preview = read?.thread === thread ? read.preview : null;
  // An unanswered update is kept outside React (conversation-update.ts); this redraws on a change.
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (revision <= 0) return;
    const controller = new AbortController();
    const asked = JSON.stringify([projectId, threadId]);
    conversationUpdatePreview(projectId, threadId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setRead({ thread: asked, preview: next });
      },
      // Nothing to offer when the dry run cannot be read: the menu stays away.
      () => undefined,
    );
    return () => controller.abort();
  }, [projectId, threadId, revision]);

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

  const visible = canUpdate(preview, updateUnconfirmed(projectId, threadId));
  return (
    <>
      {visible && (
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
      )}
      {confirming && (
        <UpdateConversation
          projectId={projectId}
          threadId={threadId}
          onClose={() => setConfirming(false)}
          onUpdated={onUpdated}
          onChanged={changed}
        />
      )}
    </>
  );
}

/**
 * The confirmation. It asks the server what the update would do and says so: whether the recent
 * messages come along, and to which route, is the server's decision, never worked out here. One
 * command per thread until the server answers it, so pressing Update again after a lost answer,
 * here or after opening this again, reads back what the first press did. A refusal keeps the
 * dialog open with the reason the server gave, and Update can be pressed again once it has passed.
 */
function UpdateConversation({
  projectId,
  threadId,
  onClose,
  onUpdated,
  onChanged,
}: {
  projectId: string;
  threadId: string;
  onClose(): void;
  onUpdated(result: ConversationUpdate): void;
  /** An update was sent or answered: the menu decides again whether it can act. */
  onChanged(): void;
}) {
  const bodyId = useId();
  const [preview, setPreview] = useState<ConversationUpdatePreview | null>(null);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [current, setCurrent] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(() => updateUnconfirmed(projectId, threadId));

  useEffect(() => {
    const controller = new AbortController();
    conversationUpdatePreview(projectId, threadId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setPreview(next);
      },
      () => {
        if (!controller.signal.aborted) setUnread(true);
      },
    );
    return () => controller.abort();
  }, [projectId, threadId]);

  async function update() {
    if (busy) return;
    const command = updateCommand(projectId, threadId);
    setBusy(true);
    setRefusal(null);
    try {
      const result = await updateConversation(projectId, threadId, command);
      updateAnswered(projectId, threadId, command);
      setUnconfirmed(false);
      onChanged();
      if (result.updated) {
        onUpdated(result);
        onClose();
        return;
      }
      setCurrent(true);
    } catch (error) {
      if (error instanceof ApiError) {
        // The server answered: nothing was done, and it said why.
        updateAnswered(projectId, threadId, command);
        setUnconfirmed(false);
        setRefusal(error.message);
      } else {
        // No answer came back. The same command goes again, and reads back if it was done.
        updateUnanswered(projectId, threadId, command);
        setUnconfirmed(true);
        setRefusal(UNANSWERED);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const nothing = preview !== null && preview.retiring === 0;
  // Update needs the server's decision to have been said, except to ask about an unanswered one.
  const ready = unconfirmed || (preview !== null && !nothing);
  const close = (
    <div className="dialog-actions">
      <Button autoFocus onClick={onClose}>
        Close
      </Button>
    </div>
  );
  return (
    <Modal title="Update this conversation?" role="alertdialog" describedBy={bodyId} onClose={onClose}>
      <div id={bodyId}>
        {nothing && unconfirmed ? (
          <p className="prose">{CHECK_UNANSWERED}</p>
        ) : nothing ? (
          <p className="prose" role="status">
            This conversation already uses the current instructions.
          </p>
        ) : (
          <>
            <p className="prose">
              {AGENT_NAME} will start this conversation fresh on its current instructions, so its answers can
              include diagrams, pictures and documents you open in the side panel. Your messages stay on screen.
            </p>
            <p className="prose thread-update-memory" aria-live="polite">
              {preview
                ? memorySentence(preview)
                : unread
                  ? `${AGENT_NAME} couldn't check what updating would do to its memory of this conversation. Close this and try again.`
                  : 'Checking what updating would do…'}
            </p>
          </>
        )}
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
          {close}
        </>
      ) : nothing && !unconfirmed ? (
        close
      ) : (
        <div className="dialog-actions">
          <Button autoFocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || !ready} onClick={() => void update()}>
            {busy ? 'Updating…' : 'Update'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
