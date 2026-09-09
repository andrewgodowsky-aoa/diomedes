import { useCallback, useEffect, useState } from 'react';
import type { ConnectionPlan, DesktopConnectionsView } from '../../shared/connection-desktop';
import type { RuleProposal } from '../../shared/connection-rules';
import type { CompiledConnectionDemoSummary } from '../../server/connections/compiler-demo';
import { api } from '../api';
import './desktop.css';

export function Connections({ projectId }: { projectId: string }) {
  const base = `/projects/${projectId}/connections`;
  const [data, setData] = useState<DesktopConnectionsView | null>(null);
  const [text, setText] = useState('Watch Toast menu availability across my three Raleigh restaurants and alert a manager.');
  const [threshold, setThreshold] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [zone, setZone] = useState('America/New_York');
  const [plan, setPlan] = useState<{ plan: ConnectionPlan; digest: string } | null>(null);
  const [revision, setRevision] = useState<{ proposal: RuleProposal; digest: string } | null>(null);
  const [event, setEvent] = useState<{ id: string; at: string; quantity: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<(CompiledConnectionDemoSummary & { previewDigest: string; installed: boolean })[]>([]);
  const [compilerResult, setCompilerResult] = useState<unknown>(null);
  const refresh = useCallback(async () => setData(await api<DesktopConnectionsView>(base)), [base]);
  useEffect(() => {
    let active = true;
    const load = () => { if (active) void refresh().catch((e: Error) => setError(e.message)); };
    load(); const timer = setInterval(load, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'The connection action failed.'); }
    finally { setBusy(false); }
  };
  const post = <T,>(action: string, body: unknown = {}) => api<T>(`${base}/${action}`, 'POST', body);
  const connection = data?.connections.find((item) => item.connection.id.startsWith('toast-'));
  const latestRun = data?.runs?.at(-1);
  return <section className="connection-desktop" aria-label="Connections">
    <div className="connection-title"><div><p className="connection-eyebrow">BUSINESS TOOLS</p><h1>Connections</h1></div><span className="connection-badge">Experimental / synthetic data</span></div>
    <p className="connection-intro">Bring menu availability into a scoped investigation, a manager task and a record you can inspect.</p>
    <p className="connection-note">This local demonstration uses three fictional restaurants. Live Toast access is unavailable. Monitoring runs while this app is open.</p>
    {error && <p role="alert" className="connection-error">{error}</p>}
    {!connection && <div className="connection-card">
      <h2>Describe what you want to watch</h2>
      <label>Request<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="connection-fields">
        <label>Reported quantity threshold<input aria-label="Reported quantity threshold" type="number" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label>Service starts<input aria-label="Service starts" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Service ends<input aria-label="Service ends" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <label>Time zone<input aria-label="Time zone" value={zone} onChange={(e) => setZone(e.target.value)} /></label>
      </div>
      <p>Service days: every day. The proposal names the approved locations and read permissions. Incomplete requests stay inactive.</p>
      <button disabled={busy} onClick={() => void perform(async () => setPlan(await post('propose', {
        text, ...(threshold === '' ? {} : { threshold: Number(threshold) }),
        ...(start && end ? { serviceWindow: { start, end, timeZone: zone, days: [0, 1, 2, 3, 4, 5, 6] } } : {}),
      })))}>Prepare connection proposal</button>
    </div>}
    {plan && !connection && <div className="connection-card" aria-label="Connection proposal">
      <h2>Review the connection</h2>
      <p>Toast menu availability / {plan.plan.resources.map((item) => item.name).join(', ')}.</p>
      <p>Read selected menu items. Create a local manager task when reported quantity is at most {plan.plan.request.threshold ?? 'unspecified'} during {plan.plan.request.serviceWindow ? `${plan.plan.request.serviceWindow.start}-${plan.plan.request.serviceWindow.end} ${plan.plan.request.serviceWindow.timeZone}` : 'unspecified service hours'}.</p>
      <p>IN_STOCK means available; its quantity is not tracked. These observations do not measure ingredient inventory. Ordering and other Toast writes are unavailable.</p>
      {plan.plan.questions.length > 0 ? <ul>{plan.plan.questions.map((question) => <li key={question}>{question}</li>)}</ul>
        : <button disabled={busy} onClick={() => void perform(async () => { await post('adopt', { id: plan.plan.id, digest: plan.digest }); setPlan(null); })}>Approve synthetic connection</button>}
    </div>}
    {connection && <>
      <div className="connection-card"><div className="connection-title"><h2>{connection.connection.name}</h2><strong data-testid="connection-health">{connection.health}</strong></div>
        <p>Scope: {connection.connection.resources?.map((item) => item.name).join(', ') ?? 'Review session authority to inspect saved evidence.'}</p>
        <p>Last full refresh: {connection.connection.lastReconciledAt ?? 'No current refresh'}. Source gaps require reconciliation.</p>
        <div className="connection-actions">
          {(!data?.authorized || connection.health !== 'healthy' && connection.health !== 'stale') && <button disabled={busy} onClick={() => void perform(() => post('resume'))}>Enable synthetic connection for this session</button>}
          <button disabled={busy || !data?.authorized} onClick={() => void perform(() => post('read'))}>Refresh availability</button>
          <button disabled={busy || !data?.authorized} onClick={() => void perform(() => post('investigate'))}>Run correction demo</button>
          <button disabled={busy || !data?.authorized} onClick={() => void perform(() => post('control', { status: 'paused' }))}>Pause connection</button>
          <button disabled={busy || !data?.authorized} onClick={() => void perform(() => post('control', { status: 'disconnected' }))}>Disconnect</button>
        </div>
      </div>
      {data?.observations && <div className="connection-card"><h2>Reported availability</h2><div className="connection-table"><table><thead><tr><th>Location</th><th>Menu item</th><th>Availability</th><th>Quantity</th><th>Received</th></tr></thead><tbody>
        {data.observations.map((item) => <tr key={`${item.resourceId}/${item.key}`}><td>{connection.connection.resources?.find((r) => r.id === item.resourceId)?.name}</td><td>{String(item.facts.itemId).slice(-4)}</td><td>{String(item.facts.availability)}</td><td>{item.facts.quantityState === 'not-tracked' ? 'Not tracked' : typeof item.facts.quantity === 'number' ? item.facts.quantity : 'Unknown'}</td><td>{new Date(item.receivedAt).toLocaleTimeString()}</td></tr>)}
      </tbody></table></div></div>}
      {data?.authorized && <div className="connection-card"><h2>Signed event demonstration</h2><p>A synthetic source reports quantity 3 at Downtown. The active threshold and service hours decide whether it creates one manager task.</p><div className="connection-actions">
        <button disabled={busy} onClick={() => void perform(async () => { const next = { id: crypto.randomUUID(), at: new Date().toISOString(), quantity: 3 }; setEvent(next); await post('event', next); })}>Deliver signed stock event</button>
        <button disabled={busy || !event} onClick={() => void perform(() => post('event', event))}>Replay same event</button>
      </div>{data.inbox?.length ? <p>{data.inbox.length} durable receipt(s). {data.tasks?.length ?? 0} manager task(s).</p> : null}
      {data.tasks?.map((task) => <details key={task.id}><summary>{task.id}: {task.name}</summary><pre>{task.description}</pre></details>)}</div>}
      {data?.rules && <div className="connection-card"><h2>Rules and revisions</h2>
        <ul className="connection-rules">{data.rules.active.map((rule) => <li key={`${rule.id}/${JSON.stringify(rule.scope)}`}><strong>{rule.id} v{rule.version}</strong> / {rule.type} / {rule.enabled ? 'enabled' : 'disabled'}<p>{rule.text}</p>
          {rule.scope.connectionId && rule.enabled && <button disabled={busy} onClick={() => void perform(() => post('rules/disable', { id: rule.id }))}>Disable {rule.id}</button>}</li>)}</ul>
        <div className="connection-actions"><button disabled={busy} onClick={() => void perform(async () => setRevision(await post('rules/revise')))}>Propose improvement from corrections</button>
          <button disabled={busy} onClick={() => void perform(async () => setRevision(await post('rules/revise', { rollbackVersion: 1 })))}>Review rollback to guidance v1</button></div>
        {revision && <div aria-label="Rule revision proposal"><h3>{revision.proposal.review?.kind} proposal</h3><p>{revision.proposal.rule?.text}</p><p>{revision.proposal.preview.authority}</p>
          <p>Offline deterministic replay; no model or network call. This comparison does not predict provider compliance.</p>
          <table><thead><tr><th>Case</th><th>Before</th><th>After</th></tr></thead><tbody>{revision.proposal.review?.replay.map((row) => <tr key={row.case}><td>{row.case}</td><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table>
          <button disabled={busy} onClick={() => void perform(async () => { await post('rules/adopt', { id: revision.proposal.id, digest: revision.digest }); setRevision(null); })}>Adopt reviewed revision</button></div>}
      </div>}
      {latestRun && <div className="connection-card"><h2>Latest investigation</h2><p>{latestRun.state} / {latestRun.used.modelCalls} scripted model calls / {latestRun.used.toolCalls} tool calls</p><pre>{JSON.stringify(latestRun.result, null, 2)}</pre>
        <details><summary>Inspect raw observations, effective context and rule decisions</summary><pre>{JSON.stringify(latestRun.steps, null, 2)}</pre></details></div>}
    </>}
    <details className="connection-card"><summary>Review generated connection examples</summary>
      <p>Two unrelated OpenAPI documents use the same constrained compiler. Only reviewed fixture arguments and outputs execute. The MCP client stays within this host.</p>
      <button disabled={busy} onClick={() => void perform(async () => setCandidates(await api(`${base}/compiler`)))}>Load generated candidates</button>
      {candidates.map((candidate) => <div key={candidate.name}><h3>{candidate.label}</h3><p>Resources: {candidate.resources.map((item) => item.name).join(', ')}. Read-only local fixture.</p>
        <details><summary>Inspect candidate, schemas and provenance</summary><pre>{JSON.stringify(candidate, null, 2)}</pre></details>
        <button disabled={busy || candidate.installed} onClick={() => void perform(async () => {
          await post('compiler/activate', { name: candidate.name, previewDigest: candidate.previewDigest });
          setCandidates(await api(`${base}/compiler`));
        })}>Approve {candidate.name} fixture</button>
        <button disabled={busy || !candidate.installed || !data?.authorized} onClick={() => void perform(async () =>
          setCompilerResult(await post('compiler/run', { name: candidate.name })))}>Run {candidate.name} MCP check</button></div>)}
      {compilerResult !== null && <pre aria-label="MCP result">{JSON.stringify(compilerResult, null, 2)}</pre>}
    </details>
    <details className="connection-card"><summary>Capability boundaries</summary><p>Curated Toast fixture reads, signed local event ingress, scoped guidance and deterministic local tasks. Candidate generation and MCP roundtrips are local verification capabilities. Direct-agent internals, live Toast authentication, arbitrary generated code, ingredient counts and unattended cloud monitoring are unavailable.</p></details>
  </section>;
}
