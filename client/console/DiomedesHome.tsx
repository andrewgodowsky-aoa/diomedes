import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  discardPendingMessage,
  lastCommand,
  pendingMessage,
  readOutcome,
  selectProposal,
  sendMessage,
  UnconfirmedMessage,
} from '../conversation-send';
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

/**
 * The Diomedes page with its records: it finds the conversation for the scope the person chose,
 * sends through `conversation-send`, and reads every outcome from the server each time it shows
 * one. It keeps no status of its own. `Diomedes` stays a page of props.
 *
 * "All projects" is the home conversation, which the server provisions on the first message and
 * never before. A project scope is that project's own Diomedes thread (`diomedesThread`), made
 * the same way: on the first send, adopting one that already exists.
 */
export function DiomedesHome(props: DiomedesHomeProps) {
  const { projects, onOpenWork } = props;
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [restriction, setRestriction] = useState<Restriction>('automatic');
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<MessageResult | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const stop = useRef<AbortController | null>(null);
  // Answers arrive for the scope that asked. A scope the person has left must not paint this one.
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;
  // The project thread this page has seen pinned to Claude Code. The home thread is made pinned.
  const pinned = useRef<string | null>(null);

  const thread = useCallback(async (found: Binding): Promise<Conversation | null> => {
    const state = await api<ProjectState>(`/projects/${encodeURIComponent(found.projectId)}/state`);
    return state.conversations.find((item) => item.id === found.threadId) ?? null;
  }, []);

  /** Reads the scope's conversation. Creates nothing. */
  const load = useCallback(
    async (scope: string | null) => {
      setBinding(null);
      setTurns([]);
      setLast(null);
      setUnconfirmed(null);
      setNotice(null);
      setUnavailable(null);
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
          pinned.current = conversation?.engine === 'claude-code' ? conversation.id : null;
        }
        if (scopeRef.current !== scope) return;
        setBinding(found);
        if (!found || !conversation) return;
        setTurns(conversation.turns);
        setRestriction(restrictionFor(conversation.mode));
        setUnconfirmed(pendingMessage(found.projectId, found.threadId)?.input.text ?? null);
        // The last message's outcome is asked for again, never remembered. It is shown only
        // while its answer is still the end of the transcript.
        const command = lastCommand(found.projectId, found.threadId);
        const recorded = command
          ? await readOutcome(found.projectId, found.threadId, command)
          : null;
        if (scopeRef.current !== scope) return;
        const ending = conversation.turns.at(-1);
        if (recorded && ending && ending.role !== 'you' && ending.text === recorded.answerText)
          setLast(recorded);
      } catch (error) {
        if (scopeRef.current !== scope) return;
        setUnavailable(
          scope === null && error instanceof ApiError && error.status === 404
            ? 'The conversation across all projects is not available in this build. Choose a project to talk about.'
            : words(error),
        );
      }
    },
    [thread],
  );
  useEffect(() => {
    void load(scopeId);
  }, [load, scopeId]);

  /** The scope's conversation, made now if it never was. Only a send calls this. */
  const ensure = async (scope: string | null): Promise<Binding> => {
    if (binding && (scope === null || pinned.current === binding.threadId)) return binding;
    if (scope === null) return api<Binding>('/home/conversation', 'POST', {});
    const project = `/projects/${encodeURIComponent(scope)}`;
    const state = await api<ProjectState>(`${project}/state`);
    const found =
      diomedesThread(state.conversations) ??
      (await api<Conversation>(`${project}/threads`, 'POST', { name: 'Diomedes', mode: 'auto' }));
    // Diomedes talks through Claude Code whatever the project's own work runs on, and work it
    // starts still runs on the project's AI. Asked on every first send rather than once at
    // creation, so a thread whose pin was lost between the two requests gets it now.
    if (found.engine !== 'claude-code')
      await api(`${project}/threads/${encodeURIComponent(found.id)}`, 'PUT', {
        engine: 'claude-code',
      });
    pinned.current = found.id;
    return { projectId: scope, threadId: found.id };
  };

  /** True when the message was sent, or may have been. False when it was refused and never sent. */
  const send = async (text: string, mode = modeFor(restriction)): Promise<boolean> => {
    const scope = scopeId;
    setNotice(null);
    setLast(null);
    setPending(true);
    const controller = new AbortController();
    stop.current = controller;
    try {
      const found = await ensure(scope);
      if (scopeRef.current === scope) setBinding(found);
      const result = await sendMessage(
        found.projectId,
        found.threadId,
        { text, mode, sources: [] },
        controller.signal,
      );
      const conversation = await thread(found);
      if (scopeRef.current !== scope) return true;
      setUnconfirmed(null);
      setTurns(conversation?.turns ?? []);
      setLast(result);
      return true;
    } catch (error) {
      // The saved message holds the text of an unconfirmed send; only a refusal gives it back.
      const kept = error instanceof UnconfirmedMessage;
      if (scopeRef.current !== scope) return kept;
      if (kept) setUnconfirmed(text);
      else setNotice(words(error));
      return kept;
    } finally {
      if (stop.current === controller) stop.current = null;
      if (scopeRef.current === scope) setPending(false);
    }
  };

  const resend = () => {
    if (!binding) return;
    const saved = pendingMessage(binding.projectId, binding.threadId);
    // Exactly what was saved, Mode included: the server refuses the same command with a changed body.
    if (saved) void send(saved.input.text, saved.input.mode);
    else setUnconfirmed(null);
  };
  const discard = () => {
    if (binding) discardPendingMessage(binding.projectId, binding.threadId);
    setUnconfirmed(null);
    void load(scopeId);
  };

  const card = outcomeCard(last?.outcome ?? null, projects);
  const act = async () => {
    const outcome = last?.outcome;
    if (!outcome || !binding || !last) return;
    if (outcome.status === 'started') return onOpenWork(outcome.projectId);
    if (outcome.status !== 'proposed') return;
    setCardBusy(true);
    setNotice(null);
    try {
      setLast(
        await selectProposal(binding.projectId, binding.threadId, last.commandId, {
          proposalDigest: outcome.proposalDigest,
          projectId: outcome.projectId,
        }),
      );
    } catch (error) {
      setNotice(words(error));
      // The record decides what is still on offer, not this screen.
      const recorded = await readOutcome(binding.projectId, binding.threadId, last.commandId).catch(
        () => null,
      );
      if (recorded) setLast(recorded);
    } finally {
      setCardBusy(false);
    }
  };

  return (
    <Diomedes
      projects={projects}
      scopeId={scopeId}
      onScope={(id) => {
        stop.current?.abort();
        setPending(false);
        setScopeId(id);
      }}
      turns={turns}
      pending={pending}
      restriction={restriction}
      onRestriction={setRestriction}
      onSend={(text) => send(text)}
      onStop={() => stop.current?.abort()}
      unavailable={unavailable}
      card={card}
      cardBusy={cardBusy}
      onCardAction={() => void act()}
      unconfirmed={unconfirmed}
      onResend={resend}
      onDiscard={discard}
      notice={notice}
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
