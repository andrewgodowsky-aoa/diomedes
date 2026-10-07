import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, listDocuments } from '../api';
import { Modal } from '../components';
import { AGENT_NAME } from '../../shared/agent-name';
import type { RoleTier } from '../../shared/escalation-roles';
import { NECTOVIA_ROUTE } from '../../shared/model-api';
import { LOOP_LIMITS, type LoopRouteOffer } from '../../shared/native-loop';
import type { SubscriptionWorkerStartView } from '../../shared/subscription-workers';
import { selectTaskSources } from '../../shared/task-sources';
import type { DocumentInfo, Session, Task } from '../../shared/types';
import {
  defaultLoopGoal, loopStartCommand, loopToolConsent, loopToolConsentRefusal, newLoopCommandId,
  collaborationOfferLabel, escalationOfferReasons, nectoviaRolesConsentText, retainAfterFailure, retainLoopStartCommand,
  LOOP_REVIEW_PROFILE, type LoopCollaborationOptions, type LoopEscalationOffers, type LoopNectoviaRoles,
  type LoopStartCommand, type LoopToolConsent,
} from './loop-start-model';
import './trigger-rules.css';

/**
 * Start a Diomedes loop run (H13) on a task, from the task's own work panel.
 *
 * It offers only the routes the server says it would admit now
 * (`GET /api/projects/:id/loop/routes`, the start route's own admission), and
 * lists every other route with the server's reason. The start is H13's
 * versioned command, unchanged: the goal defaults to the task's statement, the
 * turns to H13's default, and a refusal — consent, a file the project does not
 * share with the route, the route's own admission — is shown as the server
 * said it. The run then appears in this thread's run inspector.
 *
 * A Nectovia start that may hand a task to the person's own coding tools (S3,
 * `GET /api/projects/:id/subscription-workers`) names those tools in its consent
 * and sends what was confirmed. When the server asks again with other tools, the
 * box says what the server says, unticked, and the next start confirms those.
 *
 * A start on any other lead may name a Nectovia worker and advisor by tier
 * (DIO-216, `GET /api/projects/:id/loop/escalation`). A tier the account can't
 * use is listed unavailable with the server's own sentence, and the consent says
 * where the roles' work goes and that they use the account's credits.
 */
