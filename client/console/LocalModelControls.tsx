import { useEffect, useRef, useState } from 'react';
import type { Conversation, DocumentInfo, EngineModel, Mode, Route } from '../../shared/types';
import { imageMediaType, MODEL_IMAGE_COUNT } from '../../shared/model-images';
import { api, listDocuments } from '../api';
import { AgentPicker } from './AgentPicker';
import { AGENT_NAME } from '../../shared/agent-name';
import { effortFor } from '../../shared/effort';
import './local-models.css';

/** The local model's status as the host reports it. Its words are the host's. */
export interface LocalModelStatus {
  state: string;
  installed: boolean;
  mode: string | null;
  owned: boolean;
  detail: string;
}
/** One of the local model's profiles. Its name, levels, size and limits are the host's. */
export interface LocalModelProfile extends EngineModel {
  mode: string;
  engineLabel: string;
  contextTokens: number;
  inputModalities: readonly ('text' | 'image')[];
  callTimeoutMs: number;
  turnTimeoutMs: number;
}
/** What `GET /api/ai/local-models` answers. Nothing in it is written into the app. */
export interface LocalModelsView {
  route: Route;
  kind: 'local';
  status: LocalModelStatus;
  models: readonly LocalModelProfile[];
}

interface Props {
  projectId: string;
  thread: Conversation;
  route: Route;
  mode: Mode;
  busy: boolean;
  live: boolean;
  onChanged(thread: Conversation): void;
  /** Told the local model's route once the host has answered, so the page can tell it apart. */
  onRoute?(route: Route): void;
  /** Server-rendered fixture; production always reads the host. */
  initialView?: LocalModelsView;
}

/** A fresh Home has no saved thread. Provision only when the person asks to choose a local model. */
export function PrepareLocalModels({ onPrepare, onRoute }: { onPrepare(): Promise<void>; onRoute?(route: Route): void }) {
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<LocalModelsView>('/ai/local-models', 'GET', undefined, controller.signal)
      .then(view => { onRoute?.(view.route); setAvailable(view.status.installed && view.models.length > 0); })
      .catch(() => { /* Optional discovery never blocks a conversation. */ });
    return () => controller.abort();
  }, []);
  if (!available) return null;
  return <div className="local-model-controls"><button type="button" disabled={busy} onClick={() => {
    setBusy(true); setError(null);
    void onPrepare().catch((error: unknown) => setError(error instanceof Error ? error.message : 'The conversation could not be opened.'))
      .finally(() => setBusy(false));
  }}>Choose a local model</button>{error && <span role="alert">{error}</span>}</div>;
}

/**
 * Optional native model controls for the Home conversation, which has no ask row yet. Labels,
 * efforts and capabilities come from the host catalogue. Choosing a profile, a level or an Agent
 * only saves the choice; Start is the one control that wakes the model, as in the ask row.
 */
