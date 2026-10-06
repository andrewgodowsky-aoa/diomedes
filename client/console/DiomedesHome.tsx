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
  isMemberLimitStop,
  jobStatus,
  setThreadTier,
  settleMemberLimitStop,
  type CapChoice,
  type CapPrompt,
  type GateResult,
  type MemberLimitChoice,
  type MemberLimitPrompt,
} from '../job-cap-gate';
import { mintCommandId } from '../work-start';
import type { JobTier } from '../../shared/job-caps';
import type { MessageResult } from '../../shared/conversation';
import {
  CONVERSATION_DEFAULT_ROUTE,
  isConversationRoute,
  isExternalEngine,
  isRoute,
} from '../../shared/engines';
import { NECTOVIA_ROUTE, type NectoviaRouteView } from '../../shared/model-api';
import { SIGN_IN_REQUIRED_EVENT, useAccount } from '../AccountGate';
import { AccountPlanNotice } from './FreePlanNotice';
import { conversationSources, readThreadRoute } from './thread-send';
import { LocalImageAttachments, LocalModelControls, PrepareLocalModels } from './LocalModelControls';
import type {
  Conversation,
  Project,
  ProjectState,
  Route,
  Turn,
  WaitingItem,
} from '../../shared/types';
import type { WorkStyle } from '../../shared/work-style';
import { Diomedes } from './Diomedes';
import { MemberLimitStop } from './MemberLimitStop';
import {
  historyLine,
  historySentence,
  nextRoute,
  sharesHistoryWith,
  type HomeSharing,
} from './home-history';
import { HomeHistorySharing } from './HomeHistorySharing';
import { JobCapWarning } from './JobCapWarning';
import { ThreadMenu } from './ThreadMenu';
import { NativeSessionControls } from './NativeSessionControls';
import { ThreadManagedRoutingDetails } from './ManagedRoutingReceipt';
import { readRecordedArtifacts } from './artifact-evidence';
import { stepLiveReply, type LiveBinding, type LiveEvent, type LiveReply } from './live-reply';
import { saveArtifact } from './artifact-save';
import { HomeArt } from './HomeArt';
import { HomeBrief } from './HomeBrief';
import { WorkerRows } from './WorkerRows';
import { PinnedChartView } from './InlineVisual';
import { newestChart, pinnedWhen } from './pinned-chart';
import { toolRunning } from './engine-activity';
import { railGroups, railProject, suggestions as proposalsOf, type RailTarget, type Suggestion } from './home-rail';
import { Suggestions } from './Suggestions';
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
  /** Open one thing waiting on the person where it is decided (the brief's named items). */
  onOpenWaiting?(projectId: string, item: WaitingItem): void;
  /** The person's detail level. Technical also shows each tool call's tool and detail. */
  detail?: 'guided' | 'standard' | 'technical';
  /**
   * The appearance scheme the page is painted in. The Nectovia scheme opens the
   * conversation with its progress report and draws the bust beside it; every
   * other scheme draws the page as it always has.
   */
  scheme?: string;
  /** Settings' services: the owner's tier map, the owner-testing pin and the default tier. */
  services?: Record<string, unknown>;
  /**
   * Given the opener of the All projects conversation's Cloud sharing while that conversation is
   * showing and exists, and null otherwise, so the strip never shows a control that opens nothing.
   */
  onSharingControl?(open: (() => void) | null): void;
}

const words = (error: unknown) =>
  error instanceof Error ? error.message : 'Nectovia could not complete that.';

/** A send the host refused because nobody is signed in: signing in answers it. */
const refusedForSignIn = (error: unknown) =>
  error instanceof ApiError && error.status === 401 && error.data?.code === 'sign_in_required';

/**
 * A send the host refused under Cloud sharing. From All projects, whose typed messages carry no
 * document and need no grant, that is its earlier messages.
 */
const refusedForHistory = (error: unknown) =>
  error instanceof ApiError && error.status === 403 && error.data?.code === 'cloud_sharing_denied';

/** What an interrupt acknowledgement that cannot confirm a stop is told as. */
const STOP_UNCONFIRMED =
  'Stop was not confirmed. Sending the message again checks what happened.';

