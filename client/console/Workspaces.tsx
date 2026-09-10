import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HOSTED_BUSINESS_UNAVAILABLE_REASON,
  workspaceLabel,
  type WorkspaceRef,
  type WorkspaceView,
} from '../../shared/workspaces';
import { api } from '../api';
import { Allowance } from './Allowance';
import { Button, Modal } from '../components';
import { BusinessSetup } from './BusinessSetup';
import { Configuration } from './Configuration';
import './workspace.css';

/**
 * The workspace control and its panel.
 *
 * Personal and Business are both first-class here: Personal is not the absence
 * of a business, it is a workspace with its own settings and data, and nothing
 * in this file offers it the company questions. Creating and joining are
 * separate explicit actions, and switching goes through the host, which checks
 * membership before it agrees.
 */

export function WorkspaceMark({ view, onOpen }: { view: WorkspaceView | null; onOpen(): void }) {
  const label = view
    ? workspaceLabel(
        view.active,
        view.organizations.map((o) => o.organization),
      )
    : 'Personal';
  const business = view?.active.kind === 'business';
  const fixture =
    business &&
    view?.organizations.find(
      (o) => o.organization.id === (view.active as { organizationId: string }).organizationId,
    )?.organization.identitySource === 'development-fixture';
  return (
    <div className="ws-mark">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Change workspace"
        className="ws-mark-button"
      >
        <span className="ws-name">{label}</span>
        <span className="ws-open mono">Change</span>
      </button>
      {fixture && <p className="caption ws-fixture">Development identity — not verified</p>}
    </div>
  );
}

interface PanelProps {
  view: WorkspaceView;
  busy: boolean;
  onClose(): void;
  onChanged(next: WorkspaceView): void;
  report(error: unknown): void;
}

