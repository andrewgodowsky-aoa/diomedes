import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  discardPendingMessage,
  lastCommand,
  pendingMessage,
  readOutcome,
  resendPending,
  selectProposal,
  sendMessage,
  UnconfirmedMessage,
  type PendingMessage,
} from '../conversation-send';
import { answerTurnId } from '../conversation-turn';
import type { MessageResult } from '../../shared/conversation';
import type { Conversation, Project, ProjectState, Turn } from '../../shared/types';
import { Diomedes } from './Diomedes';
import type { EverythingItem } from './Everything';
import {
  diomedesThread,
  modeFor,
  outcomeCard,
  restrictionFor,
  type DiomedesResult,
  type Restriction,
} from './diomedes-view';

/** Where one scope's conversation lives. Null until it has been made, which is on the first send. */
interface Binding {
  projectId: string;
  threadId: string;
}

export interface DiomedesHomeProps {
  /** Never contains the reserved home Project: the server's public listing leaves it out. */
  projects: Project[];
  results: DiomedesResult[];
  onOpenResult(id: string): void;
  destinations: EverythingItem[];
  pinned: string[];
  groups?: { heading: string; ids: string[] }[];
  onDestination(id: string): void;
  onTogglePin(id: string): void;
  onNewProject(): void;
  /** Go to the project where work that started is running. */
  onOpenWork(projectId: string): void;
}

const words = (error: unknown) =>
  error instanceof Error ? error.message : 'Diomedes could not complete that.';

/** The message a conversation may still be owed an answer for. Unreadable storage reads as none. */
function retained(found: Binding): PendingMessage | null {
  try {
    return pendingMessage(found.projectId, found.threadId);
  } catch {
    return null;
  }
}

/**
 * The unconfirmed message as the page shows it: its words, and the command those words belong
 * to. Send again and Discard act on this command and no other. Another window can settle it and
 * claim a newer message while this one is still on screen, and a control beside these words
 * must never reach that newer message.
 */
interface Kept {
  text: string;
  commandId: string | null;
}
const keptOf = (saved: PendingMessage | null): Kept | null =>
  saved ? { text: saved.input.text, commandId: saved.commandId } : null;

/**
 * The Diomedes page with its records: it finds the conversation for the scope the person chose,
 * sends through `conversation-send`, and reads every outcome from the server each time it shows
 * one. It keeps no status of its own. `Diomedes` stays a page of props.
 *
 * "All projects" is the home conversation, and a project scope is that project's own Diomedes
 * thread. The server provisions both, on the first message and never before, so two windows
 * that send at once still end up in one conversation. Reading a scope creates nothing.
 *
 * Everything here is asynchronous and the person can move on at any moment, so every read, send
 * and start takes a turn number when it begins and publishes nothing once that number has moved.
 */
