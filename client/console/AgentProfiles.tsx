import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Mark } from '../components';
import { AGENT_CATALOG, AUTO_AGENT } from '../../shared/agents';
import { ROUTES, routeDisplayName } from '../../shared/engines';
import { PROFILE_MAX_RULES } from '../../shared/agent-profiles';
import './agent-profiles.css';

/**
 * Settings > Agent profiles (H09), in the Settings > Engines language: one
 * hairline-topped section per profile, its state mark, the exact route and
 * model in mono, and the reason a profile cannot run stated where it is listed.
 *
 * Saving an edit makes a new revision. A run that was already admitted keeps
 * the revision it pinned; the run's own details show which one.
 */
interface ProfileRow {
  profileId: string;
  revision: number;
  name: string;
  engine: string;
  model: string;
  effort: string | null;
  agentId: string;
  rules: string[];
  digest: string;
  available?: boolean;
  reason?: string | null;
}
interface Listing {
  profiles: ProfileRow[];
  routing: { order: string[]; fallback: boolean; source: string };
}
interface Draft {
  profileId: string | null;
  expectedRevision: number | null;
  name: string;
  engine: string;
  model: string;
  effort: string;
  agentId: string;
  rules: string;
}
const EMPTY: Draft = {
  profileId: null,
  expectedRevision: null,
  name: '',
  engine: 'codex',
  model: '',
  effort: '',
  agentId: AUTO_AGENT,
  rules: '',
};
const ROUTE_CHOICES = ROUTES.filter((route) => route !== 'sample');
const agentName = (id: string) =>
  id === AUTO_AGENT ? 'Auto' : (AGENT_CATALOG.find((item) => item.id === id)?.name ?? id);

