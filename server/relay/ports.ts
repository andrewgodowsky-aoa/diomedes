/**
 * The relay's view of this desktop (relay plan steps 3 and 4): PhoneRelayPorts built from the app's
 * own services. Each acting port takes the path the desktop's own route takes, under the same Store
 * lock where that route holds it, so a phone's command is checked exactly as the same click would
 * be. Nothing here calls the loopback API or opens a file.
 */
import { applicationOrigin } from '../../shared/attribution.js';
import type { MessageResult } from '../../shared/conversation.js';
import type { HandoffEvent } from '../../shared/team-delegation.js';
import type { MessageCommand, RequestContext } from '../interaction-service.js';
import type { ConversationMode } from '../interaction-turn.js';
import { ApiError } from '../paths.js';
import type { Store } from '../store.js';
import { RelayRefusal, type PhoneRelayPorts } from './messages.js';
import { storeWorkRows } from './work-rows.js';

/** The app's own services, as the relay reaches them. */
export interface DesktopPaths {
  store: Store;
  /** The person signed in on this computer now, or null. */
  personId(): string | null;
  /** Whether the business's current plan includes a feature, as the account session answered it. */
  includes(organizationId: string, feature: string): boolean;
  /** The business a project's work belongs to, as the Agent gate resolves it. */
  organizationFor(projectId: string | null): string | null;
  /** The Need answer route's own body. Called under the Store lock, as the route is. */
  resolveNeed(projectId: string, needId: string, body: Record<string, unknown>): Promise<unknown>;
  /** Work control's Stop. Called under the Store lock, as the Stop routes are. */
  stop(projectId: string, request: { scope: 'task'; taskId: string; sessionId: string | null }): Promise<unknown>;
  /** The project's runs in the RunService, read-only. */
  harnessRuns(projectId: string): Promise<readonly { id: string; state: string; taskId: string | null; sessionId: string | null }[]>;
  /** The H14 handoff ledger, read-only. */
  handoffs?(projectId: string): Promise<readonly HandoffEvent[]>;
  /** The conversation's message path (InteractionTurns.message). */
  message(projectId: string, threadId: string, command: MessageCommand, context: RequestContext): Promise<MessageResult>;
  /** The Team mailbox's owner message path, which takes the Store lock as the route does. */
  teamMessage(projectId: string, slotId: string, text: string): Promise<unknown>;
  /** The Team wake path, which takes the Store lock as the route does. */
  teamWake(projectId: string, slotId: string): Promise<unknown>;
  /** Whether the job-cap estimate the Console reads before a send would warn. */
  messageWarns(projectId: string, threadId: string, text: string, mode: ConversationMode): Promise<boolean>;
  /** Whether the job-cap estimate the Console reads before a wake would warn. */
  wakeWarns(projectId: string, slotId: string): Promise<boolean>;
  /** The app-update guard every desktop change passes. */
  updates: {
    closing(): boolean;
    /** Counts one change in flight; answers its release. */
    hold(): () => void;
  };
}

/** The sentence a decision from the phone leaves in History. */
const decidedSentence = (decision: 'go-ahead' | 'declined') => (decision === 'go-ahead' ? 'You went ahead from your phone' : 'You declined from your phone');