/** Where "Not now" on a suggestion is kept: this computer only, since a task has no dismissed state. */
const HIDDEN_SUGGESTIONS = 'diomedes.suggestions.hidden';
function readHidden(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(HIDDEN_SUGGESTIONS) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeHidden(ids: ReadonlySet<string>) {
  try {
    localStorage.setItem(HIDDEN_SUGGESTIONS, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Storage is unavailable; the card stays hidden for this visit.
  }
}

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
  // A model the thread pins, which keeps it on its recorded route; null when none is pinned.
  const [pinnedModel, setPinnedModel] = useState<string | null>(null);
  const [modelThread, setModelThread] = useState<Conversation | null>(null);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  // The local model's route, as the host names it once the local controls have asked.
  const [localRoute, setLocalRoute] = useState<string | null>(null);
  // All projects' Cloud sharing record, read once that conversation exists; null until then.
  // `sharingReads` asks for it again, after a refusal that another window's change may explain.
  const [sharing, setSharing] = useState<HomeSharing | null>(null);
  const [sharingReads, setSharingReads] = useState(0);
  const [sharingOpen, setSharingOpen] = useState(false);
  // The notice on screen when it is a refusal for want of history, so it carries the line's button.
  const [refusal, setRefusal] = useState<string | null>(null);
  // The notice on screen when signing in answers it, so it carries a Sign in button.
  const [signInRefusal, setSignInRefusal] = useState<string | null>(null);
  // The Nectovia route as the host sees it: the published model the caption names.
  const [nectovia, setNectovia] = useState<NectoviaRouteView | null>(null);
  // The route the host says a thread's next request runs on, kept with the thread it was read for:
  // an answer about a thread no longer on screen is never used.
  const [hostRoute, setHostRoute] = useState<{ key: string; route: string } | null>(null);
  const planAgent = useAccount()?.state.plan?.agent ?? null;
  // The records the rail reads: the scoped project's, or the one project's under All projects.
  // Read on their own request (`?view=rail`), so the conversation's own reads stay exactly
  // what they were, and read again after each delivery and whenever the project's status moves.
  const railId = railProject(projects, scopeId);
  const railStatus = JSON.stringify(projects.find((p) => p.id === railId)?.status ?? null);
  const [railState, setRailState] = useState<ProjectState | null>(null);
  const [railReads, setRailReads] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(readHidden);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // On the free version a thread on Nectovia by default runs on the person's own AI tool, and the
  // stored thread still says Nectovia (server/app.ts `routed`). Once a thread exists the host's
  // answer names that tool. Before the first send there's no thread to ask about, so the free
  // version's own tool is named the way the host will choose it: AI setup's default engine, when
  // it's an AI tool that can hold a conversation. Null keeps the recorded route.
  const ownTool = props.services?.defaultEngine;
  const answering: string | null =
    (route ?? CONVERSATION_DEFAULT_ROUTE) !== NECTOVIA_ROUTE
      ? null
      : binding
        ? hostRoute?.key === `${binding.projectId}|${binding.threadId}`
          ? hostRoute.route
          : null
        : planAgent === 'free' && isExternalEngine(ownTool) && isConversationRoute(ownTool)
          ? ownTool
          : null;
  const substitute = answering !== NECTOVIA_ROUTE && isRoute(answering) ? answering : null;
  // The route the next message takes, by the host's rules, and the one the line and the refusal
  // name. A refusal reads it after the provisioner may have moved the thread, so it is a ref too.
  const next =
    substitute ??
    nextRoute({
      engine: route,
      workStyle,
      requestedModel: pinnedModel,
      services: props.services,
    });
  const nextRef = useRef(next);
  nextRef.current = next;
  /** The job-cap decision on screen, and how to answer the send waiting on it. */
  const [capPrompt, setCapPrompt] = useState<(CapPrompt & { answer(choice: CapChoice): void }) | null>(null);
  /** The command a job-cap stop refused, told from inside the delivery to the send that awaits it. */
  const capStop = useRef<DispatchIdentity | null>(null);
  /** The member-limit question on screen, and how to answer the send waiting on it. */
  const [limitPrompt, setLimitPrompt] = useState<(MemberLimitPrompt & { answer(choice: MemberLimitChoice): void }) | null>(null);
  /** The message a member's own monthly limit stopped, with the account service's words, told from inside the delivery. */
  const limitStop = useRef<{ identity: DispatchIdentity; message: string } | null>(null);
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
    if (!railId) {
      setRailState(null);
      return;
    }
    if (pending) return;
    let current = true;
    void api<ProjectState>(`/projects/${encodeURIComponent(railId)}/state?view=rail`).then(
      (state) => {
        if (current) setRailState(state);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [railId, railStatus, railReads, pending]);
  // The caption names the model the account service publishes; a failed read names the route alone.
  useEffect(() => {
    let current = true;
    void api<NectoviaRouteView>('/ai/nectovia')
      .then((view) => {
        if (current) setNectovia(view);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  // The bound thread's route as the host resolves it, asked again whenever something that could
  // move it changes, a plan arriving or lapsing included. A failed read keeps the recorded route.
  const boundProject = binding?.projectId ?? null;
  const boundThread = binding?.threadId ?? null;
  useEffect(() => {
    if (!boundProject || !boundThread) return;
    const request = new AbortController();
    const key = `${boundProject}|${boundThread}`;
    void readThreadRoute(boundProject, boundThread, request.signal).then(
      (view) => {
        if (!request.signal.aborted) setHostRoute({ key, route: view.route });
      },
      () => undefined,
    );
    return () => request.abort();
  }, [boundProject, boundThread, route, workStyle, pinnedModel, planAgent]);
  useEffect(() => {
    const es = new EventSource('/api/events');
    // The binding is read when the frame arrives: a frame that lands after the page has moved
    // on finds none and is dropped with whatever was showing.
    const step = (event: LiveEvent) => {
      const bound = liveBinding.current;
      if (!bound) return;
      setLive((prev) => stepLiveReply(prev, bound, event));
    };
    const frame = (type: 'engine-text' | 'engine-activity' | 'engine-reasoning') => (ev: Event) => {
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
    const onReasoning = frame('engine-reasoning');
    // A reconnect replays nothing, so a missed text frame loses the preview; the recorded
    // answer still replaces it.
    const onLost = () => step({ type: 'lost' });
    es.addEventListener('engine-text', onText);
    es.addEventListener('engine-activity', onActivity);
    es.addEventListener('engine-reasoning', onReasoning);
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
      setPinnedModel(conversation?.requested?.model ?? null);
      setModelThread(conversation);
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
      setPinnedModel(null);
      setModelThread(null);
      setImagePaths([]);
      setSharingOpen(false);
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
        setPinnedModel(conversation.requested?.model ?? null);
        setModelThread(conversation);
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

  // The Home project, while All projects is showing and its conversation exists. Project scopes
  // keep their own Cloud sharing, in their own Console.
  const homeProject = scopeId === null ? (binding?.projectId ?? null) : null;
  useEffect(() => {
    if (!homeProject) {
      setSharing(null);
      return;
    }
    let live = true;
    // Unread, the page says nothing about history; the dialog reads the record itself.
    api<HomeSharing>(`/projects/${encodeURIComponent(homeProject)}/cloud-sharing`).then(
      (policy) => {
        if (live) setSharing(policy);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [homeProject, sharingReads]);
  // The strip's Cloud sharing opens this conversation's dialog, and exists only while it can.
  const sharingControl = useRef(props.onSharingControl);
  sharingControl.current = props.onSharingControl;
  const sharable = homeProject !== null;
  useEffect(() => {
    if (!sharable) return;
    sharingControl.current?.(() => setSharingOpen(true));
    return () => sharingControl.current?.(null);
  }, [sharable]);

  /**
   * The scope's conversation, made for a send or an explicit local-model choice. Both scopes ask
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
      if (owns() && !current.cancelled && provisioned) {
        setRoute(provisioned.engine ?? null);
        setPinnedModel(provisioned.requested?.model ?? null);
        setModelThread(provisioned);
      }
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
      // A member's own limit stopped the message: the dialog that follows says why and offers the ask,
      // so the stop is not also said as a notice.
      const limited = isMemberLimitStop(error) && current.issued;
      if (limited) limitStop.current = { identity: current.issued!, message: words(error) };
      // Claude Code is the one route whose All projects follow-up is refused without history; a
      // model route answers it alone. Its refusal is said once: the line's own sentence, with its
      // button. The record is read again, in case another window's change is what refused it.
      if (scopeId === null && refusedForHistory(error) && nextRef.current === 'claude-code') {
        const sentence = historySentence(nextRef.current);
        setRefusal(sentence);
        setNotice(sentence);
        setSharingReads((n) => n + 1);
      } else if (!limited) {
        setNotice(words(error));
        if (refusedForSignIn(error)) setSignInRefusal(words(error));
      }
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
  /** Ask the member what to do about their limit; the send waits for the answer. */
  const askLimit = (prompt: MemberLimitPrompt) =>
    new Promise<MemberLimitChoice>((answer) => setLimitPrompt({ ...prompt, answer }));
  const answerLimit = (choice: MemberLimitChoice) => {
    const shown = limitPrompt;
    setLimitPrompt(null);
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
    const draft = { text, mode, sources: [] as { path: string; sha: string }[] };
    capStop.current = null;
    limitStop.current = null;
    const sent = await deliver(
      text,
      () => ensure(scope),
      async (found, signal, onClaim) => {
        draft.sources = await conversationSources(found.projectId, imagePaths, signal);
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
    const limit = limitStop.current as { identity: DispatchIdentity; message: string } | null;
    limitStop.current = null;
    if (limit) {
      // The person's own monthly limit stopped it. They may ask an owner or admin for this job or for the
      // month; the message is not sent again here, and the words they typed are theirs to keep.
      setNotice(
        await settleMemberLimitStop(
          { projectId: limit.identity.projectId, commandId: limit.identity.commandId, message: limit.message },
          { ask: askLimit },
        ),
      );
      return sent;
    }
    if (!stop) { if (sent) setImagePaths([]); return sent; }
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
        // A forced stop (`ack.stop === 'killed'`) is said by the session line, from the record.
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

  // What the caption names without a tier: the recorded route, or the default a first send takes,
  // unless the free version answers on the person's own AI tool instead.
  const effective = substitute ?? route ?? CONVERSATION_DEFAULT_ROUTE;

  /**
   * Reads the transcript again once "Update this conversation" has added its note. The outcome
   * card belonged to the answer that ended the transcript, which the note now follows.
   */
  const updated = async (found: Binding) => {
    const visit = turn.current;
    try {
      const conversation = await thread(found);
      if (turn.current !== visit || !conversation) return;
      setTurns(conversation.turns);
      setLast(null);
    } catch (error) {
      if (turn.current === visit) setNotice(words(error));
    }
  };

  /** H03: a queued message was answered; its turns are read again. Nothing else on screen moves. */
  const reread = async (found: Binding) => {
    const visit = turn.current;
    try {
      const conversation = await thread(found);
      if (turn.current === visit && conversation) setTurns(conversation.turns);
    } catch (error) {
      if (turn.current === visit) setNotice(words(error));
    }
  };

  // A refusal for want of history already says the line's sentence, with its button, so the line
  // steps aside while it is up.
  const refusalShown = notice !== null && notice === refusal;
  const signInShown = notice !== null && notice === signInRefusal;
  const line =
    homeProject !== null && !refusalShown
      ? historyLine({ policy: sharing, route: next, turns })
      : null;
  const openSharing = homeProject !== null ? () => setSharingOpen(true) : undefined;
  const sharingSaved = (policy: HomeSharing) => {
    setSharing(policy);
    setSharingOpen(false);
    // The refusal is answered once its route receives earlier messages.
    if (refusalShown && sharesHistoryWith(policy, nextRef.current)) setNotice(null);
  };

  // The rail's groups for the scope, and where each row opens: a job's thread or its card.
  const groups = railGroups({ projects, scopeId, state: railState, now: Date.now() });
  const targets = new Map<string, RailTarget>();
  for (const group of groups) for (const row of group.rows) targets.set(row.id, row.target);
  const openRow = (id: string) => {
    const target = targets.get(id);
    if (!target) return;
    if ((target.taskId || target.needId) && props.onOpenWaiting) {
      props.onOpenWaiting(target.projectId, {
        id,
        kind: 'review',
        label: '',
        detail: '',
        ...(target.taskId ? { taskId: target.taskId } : {}),
        ...(target.needId ? { needId: target.needId } : {}),
        at: '',
      });
      return;
    }
    onOpenWork(target.projectId);
  };

  // "Nectovia suggests": only real proposals, from the records the rail read.
  const proposals = proposalsOf(railState, hidden);
  const accept = async (item: Suggestion) => {
    setAccepting(item.taskId);
    setAcceptError(null);
    try {
      await api(
        `/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}/accept`,
        'POST',
        { expectedRevision: item.revision },
      );
    } catch (error) {
      setAcceptError(words(error));
    } finally {
      setAccepting(null);
      setRailReads((n) => n + 1);
    }
  };
  const notNow = (item: Suggestion) => {
    const next = new Set(hidden);
    next.add(item.taskId);
    setHidden(next);
    writeHidden(next);
  };

  // The standing conversation's newest bar, line or area chart, pinned over the ask box. Its
  // baseline sweeps while a step of the answer on its way is running.
  const pinned = newestChart(turns);

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
        live={live ? { text: live.text, activity: live.activity?.lines ?? [], thinking: live.thinking } : null}
        technical={props.detail === 'technical'}
        restriction={restriction}
        onRestriction={setRestriction}
        onSend={send}
        onStop={stopDelivery}
        route={effective}
        routeModel={effective === NECTOVIA_ROUTE ? (nectovia?.tiers?.efficient?.label ?? null) : null}
        workStyle={binding !== null && effective !== localRoute ? workStyle : undefined}
        onWorkStyle={pickStyle}
        modelControls={binding && modelThread ? <><LocalModelControls projectId={binding.projectId}
          thread={modelThread} route={effective} mode={modeFor(restriction)} busy={pending} live={pending}
          onRoute={setLocalRoute}
          onChanged={conversation => {
            setModelThread(conversation); setRoute(conversation.engine ?? null);
            setPinnedModel(conversation.requested?.model ?? null); setWorkStyle(conversation.workStyle ?? null);
          }} /><LocalImageAttachments projectId={binding.projectId} route={effective} model={pinnedModel}
            paths={imagePaths} onPaths={setImagePaths} busy={pending} /></> : <PrepareLocalModels onRoute={setLocalRoute} onPrepare={async () => {
              const visit = turn.current;
              await ensure(scopeId);
              if (turn.current === visit) await load(scopeId);
            }} />}
        unavailable={unavailable}
        card={card}
        cardBusy={cardBusy}
        onCardAction={() => void act()}
        unconfirmed={kept?.text ?? null}
        onResend={resend}
        onDiscard={discard}
        notice={notice}
        noticeSharesHistory={refusalShown}
        onNoticeSignIn={signInShown ? () => window.dispatchEvent(new Event(SIGN_IN_REQUIRED_EVENT)) : null}
        history={line}
        onShareHistory={openSharing}
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
        plan={<AccountPlanNotice />}
        brief={
          props.scheme === 'nectovia' ? (
            <HomeBrief
              projects={projects}
              onOpen={props.onOpenWork}
              onOpenWaiting={props.onOpenWaiting}
            />
          ) : undefined
        }
        art={props.scheme === 'nectovia' ? <HomeArt /> : undefined}
        workers={scopeId !== null ? <WorkerRows projectId={scopeId} compact /> : undefined}
        sections={groups}
        onOpenRow={openRow}
        chart={
          pinned ? (
            <PinnedChartView
              chart={pinned}
              running={pending && toolRunning(live?.activity?.lines)}
              caption={pinnedWhen(pinned.at, new Date())}
            />
          ) : null
        }
        suggestions={
          <Suggestions
            items={proposals}
            busyId={accepting}
            error={acceptError}
            onAccept={(item) => void accept(item)}
            onNotNow={notNow}
          />
        }
        session={
          binding ? (
            <>
              <NativeSessionControls
                projectId={binding.projectId}
                threadId={binding.threadId}
                mode={modeFor(restriction)}
                answering={pending}
                onAnswered={() => void reread(binding)}
              />
              {turns.length > 0 && (
                <ThreadManagedRoutingDetails
                  key={`${binding.projectId}/${binding.threadId}`}
                  projectId={binding.projectId}
                  threadId={binding.threadId}
                  refreshKey={`${turns.length}:${pending}`}
                />
              )}
            </>
          ) : undefined
        }
        menu={
          binding ? (
            <ThreadMenu
              projectId={binding.projectId}
              threadId={binding.threadId}
              revision={turns.length}
              onUpdated={() => void updated(binding)}
            />
          ) : undefined
        }
        recorded={
          binding
            ? {
                key: `${binding.projectId}|${binding.threadId}|${turns.length}`,
                read: async (signal) => {
                  const conversation = await listedThread(binding);
                  const runIds = (conversation?.lineages ?? []).map((lineage) => lineage.runId);
                  return readRecordedArtifacts(binding.projectId, runIds, signal);
                },
              }
            : null
        }
      />
      {capPrompt && (
        <JobCapWarning
          copy={capPrompt.copy}
          onUpgrade={() => answerCap('upgrade')}
          onGoOver={() => answerCap('over')}
          onCancel={() => answerCap('cancel')}
        />
      )}
      {limitPrompt && (
        <MemberLimitStop
          prompt={limitPrompt}
          onAskJob={() => answerLimit('job')}
          onAskMonth={() => answerLimit('month')}
          onCancel={() => answerLimit('cancel')}
        />
      )}
      {sharingOpen && homeProject !== null && (
        <HomeHistorySharing
          projectId={homeProject}
          route={next}
          onClose={() => setSharingOpen(false)}
          onSaved={sharingSaved}
        />
      )}
    </>
  );
}