export function WorkspacePanel({ view, busy, onClose, onChanged, report }: PanelProps) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ code: string; role: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [configureFor, setConfigureFor] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [brief, setBrief] = useState('');
  // `useWorkspace` below holds `report` the same way, and for the same reason:
  // a caller's inline callback is a new function every render, and an effect
  // that depends on one re-runs forever.
  const reportRef = useRef(report);
  reportRef.current = report;

  const run = useCallback(
    async (action: () => Promise<WorkspaceView>) => {
      setWorking(true);
      setError('');
      try {
        onChanged(await action());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That could not be completed.');
        report(e);
      } finally {
        setWorking(false);
      }
    },
    [onChanged, report],
  );

  // The projects a business could write into. Read once the panel is open and a
  // business is current; Personal never asks, because Personal never binds one.
  //
  // The dependency is the organization id rather than `view.active`, which is a
  // fresh object on every render: depending on it re-ran this effect each pass,
  // and the cleanup then cancelled each fetch before it could be recorded. The
  // list never arrived and the request went out again, forever.
  const activeOrganizationId = view.active.kind === 'business' ? view.active.organizationId : null;
  useEffect(() => {
    if (!activeOrganizationId) return;
    let live = true;
    api<{ projects: { id: string; name: string }[] }>('/projects')
      .then((all) => {
        if (live)
          setProjects(all.projects.map((project) => ({ id: project.id, name: project.name })));
      })
      .catch((error) => reportRef.current(error));
    return () => {
      live = false;
    };
  }, [activeOrganizationId]);

  const disabled = busy || working;
  const active = view.active;
  const activeOrganization =
    active.kind === 'business'
      ? view.organizations.find((item) => item.organization.id === active.organizationId)
      : undefined;

  if (setupFor)
    return (
      <BusinessSetup
        organizationId={setupFor}
        onClose={() => setSetupFor(null)}
        onDone={async () => {
          // The questions are finished; the next thing a person does is read
          // the setup they produce. Handing straight over keeps that one
          // motion rather than closing to a panel that offers it again.
          setSetupFor(null);
          setConfigureFor(setupFor);
          onChanged(await api<WorkspaceView>('/workspace'));
        }}
        report={report}
      />
    );

  if (configureFor)
    return (
      <Configuration
        organizationId={configureFor}
        onClose={() => setConfigureFor(null)}
        onRevise={() => {
          setConfigureFor(null);
          setSetupFor(configureFor);
        }}
        report={report}
      />
    );

  return (
    <Modal title="Workspaces" onClose={onClose} wide>
      <div className="ws-panel">
        <p className="caption">
          {view.person.name} ·{' '}
          {view.person.assurance === 'hosted'
            ? 'Verified identity'
            : 'Development identity — not verified'}
        </p>
        {/* No entitlement banner here. Managed access says what it is, and what
            this installation can offer, in its own section below — where the
            meaning and the coverage sit with it. Repeating it as a banner said
            the same thing twice and answered a question nobody had yet asked. */}

        <ul className="ws-list">
          <li className={active.kind === 'personal' ? 'on' : ''}>
            <div className="ws-row">
              <div className="ws-row-text">
                <strong>Personal</strong>
                <span className="caption">
                  Your own workspace: your projects, settings and history. It never asks the
                  business questions.
                </span>
              </div>
              {active.kind === 'personal' ? (
                <span className="mono ws-current">Current</span>
              ) : (
                <Button
                  tone="quiet"
                  disabled={disabled}
                  onClick={() => void run(() => switchTo({ kind: 'personal' }))}
                >
                  Open
                </Button>
              )}
            </div>
          </li>
          {view.organizations.map(({ organization, membership, setup }) => {
            const current = active.kind === 'business' && active.organizationId === organization.id;
            return (
              <li key={organization.id} className={current ? 'on' : ''}>
                <div className="ws-row">
                  <div className="ws-row-text">
                    <strong>Business: {organization.name}</strong>
                    <span className="caption">
                      {membership.role === 'member'
                        ? 'Member'
                        : membership.role === 'admin'
                          ? 'Administrator'
                          : 'Owner'}
                      {' · '}
                      {setup?.mayConfigure
                        ? setupSentence(setup.state, setup.answered, setup.required)
                        : 'You join the setup the owners have made.'}
                    </span>
                  </div>
                  {current ? (
                    <span className="mono ws-current">Current</span>
                  ) : (
                    <Button
                      tone="quiet"
                      disabled={disabled}
                      onClick={() =>
                        void run(() =>
                          switchTo({ kind: 'business', organizationId: organization.id }),
                        )
                      }
                    >
                      Open
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {view.revoked.length > 0 && (
          <section className="ws-section">
            <h3>No longer available</h3>
            {view.revoked.map((item) => (
              <p key={item.organizationId} className="caption">
                Your access to <strong>{item.name}</strong> was removed
                {item.reason ? `: ${item.reason}` : '.'} Its work and settings stay with the
                business.
              </p>
            ))}
          </section>
        )}

        {activeOrganization?.setup?.mayConfigure && (
          <section className="ws-section">
            <h3>Set up {activeOrganization.organization.name}</h3>
            <p className="caption">
              A short set of questions about the work, asked once for the business. It records
              answers; it does not change permissions, spending or access.
            </p>
            <div className="ws-actions">
              <Button
                tone={activeOrganization.setup.state === 'proposal-ready' ? 'quiet' : 'primary'}
                disabled={disabled}
                onClick={() => setSetupFor(activeOrganization.organization.id)}
              >
                {activeOrganization.setup.resumable ? 'Resume setup' : 'Start setup'}
              </Button>
              {/* The answers are finished, so the useful next step is reading
                  what they make — not answering them again. */}
              {activeOrganization.setup.state === 'proposal-ready' && (
                <Button
                  tone="primary"
                  disabled={disabled}
                  onClick={() => setConfigureFor(activeOrganization.organization.id)}
                >
                  Review the setup
                </Button>
              )}
            </div>
          </section>
        )}

        {activeOrganization && !activeOrganization.setup?.mayConfigure && (
          <section className="ws-section">
            <h3>Set up {activeOrganization.organization.name}</h3>
            <p className="caption">
              An owner or administrator sets this workspace up. You work in the configuration they
              have made.
            </p>
          </section>
        )}

        {activeOrganization && (
          <section className="ws-section">
            <h3>Where {activeOrganization.organization.name} writes</h3>
            <p className="caption">
              Work for this business is saved into one project, for you to read before anything is
              sent anywhere. It is chosen once, here, so a run cannot land somewhere nobody picked.
            </p>
            {activeOrganization.output && (
              <p className="ws-bound">
                Writing into{' '}
                <strong className="ws-truncate">{activeOrganization.output.projectName}</strong>
              </p>
            )}
            {activeOrganization.setup?.mayConfigure ? (
              <>
                <div className="ws-form">
                  <label>
                    <span>Project</span>
                    <select
                      className="ws-input ws-select"
                      disabled={disabled || projects === null}
                      value={activeOrganization.output?.projectId ?? ''}
                      onChange={(event) => {
                        const projectId = event.target.value;
                        if (!projectId) return;
                        setBrief('');
                        void run(() =>
                          api<WorkspaceView>(
                            `/workspace/organizations/${activeOrganization.organization.id}/output`,
                            'POST',
                            { projectId },
                          ),
                        );
                      }}
                    >
                      <option value="">
                        {projects === null ? 'Reading your projects…' : 'Choose a project'}
                      </option>
                      {(projects ?? []).map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="ws-actions">
                  <Button
                    tone="quiet"
                    disabled={disabled || !activeOrganization.output}
                    onClick={() => {
                      setWorking(true);
                      setError('');
                      setBrief('');
                      api<{ destination: string; projectName: string }>(
                        `/workspace/organizations/${activeOrganization.organization.id}/brief`,
                        'POST',
                        {},
                      )
                        .then((result) =>
                          setBrief(
                            `Drafted into ${result.projectName} as ${result.destination}. It is waiting for you to read.`,
                          ),
                        )
                        .catch((e) => {
                          setError(e instanceof Error ? e.message : 'That could not be completed.');
                          report(e);
                        })
                        .finally(() => setWorking(false));
                    }}
                  >
                    Prepare the weekly brief
                  </Button>
                </div>
                {brief && <p className="caption ws-brief">{brief}</p>}
              </>
            ) : (
              !activeOrganization.output && (
                <p className="caption ws-boundary">
                  An owner or administrator chooses this.
                </p>
              )
            )}
          </section>
        )}

        {activeOrganization && (
          <Allowance organizationId={activeOrganization.organization.id} report={report} />
        )}

        {activeOrganization && activeOrganization.members && (
          <section className="ws-section">
            <h3>Invite someone</h3>
            <p className="caption">
              An invitation is a single code that expires. An email address or a matching domain
              never joins anyone.
            </p>
            <div className="ws-actions">
              {(['member', 'admin'] as const).map((role) => (
                <Button
                  key={role}
                  tone="quiet"
                  disabled={disabled}
                  onClick={() => {
                    setWorking(true);
                    setError('');
                    api<{ code: string; role: string }>(
                      `/workspace/organizations/${activeOrganization.organization.id}/invitations`,
                      'POST',
                      { role },
                    )
                      .then(setInvite)
                      .catch((e) => {
                        setError(e instanceof Error ? e.message : 'That could not be completed.');
                        report(e);
                      })
                      .finally(() => setWorking(false));
                  }}
                >
                  Invite {role === 'admin' ? 'an administrator' : 'a member'}
                </Button>
              ))}
            </div>
            {invite && (
              <p className="caption ws-code">
                Code <span className="mono">{invite.code}</span> — single use, {invite.role}.
              </p>
            )}
          </section>
        )}

        <section className="ws-section">
          <h3>Add a business workspace</h3>
          <p className="caption">
            {view.hosted.available ? '' : HOSTED_BUSINESS_UNAVAILABLE_REASON}
          </p>
          <div className="ws-form">
            <label>
              <span>Business name</span>
              <input
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="What the business is called"
              />
            </label>
            <label>
              <span>Kind of work (optional)</span>
              <input
                value={industry}
                maxLength={60}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Cabinetry, restaurant, field service…"
              />
            </label>
            <Button
              tone="primary"
              disabled={disabled || name.trim().length < 2}
              onClick={() =>
                void run(async () => {
                  const next = await api<WorkspaceView>('/workspace/organizations', 'POST', {
                    name: name.trim(),
                    industry: industry.trim() || null,
                  });
                  setName('');
                  setIndustry('');
                  return next;
                })
              }
            >
              Create business workspace
            </Button>
          </div>
        </section>

        <section className="ws-section">
          <h3>Join a business workspace</h3>
          <p className="caption">
            Paste the invitation code an owner gave you. Joining does not change your Personal
            workspace.
          </p>
          <div className="ws-form">
            <label>
              <span>Invitation code</span>
              <input value={code} maxLength={64} onChange={(e) => setCode(e.target.value)} />
            </label>
            <Button
              tone="quiet"
              disabled={disabled || code.trim().length < 4}
              onClick={() =>
                void run(async () => {
                  const next = await api<WorkspaceView>('/workspace/organizations/join', 'POST', {
                    code: code.trim(),
                  });
                  setCode('');
                  return next;
                })
              }
            >
              Join
            </Button>
          </div>
        </section>

        {view.legacyPreference.present && (
          <p className="caption ws-legacy">{view.legacyPreference.note}</p>
        )}
        {error && (
          <p className="ws-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function switchTo(ref: WorkspaceRef) {
  return api<WorkspaceView>('/workspace/switch', 'POST', ref);
}

function setupSentence(state: string, answered: number, required: number): string {
  if (state === 'not-started') return 'Setup has not started';
  if (state === 'proposal-ready') return 'Setup answered — ready to review';
  return `Setup in progress — ${answered} of ${required} needed answers`;
}

/**
 * Load the workspace view once. `report` is held in a ref so a caller that
 * passes a fresh closure each render does not re-run the fetch.
 */
export function useWorkspace(report: (error: unknown) => void) {
  const [view, setView] = useState<WorkspaceView | null>(null);
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    let live = true;
    api<WorkspaceView>('/workspace')
      .then((value) => {
        if (live) setView(value);
      })
      .catch((error) => reportRef.current(error));
    return () => {
      live = false;
    };
  }, []);
  return [view, setView] as const;
}
