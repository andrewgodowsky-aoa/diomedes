import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReadinessAxis,
  ReadinessAxisName,
  ReadinessCapability,
  ReadinessProjection,
  WorkflowReadiness,
} from '../../shared/readiness';
import { ENGINE_NAMES, isExternalEngine } from '../../shared/engines';
import { readinessApi } from '../api';
import './readiness.css';

const AXES: readonly { id: ReadinessAxisName; label: string }[] = [
  { id: 'implemented', label: 'Implemented' },
  { id: 'installed', label: 'Installed' },
  { id: 'authorized', label: 'Authorized' },
  { id: 'verified', label: 'Verified' },
  { id: 'healthy', label: 'Healthy now' },
];

const plainValue = (axis: ReadinessAxis) =>
  axis.value === 'yes' ? 'Yes' : axis.value === 'no' ? 'No' : 'Unknown';

const LOCAL_CAPABILITY_NAMES: Readonly<Record<string, string>> = {
  sample: 'Sample',
  codex: 'Codex',
  'codex-report': 'Codex report',
  'claude-code-session': 'Claude Code session',
  'native-fixture': 'Native fixture',
  'harness-runtime': 'Harness runtime',
};

function capabilityName(id: string) {
  if (isExternalEngine(id)) return ENGINE_NAMES[id];
  if (LOCAL_CAPABILITY_NAMES[id]) return LOCAL_CAPABILITY_NAMES[id];
  const words = id.replace(/[._-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function duration(milliseconds: number) {
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000} days`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} hours`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} minutes`;
  return `${milliseconds} ms`;
}

function CapabilityCard({ capability }: { capability: ReadinessCapability }) {
  return (
    <article className="ready-capability">
      <div className="ready-card-head">
        <div>
          <p className="caption">{capability.kind === 'route' ? 'Route' : 'Connection'}</p>
          <h3>{capabilityName(capability.id)}</h3>
        </div>
        <span className={`ready-result ${capability.ready ? 'yes' : 'blocked'}`}>
          {capability.ready ? 'Ready' : 'Not ready'}
        </span>
      </div>
      <div className="ready-axes" aria-label={`${capability.id} readiness checks`}>
        {AXES.map(({ id, label }) => {
          const value = capability.axes[id];
          return (
            <div className={`ready-axis ${value.value}`} key={id}>
              <span>{label}</span>
              <strong>{plainValue(value)}</strong>
            </div>
          );
        })}
      </div>
      <details className="ready-details">
        <summary>Sources and freshness</summary>
        <dl>
          <div>
            <dt>Capability ID</dt>
            <dd className="mono">{capability.id}</dd>
          </div>
          {AXES.map(({ id, label }) => {
            const value = capability.axes[id];
            return (
              <div key={id}>
                <dt>{label}</dt>
                <dd>
                  {value.detail}{' '}
                  <span className="mono">
                    {value.source.kind}: {value.source.id}
                  </span>
                  <span className="ready-freshness">
                    Freshness: {value.freshness.state}. Observed:{' '}
                    {value.freshness.observedAt
                      ? new Date(value.freshness.observedAt).toLocaleString()
                      : 'not recorded'}
                    . Stale after:{' '}
                    {value.freshness.staleAfterMs === null
                      ? 'not applicable'
                      : duration(value.freshness.staleAfterMs)}
                    .
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    </article>
  );
}

function blockerSummary(blocker: WorkflowReadiness['blockers'][number]): string {
  if (blocker.code === 'knowledge-conflict')
    return 'The saved capability information needs updating.';
  if (blocker.code === 'capability-missing') return 'A required tool is unavailable in this build.';
  if (blocker.code === 'control-missing')
    return 'This workflow needs safeguards the tool cannot currently enforce.';
  if (blocker.code === 'command-unsupported' || blocker.code === 'operation-missing')
    return 'A required action is unavailable for this tool.';
  if (blocker.code === 'axis-missing') {
    const axis = blocker.requirement.split(':').at(-1);
    if (axis === 'verified') return 'There is no current verification for this tool.';
    if (axis === 'authorized') return 'Permission or account setup is still needed in Settings.';
    if (axis === 'installed') return 'Check installed tools in Settings.';
    if (axis === 'healthy') return 'A successful tool check is needed in Settings.';
    if (axis === 'implemented') return 'A required capability is unavailable in this build.';
  }
  return blocker.detail;
}

function WorkflowCard({ workflow }: { workflow: WorkflowReadiness }) {
  return (
    <article className="ready-workflow">
      <div className="ready-card-head">
        <div>
          <p className="caption">Workflow</p>
          <h3>{workflow.title}</h3>
        </div>
        <span className={`ready-result ${workflow.ready ? 'yes' : 'blocked'}`}>
          {workflow.ready ? 'Ready' : 'Blocked'}
        </span>
      </div>
      <p>Tools: {workflow.requirements.map((item) => capabilityName(item.id)).join(', ')}.</p>
      {workflow.blockers.length > 0 && (
        <div className="ready-blockers">
          <h4>What is missing</h4>
          <ul>
            {workflow.blockers.map((blocker, index) => (
              <li key={`${blocker.requirement}:${blocker.code}:${index}`}>
                {blockerSummary(blocker)}
              </li>
            ))}
          </ul>
          <details className="ready-details">
            <summary>Evidence details</summary>
            <ul>
              {workflow.blockers.map((blocker, index) => (
                <li key={index}>{blocker.detail}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </article>
  );
}

export function ReadinessPage({ projectId }: { projectId?: string }) {
  const [projection, setProjection] = useState<ReadinessProjection | null>(null);
  const [scoped, setScoped] = useState(Boolean(projectId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const started = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const result = await readinessApi.read(scoped ? projectId : undefined, request.signal);
      if (started === epoch.current && !request.signal.aborted) setProjection(result.readiness);
    } catch (failure) {
      if (started === epoch.current && !request.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Readiness could not be read.');
    } finally {
      if (started === epoch.current && !request.signal.aborted) setLoading(false);
    }
  }, [projectId, scoped]);

  useEffect(() => {
    setProjection(null);
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      epoch.current += 1;
    };
  }, [load]);

  return (
    <div className="col readiness-page">
      <header className="ready-page-head">
        <div>
          <h1>Readiness</h1>
          <p>Check available tools and what each workflow still needs.</p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading...' : 'Refresh status'}
        </button>
      </header>
      {projectId && (
        <label className="ready-scope">
          <input
            type="checkbox"
            checked={scoped}
            onChange={(event) => setScoped(event.target.checked)}
          />
          Include this project's saved connection status
        </label>
      )}
      <p className="ready-note">Refresh uses the latest saved checks.</p>
      {error && <p role="alert">{error}</p>}
      {loading && !projection && <p role="status">Reading saved readiness...</p>}
      {projection && (
        <>
          <div className="ready-meta" role="status">
            <span>Build {projection.build.version}</span>
            <span>Status read {new Date(projection.generatedAt).toLocaleString()}</span>
          </div>
          <section className="ready-section" aria-labelledby="ready-workflows">
            <div className="ready-section-head">
              <h2 id="ready-workflows">Workflows</h2>
            </div>
            <div className="ready-grid">
              {projection.workflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} />
              ))}
            </div>
          </section>
          <section className="ready-section" aria-labelledby="ready-routes">
            <div className="ready-section-head">
              <h2 id="ready-routes">Routes</h2>
            </div>
            <div className="ready-grid">
              {projection.routes.map((route) => (
                <CapabilityCard key={route.id} capability={route} />
              ))}
            </div>
          </section>
          {projection.connectors.length > 0 && (
            <section className="ready-section" aria-labelledby="ready-connections">
              <div className="ready-section-head">
                <h2 id="ready-connections">Connections</h2>
              </div>
              <div className="ready-grid">
                {projection.connectors.map((connector) => (
                  <CapabilityCard key={connector.id} capability={connector} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
