/**
 * The Console's start of a Diomedes loop run: H13's versioned start command
 * (`POST /api/projects/:id/loop/start`), built from the dialog's fields. The
 * server admits or refuses it; nothing here decides which route may run.
 */
import type { AgentTeamSelection } from '../../shared/agent-collaboration';
import { AGENT_NAME } from '../../shared/agent-name';
import type { AgentReviewSelection } from '../../shared/agent-review';
import { nectoviaRoleLine, type EscalationOffer, type RoleTier } from '../../shared/escalation-roles';
import { NECTOVIA_ROUTE } from '../../shared/model-api';
import type { SubscriptionWorkerStartView } from '../../shared/subscription-workers';

/** The fixed review is selected by saved connection, never by editable questions. */
export const LOOP_REVIEW_PROFILE: AgentReviewSelection['profileId'] = 'agent.inventory-reconciliation';

export interface LoopHelperSelection {
  scope: string[];
  worker: { profileId: string };
  advisor: null;
}

/** The Nectovia roles a start names beside a lead that is not Nectovia (DIO-216), each by its tier. */
export interface LoopNectoviaRoles {
  worker: RoleTier;
  advisor: RoleTier | null;
}

/** The team a start sends for its Nectovia roles: a tier for each role, never a model. */
export interface LoopTierTeam {
  scope: string[] | null;
  worker: { route: typeof NECTOVIA_ROUTE; tier: RoleTier };
  advisor: { route: typeof NECTOVIA_ROUTE; tier: RoleTier } | null;
}

/** What `GET /api/projects/:id/loop/escalation` answers: each tier as a role, read now. */
export interface LoopEscalationOffers {
  offers: EscalationOffer[];
  credits: string;
}

/** The reasons the tiers a start can't name as roles give, each said once. */
export function escalationOfferReasons(view: LoopEscalationOffers | null): string[] {
  return [...new Set((view?.offers ?? []).filter((offer) => !offer.admitted && offer.reason).map((offer) => offer.reason!))];
}

/** What the consent box says when a start names Nectovia roles: where each role's work goes, and its cost. */
export function nectoviaRolesConsentText(leadLabel: string, roles: LoopNectoviaRoles): string {
  const lines = [nectoviaRoleLine('worker', roles.worker), ...(roles.advisor ? [nectoviaRoleLine('advisor', roles.advisor)] : [])];
  return `Send the goal and the files it reads to ${leadLabel}. ${lines.join(' ')} ${roles.advisor ? 'They use' : 'It uses'} your account’s credits.`;
}

interface CollaborationOffer {
  name: string;
  model: string | null;
  /** How the host names the model for a person, where that differs from its id (a local profile). */
  modelName?: string;
  admitted: boolean;
  reason: string | null;
}

/** "Name · model", with the model as the host names it for a person. */
export function collaborationOfferLabel(offer: CollaborationOffer): string {
  const model = offer.modelName ?? offer.model;
  return model ? `${offer.name} · ${model}` : offer.name;
}

export interface LoopCollaborationOptions {
  leads: (CollaborationOffer & { slotId: string; route: string })[];
  members: (CollaborationOffer & { slotId: string; route: string })[];
  helpers: (CollaborationOffer & { profileId: string; route: string })[];
  reviews: (CollaborationOffer & { profileId: string; connectionId: string })[];
  reason?: string | null;
}

/** The coding tools a person confirmed a task may go to, under the consent revision they read (S3). */
export interface LoopWorkerConsent {
  revision: string;
  engines: string[];
}

export interface LoopStartCommand {
  protocolVersion: 1;
  commandId: string;
  taskId: string;
  goal: string;
  route: string;
  sources: string[];
  consent?: true;
  workerConsent?: LoopWorkerConsent;
  maxTurns?: number;
  composition?: true;
  persistentTeam?: AgentTeamSelection;
  team?: LoopHelperSelection | LoopTierTeam;
  review?: AgentReviewSelection;
}

/** The goal a loop starts with unless the person changes it: the task's statement, else its name. */
export function defaultLoopGoal(task: { name: string; description?: string | null }): string {
  return task.description?.trim() || task.name.trim();
}

/**
 * One start, as one command. The command id is made once per dialog, so a
 * second click, or a resend after a lost answer, names the same run and
 * admits nothing new. Turns are left out unless the person set them, so H13's
 * own default applies. The tools a person confirmed go with it only when given.
 */
