import { useEffect, useState } from 'react';
import { routeDisplayName } from '../../shared/engines';
import { formatTokens } from '../../shared/context-accounting';
import type { HarnessBudget } from '../../shared/harness';
import type {
  LoopDelegationView,
  LoopModel,
  LoopOutcome,
  LoopOutcomeState,
  LoopTurnView,
  LoopView,
} from '../../shared/native-loop';
import { displayName } from '../attribution-display';
import { AGENT_NAME } from '../../shared/agent-name';
import { api } from '../api';
import './verification.css';
import './loop-inspector.css';

/**
 * H13: a Diomedes work loop, read back from its own steps (`shared/native-loop.ts`)
 * inside the run inspector: the outcome, who supervised and which models the
 * runtime reported, the bounded plan, each action with what came back, any
 * handoff to a delegate, and the finish. The outcome of a finish is H17's
 * projection of the task's declared checks; the model's own summary is shown as
 * a claim. Nothing here keeps state of its own. Machine strings wrap or
 * truncate where they are written (decision 5).
 */

interface LoopRead {
  view: LoopView;
  outcome: LoopOutcome;
}

/** The outcome's dot, in H17's four-state colours: accent only for Verified. */
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

const ACTION_STATE: Record<string, string> = {
  succeeded: 'done',
  waiting_approval: 'waiting for your OK',
  running: 'running',
  pending: 'pending',
  retry_wait: 'will retry',
  reconcile_required: 'outcome unknown',
  cancelled: 'stopped',
  failed: 'failed',
};

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '');
const budget = (value: HarnessBudget) => `${value.modelCalls} model calls, ${value.toolCalls} tool calls`;

function models(list: readonly LoopModel[]) {
  if (!list.length) return null;
  return list
    .map(
      (model) =>
        `${displayName(model.reported) || 'model not reported'}${model.engine ? ` via ${routeDisplayName(model.engine)}` : ''} · ${model.calls} ${model.calls === 1 ? 'call' : 'calls'}`,
    )
    .join('; ');
}

function Turn({ turn }: { turn: LoopTurnView }) {
  const observation = turn.observation;
  const state = turn.actionState ? ACTION_STATE[turn.actionState] ?? turn.actionState : null;
  return (
    <li className={`loop-turn ${turn.decision}`} data-turn={turn.turn} data-decision={turn.decision}>
      <span className="loop-turn-head">
        <span className="loop-turn-n">{turn.turn + 1}</span>
        <span className="loop-turn-tool">
          {turn.decision === 'finish'
            ? 'finish'
            : turn.decision === 'deciding'
              ? 'deciding'
              : (turn.tool ?? 'no tool')}
        </span>
        {state && <span className="loop-turn-state">{turn.approval && state === 'done' ? 'approved, done' : state}</span>}
        {turn.decision === 'refused' && <span className="loop-turn-state">refused</span>}
      </span>
      {observation && (
        <span className="loop-obs">
          {observation.detail && <span className="loop-obs-detail">{observation.detail}</span>}
          {observation.excerpt && <code className="loop-obs-excerpt">{observation.excerpt}</code>}
          {observation.sha && (
            <span className="loop-obs-meta" title={observation.sha}>
              {observation.bytes} B · {short(observation.sha)}
            </span>
          )}
        </span>
      )}
    </li>
  );
}

