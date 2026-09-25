import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { interruptMessage } from '../conversation-send';
import { mintCommandId } from '../work-start';
import type { ConversationMode, MessageRequest, MessageResult } from '../../shared/conversation';
import type { ThreadSessionView } from '../../shared/session-controls';
import { canQueue, queuedLabel, sessionLine } from './native-session-view';

interface NativeSessionControlsProps {
  projectId: string;
  threadId: string;
  mode: ConversationMode;
  /** This page's own message is being answered now. */
  answering: boolean;
  /** A queued message was answered: the transcript has something new to read. */
  onAnswered(): void;
}

/** A message this window queued and is still waiting on. Its words stay until it settles. */
interface Held {
  commandId: string;
  text: string;
  error: string | null;
}

/**
 * H03: what a thread's open native conversation offers, under the composer. Everything here is
 * read from `/native-session`: the controls come from the route's contract, the state from the
 * run's record and the model from what the engine reported. It renders nothing on a route with
 * no native session. Stop stays the composer's own; this adds the queue and says what the
 * session can do next.
 */
export function NativeSessionControls({ projectId, threadId, mode, answering, onAnswered }: NativeSessionControlsProps) {
  const [view, setView] = useState<ThreadSessionView | null>(null);
  const [text, setText] = useState('');
  const [held, setHeld] = useState<Held[]>([]);
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  const path = `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;

  const read = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api<ThreadSessionView>(`${path}/native-session?mode=${mode}`, 'GET', undefined, signal);
        if (!signal?.aborted) setView(next);
      } catch {
        // A failed read offers nothing rather than something stale.
        if (!signal?.aborted) setView(null);
      }
    },
    [path, mode],
  );

  const waiting = held.length > 0 || (view?.queued ?? []).some((item) => item.state === 'pending');
  const polling = answering || view?.busy === true || waiting;
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    if (!polling) return () => controller.abort();
    const timer = setInterval(() => void read(controller.signal), 700);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [read, polling, answering]);

  const queue = () => {
    const words = text.trim();
    if (!words) return;
    const commandId = mintCommandId();
    setText('');
    setHeld((items) => [...items, { commandId, text: words, error: null }]);
    const body: MessageRequest = { commandId, text: words, mode, sources: [], consent: true, queued: true };
    void api<MessageResult>(`${path}/messages`, 'POST', body).then(
      () => {
        setHeld((items) => items.filter((item) => item.commandId !== commandId));
        answered.current();
        void read();
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : 'This message was not sent.';
        setHeld((items) => items.map((item) => (item.commandId === commandId ? { ...item, error: reason } : item)));
        void read();
      },
    );
  };
  const withdraw = (commandId: string) => {
    void interruptMessage(projectId, threadId, commandId).then(
      () => void read(),
      () => void read(),
    );
  };

  const line = sessionLine(view);
  if (!line) return null;
  const recorded = new Map((view?.queued ?? []).map((item) => [item.commandId, item]));
  const queuing = canQueue(view, answering);

  return (
    <div className="dio-session" role="group" aria-label="Session">
      <p className={`dio-session-line${line.tone === 'warn' ? ' warn' : ''}`} role="status">
        {line.state && <span className="dio-session-state">{line.state}</span>}
        {line.attribution && <span className="dio-session-by" title={line.attribution}>{line.attribution}</span>}
      </p>
      {line.detail && <p className="dio-session-detail">{line.detail}</p>}
      {held.length > 0 && (
        <ul className="dio-session-queue" aria-label="Queued messages">
          {held.map((item) => {
            const known = recorded.get(item.commandId);
            const pending = !item.error && (!known || known.state === 'pending');
            return (
              <li key={item.commandId}>
                <span className="dio-quote" title={item.text}>
                  {item.text}
                </span>
                <span className="dio-session-note">
                  {item.error ?? (known ? queuedLabel(known) : 'Queued: sent when the current answer finishes')}
                </span>
                {pending ? (
                  <button type="button" className="send" onClick={() => withdraw(item.commandId)}>
                    Withdraw
                  </button>
                ) : (
                  item.error && (
                    <button
                      type="button"
                      className="send"
                      onClick={() => setHeld((items) => items.filter((entry) => entry.commandId !== item.commandId))}
                    >
                      Dismiss
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {queuing && (
        <div className="dio-session-steer">
          <input
            type="text"
            aria-label="Queue a message"
            placeholder="Queue a message for when this answer finishes"
            value={text}
            maxLength={32000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                queue();
              }
            }}
          />
          <button type="button" className={`send${text.trim() ? ' ready' : ''}`} onClick={queue}>
            Queue
          </button>
        </div>
      )}
    </div>
  );
}
