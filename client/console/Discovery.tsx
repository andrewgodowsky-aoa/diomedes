import {
  DISCOVERY_STAGES,
  HYPOTHESIS_OUTCOMES,
  PERSONALIZATION_LEVELS,
  currentFact,
  discoveryProspectName,
  displayProvenance,
  type DiscoveryStage,
  type HypothesisOutcome,
  type PersonalizationLevel,
  type ProspectDiscoveryRecord,
} from '../../shared/discovery';

export interface DiscoveryProps {
  readonly record: ProspectDiscoveryRecord | null;
  readonly busy?: boolean;
  readonly onStage?: (stage: DiscoveryStage) => void;
  readonly onPersonalizationLevel?: (level: PersonalizationLevel) => void;
  readonly onHypothesisOutcome?: (outcome: HypothesisOutcome) => void;
  readonly onExport?: () => void;
}

const title = (value: string) =>
  value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

function Fact({
  record,
  id,
  prefix,
}: {
  record: ProspectDiscoveryRecord;
  id: string;
  prefix?: string;
}) {
  const fact = currentFact(record, id);
  return (
    <li className={`disc-fact${prefix ? ' has-label' : ''}`}>
      {prefix && <span className="disc-fact-label">{prefix}</span>}
      <span className="disc-fact-value">{fact.value ?? 'Unknown'}</span>
      <span className={`disc-provenance is-${fact.provenance.class}`}>
        {displayProvenance(fact.provenance)}
      </span>
    </li>
  );
}

export function Discovery({
  record,
  busy = false,
  onStage,
  onPersonalizationLevel,
  onHypothesisOutcome,
  onExport,
}: DiscoveryProps) {
  if (!record)
    return (
      <section className="disc-view disc-empty" aria-labelledby="discovery-title">
        <p className="eyebrow">Discovery</p>
        <h2 id="discovery-title">No active prospect</h2>
        <p>Select a prospect to open their discovery record.</p>
      </section>
    );

  const hypothesis = currentFact(record, record.hypothesisFactId);
  const outcome = record.hypothesisOutcomes.at(-1)?.outcome ?? 'unknown';
  const stages = DISCOVERY_STAGES.filter(
    (stage) =>
      stage !== 'pilot' &&
      DISCOVERY_STAGES.indexOf(stage) >= DISCOVERY_STAGES.indexOf(record.stage),
  );
  const levels = PERSONALIZATION_LEVELS.filter(
    (level) =>
      PERSONALIZATION_LEVELS.indexOf(level) >=
      PERSONALIZATION_LEVELS.indexOf(record.personalizationLevel),
  );

  return (
    <section className="disc-view" aria-labelledby="discovery-title">
      <header className="disc-head">
        <div className="disc-heading">
          <h2 id="discovery-title">{discoveryProspectName(record)}</h2>
          <p className="disc-route">No-file discovery · no customer account</p>
        </div>
        {onExport && (
          <button type="button" className="verb" disabled={busy} onClick={onExport}>
            {busy ? 'Exporting...' : 'Export through Files'}
          </button>
        )}
      </header>

      <div className="disc-classification" aria-label="Discovery classification">
        <label>
          <span>Stage</span>
          <select
            value={record.stage}
            disabled={busy || !onStage}
            onChange={(event) => onStage?.(event.target.value as DiscoveryStage)}
          >
            {stages.map((stage) => (
              <option key={stage} value={stage}>
                {title(stage)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Personalization</span>
          <select
            value={record.personalizationLevel}
            disabled={busy || !onPersonalizationLevel}
            onChange={(event) =>
              onPersonalizationLevel?.(event.target.value as PersonalizationLevel)
            }
          >
            {levels.map((level) => (
              <option key={level} value={level}>
                {title(level)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="disc-section" aria-labelledby="discovery-goals">
        <h3 id="discovery-goals">Goals</h3>
        <ul className="disc-facts">
          {record.goalFactIds.map((id) => (
            <Fact key={id} record={record} id={id} />
          ))}
        </ul>
      </section>

      <section className="disc-section" aria-labelledby="discovery-current-process">
        <h3 id="discovery-current-process">Current process</h3>
        <ol className="disc-process">
          {record.currentProcess.map((step) => (
            <li className="disc-step" key={step.id}>
              <h4>{currentFact(record, step.actionFactId).value ?? 'Unknown step'}</h4>
              <ul className="disc-facts">
                <Fact record={record} id={step.actorFactId} prefix="Actor" />
                {step.inputFactIds.map((id) => (
                  <Fact key={id} record={record} id={id} prefix="Input" />
                ))}
                {step.outputFactIds.map((id) => (
                  <Fact key={id} record={record} id={id} prefix="Output" />
                ))}
                {step.handoffFactIds.map((id) => (
                  <Fact key={id} record={record} id={id} prefix="Hand-off" />
                ))}
                {step.timingFactId && (
                  <Fact record={record} id={step.timingFactId} prefix="Timing" />
                )}
                {step.painPointFactIds.map((id) => (
                  <Fact key={id} record={record} id={id} prefix="Pain point" />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <section className="disc-section disc-hypothesis" aria-labelledby="discovery-hypothesis">
        <h3 id="discovery-hypothesis">Demo hypothesis</h3>
        <p>{hypothesis.value ?? 'Unknown'}</p>
        <p className="disc-provenance is-hypothesized">
          {displayProvenance(hypothesis.provenance)}
        </p>
        <label>
          <span>Meeting outcome</span>
          <select
            value={outcome}
            disabled={busy || !onHypothesisOutcome}
            onChange={(event) => onHypothesisOutcome?.(event.target.value as HypothesisOutcome)}
          >
            {HYPOTHESIS_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {title(value)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="disc-section" aria-labelledby="discovery-exports">
        <h3 id="discovery-exports">Exports</h3>
        {record.exports.length ? (
          <ul className="disc-exports">
            {record.exports.map((item) => (
              <li key={item.id}>
                <span>{item.path}</span>
                <span className="mono">{item.routeLabel}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="disc-muted">No discovery export has been written through Files yet.</p>
        )}
      </section>
    </section>
  );
}