function Delegation({ item }: { item: LoopDelegationView }) {
  const child = item.child;
  const answered = models(child?.models ?? []);
  return (
    <li className="loop-delegation" data-child={item.childRunId}>
      <span className="loop-turn-head">
        <span className="loop-turn-n">{item.turn + 1}</span>
        <span className="loop-turn-tool">{routeDisplayName(item.route) || item.route}</span>
        <span className="loop-turn-state">{item.refusal ? 'refused' : (child?.state ?? item.state ?? 'not started')}</span>
      </span>
      <span className="loop-obs">
        <span className="loop-obs-detail">{item.task}</span>
        {item.refusal && <span className="loop-obs-detail">{item.refusal}</span>}
        {item.result?.text && <code className="loop-obs-excerpt">{item.result.text}</code>}
        {child?.cancelReason && <span className="loop-obs-detail">Stopped: {child.cancelReason}</span>}
        <span className="loop-obs-meta">
          <span className="loop-code" title={item.handoffId ?? ''}>
            handoff {item.handoffId ?? 'not opened'}
          </span>{' '}
          · <span className="loop-code" title={item.childRunId}>run {item.childRunId}</span> · budget {budget(item.budget)}
          {child ? ` · used ${child.used.modelCalls} model, ${child.used.toolCalls} tool` : ''}
          {answered ? ` · ${answered}` : ''}
        </span>
      </span>
    </li>
  );
}

export function LoopInspector({ projectId, runId, revision }: { projectId: string; runId: string; revision: number }) {
  const [read, setRead] = useState<LoopRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api<LoopRead>(
      `/projects/${encodeURIComponent(projectId)}/loop/runs/${encodeURIComponent(runId)}`,
      'GET',
      undefined,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setRead(value);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The loop could not be read.');
      },
    );
    return () => controller.abort();
  }, [projectId, runId, revision]);

  if (error) return <p role="alert">{error}</p>;
  if (!read) return <p role="status">Reading the loop…</p>;
  const { view, outcome } = read;
  const ran = models(view.models);
  const account = view.account;
  const reported = account?.provider && account.provider.reportedCalls > 0 ? account.provider.inputTokens : null;
  return (
    <section className="loop-inspector" aria-label="Diomedes loop">
      <div className="loop-outcome">
        <span className={`verif-badge ${BADGE[outcome.state]}`} data-loop-outcome={outcome.state}>
          {outcome.label}
        </span>
        <span className="loop-sentence">{outcome.sentence}</span>
      </div>
      <dl>
        <dt>Supervised by</dt>
        <dd
          className="loop-supervisor"
          title="The native loop owns the plan, the order of actions, any handoff and the finish gate. Each model step is attributed to the model the runtime reported."
        >
          {AGENT_NAME}
        </dd>
        <dt>Models</dt>
        <dd className="loop-models">{ran ?? (view.route === 'native-fixture' ? 'None: a fixed local script' : 'None reported yet')}</dd>
        <dt>Turns</dt>
        <dd>
          {view.usage.turns.used} of {view.usage.turns.limit} · model calls {view.usage.modelCalls.used} of{' '}
          {view.usage.modelCalls.limit} · tool calls {view.usage.toolCalls.used} of {view.usage.toolCalls.limit}
        </dd>
        {account && (
          <>
            <dt>Context</dt>
            <dd>
              ~{formatTokens(account.estimatedTokens)} estimated on the first call
              {reported !== null ? ` · ${formatTokens(reported)} reported across ${account.provider!.reportedCalls} calls` : ''}
            </dd>
          </>
        )}
      </dl>
      <h3>Plan</h3>
      {view.plan ? (
        <ol className="loop-plan">
          {view.plan.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      ) : (
        <p>No plan recorded yet.</p>
      )}
      <h3>Actions and observations</h3>
      {view.turns.length ? (
        <ol className="loop-turns">
          {view.turns.map((turn) => (
            <Turn key={turn.turn} turn={turn} />
          ))}
        </ol>
      ) : (
        <p>No action yet.</p>
      )}
      {view.delegations.length > 0 && (
        <>
          <h3>Delegation</h3>
          <ol className="loop-turns">
            {view.delegations.map((item) => (
              <Delegation key={item.childRunId} item={item} />
            ))}
          </ol>
        </>
      )}
      {view.finish && (
        <>
          <h3>Finish</h3>
          <p className="loop-claim" title="The model’s own summary. The task’s declared checks decide the outcome above.">
            {view.finish.claim}
          </p>
        </>
      )}
    </section>
  );
}
