import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  discardPendingMessage,
  interruptMessage,
  lastCommand,
  pendingMessage,
  readOutcome,
  resendPending,
  selectProposal,
  sendMessage,
  UnconfirmedMessage,
  type DispatchIdentity,
  type PendingMessage,
} from '../conversation-send';
import { answerTurnId } from '../conversation-turn';
import {
  afterStop,
  beforeSend,
  CapDeclined,
  estimateMessage,
  goOverAfterStop,
  goOverBeforeSend,
  isJobCapStop,
  jobStatus,
  setThreadTier,
  type CapChoice,
  type CapPrompt,
  type GateResult,
} from '../job-cap-gate';
import { mintCommandId } from '../work-start';
import type { JobTier } from '../../shared/job-caps';
import type { MessageResult } from '../../shared/conversation';
import { CONVERSATION_DEFAULT_ROUTE } from '../../shared/engines';
import type { Conversation, Project, ProjectState, Route, Turn } from '../../shared/types';
import type { WorkStyle } from '../../shared/work-style';
import { Diomedes } from './Diomedes';
import { JobCapWarning } from './JobCapWarning';
import { stepLiveReply, type LiveBinding, type LiveEvent, type LiveReply } from './live-reply';
import { saveArtifact } from './artifact-save';
import { HomeArt } from './HomeArt';
import { HomeBrief } from './HomeBrief';
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
  /** The person's detail level. Technical also shows each tool call's tool and detail. */
  detail?: 'guided' | 'standard' | 'technical';
  /**
   * The appearance scheme the page is painted in. The Nectovia scheme opens the
   * conversation with its progress report and draws the bust beside it; every
   * other scheme draws the page as it always has.
   */
  scheme?: string;
}

const words = (error: unknown) =>
  error instanceof Error ? error.message : 'Nectovia could not complete that.';

/** What an interrupt acknowledgement that cannot confirm a stop is told as. */
const STOP_UNCONFIRMED =
  'Stop was not confirmed. Sending the message again checks what happened.';

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
 * The delivery on screen now. `cancelled` is set by Stop and by the visit ending, and closes
 * the gap before the first request: a delivery cancelled while it was still finding the
 * conversation or waiting on the lock never dispatches. `issued` is the one command identity
 * this delivery's dispatch was given, so a Stop can name it and no other.
 */
