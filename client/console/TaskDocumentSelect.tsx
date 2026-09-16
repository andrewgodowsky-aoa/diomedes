import { useId } from 'react';
import type { DocumentInfo } from '../../shared/types';
import { TASK_SOURCE_LIMITS, taskDocumentProblem } from '../../shared/task-sources';
import './task-document.css';

/** A reference into the guarded Files listing, never an arbitrary path input. */
export function TaskDocumentSelect({
  documents,
  value,
  onChange,
  loading = false,
  failure = null,
  disabled = false,
  namedSources = [],
}: {
  documents: readonly DocumentInfo[];
  value: string;
  onChange(value: string): void;
  loading?: boolean;
  failure?: string | null;
  disabled?: boolean;
  namedSources?: readonly string[];
}) {
  const id = useId();
  const problem =
    failure ?? (value && value !== 'named' ? taskDocumentProblem(value, documents) : null);
  return (
    <div className="task-document">
      <label htmlFor={id}>Project document</label>
      <select
        id={id}
        value={value}
        disabled={disabled || loading || !!failure}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">No existing document</option>
        {namedSources.length > 1 && (
          <option value="named">Documents named in task ({namedSources.length})</option>
        )}
        {value && value !== 'named' && taskDocumentProblem(value, documents) && (
          <option value={value} disabled>
            {value} (unavailable)
          </option>
        )}
        {documents
          .filter(
            (item) =>
              ['markdown', 'text', 'plan'].includes(item.kind) &&
              item.size <= TASK_SOURCE_LIMITS.bytes,
          )
          .map((item) => (
            <option key={item.path} value={item.path}>
              {item.path}
            </option>
          ))}
      </select>
      {loading && <span role="status">Loading documents...</span>}
      {problem && (
        <span id={`${id}-problem`} role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}
