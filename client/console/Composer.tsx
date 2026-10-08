import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Conversation, DocumentInfo, Mode, Route } from '../../shared/types';
import { TASK_SOURCE_LIMITS } from '../../shared/task-sources';
import type { ReadAccess } from '../../shared/read-access';
import { AUTO_AGENT } from '../../shared/agents';
import type { AgentPickView } from '../../shared/agent-choice';
import { isRoute } from '../../shared/engines';
import { askDraftKey } from '../components';
import { agentCaption, placeholderFor, type AgentChoiceView } from './agent-ui';
import { SendConfirmation } from './SendConfirmation';
import { AskIcon } from './AskRow';
import './attachments.css';
import { modelAttachmentProblem } from './attachments';

/**
 * The composer's own accessible name. Exported so the Console can put focus in
 * this field by the name a person hears, rather than by a class the stylesheet
 * owns.
 */
export const COMPOSER_LABEL = 'Message this thread';

interface ComposerProps {
  thread: Conversation;
  /** Names the project whose Projects-page draft this composer may pick up. */
  projectId?: string;
  /** The thread's Agent box (DIO-292): what the box asks for, and which kinds take images. */
  choice: AgentChoiceView;
  busy: boolean;
  online: boolean;
  route: Route;
  /**
   * Auto's pick for this message, or the Agent the box names, with the kind of run it takes and
   * the route it would take. Asked once per send, before anything else.
   */
  pick(text: string, attachments: string[]): Promise<AgentPickView>;
  /** Whether the person confirms this message before it's sent (`agent-ui.ts` `confirmFor`). */
  confirmFor(pick: AgentPickView): boolean;
  prepareSources(text: string, kind: Mode): Promise<string[]>;
  onSend(text: string, sources: string[], readAccess: ReadAccess, pick: AgentPickView): void;
  /**
   * A playbook the person picked for the next message. Named once beside the box and
   * removable; `starter` fills the box each time `n` changes. The playbook's own text is
   * never put in the box: it travels in the instruction channel.
   */
  skill?: {
    name: string;
    starter: string;
    n: number;
    /** What approved read connectors cover for this playbook, and a way to add one. */
    connectors?: { text: string; onAdd?: () => void } | null;
  } | null;
  onClearSkill?(): void;
  /**
   * Text a person chose to add to the next message from elsewhere in the Console, such
   * as a repository diff from Files. Appended to the box, where it can be read and
   * edited before sending, each time `n` changes.
   */
  insert?: { text: string; n: number } | null;
  /**
   * Project files attached to the next message as references into this Thread.
   * They are sent as the message's selected sources, shown before sending, and
   * recorded on the turn; nothing else is read because of them.
   */
  attachments?: readonly DocumentInfo[];
  onAttachments?(files: DocumentInfo[]): void;
  /** The project's files for the Attach picker, read when the picker opens. */
  attachable?(): Promise<DocumentInfo[]>;
  /** Opens an attached file in Files. */
  onOpenFile?(path: string): void;
  /** The ask box's row (AskRow.tsx): engine, model or tier, effort and agent. */
  controls?: ReactNode;
  /** The context ring (AskRow.tsx), beside Send. */
  ring?: ReactNode;
  /**
   * The thread's model takes images, as its catalogue entry declares (`inputModalities`). An
   * attached project image then travels as exact bytes when the message answers in the
   * conversation.
   */
  imageInput?: boolean;
}

/**
 * Why an attached file cannot travel with a message, or null when it can. A
 * message carries project files through the one source path every route
 * already takes — text documents, read and hashed by the local service — so an
 * attachment is exactly a selected source, never a wider read. A picture, PDF
 * or workbook has no text for that path, and the composer says so rather than
 * sending the message without it.
 */
export function attachmentProblem(file: Pick<DocumentInfo, 'path' | 'kind' | 'size'>): string | null {
  return modelAttachmentProblem(file);
}

/** Pure, because React may run a state initializer twice; the effect below clears it. */
function carriedAsk(projectId: string): string {
  try {
    return localStorage.getItem(askDraftKey(projectId)) ?? '';
  } catch {
    // Storage is unavailable; the composer opens empty.
    return '';
  }
}

/**
 * The ask box (round 2 board N4): one line that grows as you type, and under it one row: the
 * engine, model or tier, effort and agent boxes, then Attach, the context ring and Send. There is
 * no mode strip (DIO-292): the Agent box is the choice, and on Auto an Agent is picked for each
 * message before it is sent. The caption speaks only while the box is waiting on something.
 */
