import { useEffect, useState } from 'react';
import { api } from '../api';
import { PackSettings } from './PackSettings';
import './plugins.css';

/** One entry point onto the existing pack lifecycle; no separate plugin store. */
export function PluginSettings() {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setProjects(null);
    void api<{ projects: { id: string; name: string }[] }>(
      '/projects',
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setProjects(result.projects);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Projects could not be read.');
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="plugin-settings" aria-label="Plugins">
      <p className="prose">Manage capability packs, their components, and where they are active.</p>
      <p className="caption">Installation is shared on this computer. Activation is per project.</p>
      {projects && projects.length > 0 && (
        <label className="plugin-project">
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Choose a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {projects?.length === 0 && <p>Create a project to manage its plugins.</p>}
      {!projects && !error && <p role="status">Reading projects...</p>}
      {error && (
        <div>
          <p role="alert">{error}</p>
          <button type="button" className="verb" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}
      {projects?.some((project) => project.id === projectId) && (
        // A project switch discards pending confirmations, inspected folders,
        // and responses from the previous project along with the old component.
        <PackSettings key={projectId} projectId={projectId} heading="Installed plugins" />
      )}
    </section>
  );
}
