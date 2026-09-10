import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  PERMISSION_PRESETS,
  type ScopeGrantCommand,
  type ScopeGrantView,
} from '../../shared/permissions';

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
  const [roots, setRoots] = useState('.');
  const [maxWrites, setMaxWrites] = useState(40);
  const [maxBytes, setMaxBytes] = useState(5_242_880);
  const [ttlMinutes, setTtlMinutes] = useState(60);
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
    api<{ grants: ScopeGrantView[] }>(base).then(
      (response) => {
        if (current) setGrants(response.grants);
      },
      (failure: unknown) => {
        if (current)
          setError(failure instanceof Error ? failure.message : 'Could not read task scopes.');
      },
    );
    return () => {
      current = false;
    };
  }, [base]);
  const matching = grants.filter((record) => record.grant.taskId === taskId);
  const active = matching.filter((record) => record.active);
  async function confirm() {
    if (!taskId || engine !== 'codex' || busy) return;
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
          review: 'human',
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
      <div className="permission-presets">
        {PERMISSION_PRESETS.map((preset) => (
          <div key={preset.id}>
            <strong>
              {preset.name}
              {preset.id === 'project' ? ' - recommended' : ''}
            </strong>
            <p>{preset.detail}</p>
            {!preset.supported && (
              <button type="button" disabled title={preset.detail}>
                Unavailable
              </button>
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
          <strong>Allowed for this task</strong>
          <span>
            {record.grant.roots.join(', ')} · until{' '}
            {new Date(record.grant.expiresAt).toLocaleTimeString()}
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
      ) : (
        <>
          <p>
            <strong>Confirm for this task:</strong> create or update supported text files in{' '}
            <strong>
              {roots.trim() === '.'
                ? 'the whole project'
                : roots
                    .split('\n')
                    .map((root) => root.trim())
                    .filter(Boolean)
                    .join(', ') || '(choose a folder)'}
            </strong>
            , via Codex using its ChatGPT account. This covers the current waiting proposal and
            future proposals for this same task.
          </p>
          <p>
            Up to <strong>{maxWrites} file writes</strong> and{' '}
            <strong>{maxBytes.toLocaleString()} output bytes</strong>, expiring after{' '}
            <strong>{ttlMinutes} minutes</strong> or on host restart. Sending context needs separate
            consent.
          </p>
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
            No command execution, deletion, installations, external destinations, billing changes or
            automatic reviewer. This local prototype does not authenticate a human or device.
          </p>
          <button type="button" className="verb go" disabled={busy} onClick={() => void confirm()}>
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
    </section>
  );
}