export function Composer({
  thread, projectId, choice, busy, online, route, pick, confirmFor, prepareSources, onSend,
  skill = null, onClearSkill, attachments = [], onAttachments, attachable, onOpenFile, insert = null,
  controls = null, ring = null, imageInput = false,
}: ComposerProps) {
  const [picking, setPicking] = useState<DocumentInfo[] | null>(null);
  const [pickFailure, setPickFailure] = useState('');
  // What the person typed on the Projects page arrives here, once. It used to
  // be read by the Workbook alone, so from the Console the words were dropped
  // on the way into the project. It is taken, not copied: once this composer
  // holds it the stored copy goes, so a second thread does not open holding the
  // same sentence.
  const [text, setText] = useState(
    () => skill?.starter ?? (projectId ? carriedAsk(projectId) : ''),
  );
  const appliedSkill = useRef(skill?.n ?? 0);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.removeItem(askDraftKey(projectId));
    } catch {
      // Nothing was stored if storage is unavailable.
    }
  }, [projectId]);
  const [pending, setPending] = useState<{
    text: string;
    sources: string[];
    pick: AgentPickView;
    send(access: ReadAccess): void;
  } | null>(null);
  // What this one message may read. It starts at the selected documents each time the dialog
  // opens and is never kept for the next message.
  const [readAccess, setReadAccess] = useState<ReadAccess>('selected');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const preparingRef = useRef(false);
  // Images travel only to a model whose catalogue entry takes them, and only in a conversation:
  // an Agent that changes files keeps the text proposal contract, and Auto never hands it an image.
  const acceptsImages = imageInput && (choice.kind === 'ask' || choice.kind === 'plan' || choice.kind === 'auto');
  const preparation = useRef(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const sources = [...new Set(thread.turns.flatMap((t) => t.sources ?? []))];
  const ready = text.trim() !== '';

  // A pending send belongs to this thread, Agent and route. Late listing results
  // cannot open a confirmation after navigation or reuse a different route.
  useEffect(() => {
    setPending(null);
    setPreparing(false);
    setError('');
    return () => {
      preparation.current += 1;
      preparingRef.current = false;
    };
  }, [thread.id, choice.id, route]);

  // A different thread opens on an empty box. Mounting is not a change of thread:
  // clearing there is what emptied the draft carried in from the Projects page.
  const shownThread = useRef(thread.id);
  useEffect(() => {
    if (shownThread.current === thread.id) return;
    shownThread.current = thread.id;
    setText('');
  }, [thread.id]);
  // A picked playbook fills the box. Declared after the thread effect above, so a pick that
  // opens a new thread lands in the box that thread's change just emptied.
  useEffect(() => {
    if (!skill || appliedSkill.current === skill.n) return;
    appliedSkill.current = skill.n;
    setText(skill.starter);
    box.current?.focus();
  }, [skill?.n]);
  const appliedInsert = useRef(insert?.n ?? 0);
  useEffect(() => {
    if (!insert || appliedInsert.current === insert.n) return;
    appliedInsert.current = insert.n;
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${insert.text}` : insert.text));
    box.current?.focus();
  }, [insert?.n]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  function dispatch(send: () => void) {
    if (!preparingRef.current || busy || !online) return;
    preparingRef.current = false;
    setPending(null);
    send();
    onAttachments?.([]);
    setText('');
  }

  async function submit() {
    const value = text.trim();
    if (!value || busy || !online || preparingRef.current) return;
    const blocked = attachments.map((file) => modelAttachmentProblem(file, acceptsImages)).find((problem) => problem !== null);
    if (blocked) {
      setError(blocked);
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    setError('');
    const attempt = ++preparation.current;
    try {
      // The Agent comes first (DIO-292): it decides the kind of run, the route and whether to confirm.
      const picked = await pick(value, attachments.map((file) => file.path));
      if (preparation.current !== attempt) return;
      if (picked.refusal) throw new Error(picked.refusal);
      // Attachments lead: they are what the person chose for this message.
      const selected = [
        ...new Set([...attachments.map((file) => file.path), ...(await prepareSources(value, picked.mode))]),
      ];
      if (preparation.current !== attempt) return;
      if (selected.length > TASK_SOURCE_LIMITS.files)
        throw new Error('A message can carry at most eight documents. Remove an attachment to send.');
      const send = (access: ReadAccess) => onSend(value, selected, access, picked);
      setReadAccess('selected');
      if (confirmFor(picked)) setPending({ text: value, sources: selected, pick: picked, send });
      else dispatch(() => send('selected'));
    } catch (e) {
      if (preparation.current !== attempt) return;
      preparingRef.current = false;
      setError(e instanceof Error ? e.message : 'The project documents could not be listed.');
    } finally {
      if (preparation.current === attempt) setPreparing(false);
    }
  }

  return (
    <div className="col compose">
      <form
        className={`composer${busy ? ' busy' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={box}
          rows={1}
          aria-label={COMPOSER_LABEL}
          placeholder={placeholderFor(choice)}
          value={text}
          disabled={preparing || pending !== null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {/* Named documents are worth stating; an empty scope says nothing at all. */}
        {choice.kind === 'build' && sources.length > 0 && (
          <div className="aux show">
            <span className="mono">in scope</span>
            <span className="mono lc names" style={{ color: 'var(--t1)' }} title={sources.join(', ')}>
              {sources.join(', ')}
            </span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="aux show attached" aria-label="Attached files">
            <span className="mono">attached</span>
            <span className="attach-chips">
              {attachments.map((file) => {
                const problem = modelAttachmentProblem(file, acceptsImages);
                const name = file.path.slice(file.path.lastIndexOf('/') + 1);
                return (
                  <span className={`attach-chip${problem ? ' blocked' : ''}`} key={file.path} title={problem ?? file.path}>
                    <button type="button" className="attach-open" onClick={() => onOpenFile?.(file.path)}>
                      {name}
                    </button>
                    {problem && <span className="mono">not sent</span>}
                    <button
                      type="button"
                      className="clear"
                      aria-label={`Remove ${name}`}
                      onClick={() => onAttachments?.(attachments.filter((item) => item.path !== file.path))}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </span>
          </div>
        )}
        {picking && (
          <div className="aux show">
            <span className="mono">attach</span>
            <select
              aria-label="Attach a project file"
              value=""
              onChange={(event) => {
                const file = picking.find((item) => item.path === event.target.value);
                if (file && !attachments.some((item) => item.path === file.path))
                  onAttachments?.([...attachments, file]);
                setPicking(null);
                box.current?.focus();
              }}
            >
              <option value="">Choose a file</option>
              {picking
                .filter((file) => !attachments.some((item) => item.path === file.path))
                .map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
            </select>
            <button type="button" className="clear" onClick={() => setPicking(null)}>
              Cancel
            </button>
          </div>
        )}
        {skill && (
          <div className="aux show">
            <span className="mono">playbook</span>
            <span className="mono lc names" style={{ color: 'var(--t1)' }} title={skill.name}>
              {skill.name}
            </span>
            {onClearSkill && (
              <button
                type="button"
                className="clear"
                aria-label={`Remove the ${skill.name} playbook`}
                onClick={onClearSkill}
              >
                Remove
              </button>
            )}
          </div>
        )}
        {skill?.connectors && (
          <div className="aux show">
            <span className="mono">connectors</span>
            {/* A sentence, so it wraps rather than truncating like a list of names. */}
            <span style={{ color: 'var(--t1)', overflowWrap: 'anywhere' }}>{skill.connectors.text}</span>
            {skill.connectors.onAdd && (
              <button type="button" className="clear" onClick={skill.connectors.onAdd}>
                Add a connector
              </button>
            )}
          </div>
        )}
        <div className="bar ask-bar">
          {controls}
          {/* The box is locked while the message is prepared, so the caption says
              why: a locked box with the text still in it reads as a send that
              never happened. */}
          {preparing && (
            <span className="cap" role="status">
              Checking project documents before sending.
            </span>
          )}
          <span className="ask-end">
            {onAttachments && attachable && (
              <button
                type="button"
                className="attach"
                aria-label="Attach"
                title="Attach a project file"
                aria-expanded={picking !== null}
                disabled={preparing || pending !== null}
                onClick={() => {
                  if (picking) return setPicking(null);
                  setPickFailure('');
                  attachable()
                    .then((files) => setPicking(files))
                    .catch((e: unknown) =>
                      setPickFailure(e instanceof Error ? e.message : 'The project files could not be listed.'),
                    );
                }}
              >
                <AskIcon name="attach" size={18} stroke={1.7} />
              </button>
            )}
            {ring}
            <button
              type="submit"
              className={`send ${ready ? 'ready' : ''}`}
              aria-label="Send"
              title="Send"
              aria-disabled={!ready || busy || !online || preparing || pending !== null}
              disabled={busy || !online || preparing || pending !== null}
            >
              <AskIcon name="send" size={16} stroke={2.2} />
            </button>
          </span>
        </div>
      </form>
      {error && <p className="caption" role="alert">{error}</p>}
      {pickFailure && <p className="caption" role="alert">{pickFailure}</p>}
      {pending && (
        <SendConfirmation
          kind="message"
          instruction={pending.text}
          route={isRoute(pending.pick.route) ? pending.pick.route : route}
          sources={pending.sources}
          mode={pending.pick.mode}
          agent={
            pending.pick.agent.id === AUTO_AGENT
              ? null
              : agentCaption({ ...pending.pick.agent, picked: choice.id === AUTO_AGENT })
          }
          disabled={busy || !online}
          readAccess={readAccess}
          onReadAccess={setReadAccess}
          onClose={() => {
            preparingRef.current = false;
            setPending(null);
            setReadAccess('selected');
          }}
          onSend={() => {
            const access = readAccess;
            setReadAccess('selected');
            dispatch(() => pending.send(access));
          }}
        />
      )}
    </div>
  );
}