export function LocalModelControls({ projectId, thread, route, mode, busy, live, onChanged, onRoute, initialView }: Props) {
  const [view, setView] = useState<LocalModelsView | null>(initialView ?? null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const selected = view?.route === route;
  const profile = selected ? view?.models.find(model => model.slug === thread.requested?.model) : undefined;

  useEffect(() => {
    const controller = new AbortController();
    active.current = null; setWorking(false); setError(null);
    const refresh = () => {
      void api<LocalModelsView>('/ai/local-models', 'GET', undefined, controller.signal)
        .then(setView).catch((error: unknown) => {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Local models could not be checked.');
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); active.current?.abort(); window.removeEventListener('focus', refresh); };
  }, [projectId, thread.id]);
  useEffect(() => { if (view) onRoute?.(view.route); }, [view?.route]);

  /** Saves the thread's profile, level and Agent. It starts nothing. */
  async function change(modelId: string, effort?: string, agent = thread.requested?.agent ?? null) {
    const model = view?.models.find(item => item.slug === modelId);
    if (!view || !model || busy || live || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setWorking(true); setError(null);
    try {
      onChanged(await api<Conversation>(`/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}`,
        'PUT', { engine: view.route, requested: { model: model.slug,
          effort: effort ?? model.defaultEffort, ...(agent ? { agent } : {}) } }, controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The model choice could not be saved.');
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  /** The person's Start: the one control here that wakes the model, on the thread's profile. */
  async function start(modelId: string) {
    const model = view?.models.find(item => item.slug === modelId);
    if (!view || !model || busy || live || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setWorking(true); setError(null);
    try {
      setView(current => current ? { ...current, status: { state: 'starting', installed: true,
        owned: false, mode: model.mode, detail: `Starting ${model.name}.` } } : current);
      const status = await api<LocalModelStatus>('/ai/local-models/wake', 'POST', { model: model.slug }, controller.signal);
      setView(current => current ? { ...current, status } : current);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'The local model could not be loaded.');
        try { setView(await api<LocalModelsView>('/ai/local-models', 'GET', undefined, controller.signal)); }
        catch { /* The action's original failure stays visible. */ }
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  async function online() {
    if (busy || live || active.current) return;
    const controller = new AbortController(); active.current = controller; setWorking(true); setError(null);
    try {
      onChanged(await api<Conversation>(`/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}`,
        'PUT', { engine: 'nectovia', requested: thread.requested?.agent
          ? { model: null, effort: null, agent: thread.requested.agent } : null }, controller.signal));
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The model choice could not be saved.'); }
    finally { if (active.current === controller) active.current = null; if (!controller.signal.aborted) setWorking(false); }
  }

  if (!view || (!view.status.installed && !selected)) return null;
  const locked = busy || live || working;
  const level = profile ? effortFor(mode, thread.requested?.effort, profile.defaultEffort ?? '') : '';
  const ready = profile && view.status.mode === profile.mode && view.status.state === 'ready';
  const recorded = [...thread.turns].reverse().find(turn => turn.context?.route === route
    && turn.context.model === profile?.slug)?.context?.provider?.firstCallInputTokens;
  return <div className="local-model-controls" aria-label="Local model controls">
    <div className="local-model-row">
      {selected && <span className="local-engine">{profile?.engineLabel ?? AGENT_NAME}</span>}
      <select aria-label="Local model" disabled={locked || !view.status.installed}
        value={selected ? thread.requested?.model ?? '' : ''} onChange={e => void change(e.target.value)}>
        <option value="">{selected ? 'Choose a local model' : 'Local model'}</option>
        {view.models.map(model => <option key={model.slug} value={model.slug}>{model.name}</option>)}
      </select>
      {profile && <>
        <select aria-label="Local reasoning effort" value={level} disabled={locked}
          title={mode === 'fix' ? 'Fix caps the reasoning level.' : 'Reasoning effort'}
          onChange={e => void change(profile.slug, e.target.value)}>
          {profile.efforts.map(effort => <option key={effort.id} value={effort.id} disabled={effortFor(mode, effort.id, effort.id) !== effort.id}>
            {'label' in effort ? String(effort.label) : effort.id}
          </option>)}
        </select>
        <AgentPicker projectId={projectId} thread={thread} mode={mode} route={route} live={live} busy={locked}
          onPick={agent => void change(profile.slug, level, agent)} />
        <span className="local-context" title={`${profile.contextTokens.toLocaleString('en-US')} token context. ${recorded == null ? 'Usage not measured yet.' : `${recorded.toLocaleString('en-US')} tokens reported on the last message.`} ${profile.inputModalities.includes('image') ? 'Text and images.' : 'Text only.'}`}>
          <svg width="18" height="18" viewBox="0 0 20 20" role="img" aria-label={`${profile.contextTokens.toLocaleString('en-US')} token context`}>
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity=".25" />
            {recorded != null && <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2"
              strokeDasharray={`${Math.min(1, recorded / profile.contextTokens) * 50.27} 50.27`} transform="rotate(-90 10 10)" />}
          </svg>
          {profile.contextTokens.toLocaleString('en-US')}
        </span>
        {!ready && !working && <button type="button" disabled={locked} onClick={() => void start(profile.slug)}>Start</button>}
      </>}
      {selected && <button type="button" disabled={locked} onClick={() => void online()}>Use online</button>}
    </div>
    {selected && <span className="local-model-status" role="status">{view.status.detail}</span>}
    {profile && profile.callTimeoutMs > 240_000 && <span className="local-model-status">
      Higher effort can take several minutes. Each model call stops after {profile.callTimeoutMs / 60_000} minutes,
      and a message after {profile.turnTimeoutMs / 60_000} minutes.
    </span>}
    {error && <span className="local-model-error" role="alert">{error}</span>}
  </div>;
}

/** Home uses the same project-file attachment path as Work, with no URL or additional file authority. */
export function LocalImageAttachments({ projectId, route, model, paths, onPaths, busy }: {
  projectId: string; route: Route; model: string | null; paths: readonly string[];
  onPaths(paths: string[]): void; busy: boolean;
}) {
  const [view, setView] = useState<LocalModelsView | null>(null);
  const [files, setFiles] = useState<DocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<LocalModelsView>('/ai/local-models', 'GET', undefined, controller.signal).then(setView)
      .catch(() => { if (!controller.signal.aborted) setView(null); });
    return () => controller.abort();
  }, [route, model]);
  const images = view?.route === route && view.models.some(profile => profile.slug === model && profile.inputModalities.includes('image'));
  if (!images && !paths.length) return null;
  return <div className="local-image-attachments">
    {images && <button type="button" disabled={busy || paths.length >= MODEL_IMAGE_COUNT} onClick={() => {
      setError(null);
      void listDocuments(projectId).then(result => setFiles(result.documents.filter(file => imageMediaType(file.path))))
        .catch((error: unknown) => setError(error instanceof Error ? error.message : 'Project images could not be read.'));
    }}>Attach image</button>}
    {images && files && <select aria-label="Project image" disabled={busy} value="" onChange={e => {
      if (e.target.value && !paths.includes(e.target.value) && paths.length < MODEL_IMAGE_COUNT) onPaths([...paths, e.target.value]);
      setFiles(null);
    }}><option value="">Choose an image from Files</option>{files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select>}
    {files?.length === 0 && <span>No project images. Add an image in Files first.</span>}
    {paths.map(path => <button key={path} type="button" disabled={busy} title="Remove image" onClick={() => onPaths(paths.filter(item => item !== path))}>{path} (remove)</button>)}
    {!images && paths.length > 0 && <span role="alert">The selected model cannot receive these images. Choose an image model or remove them.</span>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