export function loopStartCommand(input: {
  commandId: string;
  taskId: string;
  goal: string;
  route: string;
  sources: readonly string[];
  consent: boolean;
  workerConsent?: { revision: string; engines: readonly string[] } | null;
  maxTurns: number | null;
  persistentTeam?: AgentTeamSelection | null;
  team?: LoopHelperSelection | null;
  review?: AgentReviewSelection | null;
  /** Nectovia roles beside a lead that is not Nectovia. Never with a composition. */
  nectovia?: LoopNectoviaRoles | null;
}): LoopStartCommand {
  if (input.review && input.review.profileId !== LOOP_REVIEW_PROFILE)
    throw new Error('Only the inventory reconciliation review is available here.');
  if (input.nectovia && (input.persistentTeam || input.team || input.review))
    throw new Error('Choose either Nectovia roles or a Team.');
  return {
    protocolVersion: 1,
    commandId: input.commandId,
    taskId: input.taskId,
    goal: input.goal.trim(),
    route: input.route,
    sources: [...input.sources],
    ...(input.consent ? { consent: true as const } : {}),
    ...(input.workerConsent
      ? { workerConsent: { revision: input.workerConsent.revision, engines: [...input.workerConsent.engines] } }
      : {}),
    ...(input.maxTurns !== null ? { maxTurns: input.maxTurns } : {}),
    ...(input.persistentTeam || input.team || input.review ? { composition: true as const } : {}),
    ...(input.persistentTeam ? {
      persistentTeam: {
        leadSlotId: input.persistentTeam.leadSlotId,
        memberSlotId: input.persistentTeam.memberSlotId,
      },
    } : {}),
    ...(input.team ? {
      team: {
        scope: [...input.team.scope],
        worker: { profileId: input.team.worker.profileId },
        advisor: null,
      },
    } : {}),
    ...(input.review ? {
      review: { profileId: LOOP_REVIEW_PROFILE, connectionId: input.review.connectionId },
    } : {}),
    // Nectovia roles are an H14 team, not a composition: each names its tier, never a model.
    ...(input.nectovia ? {
      team: {
        scope: input.sources.length ? [...input.sources] : null,
        worker: { route: NECTOVIA_ROUTE, tier: input.nectovia.worker },
        advisor: input.nectovia.advisor ? { route: NECTOVIA_ROUTE, tier: input.nectovia.advisor } : null,
      },
    } : {}),
  };
}

export const LOOP_START_CHANGED_CHOICES =
  'The previous start may have been received. Retry with the same choices, or reopen this dialog to change them.';

/** A lost answer can only resend the exact command; edited choices need a new dialog. */
export function retainLoopStartCommand(
  submitted: LoopStartCommand | null,
  next: LoopStartCommand,
): LoopStartCommand {
  if (!submitted) return next;
  if (JSON.stringify(submitted) !== JSON.stringify(next))
    throw new Error(LOOP_START_CHANGED_CHOICES);
  return submitted;
}

/**
 * A start the server refused until the person confirms the coding tools a task may go to (S3):
 * its sentence, and the tools and consent revision to echo on the next submit.
 */
export interface LoopToolConsent {
  text: string;
  workerConsent: LoopWorkerConsent;
}

/**
 * The command the dialog keeps after a start fails. The start route looks for a run under the
 * command id before anything else, so a refusal asking to confirm the tools means no run exists
 * under it: the dialog lets the command go, and the new confirmation goes out under the same id.
 * Any other failure may have been received, so a resend must repeat the exact command.
 */
export function retainAfterFailure(
  submitted: LoopStartCommand | null,
  refusal: LoopToolConsent | null,
): LoopStartCommand | null {
  return refusal ? null : submitted;
}

/** Tools by name for one sentence, joined as the start route joins them: "A", "A or B", "A, B or C". */
export function loopToolNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** What a Nectovia start's consent says when a task it hands off may go to the person's own tools. */
export function loopToolConsentText(names: readonly string[]): string {
  return `Your goal and the files the loop reads will be sent to ${AGENT_NAME}, and a task it hands off goes to ${loopToolNames(names)} with the files it needs, signed in with your own account.`;
}

/**
 * What the consent box on a Nectovia start confirms, when a task may go to the person's own tools:
 * the server's own sentence once it asked again, else the sentence made from the project's
 * choice. Null: no tool would be asked, and the start asks for consent as it always has.
 */
export function loopToolConsent(
  view: SubscriptionWorkerStartView | null,
  refusal: LoopToolConsent | null,
): LoopToolConsent | null {
  if (refusal) return refusal;
  if (view?.kind !== 'candidates' || view.engines.length === 0 || view.names.length !== view.engines.length) return null;
  return {
    text: loopToolConsentText(view.names),
    workerConsent: { revision: view.consentRevision, engines: [...view.engines] },
  };
}

/**
 * The refusal a start answers when it would hand a task to the person's tools and the consent
 * didn't name exactly those tools (409 with `consentRequired` and the `workerConsent` to echo),
 * read from the answer's body. Anything else, including a plain consent refusal, is null.
 */
export function loopToolConsentRefusal(status: number, body: unknown): LoopToolConsent | null {
  if (status !== 409 || !body || typeof body !== 'object') return null;
  const { error, consentRequired, workerConsent } = body as Record<string, unknown>;
  if (consentRequired !== true || typeof error !== 'string' || !error.trim()) return null;
  if (!workerConsent || typeof workerConsent !== 'object') return null;
  const { revision, engines } = workerConsent as Record<string, unknown>;
  if (typeof revision !== 'string' || !revision || !Array.isArray(engines) || engines.length === 0) return null;
  if (!engines.every((engine): engine is string => typeof engine === 'string' && engine.length > 0)) return null;
  return { text: error, workerConsent: { revision, engines: [...engines] } };
}

export const newLoopCommandId = () =>
  `console-loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