export function LoopStart({
  projectId,
  task,
  onClose,
  onStarted,
}: {
  projectId: string;
  task: Task;
  onClose(): void;
  onStarted(session: Session | null): void;
}) {
  const labelId = useId();
  // One dialog, one command: a second click or a resend names the same run.
  const [commandId] = useState(newLoopCommandId);
  const [offers, setOffers] = useState<LoopRouteOffer[] | null>(null);
  // Set when the business does not hold 'owner-rules' (Andrew, 2026-09-25): the
  // run still starts, but the project's instruction files do not reach it.
  const [notIncluded, setNotIncluded] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [route, setRoute] = useState('');
  const [goal, setGoal] = useState(() => defaultLoopGoal(task));
  const [sources, setSources] = useState<string[]>([]);
  const [turns, setTurns] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collaboration, setCollaboration] = useState<LoopCollaborationOptions | null>(null);
  const [leadSlotId, setLeadSlotId] = useState('');
  const [memberSlotId, setMemberSlotId] = useState('');
  const [helperProfileId, setHelperProfileId] = useState('');
  const [reviewConnectionId, setReviewConnectionId] = useState('');
  // S3: what a Nectovia start here would do with the person's own coding tools, and the
  // server's own sentence once it asked again for them.
  const [workers, setWorkers] = useState<SubscriptionWorkerStartView | null>(null);
  const [askedAgain, setAskedAgain] = useState<LoopToolConsent | null>(null);
  // DIO-216: the Nectovia tiers this start may name as roles, and the ones chosen.
  const [escalation, setEscalation] = useState<LoopEscalationOffers | null>(null);
  const [nectoviaWorker, setNectoviaWorker] = useState<RoleTier | ''>('');
  const [nectoviaAdvisor, setNectoviaAdvisor] = useState<RoleTier | ''>('');
  const consentBox = useRef<HTMLInputElement | null>(null);
  const starting = useRef(false);
  const submitted = useRef<LoopStartCommand | null>(null);

  useEffect(() => {
    let live = true;
    api<{ routes: LoopRouteOffer[]; notIncludedReason?: string | null }>(
      `/projects/${projectId}/loop/routes`,
    ).then(
      ({ routes, notIncludedReason }) => {
        if (!live) return;
        setOffers(routes);
        setNotIncluded(notIncludedReason ?? null);
        setRoute((current) => current || routes.find((offer) => offer.admitted)?.route || '');
      },
      (failure) => live && setError(failure instanceof Error ? failure.message : "The connections couldn't be read."),
    );
    listDocuments(projectId).then(
      ({ documents: listed }) => {
        if (!live) return;
        const readable = listed.filter((item) => item.kind === 'markdown' || item.kind === 'text' || item.kind === 'plan');
        setDocuments(readable);
        try {
          setSources(selectTaskSources(task, listed).slice(0, 32));
        } catch {
          setSources([]);
        }
      },
      () => undefined,
    );
    api<LoopCollaborationOptions>(
      `/projects/${projectId}/loop/collaboration-options?taskId=${encodeURIComponent(task.id)}`,
    ).then(
      (options) => live && setCollaboration(options),
      (failure) => live && setCollaboration({
        leads: [], members: [], helpers: [], reviews: [],
        reason: failure instanceof Error ? failure.message : "Team choices couldn't be read.",
      }),
    );
    // A host without this read starts as it always has.
    api<SubscriptionWorkerStartView>(`/projects/${projectId}/subscription-workers`).then(
      (view) => live && setWorkers(view),
      () => undefined,
    );
    // A host without this read offers no Nectovia roles.
    api<LoopEscalationOffers>(`/projects/${projectId}/loop/escalation`).then(
      (view) => live && setEscalation(view),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId, task.id]);

  const leads = collaboration?.leads ?? [];
  const selectedLead = leads.find(offer => offer.slotId === leadSlotId) ?? null;
  // A selected lead has its own current model; the route's default model may be refused.
  const acceptsChoice = (offer: LoopRouteOffer) => offer.admitted ||
    Boolean(selectedLead?.admitted && selectedLead.route === offer.route);
  const admitted = (offers ?? []).filter(acceptsChoice);
  const refused = (offers ?? []).filter(offer => !acceptsChoice(offer));
  const chosen = admitted.find((offer) => offer.route === route) ?? null;
  const members = collaboration?.members ?? [];
  const helpers = collaboration?.helpers ?? [];
  const reviews = (collaboration?.reviews ?? []).filter(offer => offer.profileId === LOOP_REVIEW_PROFILE);
  const partialTeam = Boolean(leadSlotId) !== Boolean(memberSlotId) ||
    Boolean(leadSlotId && leadSlotId === memberSlotId);
  const unavailableSelection =
    Boolean(leadSlotId && !leads.some(offer => offer.slotId === leadSlotId && offer.admitted)) ||
    Boolean(selectedLead && selectedLead.route !== route) ||
    Boolean(memberSlotId && !members.some(offer => offer.slotId === memberSlotId && offer.admitted)) ||
    Boolean(helperProfileId && !helpers.some(offer => offer.profileId === helperProfileId && offer.admitted)) ||
    Boolean(reviewConnectionId && !reviews.some(offer => offer.connectionId === reviewConnectionId && offer.admitted));
  const collaborationRefusals = [...new Set(
    [...leads, ...members, ...helpers, ...reviews]
      .filter(offer => !offer.admitted && offer.reason)
      .map(offer => offer.reason!),
  )];
  // DIO-216: Nectovia roles by tier, beside a lead that is not Nectovia and never with a Team.
  const composing = Boolean(leadSlotId || memberSlotId || helperProfileId || reviewConnectionId);
  const offersRoles = Boolean(chosen?.sends && chosen.route !== NECTOVIA_ROUTE && escalation);
  const tierOffers = escalation?.offers ?? [];
  const nectovia: LoopNectoviaRoles | null = offersRoles && !composing && nectoviaWorker
    ? { worker: nectoviaWorker, advisor: nectoviaAdvisor || null }
    : null;
  const tierAdmitted = (tier: RoleTier | null) => tier === null || tierOffers.some(offer => offer.tier === tier && offer.admitted);
  const unavailableRoles = Boolean(nectovia && (!tierAdmitted(nectovia.worker) || !tierAdmitted(nectovia.advisor)));
  useEffect(() => {
    if (composing || !offersRoles) {
      setNectoviaWorker('');
      setNectoviaAdvisor('');
    }
  }, [composing, offersRoles]);
  const toolConsent = chosen?.route === NECTOVIA_ROUTE ? loopToolConsent(workers, askedAgain) : null;
  const consentText = chosen?.sends
    ? (toolConsent?.text ?? (nectovia ? nectoviaRolesConsentText(chosen.label, nectovia) : `Send the goal and the files it reads to ${chosen.label}.`))
    : null;
  // A tick was given to the words beside it. When they change, the person confirms again.
  useEffect(() => {
    setConsent(false);
  }, [consentText]);

  async function start() {
    // React's disabled state is painted later; the ref closes two submits in one turn.
    if (starting.current || !chosen || partialTeam || unavailableSelection || unavailableRoles) return;
    starting.current = true;
    setBusy(true);
    setError('');
    try {
      const command = retainLoopStartCommand(submitted.current, loopStartCommand({
        commandId, taskId: task.id, goal, route: chosen.route, sources, consent, maxTurns: turns,
        workerConsent: consent && toolConsent ? toolConsent.workerConsent : null,
        persistentTeam: leadSlotId && memberSlotId ? { leadSlotId, memberSlotId } : null,
        team: helperProfileId ? { scope: sources, worker: { profileId: helperProfileId }, advisor: null } : null,
        review: reviewConnectionId ? { profileId: LOOP_REVIEW_PROFILE, connectionId: reviewConnectionId } : null,
        nectovia,
      }));
      submitted.current = command;
      const started = await api<{ runId: string; session: Session | null }>(
        `/projects/${projectId}/loop/start`,
        'POST',
        command,
      );
      onStarted(started.session);
    } catch (failure) {
      const refusal = failure instanceof ApiError ? loopToolConsentRefusal(failure.status, failure.data) : null;
      submitted.current = retainAfterFailure(submitted.current, refusal);
      if (refusal) {
        // The server named the tools again: its sentence goes beside the box, said once.
        setAskedAgain(refusal);
        setConsent(false);
        consentBox.current?.focus();
      } else setError(failure instanceof Error ? failure.message : "The job couldn't be started.");
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={`Start a ${AGENT_NAME} work loop`} onClose={onClose}>
      <form
        className="loop-start trigger-rule-form"
        aria-label={`Start a ${AGENT_NAME} work loop`}
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <p className="loop-start-task" title={task.name}>
          {task.name}
        </p>
        {notIncluded && <p className="trigger-rules-reach">{notIncluded}</p>}
        {offers && admitted.length === 0 && !leads.some(offer => offer.admitted) && (
          <p className="trigger-rules-reach">No connection can start this work.</p>
        )}
        {admitted.length > 0 && (
          <label className="field">
            <span id={`${labelId}-route`}>Route</span>
            <select
              aria-labelledby={`${labelId}-route`}
              value={route}
              disabled={busy || Boolean(leadSlotId)}
              onChange={(event) => {
                setRoute(event.target.value);
                setConsent(false);
              }}
            >
              {admitted.map((offer) => (
                <option key={offer.route} value={offer.route}>
                  {offer.label}
                  {(selectedLead?.route === offer.route ? selectedLead.model : offer.model)
                    ? ` · ${selectedLead?.route === offer.route ? selectedLead.model : offer.model}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {refused.length > 0 && (
          <details className="loop-start-refused">
            <summary>Not offered ({refused.length})</summary>
            <ul>
              {refused.map((offer) => (
                <li key={offer.route} data-route={offer.route}>
                  <span className="loop-start-route">{offer.label}</span> {offer.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <label className="field">
          <span id={`${labelId}-goal`}>Goal</span>
          <textarea aria-labelledby={`${labelId}-goal`} value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} maxLength={16_000} />
        </label>
        {documents.length > 0 && (
          <fieldset className="trigger-rule-kinds">
            <legend>Files it reads</legend>
            {documents.map((item) => (
              <label className="trigger-rule-choice" key={item.path} title={item.path}>
                <input
                  type="checkbox"
                  checked={sources.includes(item.path)}
                  disabled={!sources.includes(item.path) && sources.length >= 32}
                  onChange={(event) =>
                    setSources(
                      event.target.checked
                        ? [...sources, item.path]
                        : sources.filter((path) => path !== item.path),
                    )
                  }
                />
                <span>{item.path}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">
          <span id={`${labelId}-team-lead`}>Team lead</span>
          <select aria-labelledby={`${labelId}-team-lead`} value={leadSlotId} onChange={event => {
            const next = leads.find(offer => offer.slotId === event.target.value);
            setLeadSlotId(event.target.value);
            if (next && next.route !== route) {
              setRoute(next.route);
              setConsent(false);
            }
          }}
            disabled={busy || !leads.some(offer => offer.admitted)}>
            <option value="">None</option>
            {leads.map(offer => (
              <option key={offer.slotId} value={offer.slotId}
                disabled={!offer.admitted || offer.slotId === memberSlotId}>
                {collaborationOfferLabel(offer)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span id={`${labelId}-team-member`}>Team member</span>
          <select aria-labelledby={`${labelId}-team-member`} value={memberSlotId} onChange={event => setMemberSlotId(event.target.value)}
            disabled={busy || !members.some(offer => offer.admitted)}>
            <option value="">None</option>
            {members.map(offer => (
              <option key={offer.slotId} value={offer.slotId}
                disabled={!offer.admitted || offer.slotId === leadSlotId}>
                {collaborationOfferLabel(offer)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span id={`${labelId}-helper-profile`}>Helper profile</span>
          <select aria-labelledby={`${labelId}-helper-profile`} value={helperProfileId} onChange={event => setHelperProfileId(event.target.value)}
            disabled={busy || !helpers.some(offer => offer.admitted)}>
            <option value="">None</option>
            {helpers.map(offer => (
              <option key={offer.profileId} value={offer.profileId} disabled={!offer.admitted}>
                {collaborationOfferLabel(offer)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span id={`${labelId}-jev-review`}>AI review</span>
          <select aria-labelledby={`${labelId}-jev-review`} value={reviewConnectionId} onChange={event => setReviewConnectionId(event.target.value)}
            disabled={busy || !reviews.some(offer => offer.admitted)}>
            <option value="">None</option>
            {reviews.map(offer => (
              <option key={offer.connectionId} value={offer.connectionId} disabled={!offer.admitted}>
                {offer.name}{offer.model ? ` · ${offer.model}` : ''}
              </option>
            ))}
          </select>
        </label>
        {collaboration?.reason && <p className="trigger-rules-reach">{collaboration.reason}</p>}
        {collaborationRefusals.map(reason => <p className="loop-start-refused" key={reason}>{reason}</p>)}
        {offersRoles && (
          <>
            <label className="field">
              <span id={`${labelId}-nectovia-worker`}>{AGENT_NAME} worker</span>
              <select aria-labelledby={`${labelId}-nectovia-worker`} value={nectoviaWorker} onChange={event => {
                const next = event.target.value as RoleTier | '';
                setNectoviaWorker(next);
                if (!next) setNectoviaAdvisor('');
              }}
                disabled={busy || composing || !tierOffers.some(offer => offer.admitted)}>
                <option value="">None</option>
                {tierOffers.map(offer => (
                  <option key={offer.tier} value={offer.tier} disabled={!offer.admitted}>{offer.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span id={`${labelId}-nectovia-advisor`}>{AGENT_NAME} advisor</span>
              <select aria-labelledby={`${labelId}-nectovia-advisor`} value={nectoviaAdvisor}
                onChange={event => setNectoviaAdvisor(event.target.value as RoleTier | '')}
                disabled={busy || composing || !nectoviaWorker || !tierOffers.some(offer => offer.admitted)}>
                <option value="">None</option>
                {tierOffers.map(offer => (
                  <option key={offer.tier} value={offer.tier} disabled={!offer.admitted}>{offer.name}</option>
                ))}
              </select>
            </label>
            {escalationOfferReasons(escalation).map(reason => (
              <p className="loop-start-refused" key={`nectovia-${reason}`}>{reason}</p>
            ))}
          </>
        )}
        <label className="field">
          <span>Turns (up to {LOOP_LIMITS.maxTurns})</span>
          <input
            type="number"
            min={1}
            max={LOOP_LIMITS.maxTurns}
            value={turns ?? LOOP_LIMITS.defaultTurns}
            onChange={(event) => setTurns(event.target.value === '' ? null : Number(event.target.value))}
          />
        </label>
        {consentText && (
          <label className="trigger-rule-choice">
            <input ref={consentBox} type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>{consentText}</span>
          </label>
        )}
        {error && (
          <p className="trigger-rules-error" role="alert">
            {error}
          </p>
        )}
        <div className="trigger-rule-form-acts">
          <button type="submit" className="button primary" disabled={busy || !chosen || partialTeam || unavailableSelection || unavailableRoles}>
            {busy ? 'Starting…' : 'Start loop run'}
          </button>
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