interface ActiveDelivery {
  controller: AbortController;
  cancelled: boolean;
  issued: DispatchIdentity | null;
}

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
  // The route the scoped thread is recorded on, or null until one is read: the caption then
  // names the default a first send takes. There is no Route control; a tier decides the route.
  const [route, setRoute] = useState<Route | null>(null);
  // The scoped thread's own WorkStyle, or null to follow the Settings default.
  const [workStyle, setWorkStyle] = useState<WorkStyle | null>(null);
  /** The job-cap decision on screen, and how to answer the send waiting on it. */
  const [capPrompt, setCapPrompt] = useState<(CapPrompt & { answer(choice: CapChoice): void }) | null>(null);
  /** The command a job-cap stop refused, told from inside the delivery to the send that awaits it. */
  const capStop = useRef<DispatchIdentity | null>(null);
  const delivery = useRef<ActiveDelivery | null>(null);
  // Whose turn it is to paint. A scope change, a read and a send each take the next number, so
  // an answer for a visit the person has left, or for a message they have since followed with
  // another, finds the number moved and is dropped. Leaving a scope and coming back is a new
  // visit: the scope's id alone could not tell the two apart.
  const turn = useRef(0);
  const lastRef = useRef(last);
  lastRef.current = last;
  // The answer streaming for the message in flight, and the one command it may belong to. The
  // binding is the dispatch identity the send was issued, set before its request leaves, and
  // cleared whenever the delivery ends or the visit moves on, so a frame for any other command,
  // thread, project or run never paints here.
  const [live, setLive] = useState<LiveReply | null>(null);
  const liveBinding = useRef<LiveBinding | null>(null);
  const dropLive = useCallback(() => {
    liveBinding.current = null;
    setLive(null);
  }, []);
  useEffect(() => {
    const es = new EventSource('/api/events');
    // The binding is read when the frame arrives: a frame that lands after the page has moved
    // on finds none and is dropped with whatever was showing.
    const step = (event: LiveEvent) => {
      const bound = liveBinding.current;
      if (!bound) return;
      setLive((prev) => stepLiveReply(prev, bound, event));
    };
    const frame = (type: 'engine-text' | 'engine-activity') => (ev: Event) => {
      let data: unknown;
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      step({ type, data });
    };
    const onText = frame('engine-text');
    const onActivity = frame('engine-activity');
    // A reconnect replays nothing, so a missed text frame loses the preview; the recorded
    // answer still replaces it.
    const onLost = () => step({ type: 'lost' });
    es.addEventListener('engine-text', onText);
    es.addEventListener('engine-activity', onActivity);
    es.addEventListener('error', onLost);
    return () => es.close();
  }, []);

  const thread = useCallback(async (found: Binding): Promise<Conversation | null> => {
    const state = await api<ProjectState>(`/projects/${encodeURIComponent(found.projectId)}/state`);
    return state.conversations.find((item) => item.id === found.threadId) ?? null;
  }, []);

  /**
   * The bound thread through the narrow list read: route metadata, not the transcript. The
   * pre-dispatch refresh uses this on purpose, so it never stands in front of the state read
   * the answer's own confirmation still performs.
   */
  const listedThread = useCallback(async (found: Binding): Promise<Conversation | null> => {
    const listed = await api<{ threads: Conversation[] }>(
      `/projects/${encodeURIComponent(found.projectId)}/threads`,
    );
    return listed.threads.find((item) => item.id === found.threadId) ?? null;
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
      setRoute(conversation?.engine ?? null);
      setWorkStyle(conversation?.workStyle ?? null);
      setTurns(conversation?.turns ?? []);
      setLast(ending && answer !== null && ending.id === answer ? result : null);
    },
    [thread],
  );

  /** Ends whatever is in flight: its signal fires, and the cancelled flag closes the gap before it. */
  const endDelivery = useCallback(() => {
    const active = delivery.current;
    if (!active) return;
    active.cancelled = true;
    active.controller.abort();
  }, []);

  /** Reads the scope's conversation. Creates nothing. */
  const load = useCallback(
    async (scope: string | null) => {
      endDelivery();
      dropLive();
      const mine = ++turn.current;
      const owns = () => turn.current === mine;
      setBinding(null);
      setRoute(null);
      setWorkStyle(null);
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
        setRoute(conversation.engine ?? null);
        setWorkStyle(conversation.workStyle ?? null);
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
    [thread, show, endDelivery, dropLive],
  );
  useEffect(() => {
    void load(scopeId);
  }, [load, scopeId]);

  /**
   * The scope's conversation, made now if it never was. Only a send calls this. Both scopes ask
   * every time: the provisioner is also where the route default lands and where an unmarked pin
   * is migrated once, so a cached binding can never stand in for the ask. A provisioner that
   * changed nothing writes nothing.
   */
  const ensure = (scope: string | null): Promise<Binding> =>
    scope === null
      ? api<Binding>('/home/conversation', 'POST', {})
      : api<Binding>(`/projects/${encodeURIComponent(scope)}/conversation`, 'POST', {});

  /**
   * One delivery, a new message or a saved one sent again. True when the message was sent, or
   * may have been. False only when it was refused, never sent, and is still the person's to
   * change, which is when the page puts the text back in the box.
   */
  const deliver = async (
    text: string,
    where: () => Promise<Binding>,
    transport: (
      found: Binding,
      signal: AbortSignal,
      onClaim: (identity: DispatchIdentity) => void,
    ) => Promise<MessageResult>,
  ): Promise<boolean> => {
    const mine = ++turn.current;
    const owns = () => turn.current === mine;
    dropLive();
    setNotice(null);
    setLast(null);
    setUnread(false);
    setCardBusy(false);
    setPending(true);
    const current: ActiveDelivery = {
      controller: new AbortController(),
      cancelled: false,
      issued: null,
    };
    delivery.current = current;
    let found: Binding | null = null;
    try {
      found = await where();
      if (owns()) setBinding(found);
      // A Stop pressed while the conversation was being found sent nothing. This visit's Stop
      // hands the text back; after the visit has moved on, nothing is put back in a box that
      // now speaks to somewhere else.
      if (current.cancelled) return !owns();
      // The provisioner is also where an unmarked pin is migrated, on this very call: the
      // caption the pending message waits under is read from the concrete thread it answered,
      // not from the record the last visit read. A marked choice is untouched either way; the
      // thread is the authority. A failed read blocks nothing - the send still proceeds and the
      // outcome read afterwards still refreshes it.
      const provisioned = await listedThread(found).catch(() => null);
      if (owns() && !current.cancelled && provisioned) setRoute(provisioned.engine ?? null);
      const result = await transport(found, current.controller.signal, (identity) => {
        current.issued = identity;
        // Told before the request leaves, so the started frame always finds its binding.
        if (owns() && !current.cancelled)
          liveBinding.current = {
            projectId: identity.projectId,
            threadId: identity.threadId,
            requestId: identity.commandId,
          };
      });
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
      // A delivery its own Stop ended before dispatch saved and sent nothing: the text is still
      // the person's to take back, and whatever the conversation still owes is shown as it is.
      if (current.cancelled) {
        setKept(keptOf(found ? retained(found) : null));
        return false;
      }
      // Cancel at a job-cap question sent nothing and saved nothing: the words go back, unremarked.
      if (error instanceof CapDeclined) return false;
      // A job that reached its cap stopped before its next step; the send decides what follows.
      if (isJobCapStop(error) && current.issued) capStop.current = current.issued;
      setNotice(words(error));
      // A refusal after an uncertain attempt may be about the retry, not the original, and the
      // saved message is kept for exactly that case. It is shown with its own words so it can
      // be sent again or given up, never silently turned back into a draft.
      const saved = found ? retained(found) : null;
      setKept(keptOf(saved));
      return saved?.input.text === text.trim();
    } finally {
      if (delivery.current === current) delivery.current = null;
      if (owns()) {
        dropLive();
        setPending(false);
      }
    }
  };

  /**
   * Ask the person a job-cap question; the send waits until one of the three is chosen. A Stop
   * while it is on screen answers it as Cancel.
   */
  const askCap = (prompt: CapPrompt, signal?: AbortSignal) =>
    new Promise<CapChoice>((answer) => {
      setCapPrompt({ ...prompt, answer });
      signal?.addEventListener(
        'abort',
        () => {
          setCapPrompt(null);
          answer('cancel');
        },
        { once: true },
      );
    });
  const answerCap = (choice: CapChoice) => {
    const shown = capPrompt;
    setCapPrompt(null);
    shown?.answer(choice);
  };
  const tierUp = async (where: Binding, tier: JobTier) => {
    await setThreadTier(where.projectId, where.threadId, tier);
    setWorkStyle(tier);
  };

  /**
   * A new message. Once the conversation is found and before anything is sent, the host
   * estimates the job; when it will likely pass its cap (or cannot say), nothing is sent until
   * the person chooses the tier above, going over this once for this message's own command id,
   * or Cancel. A job that stops at its cap mid-way asks the same two choices, and either one
   * sends the message again as a new job.
   */
  const send = async (text: string, presetCommandId?: string): Promise<boolean> => {
    const scope = scopeId;
    const mode = modeFor(restriction);
    const draft = { text, mode, sources: [] };
    capStop.current = null;
    const sent = await deliver(
      text,
      () => ensure(scope),
      async (found, signal, onClaim) => {
        let commandId = presetCommandId;
        if (commandId === undefined) {
          const gate = await beforeSend({
            estimate: () => estimateMessage(found.projectId, found.threadId, draft),
            ask: (prompt) => askCap(prompt, signal),
            upgrade: (tier) => tierUp(found, tier),
            goOver: (id) => goOverBeforeSend(found.projectId, found.threadId, id, draft),
            mint: mintCommandId,
          });
          if (!gate.send || signal.aborted) throw new CapDeclined();
          commandId = gate.commandId;
        }
        return sendMessage(found.projectId, found.threadId, draft, signal, onClaim, commandId);
      },
    );
    // Set inside the delivery, which TypeScript cannot see from here.
    const stop = capStop.current as DispatchIdentity | null;
    capStop.current = null;
    if (!stop) return sent;
    const again: GateResult = await afterStop({
      status: () => jobStatus(stop.projectId, stop.commandId),
      ask: (prompt) => askCap(prompt),
      upgrade: (tier) => tierUp(stop, tier),
      goOverAfter: (id) => goOverAfterStop(stop.projectId, stop.threadId, id, stop.commandId),
      mint: mintCommandId,
    }).catch((error: unknown) => {
      setNotice(words(error));
      return { send: false } as const;
    });
    if (!again.send) return sent;
    return send(text, again.commandId);
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
      (where, signal, onClaim) =>
        resendPending(where.projectId, where.threadId, command, signal, onClaim),
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
    //
    // It can wait a while for the conversation's lock. The message is given up wherever the
    // person has gone by then, but what happens on the page afterwards belongs to the visit it
    // was pressed in: a later visit is not reloaded, and its delivery is not stopped.
    const mine = turn.current;
    const scope = scopeId;
    const owns = () => turn.current === mine;
    void discardPendingMessage(found.projectId, found.threadId, command).then(
      () => {
        if (owns()) void load(scope);
      },
      (error) => {
        if (owns()) setNotice(words(error));
      },
    );
  };

  /**
   * Stop, for the delivery on screen now. It ends this window's wait, and when the delivery was
   * issued an identity it asks the server to interrupt that one command. `requested` and
   * `settled` are the transport answering, not the message's outcome: the record stays the
   * authority on what the message came to, so anything else is said as not confirmed. A Stop
   * that lands after the delivery ended finds nothing and asks for nothing.
   */
  const stopDelivery = () => {
    const active = delivery.current;
    if (!active) return;
    // Abort first while the slot still names this delivery, then release it: a second press in
    // the moment before the abort lands has nothing left to name and asks for nothing.
    endDelivery();
    delivery.current = null;
    dropLive();
    const issued = active.issued;
    // A delivery stopped while it was still finding the conversation or waiting on the lock was
    // never dispatched, so there is nothing on the server to interrupt.
    if (!issued) return;
    const mine = turn.current;
    void interruptMessage(issued.projectId, issued.threadId, issued.commandId).then(
      (ack) => {
        if (turn.current === mine && ack.state !== 'requested' && ack.state !== 'settled')
          setNotice(STOP_UNCONFIRMED);
      },
      () => {
        if (turn.current === mine) setNotice(STOP_UNCONFIRMED);
      },
    );
  };

  /**
   * The person's WorkStyle for the scoped thread, written to the thread. From the next message
   * the owner's tier map decides the route and the model it runs on; never the Mode. A refused
   * write puts the record's answer back and says why.
   */
  const pickStyle = (next: WorkStyle | null) => {
    const found = binding;
    if (!found || pending) return;
    const visit = turn.current;
    const before = workStyle;
    setWorkStyle(next);
    void api<Conversation>(
      `/projects/${encodeURIComponent(found.projectId)}/threads/${encodeURIComponent(found.threadId)}`,
      'PUT',
      { workStyle: next },
    ).then(
      (conversation) => {
        if (turn.current === visit) setWorkStyle(conversation.workStyle ?? null);
      },
      (error) => {
        if (turn.current !== visit) return;
        setWorkStyle(before);
        setNotice(words(error));
      },
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

  // What the caption names without a tier: the recorded route, or the default a first send takes.
  const effective = route ?? CONVERSATION_DEFAULT_ROUTE;

  return (
    <>
      <Diomedes
        projects={projects}
        scopeId={scopeId}
        onScope={(id) => {
          if (id === scopeId) return;
          endDelivery();
          dropLive();
          turn.current += 1;
          setPending(false);
          setScopeId(id);
        }}
        turns={turns}
        pending={pending}
        live={live ? { text: live.text, activity: live.activity?.lines ?? [] } : null}
        technical={props.detail === 'technical'}
        restriction={restriction}
        onRestriction={setRestriction}
        onSend={send}
        onStop={stopDelivery}
        route={effective}
        workStyle={binding !== null ? workStyle : undefined}
        onWorkStyle={pickStyle}
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
        artifactScope={binding?.threadId ?? null}
        onSaveArtifact={
          scopeId !== null && binding ? (record) => saveArtifact(binding.projectId, record) : undefined
        }
        brief={
          props.scheme === 'nectovia' ? (
            <HomeBrief projects={projects} onOpen={props.onOpenWork} />
          ) : undefined
        }
        art={props.scheme === 'nectovia' ? <HomeArt /> : undefined}
      />
      {capPrompt && (
        <JobCapWarning
          copy={capPrompt.copy}
          onUpgrade={() => answerCap('upgrade')}
          onGoOver={() => answerCap('over')}
          onCancel={() => answerCap('cancel')}
        />
      )}
    </>
  );
}