export function AgentProfiles() {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [listing, setListing] = useState<Listing | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [order, setOrder] = useState<string[]>([]);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    void api<{ projects: { id: string; name: string }[] }>('/projects')
      .then((data) => {
        setProjects(data.projects);
        setProjectId((current) => current || data.projects[0]?.id || '');
      })
      .catch(() => setProjects([]));
  }, []);
  const load = useCallback(async () => {
    const data = projectId
      ? await api<Listing>(`/projects/${projectId}/agent-profiles`)
      : {
          ...(await api<{ profiles: ProfileRow[] }>('/agent-profiles')),
          routing: { order: [], fallback: false, source: 'project' },
        };
    setListing(data);
    setOrder(data.routing.source === 'project' ? data.routing.order : []);
    setFallback(data.routing.source === 'project' ? data.routing.fallback : false);
  }, [projectId]);
  useEffect(() => {
    void load().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'Profiles could not be read.'),
    );
  }, [load]);

  const act = (step: () => Promise<unknown>) => {
    setError('');
    void step()
      .then(load)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'That did not save.'));
  };
  function save(value: Draft) {
    const body = {
      name: value.name,
      engine: value.engine,
      model: value.model,
      effort: value.effort.trim() || null,
      agentId: value.agentId,
      rules: value.rules
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
    act(async () => {
      if (value.profileId)
        await api(`/agent-profiles/${value.profileId}`, 'PUT', {
          ...body,
          expectedRevision: value.expectedRevision,
        });
      else await api('/agent-profiles', 'POST', body);
      setDraft(null);
    });
  }
  const profiles = listing?.profiles ?? [];
  const move = (index: number, by: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    setOrder(next);
  };

  return (
    <div className="agent-profiles">
      <p className="prose">
        A profile is one exact model on one route, the Agent it works as, and your rules for it.
        Saving an edit makes a new revision; a run that already started keeps the one it used.
      </p>
      {error && <p role="alert">{error}</p>}
      {!draft && (
        <div className="row choice-row">
          <Button onClick={() => setDraft({ ...EMPTY })}>New profile</Button>
        </div>
      )}
      {draft && <ProfileEditor draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}
      <div className="service-list">
        {profiles.length === 0 && <p className="caption">No profiles yet.</p>}
        {profiles.map((item) => (
          <section className="service" key={item.profileId} aria-label={`Profile ${item.name}`}>
            <div className="row">
              <h3>
                <Mark state={item.available === false ? 'todo' : 'done'} />
                {item.name}
              </h3>
              <span className="caption push-right">Revision {item.revision}</span>
            </div>
            <p className="code caption profile-line">
              {routeDisplayName(item.engine)} · {item.model}
              {item.effort ? ` · ${item.effort}` : ''} · {agentName(item.agentId)}
            </p>
            {item.available === false && (
              <p className="profile-unavailable">Unavailable: {item.reason}</p>
            )}
            {item.rules.length > 0 && (
              <ul className="profile-rules">
                {item.rules.map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
            )}
            <div className="row choice-row">
              <Button
                onClick={() =>
                  setDraft({
                    profileId: item.profileId,
                    expectedRevision: item.revision,
                    name: item.name,
                    engine: item.engine,
                    model: item.model,
                    effort: item.effort ?? '',
                    agentId: item.agentId,
                    rules: item.rules.join('\n'),
                  })
                }
              >
                Edit
              </Button>
              <Button onClick={() => act(() => api(`/agent-profiles/${item.profileId}`, 'DELETE'))}>
                Delete
              </Button>
            </div>
          </section>
        ))}
      </div>
      {projects.length > 0 && profiles.length > 0 && (
        <section className="profile-routing" aria-label="Project routing">
          <h2>Project routing</h2>
          <label className="field">
            Project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <p className="caption">
            Runs in this project use the first profile listed, unless a thread picks its own
            profile, model or tier.
          </p>
          <ol className="profile-order">
            {order.map((id, index) => (
              <li key={id}>
                <span className="profile-line">
                  {profiles.find((item) => item.profileId === id)?.name ?? `${id} (deleted)`}
                </span>
                <Button aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </Button>
                <Button
                  aria-label="Move down"
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button onClick={() => setOrder(order.filter((item) => item !== id))}>Remove</Button>
              </li>
            ))}
          </ol>
          <div className="row choice-row">
            <select
              aria-label="Add a profile to the routing list"
              value=""
              onChange={(e) => e.target.value && setOrder([...order, e.target.value])}
            >
              <option value="">Add a profile…</option>
              {profiles
                .filter((item) => !order.includes(item.profileId))
                .map((item) => (
                  <option key={item.profileId} value={item.profileId}>
                    {item.name}
                  </option>
                ))}
            </select>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={fallback}
              onChange={(e) => setFallback(e.target.checked)}
            />
            Fall back to the next profile when one cannot run
          </label>
          <p className="caption">
            {fallback
              ? 'Every fallback is recorded on the run with the profile it skipped and why.'
              : 'Off: when the first profile cannot run, the run is refused by name.'}
          </p>
          <Button
            onClick={() =>
              act(() => api(`/projects/${projectId}/agent-routing`, 'PUT', { order, fallback }))
            }
          >
            Save routing
          </Button>
        </section>
      )}
    </div>
  );
}

function ProfileEditor({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange(next: Draft): void;
  onSave(value: Draft): void;
  onCancel(): void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <form
      className="profile-editor"
      aria-label={draft.profileId ? 'Edit profile' : 'New profile'}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <label className="field">
        Name
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
      </label>
      <label className="field">
        Route
        <select value={draft.engine} onChange={(e) => set({ engine: e.target.value })}>
          {ROUTE_CHOICES.map((route) => (
            <option key={route} value={route}>
              {routeDisplayName(route)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Model id, exactly as the route lists it
        <input
          className="code"
          value={draft.model}
          onChange={(e) => set({ model: e.target.value })}
          maxLength={120}
          spellCheck={false}
        />
      </label>
      <label className="field">
        Reasoning level (optional)
        <input
          className="code"
          value={draft.effort}
          onChange={(e) => set({ effort: e.target.value })}
          maxLength={40}
          spellCheck={false}
        />
      </label>
      <label className="field">
        Works as
        <select value={draft.agentId} onChange={(e) => set({ agentId: e.target.value })}>
          <option value={AUTO_AGENT}>Auto</option>
          {AGENT_CATALOG.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Rules, one per line (up to {PROFILE_MAX_RULES})
        <textarea value={draft.rules} rows={3} onChange={(e) => set({ rules: e.target.value })} />
      </label>
      <div className="row choice-row">
        <Button type="submit" tone="primary">
          {draft.profileId ? `Save as revision ${(draft.expectedRevision ?? 0) + 1}` : 'Save profile'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
