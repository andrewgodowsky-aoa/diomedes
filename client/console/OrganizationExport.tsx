/**
 * OPS-05: the Business owner's copy of the business's records, and the
 * separate steps of leaving. Shown to the owner only; the account service
 * refuses anyone else whatever this shows.
 *
 * The copy goes into the project the business writes into, which is always
 * one of the business's own. What it leaves out, and how leaving works, are
 * shown before anything is exported, so nobody has to export to find out.
 */
import { useState } from 'react';
import { EXIT_STEPS, OMITTED_CATEGORIES, type OrganizationExportResult } from '../../shared/organization-export';
import type { OutputBinding } from '../../shared/workspaces';
import { api } from '../api';
import { Button } from '../components';

export function OrganizationExport({
  organizationId,
  name,
  output,
  disabled,
  report,
}: {
  organizationId: string;
  name: string;
  output: OutputBinding | null;
  disabled: boolean;
  report(error: unknown): void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<OrganizationExportResult | null>(null);

  const start = async (projectId: string) => {
    setWorking(true);
    setError('');
    setDone(null);
    try {
      setDone(await api<OrganizationExportResult>(`/workspace/organizations/${organizationId}/export`, 'POST', { projectId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The export couldn't be completed.");
      report(e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="ws-section ws-export">
      <h3>{name}&apos;s records</h3>
      <p className="caption">
        Save the business&apos;s account and setup history as files. The copy excludes credentials.
      </p>
      {output ? (
        <div className="ws-actions">
          <Button tone="quiet" disabled={disabled || working} onClick={() => void start(output.projectId)}>
            {working ? 'Exporting…' : `Export into ${output.projectName}`}
          </Button>
        </div>
      ) : (
        <p className="caption ws-boundary">Choose this business’s project to save the copy.</p>
      )}
      {done && (
        <p className="ws-export-done" role="status">
          Written to <span className="mono">{done.folder}</span> in {output?.projectName ?? 'the project'}:{' '}
          {done.manifest.files.length} {done.manifest.files.length === 1 ? 'file' : 'files'}, a manifest and a README.
        </p>
      )}
      {error && (
        <p className="ws-error" role="alert">
          {error}
        </p>
      )}
      <details>
        <summary>What the copy leaves out</summary>
        <ul>
          {OMITTED_CATEGORIES.map((item) => (
            <li key={item.id}>
              <strong>{item.title}.</strong> {item.why}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Leaving Nectovia</summary>
        <ol>
          {EXIT_STEPS.map((step) => (
            <li key={step.id}>
              <strong>{step.title}.</strong> {step.how}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
