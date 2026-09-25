import { useEffect, useState } from 'react';
import { routeDisplayName } from '../../shared/engines';
import type { LoopModel, LoopOutcome, LoopOutcomeState, LoopView } from '../../shared/native-loop';
import type { HandoffView, TeamLeadView, TeamRole } from '../../shared/team-delegation';
import { VERIFICATION_LABEL, type VerificationState } from '../../shared/verification';
import type { ControlReceipt } from '../../shared/work-control';
import { displayName } from '../attribution-display';
import { AGENT_NAME } from '../../shared/agent-name';
import { api } from '../api';
import './verification.css';
import './loop-inspector.css';
import './lead-workers.css';

/**
 * H14 in the Team view: each lead loop that was admitted with a team, its
 * workers and its advice, read back from the handoff ledger and the child runs
 * (`GET /loop/team`). For each worker: what it was handed, its files, its
 * state, its budget and what it used, what came back, and verification through
 * the lead's outcome. The lead's own plan and actions stay in its run inspector;
 * this says only what the team did (decision 4). A lead stopped because a
 * worker did not answer offers the ordinary H08 Retry. Machine strings wrap
 * where they are written (decision 5); no `.col` rule is touched (decision 6).
 */

interface LeadRead {
  runId: string;
  sessionId: string | null;
  sessionState: string | null;
  taskId: string | null;
  taskName: string | null;
  route: string | null;
  models: LoopModel[];
  usage: LoopView['usage'];
  outcome: LoopOutcome;
  team: TeamLeadView | null;
}

const BADGE: Record<LoopOutcomeState, string> = {
  working: '',
  waiting: '',
  verified: 'verified',
  'not-verified': 'not-verified',
  'failed-verification': 'failed',
  uncertain: 'uncertain',
  'stopped-limit': 'uncertain',
  stopped: 'not-verified',
  failed: 'failed',
  reconcile: 'uncertain',
};
const VERIFICATION_BADGE: Record<VerificationState, string> = {
  verified: 'verified',
  'not-verified': 'not-verified',
  failed: 'failed',
  uncertain: 'uncertain',
};
const OUTCOME_WORD: Record<HandoffView['outcome'], string> = {
  running: 'working',
  completed: 'answered',
  stopped: 'stopped',
  failed: 'failed',
  died: 'ended unconfirmed',
  refused: 'not started',
  reused: 'answered earlier',
};

