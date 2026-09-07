import { useState } from 'react';
import type { IntegrationStatus, Settings as SettingsModel } from '../shared/types';
import {
  Button,
  Mark,
  Modal,
  detailDescriptions,
  surfaceDescriptions,
  surfaceOf,
  titleCase,
} from './components';

export function SettingsPage({
  settings,
  save,
  integrations,
  refresh,
}: {
  settings: SettingsModel;
  save: (value: SettingsModel) => Promise<void>;
  integrations: IntegrationStatus[];
  refresh: () => void;
}) {
  const [section, setSection] = useState('Interface detail');
  const [disclosure, setDisclosure] = useState<IntegrationStatus | null>(null);
  const surface = surfaceOf(settings);
  const isDesk = surface === 'desk';
  const sections = [
    'Interface detail',
    'Helpers on this computer',
    'Permissions',
    'History',
    'Appearance',
    'About',
    ...(isDesk ? ['Engines', 'Rules', 'Developer'] : []),
  ];
  return (
    <div className="settings-layout">
      <nav className="rail" aria-label="Settings">
        {sections.map((s) => (
          <button
            key={s}
            className={`rail-link ${s === section ? 'active' : ''}`}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </nav>
      <main className="main">
        <header className="page-header">
          <h1>{section}</h1>
          <span className="caption">Settings</span>
        </header>
        <div className="book-layout">
          <div className="reading">
            {section === 'Interface detail' && (
              <>
                <p className="prose">
                  Choose how Diomedes lays out your work and how much detail the Book shows.
                </p>
                <h2>Surface</h2>
                <div className="radio-list">
                  {(['book', 'desk'] as const).map((s) => (
                    <label key={s} className={`radio-row ${surface === s ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="settings-surface"
                        checked={surface === s}
                        onChange={() =>
                          void save({
                            ...settings,
                            surface: s,
                            ...(s === 'book' && settings.detail === 'technical'
                              ? { detail: 'standard' }
                              : {}),
                          })
                        }
                      />
                      <span>
                        <strong>The {titleCase(s)}</strong>
                        <span className="caption">{surfaceDescriptions[s]}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {surface === 'book' && (
                  <>
                    <h2>Detail</h2>
                    <div className="radio-list">
                      {(['guided', 'standard'] as const).map((d) => (
                        <label
                          key={d}
                          className={`radio-row ${settings.detail === d ? 'selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="settings-detail"
                            checked={settings.detail === d}
                            onChange={() => void save({ ...settings, detail: d, surface: 'book' })}
                          />
                          <span>
                            <strong>{titleCase(d)}</strong>
                            <span className="caption">{detailDescriptions[d]}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
                <section className="block">
                  <h3>Same work, two surfaces</h3>
                  <p className="prose">
                    Documents, tasks, approvals and History stay in place when you switch. Every
                    decision is still yours.
                  </p>
                </section>
              </>
            )}
            {(section === 'Helpers on this computer' || section === 'Engines') && (
              <>
                {section === 'Engines' ? (
                  <p className="prose">
                    Diomedes uses AI services to do work. Here is which ones, and what is sent.
                  </p>
                ) : (
                  <p className="prose">
                    Diomedes can use these to do work. Here is which ones it found, and what each
                    one sends.
                  </p>
                )}
                <Button onClick={refresh}>Check connections</Button>
                <div className="service-list">
                  {(settings.detail === 'guided' && !isDesk
                    ? integrations.filter((s) => s.adapter === 'ready')
                    : integrations
                  ).map((s) => (
                    <section className="service" key={s.id}>
                      <div className="row">
                        <h3>
                          <Mark
                            state={
                              s.available && s.enabled
                                ? 'done'
                                : s.found && s.adapter === 'ready'
                                  ? 'waiting'
                                  : 'todo'
                            }
                          />
                          {s.name}
                        </h3>
                        <span className="caption push-right">{s.status}</span>
                      </div>
                      <p>{s.detail}</p>
                      {isDesk && (
                        <p className="code caption">
                          {s.installedVersion ?? 'Version not reported'}
                          <br />
                          {s.provenVersion ? (
                            <>
                              proven on {s.provenVersion}
                              <br />
                            </>
                          ) : null}
                          {s.location ? (
                            <>
                              {s.location}
                              <br />
                            </>
                          ) : null}
                          {s.capabilities.join(', ') || 'No execution capabilities'}
                        </p>
                      )}
                      <div className="actions">
                        {s.adapter === 'ready' && s.kind !== 'sample' && (
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={settings.services?.[s.id] ?? false}
                              disabled={!s.available}
                              onChange={(e) =>
                                void save({
                                  ...settings,
                                  services: { ...settings.services, [s.id]: e.target.checked },
                                })
                              }
                            />
                            {settings.services?.[s.id] ? 'On' : 'Off'}
                          </label>
                        )}
                        {s.adapter === 'ready' && (
                          <Button tone="quiet" onClick={() => setDisclosure(s)}>
                            What is sent
                          </Button>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            )}
            {section === 'Permissions' && (
              <>
                <h2>Ask before...</h2>
                <div className="setting-rows">
                  {(
                    [
                      ['changingFiles', 'changing files in a project'],
                      ['deleting', 'deleting files'],
                      ['sending', 'sending anything outside this computer'],
                      ['workingOutside', 'working outside the project folder'],
                      ['spending', 'spending money'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="setting-row" key={key}>
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={settings.permissions[key]}
                        onChange={(e) =>
                          void save({
                            ...settings,
                            permissions: { ...settings.permissions, [key]: e.target.checked },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="caption">
                  Working outside a project and purchases are unavailable in this build. Switching
                  these off does not grant access to either.
                </p>
              </>
            )}
            {section === 'History' && (
              <>
                <h2>A way back</h2>
                <p className="prose">
                  Diomedes records its changes to supported text files before writing them.
                  Restoring a change creates a new entry, so the restore can be undone too.
                </p>
                <p className="prose">
                  History stays on this computer. Automatic cleanup is not active in this build; no
                  entries are removed on a schedule.
                </p>
                <p className="caption">
                  Files must be valid text and no larger than 8 MB. Edits from other applications
                  are recorded when Diomedes next reads the file. Intermediate external edits cannot
                  be recovered.
                </p>
              </>
            )}
            {section === 'Appearance' && (
              <>
                <h2>Appearance package</h2>
                <div className="radio-list">
                  {['deep-field', 'cobalt', 'graphite', 'verdigris', 'paper'].map((p) => (
                    <label
                      className={`radio-row ${settings.appearance.package === p ? 'selected' : ''}`}
                      key={p}
                    >
                      <input
                        type="radio"
                        name="appearance"
                        checked={settings.appearance.package === p}
                        onChange={() =>
                          void save({
                            ...settings,
                            appearance: { ...settings.appearance, package: p },
                          })
                        }
                      />
                      <span className={`palette-swatch ${p}`} />
                      <strong>{p === 'deep-field' ? 'Deep Field' : titleCase(p)}</strong>
                    </label>
                  ))}
                </div>
                <label className="setting-row">
                  <span>Reduced motion</span>
                  <input
                    type="checkbox"
                    checked={settings.appearance.motion === 'reduced'}
                    onChange={(e) =>
                      void save({
                        ...settings,
                        appearance: {
                          ...settings.appearance,
                          motion: e.target.checked ? 'reduced' : 'normal',
                        },
                      })
                    }
                  />
                </label>
                {(['interfaceScale', 'readingScale', 'codeScale'] as const).map((key, i) => (
                  <label key={key} className="setting-row">
                    <span>{['Interface size', 'Reading size', 'Code size'][i]}</span>
                    <select
                      value={settings.appearance[key] ?? 1}
                      onChange={(e) =>
                        void save({
                          ...settings,
                          appearance: { ...settings.appearance, [key]: Number(e.target.value) },
                        })
                      }
                    >
                      <option value={1}>Default</option>
                      <option value={1.12}>Larger</option>
                      <option value={1.24}>Largest</option>
                    </select>
                  </label>
                ))}
              </>
            )}
            {section === 'About' && (
              <>
                <h2>Diomedes</h2>
                <p className="prose">By Diomedes Systems. Version 0.1.</p>
                <p className="prose">
                  A working book for your projects, documents, plans, tasks, and the history of what
                  changed.
                </p>
                <p className="prose">
                  Sample work runs on this computer. Online work uses only a service you explicitly
                  enable. Fonts are bundled and served locally.
                </p>
                <p className="caption">
                  Local browser application. Text and Markdown editing. No startup service or remote
                  access.
                </p>
              </>
            )}
            {section === 'Rules' && (
              <>
                <h2>How work is bounded</h2>
                <p className="prose">
                  Each project is a folder. All edits made here go through the same recorded write
                  path. Online work proposes file changes for your approval. Sample work runs a
                  fixed demonstration.
                </p>
                <p className="code">
                  Ask: read-only response
                  <br />
                  Plan: response saved through History
                  <br />
                  Work: approved file proposals or local sample
                  <br />
                  Review: human Keep / Undo
                </p>
              </>
            )}
            {section === 'Developer' && (
              <>
                <h2>Local runtime</h2>
                <p className="code">
                  Schema: diomedes/1
                  <br />
                  Host: loopback only
                  <br />
                  Transport: HTTP and server-sent events
                  <br />
                  Storage: F:/Achilles/diomedes/.data
                  <br />
                  History: content-addressed objects and journal
                  <br />
                  Client: React and TypeScript
                  <br />
                  Shell: browser, replaceable
                </p>
                <p className="prose">
                  Requests from other origins are blocked. The local service has no sign-in; other
                  software running on this computer can access it.
                </p>
              </>
            )}
          </div>
          <aside className="margin">
            <section className="block">
              <h3>Services</h3>
              {integrations
                .filter((s) => s.kind !== 'local' || s.available)
                .slice(0, 3)
                .map((s) => (
                  <div className="reference-row" key={s.id}>
                    <Mark state={s.available ? 'done' : 'todo'} />
                    <span>
                      {isDesk ? s.name : s.kind === 'sample' ? 'Sample work' : 'Online service'}
                    </span>
                    <span className="caption push-right">
                      {s.available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                ))}
            </section>
            <p className="caption">Your settings are saved on this computer.</p>
          </aside>
        </div>
      </main>
      {disclosure && (
        <Modal title="What is sent" onClose={() => setDisclosure(null)}>
          <ul className="prose">
            {disclosure.disclosure.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <Button onClick={() => setDisclosure(null)}>Close</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
