import { useEffect, useRef, useState } from 'react';
import type { Conversation, Mode, Route } from '../../shared/types';
import { AUTO_AGENT, AUTO_BY_MODE } from '../../shared/agents';
import { api } from '../api';

/** What `GET /projects/:id/agents` returns for one Agent. */
interface AgentOption {
  id: string;
  version: string;
  name: string;
  summary: string;
  origin: 'built-in' | 'user' | 'project';
  permissionCeiling: string;
  modes: Mode[];
  compatibility: { ok: boolean; unmet: { requirement: string; detail: string }[] };
}
interface AgentListing {
  route: string;
  auto: string;
  agents: AgentOption[];
}

interface AgentPickerProps {
  projectId: string;
  thread: Conversation;
  mode: Mode;
  route: Route;
  live: boolean;
  busy: boolean;
  onPick(agentId: string | null): void;
}

/**
 * Which worker does this. It sits beside the model control on purpose: an Agent
 * and a model are independent axes, and the same `Code Reviewer` runs through
 * whichever compatible model is selected.
 *
 * Choosing here changes who works, never what they may do. That sentence is in
 * the menu rather than a tooltip: it is the one thing a person must not have to
 * hover to learn.
 */
export function AgentPicker({
  projectId,
  thread,
  mode,
  route,
  live,
  busy,
  onPick,
}: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<AgentListing | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api<AgentListing>(`/projects/${projectId}/agents?route=${encodeURIComponent(route)}`)
      .then((data) => {
        if (alive) setListing(data);
      })
      .catch(() => {
        if (alive) setListing(null);
      });
    return () => {
      alive = false;
    };
  }, [projectId, route]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const agents = listing?.agents ?? [];
  const chosenId = thread.requested?.agent ?? null;
  const chosen = chosenId ? agents.find((item) => item.id === chosenId) : undefined;
  // What Auto resolves to for the current mode, shown so the person can see it
  // before starting rather than only in the record afterwards.
  const autoName = agents.find((item) => item.id === AUTO_BY_MODE[mode])?.name ?? '';
  const forMode = (item: AgentOption) => item.modes.includes(mode);

  function choose(agentId: string | null) {
    if (live || busy) return;
    onPick(agentId);
    setOpen(false);
  }
  const entry = (item: AgentOption) => {
    const blocked = !item.compatibility.ok;
    return (
      <button
        key={item.id}
        type="button"
        className={`m ${item.id === chosenId ? 'on' : ''}`}
        role="menuitemradio"
        aria-checked={item.id === chosenId}
        disabled={blocked}
        onClick={() => choose(item.id)}
      >
        <span>{item.name}</span>
        <span className="id">{item.origin === 'built-in' ? item.id : item.origin}</span>
        <small>
          {blocked
            ? (item.compatibility.unmet[0]?.detail ?? 'This engine cannot support this worker.')
            : item.summary}
        </small>
      </button>
    );
  };
  const fits = agents.filter(forMode);
  const rest = agents.filter((item) => !forMode(item));

  return (
    <div className="picker agent-picker" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Worker for this thread"
        title="Which worker does this. It does not change what the worker may do."
        onClick={() => setOpen(!open)}
      >
        <span className="eng">Agent</span>
        <span className="mdl">{chosen?.name ?? 'Auto'}</span>
        {!chosen && autoName && <span className="eff">{autoName}</span>}
      </button>
      {open && (
        <div className="pmenu open" role="menu">
          {live ? (
            <div className="note">Waiting for the current run to finish</div>
          ) : (
            <>
              <button
                type="button"
                className={`m ${!chosenId ? 'on' : ''}`}
                role="menuitemradio"
                aria-checked={!chosenId}
                onClick={() => choose(null)}
              >
                <span>Auto</span>
                <span className="id">{AUTO_AGENT}</span>
                <small>
                  {autoName
                    ? `Diomedes picks the worker for the mode. In ${mode} that is ${autoName}.`
                    : 'Diomedes picks the worker for the mode.'}
                </small>
              </button>
              {fits.length > 0 && (
                <div>
                  <h4>
                    For {mode}
                    <span />
                  </h4>
                  {fits.map(entry)}
                </div>
              )}
              {rest.length > 0 && (
                <div>
                  <h4>
                    Other workers
                    <span />
                  </h4>
                  {rest.map(entry)}
                </div>
              )}
              {agents.length === 0 && <p className="note">No workers are available here.</p>}
              <div className="note">
                <b>Choosing a worker does not change what it may do.</b> Permissions decide that,
                and each worker may be narrower still.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