export function DiomedesHome(props: DiomedesHomeProps) {
  const { projects, onOpenWork } = props;
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [restriction, setRestriction] = useState<Restriction>('automatic');
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<MessageResult | null>(null);
  const [kept, setKept] = useState<Kept | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [unread, setUnread] = useState(false);
  const stop = useRef<AbortController | null>(null);
  // Whose turn it is to paint. A scope change, a read and a send each take the next number, so
  // an answer for a visit the person has left, or for a message they have since followed with
  // another, finds the number moved and is dropped. Leaving a scope and coming back is a new
  // visit: the scope's id alone could not tell the two apart.
  const turn = useRef(0);
  const lastRef = useRef(last);
  lastRef.current = last;

  const thread = useCallback(async (found: Binding): Promise<Conversation | null> => {
    const state = await api<ProjectState>(`/projects/${encodeURIComponent(found.projectId)}/state`);
    return state.conversations.find((item) => item.id === found.threadId) ?? null;
  }, []);

  /**
   * Shows one message's outcome under its own answer, and only while that answer is still the
   * end of the transcript. The transcript is read after the outcome, so a message another window
   * added in between is seen. The answer is found by the name the server gave its turn, never by
   * its words: an outcome read carries no words, and two messages can be answered alike.
   */
  const show = useCallback(
    async (found: Binding, result: MessageResult, owns: () => boolean) => {
      const conversation = await thread(found);
      const answer = await answerTurnId(result.runId, result.commandId);
      if (!owns()) return;
      const ending = conversation?.turns.at(-1);
      setTurns(conversation?.turns ?? []);
      setLast(ending && answer !== null && ending.id === answer ? result : null);
    },
    [thread],
  );

  /** Reads the scope's conversation. Creates nothing. */
  const load = useCallback(
    async (scope: string | null) => {
      stop.current?.abort();
      const mine = ++turn.current;
      const owns = () => turn.current === mine;
      setBinding(null);
      setTurns([]);
      setLast(null);
      setKept(null);
      setNotice(null);
      setUnavailable(null);
      setUnread(false);
      setPending(false);
      setCardBusy(false);
      try {
        let found: Binding | null;
        let conversation: Conversation | null = null;
        if (scope === null) {
          found = await api<Binding | null>('/home/conversation');
          if (found) conversation = await thread(found);
        } else {
          const state = await api<ProjectState>(`/projects/${encodeURIComponent(scope)}/state`);
          conversation = diomedesThread(state.conversations);
          found = conversation ? { projectId: scope, threadId: conversation.id } : null;
        }
        if (!owns()) return;
        setBinding(found);
        if (!found || !conversation) return;
        setTurns(conversation.turns);
        setRestriction(restrictionFor(conversation.mode));
        setKept(keptOf(retained(found)));
        // The last message's outcome is asked for again, never remembered.
        const command = lastCommand(found.projectId, found.threadId);
        const recorded = command
          ? await readOutcome(found.projectId, found.threadId, command)
          : null;
        if (!owns() || !recorded || !outcomeCard(recorded.outcome, [])) return;
        await show(found, recorded, owns);
      } catch (error) {
        if (!owns()) return;
        setUnavailable(
          scope === null && error instanceof ApiError && error.status === 404
            ? 'The conversation across all projects is not available in this build. Choose a project to talk about.'
            : words(error),
        );
      }
    },
    [thread, show],
  );
  useEffect(() => {
    void load(scopeId);
  }, [load, scopeId]);

  /**
   * The scope's conversation, made now if it never was. Only a send calls this. The server finds
   * or makes it in one step and keeps it on Claude Code, whatever the project's own work runs
   * on; work the conversation starts still runs on the project's AI. A project is asked on every
   * send, which writes nothing when nothing changed and mends a thread another window re-routed.
   */
  const ensure = (scope: string | null): Promise<Binding> => {
    if (scope === null)
      return binding ? Promise.resolve(binding) : api<Binding>('/home/conversation', 'POST', {});
    return api<Binding>(`/projects/${encodeURIComponent(scope)}/conversation`, 'POST', {});
  };

  /**
   * One delivery, a new message or a saved one sent again. True when the message was sent, or
   * may have been. False only when it was refused, never sent, and is still the person's to
   * change, which is when the page puts the text back in the box.
   */
  const deliver = async (
    text: string,
    where: () => Promise<Binding>,
    transport: (found: Binding, signal: AbortSignal) => Promise<MessageResult>,
  ): Promise<boolean> => {
    const mine = ++turn.current;
    const owns = () => turn.current === mine;
    setNotice(null);
    setLast(null);
    setUnread(false);
    setCardBusy(false);
    setPending(true);
    const controller = new AbortController();
    stop.current = controller;
    let found: Binding | null = null;
    try {
      found = await where();
      if (owns()) setBinding(found);
      const result = await transport(found, controller.signal);
      // Confirmed. Nothing after this line may hand the text back or send it again: a
      // transcript that cannot be read is a failed read, not a failed send. What is shown as
      // unconfirmed now is whatever the conversation still holds, which is nothing unless
      // another window has claimed a newer message since.
      if (owns()) setKept(keptOf(retained(found)));
      try {
        await show(found, result, owns);
      } catch (error) {
        if (owns()) {
          setNotice(words(error));
          setUnread(true);
        }
      }
      return true;
    } catch (error) {
      // A refusal that arrives after the person has moved on is not put back in a box that
      // now speaks to somewhere else.
      if (!owns()) return true;
      if (error instanceof UnconfirmedMessage) {
        const saved = found ? retained(found) : null;
        setKept(keptOf(saved) ?? { text, commandId: null });
        return true;
      }
      setNotice(words(error));
      // A refusal after an uncertain attempt may be about the retry, not the original, and the
      // saved message is kept for exactly that case. It is shown with its own words so it can
      // be sent again or given up, never silently turned back into a draft.
      const saved = found ? retained(found) : null;
      setKept(keptOf(saved));
      return saved?.input.text === text.trim();
    } finally {
      if (stop.current === controller) stop.current = null;
      if (owns()) setPending(false);
    }
  };

  const send = (text: string): Promise<boolean> => {
    const scope = scopeId;
    const mode = modeFor(restriction);
    return deliver(
      text,
      () => ensure(scope),
      (found, signal) =>
        sendMessage(found.projectId, found.threadId, { text, mode, sources: [] }, signal),
    );
  };

  const resend = () => {
    const found = binding;
    const shown = kept;
    const command = shown?.commandId;
    // Nothing on record to send again: read what happened.
    if (!found || !shown || !command) return void load(scopeId);
    // The command these words were shown for, never whichever is pending now. The transport
    // sends it with the body it was saved with, Mode included, and if another window settled it
    // meanwhile it sends nothing and reads what that command came to.
    void deliver(
      shown.text,
      () => Promise.resolve(found),
      (where, signal) => resendPending(where.projectId, where.threadId, command, signal),
    ).then((sent) => {
      if (!sent) void load(scopeId);
    });
  };
  const discard = () => {
    const found = binding;
    const command = kept?.commandId;
    if (!found || !command) return void load(scopeId);
    // Gives up the command that was shown. A newer message another window has claimed since is
    // not this one to give up, and reading again shows it for what it is.
    void discardPendingMessage(found.projectId, found.threadId, command).then(
      () => load(scopeId),
      (error) => setNotice(words(error)),
    );
  };

  const card = outcomeCard(last?.outcome ?? null, projects);
  const act = async () => {
    const shown = last;
    const found = binding;
    if (!shown || !found) return;
    const outcome = shown.outcome;
    if (outcome.status === 'started') return onOpenWork(outcome.projectId);
    if (outcome.status !== 'proposed') return;
    const mine = turn.current;
    // The answer belongs to this visit and to this message. Once either has moved on it is the
    // record's to tell, the next time this conversation is read.
    const owns = () => turn.current === mine && lastRef.current?.commandId === shown.commandId;
    setCardBusy(true);
    setNotice(null);
    try {
      const result = await selectProposal(found.projectId, found.threadId, shown.commandId, {
        proposalDigest: outcome.proposalDigest,
        projectId: outcome.projectId,
      });
      if (owns()) setLast(result);
    } catch (error) {
      if (!owns()) return;
      setNotice(words(error));
      // The record decides what is still on offer, not this screen.
      const recorded = await readOutcome(found.projectId, found.threadId, shown.commandId).catch(
        () => null,
      );
      if (recorded && owns()) setLast(recorded);
    } finally {
      if (owns()) setCardBusy(false);
    }
  };

  return (
    <Diomedes
      projects={projects}
      scopeId={scopeId}
      onScope={(id) => {
        if (id === scopeId) return;
        stop.current?.abort();
        turn.current += 1;
        setPending(false);
        setScopeId(id);
      }}
      turns={turns}
      pending={pending}
      restriction={restriction}
      onRestriction={setRestriction}
      onSend={send}
      onStop={() => stop.current?.abort()}
      unavailable={unavailable}
      card={card}
      cardBusy={cardBusy}
      onCardAction={() => void act()}
      unconfirmed={kept?.text ?? null}
      onResend={resend}
      onDiscard={discard}
      notice={notice}
      onReadAgain={unread ? () => void load(scopeId) : null}
      results={props.results}
      onOpenResult={props.onOpenResult}
      destinations={props.destinations}
      pinned={props.pinned}
      groups={props.groups}
      onDestination={props.onDestination}
      onTogglePin={props.onTogglePin}
      onNewProject={props.onNewProject}
    />
  );
}
