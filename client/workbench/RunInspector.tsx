import { Fragment, useEffect, useState } from 'react';
import type { HarnessRun } from '../../shared/harness';
import type { HistoryEntry, Need, Session } from '../../shared/types';
import {
  displayName,
  formatOrigin,
  originForNeed,
  originForSession,
} from '../attribution-display';
import { evidenceRows } from '../../shared/evidence-rows';
import { rememberedAttribution } from '../../shared/remembered-approvals';
import { loadHarnessEvidence, sessionEvidence, sessionEvidenceView } from './run-evidence';
import {
  CONTROL_COMMANDS,
  CONTROL_LABELS,
  type ControlReceipt,
  type RouteControlProfile,
} from '../../shared/work-control';
import { AGENT_NAME } from '../../shared/agent-name';
import {
  ROUTING_SOURCE_LABELS,
  fallbackSentence,
  runtimeModelDifference,
} from '../../shared/agent-profiles';
import { NATIVE_LOOP_CAPABILITY } from '../../shared/native-loop';
import { LoopInspector } from '../console/LoopInspector';
import './workbench.css';

/**
 * The governance rows this panel owns. The rest of `evidenceRows` is already
 * said elsewhere on this screen — actor, engine, route, account — and Diomedes
 * says a thing once.
 */
const GOVERNANCE_ROWS = ['Worker', 'Chosen', 'Business', 'Setup', 'Rules', 'Paid by'];

export interface RunInspectorProps {
  projectId: string;
  session: Session | null;
  needs: readonly Need[];
  history: readonly HistoryEntry[];
  /** What this run's route offers of the six controls (H08). Absent while it loads. */
  controls?: RouteControlProfile | null;
  /** The project's control receipts, for this run's lineage. */
  receipts?: readonly ControlReceipt[];
}

type Snapshot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'loaded'; run: HarnessRun | null; at: string };

/** Keyed ownership prevents even a single render of another task's evidence. */
export function RunInspector(props: RunInspectorProps) {
  if (!props.session) return null;
  return (
    <SessionInspector
      key={JSON.stringify([props.projectId, props.session.id])}
      {...props}
      session={props.session}
    />
  );
}

