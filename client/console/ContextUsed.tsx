import { useState } from 'react';
import {
  CONTEXT_SECTION_LABELS,
  formatTokens,
  summarisedCount,
  type ContextAccount,
} from '../../shared/context-accounting';

/**
 * H18: the "Context used" line under an answer on a model-API route, and what it opens: each
 * section of what was sent with Diomedes' estimate, what the provider reported, the stable prefix
 * and, when the history passed its budget, which messages went and which were summarised.
 *
 * The record is the turn's own (`Turn.context`), written once when it was answered; nothing here
 * derives a number of its own. An estimate reads as one, and a number nobody reported reads as
 * unknown, never zero. Graphite rows in the Settings > Engines language; every machine string
 * truncates where it is written (decision 5).
 */
const n = (value: number) => value.toLocaleString('en-US');
const signed = (value: number) => (value > 0 ? `+${n(value)}` : n(value));
const plural = (indexes: readonly number[], what: string) =>
  indexes.length ? `${indexes.length === 1 ? 'message' : 'messages'} ${indexes.join(', ')}, ${what}. ` : '';

export function ContextUsed({ account }: { account: ContextAccount }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(false);
  const provider = account.provider;
  const reported = provider && provider.reportedCalls > 0 ? provider.inputTokens : null;
  const sections = account.sections.filter((section) => section.bytes > 0 || section.id === 'history');
  const history = account.history;
  const compaction = account.compaction;
  const prefix = account.stablePrefix;
  // The summary lists the first omitted messages it has room for, in order; the rest are only counted.
  const ownOmitted = (history?.omitted ?? []).filter((item) => !item.carried).map((item) => item.index);
  const listed = compaction ? summarisedCount(compaction) : 0;

  return (
    <div className="context-used">
      <button
        type="button"
        className="context-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="context-lead">Context used ·</span>{' '}
        <span>
          ~{formatTokens(account.estimatedTokens)} estimated
          {reported !== null ? ` · ${formatTokens(reported)} reported` : ''}
          {provider && provider.cacheReadTokens > 0 ? ` · ${formatTokens(provider.cacheReadTokens)} cached` : ''}
          {compaction ? ` · ${summarisedCount(compaction)} summarised` : ''}
        </span>
      </button>
      {open && (
        <section className="context-panel" aria-label="Context used">
          <ol className="context-sections">
            {sections.map((section) => (
              <li key={section.id} className="context-section" data-section={section.id}>
                <span className="context-name">{CONTEXT_SECTION_LABELS[section.id]}</span>
                <span className="context-num">~{n(section.estimatedTokens)}</span>
                <span className="context-bytes">{n(section.bytes)} B</span>
                {section.detail && <span className="context-detail">{section.detail}</span>}
              </li>
            ))}
          </ol>
          <dl className="context-facts">
            <dt>Estimate</dt>
            <dd>
              {n(account.estimatedTokens)} tokens in the first call, at one token per four bytes
            </dd>
            <dt>Provider</dt>
            <dd>
              {!provider
                ? 'No call was recorded'
                : provider.reportedCalls === 0
                  ? 'Usage not reported'
                  : `${n(provider.inputTokens)} input, ${n(provider.cacheReadTokens)} cached, ${n(provider.outputTokens)} output over ${
                      provider.reportedCalls === provider.calls
                        ? `${provider.calls} ${provider.calls === 1 ? 'call' : 'calls'}`
                        : `${provider.reportedCalls} of ${provider.calls} calls`
                    }`}
            </dd>
            {account.reconciliation && (
              <>
                <dt>First call</dt>
                <dd>
                  {n(account.reconciliation.reported)} reported against {n(account.reconciliation.estimated)} estimated (
                  {signed(account.reconciliation.difference)})
                </dd>
              </>
            )}
            <dt>Window</dt>
            <dd title={account.model}>
              {account.window.tokens === null
                ? `Not declared for ${account.model}`
                : `${n(account.window.tokens)} tokens (${account.window.source})`}
            </dd>
            <dt>Prefix</dt>
            <dd title={prefix.sha}>
              {prefix.sha.slice(0, 12)} · {n(prefix.bytes)} B ·{' '}
              {prefix.sameAsPrevious === null
                ? 'first recorded message'
                : prefix.sameAsPrevious
                  ? 'same as the previous message'
                  : 'changed since the previous message'}
            </dd>
            <dt>Cache</dt>
            <dd>{account.cache.note}</dd>
            {history && history.omitted.length > 0 && (
              <>
                <dt>Left out</dt>
                <dd>
                  {plural(ownOmitted.slice(0, listed), 'summarised')}
                  {plural(ownOmitted.slice(listed), 'left out without a line in the summary')}
                  {plural(history.omitted.filter((item) => item.carried).map((item) => item.index), 'from before the update, not summarised')}
                </dd>
              </>
            )}
          </dl>
          {compaction && (
            <div className="context-compaction">
              <button
                type="button"
                className="context-summary-toggle"
                aria-expanded={summary}
                onClick={() => setSummary(!summary)}
              >
                What was summarised
              </button>
              {/* The summary says itself who wrote it and that the messages stay (decision 4). */}
              {summary && <pre className="context-summary">{compaction.text}</pre>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