export function desktopRelayPorts(paths: DesktopPaths): PhoneRelayPorts {
  const { store } = paths;
  const onChange = (listener: (projectId: string) => void) => {
    store.on('change', listener);
    return () => {
      store.off('change', listener);
    };
  };
  return {
    personId: () => paths.personId(),
    includes: (organizationId, feature) => paths.includes(organizationId, feature),
    organizationFor: (projectId) => paths.organizationFor(projectId),
    projectIds: () => store.projectIds(),
    homeProjectId: () => store.projectIds().find((projectId) => store.isHomeProject(projectId)) ?? null,
    state: (projectId) => store.state(projectId),
    workRows: storeWorkRows({
      state: (projectId) => store.state(projectId),
      projectIds: () => store.projectIds(),
      onChange,
      runs: (projectId) => paths.harnessRuns(projectId),
      ...(paths.handoffs ? { handoffs: (projectId: string) => paths.handoffs!(projectId) } : {}),
    }),
    onChange,
    onTurnStarted: (listener) => {
      const heard = (data: unknown) => {
        const event = data as { projectId?: unknown; threadId?: unknown; requestId?: unknown; kind?: unknown } | null;
        if (event?.kind === 'started' && typeof event.projectId === 'string' && typeof event.threadId === 'string' && typeof event.requestId === 'string')
          listener({ projectId: event.projectId, threadId: event.threadId, requestId: event.requestId });
      };
      store.on('engine-text', heard);
      return () => {
        store.off('engine-text', heard);
      };
    },
    mutation: async (action) => {
      if (paths.updates.closing()) throw new RelayRefusal('updating');
      const release = paths.updates.hold();
      try {
        return await action();
      } finally {
        release();
      }
    },
    decide: ({ projectId, needId, decision, commandId, personId }) =>
      store.locked(async () => {
        const need = store.state(projectId).needs.find((item) => item.id === needId);
        if (!need) throw new ApiError(404, 'This request was not found.');
        if (need.state !== 'open') return 'already-answered' as const;
        // The body the Console sends for this kind of Need, under the phone's own command id, and
        // never `allowForTask`: a task allowance changes Trust, which a phone never does.
        const command = `phone.${commandId}`;
        const body: Record<string, unknown> =
          need.engineAsk || need.changeSet || need.supervision
            ? { resolution: decision, commandId: command }
            : need.approval
              ? {
                  protocolVersion: 1, commandId: command, resolution: decision,
                  proposalDigest: need.approval.proposalDigest, actionDigest: need.approval.actionDigest, baseDigest: need.approval.baseDigest,
                }
              : { resolution: decision };
        await paths.resolveNeed(projectId, needId, body);
        const state = store.state(projectId);
        const decided = state.needs.find((item) => item.id === needId);
        if (decided && decided.state !== 'open') {
          decided.decidedFrom = 'phone';
          store.addEntry(state, {
            kind: 'phone-decision',
            sentence: decidedSentence(decision),
            sessionId: decided.sessionId,
            taskId: decided.taskId,
            approvalId: decided.id,
            origin: { ...applicationOrigin(), executorId: 'diomedes:phone-relay', producerId: `person:${personId}` },
          });
          await store.persist(state);
        }
        return 'decided' as const;
      }),
    stop: (projectId, target) =>
      store.locked(async () => {
        if (target.kind === 'task') {
          await paths.stop(projectId, { scope: 'task', taskId: target.taskId, sessionId: null });
          return;
        }
        // A run is a work session, or a RunService run that names one.
        const sessions = store.state(projectId).sessions;
        let session = sessions.find((item) => item.id === target.runId);
        if (!session) {
          const run = (await paths.harnessRuns(projectId)).find((item) => item.id === target.runId);
          session = run?.sessionId ? sessions.find((item) => item.id === run.sessionId) : undefined;
        }
        if (!session) throw new ApiError(404, 'This run was not found.', { code: 'run_not_found' });
        await paths.stop(projectId, { scope: 'task', taskId: session.taskId, sessionId: session.id });
      }),
    thread: async (conversation) => {
      // The provisioners take the Store lock themselves, exactly as their routes call them.
      const bound =
        conversation.kind === 'home'
          ? ((await store.locked(async () => store.homeBinding())) ?? (await store.provisionHome()))
          : await store.provisionProjectConversation(conversation.projectId);
      const thread = store.state(bound.projectId).conversations.find((item) => item.id === bound.threadId);
      if (!thread) throw new ApiError(404, 'This thread was not found.', { code: 'conversation_not_found' });
      // The thread's own Mode control, as the Console sends it; Build and Fix have no conversation message.
      const mode: ConversationMode = thread.mode === 'ask' || thread.mode === 'plan' ? thread.mode : 'auto';
      return { projectId: bound.projectId, threadId: bound.threadId, mode };
    },
    messageWarns: (projectId, threadId, text, mode) => paths.messageWarns(projectId, threadId, text, mode),
    message: async (input, done) => {
      const result = await paths.message(
        input.projectId,
        input.threadId,
        { commandId: input.commandId, text: input.text, mode: input.mode, sources: [] },
        { whenDone: (end) => void done.then(end) },
      );
      return { answerText: result.answerText, interrupted: result.interrupted };
    },
    memberMessage: async (projectId, slotId, text) => {
      await paths.teamMessage(projectId, slotId, text);
    },
    wakeWarns: (projectId, slotId) => paths.wakeWarns(projectId, slotId),
    wake: async (projectId, slotId) => {
      await paths.teamWake(projectId, slotId);
    },
  };
}
