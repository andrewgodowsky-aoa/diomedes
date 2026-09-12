import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PackSettings } from './PackSettings';
import {
  type PermissionCapabilityView,
  type PermissionChoiceId,
  type ScopeGrantCommand,
  type ScopeGrantView,
} from '../../shared/permissions';
import { ROUTE_CAPABILITIES } from '../../shared/capabilities';

export interface PermissionPanelProps {
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskName: string | null;
  engine: string;
  onChange(): void;
  onClose?(): void;
}
/** Task authority is confirmed here, independently of density, effort and engine pickers. */
export function PermissionPanel({
  projectId,
  projectName,
  taskId,
  taskName,
  engine,
  onChange,
  onClose,
}: PermissionPanelProps) {
  const [grants, setGrants] = useState<ScopeGrantView[]>([]);
  const [capabilities, setCapabilities] = useState<PermissionCapabilityView | null>(null);
  const [choice, setChoice] = useState<PermissionChoiceId>('project');
  const [roots, setRoots] = useState('.');
  const [maxWrites, setMaxWrites] = useState(40);
  const [maxBytes, setMaxBytes] = useState(5_242_880);
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [reviewerModel, setReviewerModel] = useState('');
  const [maxReviews, setMaxReviews] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; command: ScopeGrantCommand } | null>(null);
  const base = `/projects/${projectId}/permissions/grants`;
  async function refresh() {
    const response = await api<{ grants: ScopeGrantView[] }>(base);
    setGrants(response.grants);
  }
  useEffect(() => {
    let current = true;
    Promise.all([
      api<{ grants: ScopeGrantView[] }>(base),
      api<PermissionCapabilityView>(
        `/projects/${projectId}/permissions/capabilities?route=${encodeURIComponent(engine)}`,
      ),
    ]).then(
      ([saved, available]) => {
        if (!current) return;
        setGrants(saved.grants);
        setCapabilities(available);
      },
      (failure: unknown) => {
        if (current)
          setError(failure instanceof Error ? failure.message : 'Could not read task scopes.');
      },
    );
    return () => {
      current = false;
    };
  }, [base, projectId, engine]);
  /**
   * Why an option is off, in the person's terms.
   *
   * `Work in this project` and `Approve for me` are refused for every route but
   * Codex, because a scoped automatic write has a verified boundary on that
   * route and nowhere else (`server/permission-routes.ts`). That is a fact
   * about the route, not a fault in the account: a signed-in, ready OpenCode
   * reads exactly the same. The bare word "Unavailable" said the opposite, so
   * the scope-backed options name the route instead, and say the one thing that
   * changes the answer.
   */
  const scopeOnCodexOnly =
    !!capabilities && capabilities.routeId !== 'codex' && capabilities.routeId !== 'unknown';
  const scopeBacked = (id: PermissionChoiceId) => id === 'project' || id === 'auto-review';
  const offState = (id: PermissionChoiceId) =>
    scopeOnCodexOnly && scopeBacked(id) ? 'Codex only' : 'Unavailable';
  const routeName = ROUTE_CAPABILITIES[capabilities?.routeId ?? '']?.name ?? engine;
  const matching = grants.filter((record) => record.grant.taskId === taskId);
  const active = matching.filter((record) => record.active);
  const choices = capabilities?.choices ?? [];
  const selected = choices.find((item) => item.id === choice);
  const reviewer = capabilities?.reviewer;
  const scoping = choice === 'project' || choice === 'auto-review';
  const namedRoots =
    roots.trim() === '.'
      ? 'the whole project'
      : roots
          .split('\n')
          .map((root) => root.trim())
          .filter(Boolean)
          .join(', ') || '(choose a folder)';
  async function confirm() {
    if (!taskId || engine !== 'codex' || busy || !scoping || !selected?.available) return;
    setBusy(true);
    setError('');
    const input = {
      taskId,
      roots: roots
        .split('\n')
        .map((root) => root.trim())
        .filter(Boolean),
      maxWrites,
      maxBytes,
      ttlMinutes,
      review: choice === 'auto-review' ? ('model-reviewer' as const) : ('human' as const),
      ...(choice === 'auto-review'
        ? { reviewer: { requestedModel: reviewerModel.trim() || null, maxReviews } }
        : {}),
    };
    const key = JSON.stringify(input);
    if (pending.current?.key !== key)
      pending.current = {
        key,
        command: {
          protocolVersion: 2,
          commandId: crypto.randomUUID(),
          ...input,
          operations: ['text.create', 'text.modify'],
          engine: 'codex',
          accountRoute: 'codex:chatgpt',
        },
      };
    try {
      await api(base, 'POST', pending.current.command);
      pending.current = null;
      await refresh();
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not confirm this scope.');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(ids: string[]) {
    setBusy(true);
    setError('');
    try {
      for (const id of ids) await api(`${base}/${id}/revoke`, 'POST', {});
      await refresh();
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not revoke this scope.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="permission-panel" aria-label="Task permissions">
      <div className="permission-panel-title">
        <strong>
          {projectName}
          {taskName ? ` / ${taskName}` : ''}
        </strong>
        {onClose && (
          <button type="button" className="verb" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <div className="permission-presets" role="radiogroup" aria-label="Permission for this task">
        {choices.map((preset) => (
          <div key={preset.id} className={preset.available ? '' : 'is-unavailable'}>
            <label className="permission-choice">
              <input
                type="radio"
                name="permission-choice"
                value={preset.id}
                checked={choice === preset.id}
                disabled={!preset.available}
                onChange={() => setChoice(preset.id)}
              />
              <strong>{preset.name}</strong>
              {!preset.available && <em>{offState(preset.id)}</em>}
              {preset.id === 'project' && preset.available && <em>recommended</em>}
            </label>
            <p>{preset.detail}</p>
            {!preset.available && <p className="permission-why">{preset.unavailableReason}</p>}
            {!preset.available && scopeOnCodexOnly && scopeBacked(preset.id) && (
              <p className="permission-why">
                This is about the route, not about the {routeName} connection: only Codex has a
                verified boundary for scoped automatic writes. Set this thread to Codex in the
                engine picker, or connect Codex in Settings &gt; Engines. Review changes stays
                available on {routeName}.
              </p>
            )}
            {(choice === preset.id || !preset.available) && (
              <ul className="permission-points">
                {preset.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            )}
            {preset.id === 'full' && (
              <>
                <p>
                  <strong>Which environment would receive this?</strong>{' '}
                  {capabilities?.environments.length
                    ? capabilities.environments.map((item) => item.name).join(', ')
                    : 'None. There is no isolated environment on this installation to give unrestricted authority to.'}
                </p>
                {!preset.available && (
                  <details>
                    <summary>What it would take</summary>
                    <p className="permission-why">{capabilities?.noEnvironmentReason}</p>
                    <ul className="permission-points">
                      {(capabilities?.fullAccess.unmet ?? []).map((item) => (
                        <li key={item.id}>{item.detail}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {preset.id === 'review' && (
              <button
                type="button"
                className="verb"
                disabled={busy || !active.length}
                onClick={() => void revoke(active.map((record) => record.grant.id))}
              >
                Use Review changes
              </button>
            )}
          </div>
        ))}
      </div>
      {active.map((record) => (
        <div className="permission-active" key={record.grant.id}>
          <strong>
            {record.grant.review === 'model-reviewer'
              ? 'Allowed for this task, reviewer first'
              : 'Allowed for this task'}
          </strong>
          <span>
            {record.grant.roots.join(', ')} · until{' '}
            {new Date(record.grant.expiresAt).toLocaleTimeString()}
            {record.grant.reviewer
              ? ` · reviewer ${record.grant.reviewer.requestedModel ?? 'runtime default'}, up to ${record.grant.reviewer.maxReviews} checks`
              : ''}
          </span>
          <button
            type="button"
            className="verb"
            disabled={busy}
            onClick={() => void revoke([record.grant.id])}
          >
            Revoke and stop
          </button>
        </div>
      ))}
      {!taskId ? (
        <p>
          Create or select a task before confirming its scope. A new task needs its own authority.
        </p>
      ) : engine !== 'codex' ? (
        <p>
          Scoped writes are currently available for Codex text proposals. This engine's containment
          boundary has not been verified for this mode.
        </p>
      ) : choice === 'review' ? (
        <p>
          Review changes needs no confirmation. It is what happens when this task has no scope, and
          revoking one returns you to it.
        </p>
      ) : (
        <>
          <p>
            <strong>Confirm for this task:</strong> create or update supported text files in{' '}
            <strong>{namedRoots}</strong>, via Codex using its ChatGPT account.
            {choice === 'auto-review'
              ? ' Each change set goes to the reviewer first; only its approval applies one without you.'
              : ' This covers the current waiting proposal and future proposals for this same task.'}
          </p>
          <p>
            Up to <strong>{maxWrites} file writes</strong> and{' '}
            <strong>{maxBytes.toLocaleString()} output bytes</strong>, expiring after{' '}
            <strong>{ttlMinutes} minutes</strong> or on host restart. Sending context needs separate
            consent.
          </p>
          {choice === 'auto-review' && reviewer && (
            <>
              <label>
                Reviewer model
                <select
                  value={reviewerModel}
                  onChange={(event) => setReviewerModel(event.target.value)}
                >
                  <option value="">Runtime default</option>
                  {reviewer.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reviewer checks this scope may spend{' '}
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={maxReviews}
                  onChange={(event) => setMaxReviews(Number(event.target.value))}
                />
              </label>
              <p className="permission-why">{reviewer.independence}</p>
              <p>
                A reviewer check is a separate request on your Codex account, up to{' '}
                {Math.round(reviewer.timeoutMs / 1000)} seconds each. Confirming here is the consent
                for those {maxReviews} checks and nothing else.
              </p>
            </>
          )}
          <details>
            <summary>Edit scope and limits</summary>
            <label>
              Folders inside this project, one per line. A dot means the whole project.
              <textarea value={roots} onChange={(event) => setRoots(event.target.value)} rows={3} />
            </label>
            <label>
              Maximum files written{' '}
              <input
                type="number"
                min={1}
                max={200}
                value={maxWrites}
                onChange={(event) => setMaxWrites(Number(event.target.value))}
              />
            </label>
            <label>
              Maximum output bytes{' '}
              <input
                type="number"
                min={1}
                max={25_165_824}
                value={maxBytes}
                onChange={(event) => setMaxBytes(Number(event.target.value))}
              />
            </label>
            <label>
              Expires after minutes{' '}
              <input
                type="number"
                min={1}
                max={480}
                value={ttlMinutes}
                onChange={(event) => setTtlMinutes(Number(event.target.value))}
              />
            </label>
          </details>
          <p>
            No command execution, deletion, installations, external destinations or billing changes.
            This local prototype does not authenticate a human or device.
          </p>
          <button
            type="button"
            className="verb go"
            disabled={busy || !selected?.available}
            onClick={() => void confirm()}
          >
            {busy ? 'Saving...' : 'Confirm task scope'}
          </button>
        </>
      )}
      {matching
        .filter((record) => !record.active)
        .map((record) => (
          <p key={record.grant.id}>{record.reason}</p>
        ))}
      <p>
        Revocation blocks future scoped writes and asks owned work to stop. Effects already
        dispatched may finish; History can restore supported file versions after checking current
        contents.
      </p>
      {error && <p role="alert">{error}</p>}
      {/* Capabilities sit under authority and are not part of it: activating a
          pack changes what Diomedes is good at and grants nothing. */}
      <PackSettings projectId={projectId} onChange={onChange} />
    </section>
  );
}