function seconds(ms: number | null) {
  if (ms === null) return null;
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

function modelsLine(list: readonly LoopModel[], route: string | null) {
  if (!list.length) return route === 'native-fixture' ? 'None: a fixed local script' : null;
  return list
    .map((model) => `${displayName(model.reported) || 'model not reported'}${model.engine ? ` via ${routeDisplayName(model.engine)}` : ''}`)
    .join('; ');
}

function roleLine(role: TeamRole) {
  const where = role.profile
    ? `${role.profile.name} (revision ${role.profile.revision})`
    : role.route === 'native-fixture'
      ? 'a fixed local script'
      : `${routeDisplayName(role.route) || role.route}${role.model ? ` · ${role.model}` : ''}`;
  return `${role.agent.name} · ${where}`;
}

function budgetLine(item: HandoffView) {
  if (!item.budget) return null;
  const used = item.used;
  const parts = [`turns ${used?.turns ?? 0} of ${item.budget.turns}`];
  if (item.budget.tokens !== null) parts.push(`tokens ${used?.tokens ?? 0} of ${item.budget.tokens}`);
  else if (used?.tokens) parts.push(`${used.tokens} tokens reported`);
  if (item.budget.wallMs !== null) parts.push(`time ${seconds(used?.wallMs ?? 0)} of ${seconds(item.budget.wallMs)}`);
  return parts.join(' · ');
}

function Handoff({ item, index }: { item: HandoffView; index: number }) {
  const ran = modelsLine(item.models, item.route);
  const budget = budgetLine(item);
  return (
    <li className="lw-handoff" data-handoff={item.handoffId} data-outcome={item.outcome}>
      <span className="loop-turn-head">
        <span className="loop-turn-n">{index + 1}</span>
        <span className="lw-task">{item.task}</span>
        <span className="loop-turn-state lw-state">{OUTCOME_WORD[item.outcome]}</span>
        {item.attempt > 1 && <span className="loop-turn-state lw-attempt">attempt {item.attempt}</span>}
      </span>
      <span className="loop-obs">
        {item.scope.length > 0 && <span className="lw-files loop-code">{item.scope.join(', ')}</span>}
        {item.outcome !== 'completed' && item.outcome !== 'reused' && <span className="loop-obs-detail lw-sentence">{item.sentence}</span>}
        {item.text && <code className="loop-obs-excerpt lw-answer">{item.text}</code>}
        {item.verification && (
          // The lead's outcome above already says why; each worker carries only its dot (decision 4).
          <span className="lw-verification">
            <span
              className={`verif-badge ${VERIFICATION_BADGE[item.verification.state]}`}
              data-verification={item.verification.state}
              title={item.verification.sentence}
            >
              {VERIFICATION_LABEL[item.verification.state]}
            </span>
          </span>
        )}
        <span className="loop-obs-meta lw-meta">
          {budget && <span className="lw-budget">{budget}</span>}
          {ran && <span className="loop-code">{ran}</span>}
          {item.reusedFrom ? (
            <span className="loop-code" title={item.reusedFrom}>
              from {item.reusedFrom}
            </span>
          ) : item.childRunId ? (
            <span className="loop-code" title={item.childRunId}>
              run {item.childRunId}
            </span>
          ) : null}
          {item.retryOf && (
            <span className="loop-code" title={item.retryOf}>
              retries {item.retryOf}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}

function Lead({
  lead,
  projectId,
  retried,
  onChanged,
}: {
  lead: LeadRead;
  projectId: string;
  /** A later attempt already retries this lead, so it is not offered again. */
  retried: boolean;
  onChanged: () => void;
}) {
  const team = lead.team!;
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retryable =
    !retried &&
    lead.sessionId &&
    lead.taskId &&
    (lead.sessionState === 'stopped' || lead.sessionState === 'failed') &&
    team.workers.some((item) => item.outcome === 'failed' || item.outcome === 'died');
  const retry = async () => {
    if (!lead.sessionId || !lead.taskId) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ receipt: ControlReceipt }>(`/projects/${encodeURIComponent(projectId)}/controls`, 'POST', {
        protocolVersion: 1,
        commandId: `retry-${lead.sessionId}-${crypto.randomUUID()}`,
        taskId: lead.taskId,
        control: 'retry',
        sessionId: lead.sessionId,
      });
      setReceipt(answer.receipt.detail);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The retry was not accepted.');
    } finally {
      setBusy(false);
    }
  };
  const ran = modelsLine(lead.models, lead.route);
  return (
    <article className="lw-lead" data-lead={lead.runId} aria-label={`Lead: ${lead.taskName ?? lead.runId}`}>
      <div className="loop-outcome">
        <span className={`verif-badge ${BADGE[lead.outcome.state]}`} data-lead-outcome={lead.outcome.state}>
          {lead.outcome.label}
        </span>
        <span className="lw-lead-task">{lead.taskName ?? 'Task'}</span>
        {retryable && (
          <button type="button" className="lw-retry" disabled={busy} onClick={() => void retry()}>
            Retry
          </button>
        )}
      </div>
      <p className="loop-sentence lw-lead-sentence">{lead.outcome.sentence}</p>
      {receipt && <p className="loop-obs-detail lw-receipt" role="status">{receipt}</p>}
      {error && <p role="alert">{error}</p>}
      <dl className="lw-facts">
        <dt>Lead</dt>
        <dd>
          {AGENT_NAME}
          {ran ? <span className="loop-code"> · {ran}</span> : null}
          {team.retryOf ? <span className="loop-code" title={team.retryOf.runId}> · attempt {team.retryOf.attempt}</span> : null}
        </dd>
        <dt>Reads</dt>
        <dd className="loop-code">{team.scope ? team.scope.join(', ') : 'The whole project, as its route allows'}</dd>
        <dt>Workers</dt>
        <dd>
          {roleLine(team.worker)} · at most {team.limits.concurrentWorkers} at once, {team.limits.workersPerRun} per run, one level
        </dd>
        {team.advisor && (
          <>
            <dt>Advisor</dt>
            <dd>{roleLine(team.advisor)} · reads only</dd>
          </>
        )}
      </dl>
      <h3>Workers</h3>
      {team.workers.length ? (
        <ol className="loop-turns lw-workers">
          {team.workers.map((item, index) => (
            <Handoff key={item.handoffId} item={item} index={index} />
          ))}
        </ol>
      ) : (
        <p className="loop-obs-detail">No task handed out yet.</p>
      )}
      {team.advice.length > 0 && (
        <>
          <h3>Advice</h3>
          <ol className="loop-turns lw-advice">
            {team.advice.map((item, index) => (
              <Handoff key={item.handoffId} item={item} index={index} />
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

export function LeadWorkers({ projectId, revision }: { projectId: string; revision: unknown }) {
  const [leads, setLeads] = useState<LeadRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ leads: LeadRead[] }>(`/projects/${encodeURIComponent(projectId)}/loop/team`, 'GET', undefined, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setLeads(value.leads.filter((lead) => lead.team));
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The team could not be read.');
      },
    );
    return () => controller.abort();
  }, [projectId, revision, tick]);
  if (error) return <p role="alert">{error}</p>;
  if (!leads?.length) return null;
  return (
    <section className="lead-workers loop-inspector" aria-label="Lead and workers">
      <h2 className="caption">Lead and workers</h2>
      {leads.map((lead) => (
        <Lead
          key={lead.runId}
          lead={lead}
          projectId={projectId}
          retried={leads.some((other) => other.team?.retryOf?.runId === lead.runId)}
          onChanged={() => setTick((value) => value + 1)}
        />
      ))}
    </section>
  );
}
