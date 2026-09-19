import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  activeDiscoveryFacts,
  type CreateProspectDiscoveryInput,
  type ProspectDiscoveryRecord,
} from '../../shared/discovery';
import { discoveryApi, readDocument } from '../api';
import { Discovery } from './Discovery';
import './discovery.css';

const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** The normal Console owns this view; a prospect does not need a Business account. */
export function DiscoveryPage({ projectId }: { projectId: string }) {
  const [record, setRecord] = useState<ProspectDiscoveryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState('');
  const [actor, setActor] = useState('');
  const [inputs, setInputs] = useState('');
  const [outputs, setOutputs] = useState('');
  const [handoffs, setHandoffs] = useState('');
  const [timing, setTiming] = useState('');
  const [pain, setPain] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [importPath, setImportPath] = useState('');
  const [correctionId, setCorrectionId] = useState('');
  const [correction, setCorrection] = useState('');
  const [switchId, setSwitchId] = useState('');
  const epoch = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    epoch.current += 1;
    inFlight.current = false;
    setBusy(false);
    setLoading(true);
    setRecord(null);
    setError('');
    setImportPath('');
    setCorrectionId('');
    setCorrection('');
    discoveryApi
      .active(controller.signal)
      .then(({ record: active }) => {
        if (!controller.signal.aborted) setRecord(active);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'The discovery record could not be opened.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      epoch.current += 1;
    };
  }, [projectId]);

  async function perform(action: () => Promise<{ record: ProspectDiscoveryRecord | null }>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    const started = epoch.current;
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (started !== epoch.current) return false;
      setRecord(next.record);
      setCorrectionId('');
      setCorrection('');
      return true;
    } catch (failure) {
      if (started === epoch.current)
        setError(failure instanceof Error ? failure.message : 'That change could not be recorded.');
      return false;
    } finally {
      if (started === epoch.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const actions = lines(steps);
    const input: CreateProspectDiscoveryInput = {
      prospectName: name,
      goals: lines(goal),
      currentProcess: actions.map((action, index) => ({
        action,
        actor,
        inputs: index === 0 ? lines(inputs) : [],
        outputs: index === actions.length - 1 ? lines(outputs) : [],
        handoffs: index === actions.length - 1 ? lines(handoffs) : [],
        timing: index === 0 ? timing.trim() || null : null,
        painPoints: index === 0 ? lines(pain) : [],
      })),
      hypothesis: { statement: hypothesis, workflowFamily: workflow },
      stage: 'discovery',
      personalizationLevel: 'account',
    };
    if (await perform(() => discoveryApi.create(input))) setCreating(false);
  }

  function toggleCreate() {
    if (!creating) {
      setName('');
      setGoal('');
      setSteps('');
      setActor('');
      setInputs('');
      setOutputs('');
      setHandoffs('');
      setTiming('');
      setPain('');
      setHypothesis('');
      setWorkflow('');
      setError('');
    }
    setCreating(!creating);
  }

  if (loading)
    return (
      <div className="col">
        <p role="status">Opening discovery...</p>
      </div>
    );
  const showCreate = creating || !record;
  const editableFacts = record
    ? activeDiscoveryFacts(record).filter(
        (fact) => fact.id !== record.hypothesisFactId && fact.provenance.class !== 'public',
      )
    : [];

  return (
    <div className="col discovery-page">
      <div className="discovery-actions">
        <h1>Discovery</h1>
        {record && (
          <button type="button" disabled={busy} onClick={toggleCreate}>
            {creating ? 'Back to record' : 'New prospect'}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {showCreate || !record ? (
        <form onSubmit={(event) => void create(event)} className="discovery-form">
          <p>Record what the owner tells you. Their business does not need an account.</p>
          <label>
            Business name
            <input
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Goals, one per line
            <textarea
              required
              maxLength={5000}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
          <label>
            Current process, one step per line
            <textarea
              required
              maxLength={10000}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
            />
          </label>
          <label>
            Who does this work?
            <input
              required
              maxLength={200}
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </label>
          <details>
            <summary>Inputs, hand-offs and time</summary>
            <label>
              Inputs, one per line
              <textarea
                value={inputs}
                maxLength={3000}
                onChange={(e) => setInputs(e.target.value)}
              />
            </label>
            <label>
              Outputs, one per line
              <textarea
                value={outputs}
                maxLength={3000}
                onChange={(e) => setOutputs(e.target.value)}
              />
            </label>
            <label>
              Hand-offs, one per line
              <textarea
                value={handoffs}
                maxLength={3000}
                onChange={(e) => setHandoffs(e.target.value)}
              />
            </label>
            <label>
              Time spent on the process
              <input maxLength={200} value={timing} onChange={(e) => setTiming(e.target.value)} />
            </label>
            <label>
              Reported difficulties, one per line
              <textarea maxLength={5000} value={pain} onChange={(e) => setPain(e.target.value)} />
            </label>
          </details>
          <label>
            Idea to check with the owner
            <textarea
              required
              maxLength={500}
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
            />
          </label>
          <label>
            Workflow to explore
            <input
              required
              maxLength={120}
              placeholder="For example, weekly operations review"
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Saving...' : 'Create discovery record'}
          </button>
        </form>
      ) : (
        <>
          <Discovery
            record={record}
            busy={busy}
            onStage={(stage) =>
              void perform(() =>
                discoveryApi.classify(record.prospectId, stage, record.personalizationLevel),
              )
            }
            onPersonalizationLevel={(level) =>
              void perform(() => discoveryApi.classify(record.prospectId, record.stage, level))
            }
            onHypothesisOutcome={(outcome) =>
              void perform(() => discoveryApi.outcome(record.prospectId, outcome))
            }
            onExport={() =>
              void perform(() => discoveryApi.exportRecord(record.prospectId, projectId))
            }
          />
          <details className="discovery-form">
            <summary>Record an owner's correction</summary>
            <label>
              Fact
              <select value={correctionId} onChange={(e) => setCorrectionId(e.target.value)}>
                <option value="">Choose a fact</option>
                {editableFacts.map((fact) => (
                  <option key={fact.id} value={fact.id}>
                    {fact.label}: {fact.value ?? 'Unknown'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              What the owner said
              <textarea
                maxLength={1000}
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !correctionId || !correction.trim()}
              onClick={() =>
                void perform(() =>
                  discoveryApi.correct(record.prospectId, {
                    factId: correctionId,
                    value: correction,
                    provenance: { class: 'reported', reportedBy: 'owner' },
                  }),
                )
              }
            >
              Save correction
            </button>
          </details>
          <details className="discovery-form">
            <summary>Import a research brief</summary>
            <p>
              Import the JSON or Markdown file through Files first, then enter its project path
              here.
            </p>
            <label>
              Imported research file
              <input
                placeholder="Imports/research.json"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !importPath}
              onClick={() =>
                void perform(async () => {
                  const document = await readDocument(projectId, importPath);
                  if (!document.sha) throw new Error('Choose a recorded research file.');
                  return discoveryApi.importBrief(record.prospectId, {
                    projectId,
                    path: document.path,
                    sha: document.sha,
                  });
                })
              }
            >
              Import public facts
            </button>
          </details>
        </>
      )}
      <details className="discovery-form">
        <summary>Facilitator: saved prospect reference</summary>
        {record && (
          <p>
            Save this reference to reopen this prospect: <code>{record.prospectId}</code>
          </p>
        )}
        <label>
          Prospect reference
          <input value={switchId} onChange={(e) => setSwitchId(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !switchId}
          onClick={() => void perform(() => discoveryApi.select(switchId))}
        >
          Open prospect
        </button>
      </details>
    </div>
  );
}