function SessionInspector({
  projectId,
  session,
  needs,
  history,
  controls = null,
  receipts = [],
}: RunInspectorProps & { session: Session }) {
  const lineage = receipts.find(
    (receipt) => receipt.result.sessionId === session.id && receipt.lineage,
  )?.lineage;
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: 'loading' });
  const evidence = sessionEvidence(session, needs, history);
  const origin = originForSession(session);
  const actor = formatOrigin(origin);
  // H09: the profile revision this run pinned at admission, and decision 8's
  // runtime-reported model beside the one that was asked for when they differ.
  const profile = session.agent?.profile;
  const modelDifference = runtimeModelDifference(session);
  const governance = evidenceRows(sessionEvidenceView(session)).filter((row) =>
    GOVERNANCE_ROWS.includes(row.label),
  );
  const authorizations = [
    ...new Map(
      [
        ...evidence.needs.flatMap((need) => (need.authorization ? [need.authorization] : [])),
        ...evidence.history.flatMap((entry) => (entry.authorization ? [entry.authorization] : [])),
      ].map((authorization) => [authorization.id, authorization]),
    ).values(),
  ];
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSnapshot({ state: 'loading' });
    void loadHarnessEvidence(projectId, session, controller.signal).then(
      (run) => {
        if (!controller.signal.aborted)
          setSnapshot({ state: 'loaded', run, at: new Date().toLocaleTimeString() });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setSnapshot({
            state: 'error',
            message: error instanceof Error ? error.message : 'Run evidence could not be loaded.',
          });
      },
    );
    return () => controller.abort();
  }, [open, projectId, session.id, session.taskId, session.state, revision]);

  return (
    <details className="run-inspector" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Run details{' '}
        <span>
          {session.state}
          {session.sample ? ' · Example run' : ''}
        </span>
      </summary>
      {open && (
        <div className="run-inspector-body">
          <dl>
            <dt>Actor</dt>
            <dd title={actor.detail}>{actor.label}</dd>
            <dt>Engine version</dt>
            <dd>{displayName(origin?.engine?.version) || 'Not recorded'}</dd>
            <dt>Execution route</dt>
            <dd>{session.route || session.receipt?.route || 'Not recorded'}</dd>
            <dt>Account route</dt>
            <dd>{displayName(origin?.accountRoute) || 'Not recorded'}</dd>
            <dt>Environment</dt>
            <dd>Isolation and execution host are not recorded in this session.</dd>
            {governance.map((item) => (
              <Fragment key={item.label}>
                <dt>{item.label}</dt>
                <dd className={item.code && !item.unknown ? 'run-inspector-code' : undefined}>
                  {item.value}
                </dd>
              </Fragment>
            ))}
            {profile && (
              <>
                <dt>Profile</dt>
                <dd>
                  {profile.name} · revision {profile.revision}{' '}
                  <span className="run-inspector-code">{profile.digest.slice(0, 19)}</span>
                </dd>
                <dt>Resolved by</dt>
                <dd>
                  {ROUTING_SOURCE_LABELS[profile.source]}. Fallback {profile.fallbackPolicy}.
                  {profile.fallback && <> {fallbackSentence(profile)}</>}
                </dd>
              </>
            )}
            {(profile || modelDifference) && (
              <>
                <dt>Model</dt>
                <dd className="run-inspector-code">
                  {modelDifference
                    ? `Ran on ${modelDifference.reported}, as the runtime reported. Requested ${modelDifference.requested}.`
                    : `${profile!.model}${profile!.effort ? ` · ${profile!.effort}` : ''}`}
                </dd>
              </>
            )}
            <dt>Authority</dt>
            <dd>
              {session.agent
                ? `${session.agent.policy.effective}. See the recorded authorization below. A thread preference is not a grant.`
                : 'See the recorded authorization below. A thread preference is not a grant.'}
            </dd>
            <dt>Controls</dt>
            <dd>
              {controls ? (
                <ul className="run-inspector-controls">
                  {CONTROL_COMMANDS.map((control) => {
                    const offered = controls.controls[control];
                    return (
                      <li key={control}>
                        <span>
                          {CONTROL_LABELS[control]} ·{' '}
                          {offered.support === 'native'
                            ? 'by the route'
                            : offered.support === 'host'
                              ? `by ${AGENT_NAME}`
                              : 'not offered'}
                        </span>
                        <small>{offered.note}</small>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                'Reading what this route offers.'
              )}
            </dd>
            {lineage && (
              <>
                <dt>Lineage</dt>
                <dd>
                  {lineage.kind === 'retry'
                    ? `Attempt ${lineage.attempt ?? 2}, retrying `
                    : lineage.kind === 'resume'
                      ? 'Continues '
                      : 'Forked from '}
                  <span className="run-inspector-code">{lineage.originSessionId}</span>
                </dd>
              </>
            )}
            {session.nativeThread && (
              <>
                <dt>Codex thread</dt>
                <dd>
                  <span className="run-inspector-code">{session.nativeThread.id}</span>
                  {session.nativeThread.origin === 'resumed'
                    ? ' · resumed'
                    : session.nativeThread.origin === 'forked'
                      ? ' · a fork'
                      : session.nativeThread.origin === 'restarted-fresh'
                        ? ' · new, resume not possible'
                        : session.nativeThread.kept
                          ? ' · kept for resume'
                          : ' · not kept'}
                </dd>
              </>
            )}
            <dt>Session</dt>
            <dd className="run-inspector-code">{session.id}</dd>
            {session.receipt && (
              <>
                <dt>Start receipt</dt>
                <dd className="run-inspector-code">
                  {session.receipt.commandId} · {session.receipt.scope}
                </dd>
              </>
            )}
          </dl>
          <section aria-label="Recorded authorization">
            <h3>Recorded authorization</h3>
            {evidence.needs.length === 0 && authorizations.length === 0 && (
              <p>No effect authorization record yet.</p>
            )}
            {authorizations.map((authorization) =>
              authorization.kind === 'remembered-approval' ? (
                <div className="run-inspector-record" key={authorization.id}>
                  <p>{rememberedAttribution(authorization)}</p>
                  <dl>
                    <dt>Remembered approval</dt>
                    <dd className="run-inspector-code">{authorization.grantId}</dd>
                    <dt>Authorized at</dt>
                    <dd>{authorization.authorizedAt}</dd>
                    <dt>Action digest</dt>
                    <dd className="run-inspector-code">{authorization.actionDigest}</dd>
                    <dt>History event</dt>
                    <dd className="run-inspector-code">{authorization.eventId}</dd>
                  </dl>
                </div>
              ) : (
              <div className="run-inspector-record" key={authorization.id}>
                <p>Allowed by a task scope grant</p>
                <dl>
                  <dt>Grant</dt>
                  <dd className="run-inspector-code">{authorization.grantId}</dd>
                  <dt>Authorized effects</dt>
                  <dd>
                    {authorization.writes} writes · {authorization.bytes} bytes
                  </dd>
                  <dt>Account route</dt>
                  <dd>{authorization.accountRoute}</dd>
                  <dt>Authorized at</dt>
                  <dd>{authorization.authorizedAt}</dd>
                  <dt>Action digest</dt>
                  <dd className="run-inspector-code">{authorization.actionDigest}</dd>
                  <dt>History event</dt>
                  <dd className="run-inspector-code">{authorization.eventId}</dd>
                </dl>
                <p>
                  This records past authorization; current grant validity is checked before each
                  effect.
                </p>
              </div>
              ),
            )}
            {evidence.needs.map((need) => (
              <div className="run-inspector-record" key={need.id}>
                <p>{need.what}</p>
                <dl>
                  <dt>Proposer</dt>
                  <dd>{formatOrigin(originForNeed(need, session)).label}</dd>
                  <dt>Request</dt>
                  <dd>
                    {need.authorization?.kind === 'remembered-approval'
                      ? 'Resolved by a remembered approval'
                      : need.authorization
                        ? 'Resolved by task scope'
                        : need.state}
                  </dd>
                  <dt>Authorization</dt>
                  <dd>
                    {need.authorization?.kind === 'remembered-approval'
                      ? 'Remembered approval (recorded above)'
                      : need.authorization
                      ? 'Task scope grant (recorded above)'
                      : need.approvalReceipt
                        ? `Exact decision: ${need.approvalReceipt.decision}`
                        : 'No effect authorization record yet'}
                  </dd>
                  <dt>Execution</dt>
                  <dd>{need.execution?.state ?? 'No execution receipt'}</dd>
                  {need.approval && (
                    <>
                      <dt>Proposal digest</dt>
                      <dd className="run-inspector-code">{need.approval.proposalDigest}</dd>
                    </>
                  )}
                  {need.execution?.eventId && (
                    <>
                      <dt>History event</dt>
                      <dd className="run-inspector-code">{need.execution.eventId}</dd>
                    </>
                  )}
                </dl>
              </div>
            ))}
          </section>
          <section aria-label="Recorded sources">
            <h3>Recorded sources</h3>
            {!evidence.sources.length && <p>No source snapshot is attached to this session.</p>}
            {evidence.sources.length > 0 && (
              <ul>
                {evidence.sources.map((source) => (
                  <li key={JSON.stringify([source.path, source.sha])}>
                    <span>{source.path}</span>
                    <small>
                      {source.basis} · <span className="run-inspector-code">{source.sha}</span>
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Runtime evidence">
            <div className="run-inspector-heading">
              <h3>Runtime evidence</h3>
              <button
                type="button"
                disabled={snapshot.state === 'loading'}
                onClick={() => setRevision((value) => value + 1)}
              >
                Refresh
              </button>
            </div>
            {snapshot.state === 'loading' && <p role="status">Loading run evidence...</p>}
            {snapshot.state === 'error' && <p role="alert">{snapshot.message}</p>}
            {snapshot.state === 'loaded' && (
              <>
                <p>Snapshot at {snapshot.at}</p>
                {snapshot.run ? (
                  <HarnessEvidence run={snapshot.run} projectId={projectId} revision={revision} />
                ) : (
                  <p>
                    No detailed Runtime record is linked to this session. Tool and budget evidence
                    is unavailable.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </details>
  );
}

function HarnessEvidence({ run, projectId, revision }: { run: HarnessRun; projectId: string; revision: number }) {
  return (
    <>
      {run.capabilityId === NATIVE_LOOP_CAPABILITY && <LoopInspector projectId={projectId} runId={run.id} revision={revision} />}
      <dl>
        <dt>Run</dt>
        <dd className="run-inspector-code">{run.id}</dd>
        <dt>State</dt>
        <dd>{run.state}</dd>
        <dt>Capability</dt>
        <dd>
          {run.capabilityId} · {run.capabilityVersion}
        </dd>
        <dt>Policy version</dt>
        <dd>{run.policyVersion}</dd>
        <dt>Declared tools</dt>
        <dd>{run.capabilityTools.join(', ') || 'None'}</dd>
        <dt>Model calls</dt>
        <dd>
          {run.used.modelCalls} / {run.budget.modelCalls}
        </dd>
        <dt>Tool calls</dt>
        <dd>
          {run.used.toolCalls} / {run.budget.toolCalls}
        </dd>
        <dt>Step units</dt>
        <dd>
          {run.used.units} / {run.budget.units}
        </dd>
        <dt>Time limit</dt>
        <dd>
          {run.budget.wallMs === null
            ? 'None recorded'
            : `${run.budget.wallMs} ms recorded; not enforced`}
        </dd>
        <dt>Tokens / spend</dt>
        <dd>Unknown; call counts are not provider charges.</dd>
        <dt>Context revision</dt>
        <dd>{run.contextRevision}</dd>
        <dt>Event cursor</dt>
        <dd>{run.lastSeq}</dd>
      </dl>
      {run.state === 'reconcile_required' && (
        <p role="status">An effect is uncertain. Review its evidence before trying again.</p>
      )}
      <h3>Recorded steps</h3>
      {run.steps.length === 0 ? (
        <p>No steps recorded.</p>
      ) : (
        <ol>
          {run.steps.map((step) => (
            <li key={step.intent.stepId}>
              <span>{step.intent.name || step.intent.stepId}</span>
              <small title={formatOrigin(step.origin).detail}>
                {formatOrigin(step.origin).label}
              </small>
              <small>
                {step.state} · attempt {step.attempt} / {step.intent.maxAttempts}
              </small>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
