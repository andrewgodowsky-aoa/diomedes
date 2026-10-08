import { useEffect, useRef, useState } from 'react';
import type { Conversation, Mode, Route } from '../../shared/types';
import { AUTO_AGENT, AUTO_SUMMARY } from '../../shared/agents';
import { agentChoiceOf } from '../../shared/agent-choice';
import { api } from '../api';
import { routeDisplayName } from '../../shared/engines';
import { nectoviaAgentGap } from './agent-gaps';
import { choiceView, lastPick } from './agent-ui';

/** What `GET /projects/:id/agent-profiles` returns for one profile (H09). */
interface ProfileOption {
  profileId: string;
  revision: number;
  name: string;
  engine: string;
  model: string;
  effort: string | null;
  available: boolean;
  reason: string | null;
}

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
  route: Route;
  live: boolean;
  busy: boolean;
  onPick(agentId: string): void;
  /** Picks an exact-model profile for the thread. Absent hides the profile group. */
  onPickProfile?(profileId: string): void;
}

/**
 * Who does the work (DIO-292): Auto first, then each Agent with one plain line. It sits beside the
 * model control on purpose: an Agent and a model are independent axes. An Agent that can't run
 * here is grayed with its reason. Choosing changes who works, never what they may do.
 */
export function AgentPicker({
  projectId,
  thread,
  route,
  live,
  busy,
  onPick,
  onPickProfile,
}: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<AgentListing | null>(null);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const taskQuery = thread.taskId ? `?taskId=${encodeURIComponent(thread.taskId)}` : '';
  // Read again each time the menu opens: availability follows Settings.
  useEffect(() => {
    if (!onPickProfile) return;
    let alive = true;
    api<{ profiles: ProfileOption[] }>(`/projects/${projectId}/agent-profiles${taskQuery}`)
      .then((data) => {
        if (alive) setProfiles(data.profiles);
      })
      .catch(() => {
        if (alive) setProfiles([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId, taskQuery, open, onPickProfile]);
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

  const profileId = thread.requested?.profile ?? null;
  const profile = profileId ? profiles.find((item) => item.profileId === profileId) : undefined;
  const chosenId = profileId ? null : agentChoiceOf(thread);
  // The listing puts the built-ins first, in catalog order, then the Agents a project added.
  const agents = listing?.agents ?? [];
  const chosen = chosenId && chosenId !== AUTO_AGENT ? agents.find((item) => item.id === chosenId) : undefined;
  // On Auto, the Agent it picked for the latest reply, so the box says who answered.
  const picked = chosenId === AUTO_AGENT ? lastPick(thread) : null;

  function choose(agentId: string) {
    if (live || busy) return;
    onPick(agentId);
    setOpen(false);
  }
  const entry = (item: AgentOption) => {
    // On Nectovia an Agent that changes files is grayed: a thread send there refuses that work.
    const gap = nectoviaAgentGap(item, route);
    const blocked = !item.compatibility.ok || gap !== null;
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
          {gap ??
            (blocked
              ? (item.compatibility.unmet[0]?.detail ?? "This engine can't run this agent.")
              : item.summary)}
        </small>
      </button>
    );
  };

  return (
    <div className="picker agent-picker" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Agent for this thread"
        onClick={() => setOpen(!open)}
      >
        <span className="eng">{profileId ? 'Profile' : 'Agent'}</span>
        <span className="mdl">
          {profileId
            ? (profile?.name ?? 'Unavailable profile')
            : chosenId === AUTO_AGENT
              ? 'Auto'
              : (chosen?.name ?? choiceView(thread).name)}
        </span>
        {picked && <span className="eff">{picked}</span>}
      </button>
      {open && (
        <div className="pmenu open" role="menu">
          {live ? (
            <div className="note">Waiting for the current run to finish</div>
          ) : (
            <>
              <button
                type="button"
                className={`m ${chosenId === AUTO_AGENT ? 'on' : ''}`}
                role="menuitemradio"
                aria-checked={chosenId === AUTO_AGENT}
                onClick={() => choose(AUTO_AGENT)}
              >
                <span>Auto</span>
                <span className="id">{AUTO_AGENT}</span>
                <small>{AUTO_SUMMARY}</small>
              </button>
              {agents.map(entry)}
              {onPickProfile && profiles.length > 0 && (
                <div>
                  <h4>
                    Profiles
                    <span />
                  </h4>
                  {profiles.map((item) => (
                    <button
                      key={item.profileId}
                      type="button"
                      className={`m ${item.profileId === profileId ? 'on' : ''}`}
                      role="menuitemradio"
                      aria-checked={item.profileId === profileId}
                      disabled={!item.available}
                      onClick={() => {
                        if (live || busy) return;
                        onPickProfile(item.profileId);
                        setOpen(false);
                      }}
                    >
                      <span>{item.name}</span>
                      <span className="id">r{item.revision}</span>
                      <small>
                        {item.available
                          ? `${routeDisplayName(item.engine)} · ${item.model}${item.effort ? ` · ${item.effort}` : ''}`
                          : `Unavailable: ${item.reason}`}
                      </small>
                    </button>
                  ))}
                </div>
              )}
              <div className="note">Permissions decide what each agent can do.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
