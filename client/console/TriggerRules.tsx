import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../api';
import { INTERVENTION_LABELS, STREAM_INTERVENTIONS, type StreamRule, type StreamRuleAuthority } from '../../shared/stream-rules';
import {
  EFFECT_CLASSES,
  LOOP_TOOLS,
  RULE_MESSAGE_LIMIT,
  RULE_PATTERN_LIMIT,
  RULE_TEXT_LIMIT,
  RULE_WINDOW_LIMIT,
  decisionFor,
  decisionLine,
  draftFromRule,
  emptyDraft,
  interventionLabel,
  matchSummary,
  ruleFromDraft,
  toggled,
  watchesSentence,
  withRule,
  type RuleDraft,
  type StreamRulesView,
} from './trigger-rules-model';
import './trigger-rules.css';

/**
 * H16 trigger rules, listed and edited at one authority: the installation's
 * (Settings > Rules) or a project's (beside its Project instructions in a
 * thread head).
 *
 * The server is the only judge. A save sends the authority's whole rule set
 * through `PUT`, and a refusal — a pattern outside the bounded grammar, a hold
 * on streamed text, a project rule that would loosen one written for
 * everybody, two rules that contradict — is shown in the server's own words.
 * In a project, each rule carries the server's H11 resolution for this task:
 * whether it governs, and why not when it does not.
 */

const WHAT_IT_DOES: Record<(typeof STREAM_INTERVENTIONS)[number], string> = {
  annotate: 'record it, nothing else',
  steer: 'ask the run to correct, with the message below',
  hold: 'hold the proposed call for you before it runs',
  stop: 'stop the run and ask you',
};

const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : 'The rules could not be saved.');

export function TriggerRules({
  authority,
  projectId = null,
  taskId = null,
  tasks = [],
  onChange,
}: {
  authority: StreamRuleAuthority;
  /** Required for project rules. */
  projectId?: string | null;
  /** The task a project view resolves rules for; new project rules default to it. */
  taskId?: string | null;
  /** The project's tasks, for a rule limited to one. */
  tasks?: readonly { id: string; name: string }[];
  /** A save went through. */
  onChange?: () => void;
}) {
  const base = authority === 'organization' ? '/stream-rules' : `/projects/${projectId}/stream-rules`;
  const read = authority === 'project' && taskId ? `${base}?taskId=${encodeURIComponent(taskId)}` : base;
  const [view, setView] = useState<StreamRulesView | null>(null);
  const [editing, setEditing] = useState<{ previous: StreamRule | null; draft: RuleDraft } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setView(await api<StreamRulesView>(read)), [read]);
  useEffect(() => {
    setView(null);
    setEditing(null);
    setError('');
    load().catch((failure) => setError(errorText(failure)));
  }, [load]);

  const rules = view ? view[authority] : [];
  // The business does not hold 'owner-rules': the rules stay listed — they are
  // the owner's data — but nothing edits them here or claims they apply.
  const readOnly = Boolean(view?.notIncludedReason);
  const taskName = (id: string) => tasks.find((task) => task.id === id)?.name ?? id;
  const reach = (rule: StreamRule) =>
    rule.taskId
      ? `Only ${authority === 'project' || tasks.length ? taskName(rule.taskId) : `task ${rule.taskId}`}`
      : authority === 'organization'
        ? 'Every project'
        : 'Every task';

  async function save(next: readonly StreamRule[]): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await api(base, 'PUT', { protocolVersion: 1, rules: next });
      await load();
      onChange?.();
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!editing) return;
    const rule = ruleFromDraft(editing.draft, editing.previous);
    if (await save(withRule(rules, rule, editing.previous?.id ?? null))) setEditing(null);
  }

  const row = (rule: StreamRule, own: boolean) => {
    const decision = decisionFor(view?.resolution ?? null, own ? authority : 'organization', rule.id);
    return (
      <li
        className="trigger-rule"
        key={`${own ? authority : 'organization'}:${rule.id}`}
        data-rule={rule.id}
        data-enabled={rule.enabled}
        {...(decision ? { 'data-outcome': decision.outcome } : {})}
      >
        <div className="trigger-rule-head">
          <span className="trigger-rule-id" title={rule.id}>
            {rule.id} <span className="lc">v{rule.version}</span>
          </span>
          <span className="trigger-rule-intervention">{interventionLabel(rule.intervention)}</span>
          {!rule.enabled && <span className="trigger-rule-off">off</span>}
          {own && !readOnly && (
            <span className="trigger-rule-acts">
              <button
                type="button"
                disabled={busy || !!editing}
                onClick={() => {
                  setError('');
                  setEditing({ previous: rule, draft: draftFromRule(rule) });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy || !!editing}
                onClick={() => void save(withRule(rules, toggled(rule), rule.id))}
              >
                {rule.enabled ? 'Turn off' : 'Turn on'}
              </button>
              <button type="button" disabled={busy || !!editing} onClick={() => setDeleting(rule.id)}>
                Delete
              </button>
            </span>
          )}
        </div>
        <p className="trigger-rule-text">{rule.text}</p>
        <p className="trigger-rule-match">
          {matchSummary(rule)} · {reach(rule)}
          {rule.constrains ? ` · key ${rule.constrains}` : ''}
        </p>
        {rule.message && <p className="trigger-rule-message">Correction: “{rule.message}”</p>}
        {decision && <p className="trigger-rule-decision">{decisionLine(decision)}</p>}
        {deleting === rule.id && (
          <div className="trigger-rule-confirm" role="group" aria-label={`Delete ${rule.id}`}>
            <span>Delete {rule.id}? Firings it already recorded stay in the run records.</span>
            <button
              type="button"
              className="verb"
              disabled={busy}
              onClick={() =>
                void save(withRule(rules, null, rule.id)).then((saved) => saved && setDeleting(null))
              }
            >
              Delete
            </button>
            <button type="button" onClick={() => setDeleting(null)}>
              Keep
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="trigger-rules" data-authority={authority}>
      <p className="trigger-rules-reach">{watchesSentence(view?.watches)}</p>
      {view?.notIncludedReason && <p className="trigger-rules-reach">{view.notIncludedReason}</p>}
      {view?.unreadable?.map((item) => (
        <p key={item.authority} className="trigger-rules-error" role="alert">
          {item.message}
        </p>
      ))}
      {authority === 'project' && view && view.organization.length > 0 && (
        <section className="trigger-rules-layer" aria-label="Organization rules">
          <div className="trigger-rules-layer-head">Organization rules · written in Settings, for every project</div>
          <ul className="trigger-rules-list">{view.organization.map((rule) => row(rule, false))}</ul>
        </section>
      )}
      <section
        className="trigger-rules-layer"
        aria-label={authority === 'project' ? 'Project rules' : 'Organization rules'}
      >
        {authority === 'project' && <div className="trigger-rules-layer-head">Project rules</div>}
        {view && rules.length === 0 && <p className="trigger-rules-empty">No rules yet.</p>}
        {rules.length > 0 && <ul className="trigger-rules-list">{rules.map((rule) => row(rule, true))}</ul>}
      </section>
      {editing && !readOnly ? (
        <RuleForm
          authority={authority}
          draft={editing.draft}
          isNew={!editing.previous}
          tasks={tasks}
          busy={busy}
          error={error}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={() => void submit()}
          onCancel={() => {
            setEditing(null);
            setError('');
          }}
        />
      ) : (
        <>
          {error && (
            <p className="trigger-rules-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <button
              type="button"
              className="button"
              disabled={busy || !view || readOnly}
              onClick={() => {
                setError('');
                setDeleting(null);
                setEditing({ previous: null, draft: emptyDraft(authority === 'project' ? (taskId ?? '') : '') });
              }}
            >
              Add a rule
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RuleForm({
  authority,
  draft,
  isNew,
  tasks,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  authority: StreamRuleAuthority;
  draft: RuleDraft;
  isNew: boolean;
  tasks: readonly { id: string; name: string }[];
  busy: boolean;
  error: string;
  onChange(draft: RuleDraft): void;
  onSave(): void;
  onCancel(): void;
}) {
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => onChange({ ...draft, [key]: value });
  const name = useId();
  const knownTask = !draft.taskId || tasks.some((task) => task.id === draft.taskId);
  return (
    <form
      className="trigger-rule-form"
      aria-label={isNew ? 'New rule' : `Edit ${draft.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="field">
        <span>Rule id</span>
        <input
          value={draft.id}
          onChange={(event) => set('id', event.target.value)}
          maxLength={64}
          spellCheck={false}
          placeholder="lowercase-with-hyphens"
        />
      </label>
      <label className="field">
        <span>What it is for</span>
        <textarea
          value={draft.text}
          onChange={(event) => set('text', event.target.value)}
          maxLength={RULE_TEXT_LIMIT}
          rows={2}
        />
      </label>
      <fieldset className="trigger-rule-kinds">
        <legend>It watches</legend>
        {(
          [
            ['text', 'A phrase in streamed text'],
            ['pattern', 'A pattern in streamed text'],
            ['tool', 'A proposed tool call, before it runs'],
          ] as const
        ).map(([kind, label]) => (
          <label className="trigger-rule-choice" key={kind}>
            <input type="radio" name={`${name}-kind`} checked={draft.kind === kind} onChange={() => set('kind', kind)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {draft.kind === 'text' && (
        <label className="field">
          <span>Phrase</span>
          <input value={draft.phrase} onChange={(event) => set('phrase', event.target.value)} maxLength={RULE_PATTERN_LIMIT} />
        </label>
      )}
      {draft.kind === 'pattern' && (
        <>
          <label className="field">
            <span>Pattern</span>
            <input
                value={draft.pattern}
              onChange={(event) => set('pattern', event.target.value)}
              maxLength={RULE_PATTERN_LIMIT}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Longest match, in characters (up to {RULE_WINDOW_LIMIT})</span>
            <input
              type="number"
              min={1}
              max={RULE_WINDOW_LIMIT}
              value={draft.window}
              onChange={(event) => set('window', event.target.value)}
            />
          </label>
        </>
      )}
      {(draft.kind === 'text' || draft.kind === 'pattern') && (
        <label className="trigger-rule-choice">
          <input
            type="checkbox"
            checked={draft.caseSensitive}
            onChange={(event) => set('caseSensitive', event.target.checked)}
          />
          <span>Case-sensitive</span>
        </label>
      )}
      {draft.kind === 'tool' && (
        <>
          <label className="field">
            <span>Tool</span>
            <input
                list="trigger-rule-tools"
              value={draft.tool}
              onChange={(event) => set('tool', event.target.value)}
              maxLength={64}
              spellCheck={false}
            />
            <datalist id="trigger-rule-tools">
              {LOOP_TOOLS.map((tool) => (
                <option key={tool} value={tool} />
              ))}
            </datalist>
          </label>
          <fieldset className="trigger-rule-kinds">
            <legend>Effect class</legend>
            {EFFECT_CLASSES.map((item) => (
              <label className="trigger-rule-choice" key={item.id}>
                <input
                  type="checkbox"
                  checked={draft.effectClass.includes(item.id)}
                  onChange={(event) =>
                    set(
                      'effectClass',
                      event.target.checked
                        ? [...draft.effectClass, item.id]
                        : draft.effectClass.filter((value) => value !== item.id),
                    )
                  }
                />
                <span>{item.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Target: a file in the project, or a folder ending in /</span>
            <input value={draft.target} onChange={(event) => set('target', event.target.value)} maxLength={400} spellCheck={false} />
          </label>
        </>
      )}
      <label className="field">
        <span>When it matches</span>
        <select
          value={draft.intervention}
          onChange={(event) => set('intervention', event.target.value as RuleDraft['intervention'])}
        >
          {STREAM_INTERVENTIONS.map((intervention) => (
            <option key={intervention} value={intervention}>
              {INTERVENTION_LABELS[intervention]}: {WHAT_IT_DOES[intervention]}
            </option>
          ))}
        </select>
      </label>
      {(draft.intervention === 'steer' || draft.message) && (
        <label className="field">
          <span>Correction message</span>
          <textarea
            value={draft.message}
            onChange={(event) => set('message', event.target.value)}
            maxLength={RULE_MESSAGE_LIMIT}
            rows={2}
          />
        </label>
      )}
      {authority === 'project' ? (
        <label className="field">
          <span>Applies to</span>
          <select value={draft.taskId} onChange={(event) => set('taskId', event.target.value)}>
            <option value="">Every task in this project</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                Only {task.name}
              </option>
            ))}
            {!knownTask && <option value={draft.taskId}>Only task {draft.taskId}</option>}
          </select>
        </label>
      ) : (
        <label className="field">
          <span>Limit to one task (its id; empty for every task)</span>
          <input value={draft.taskId} onChange={(event) => set('taskId', event.target.value)} maxLength={100} spellCheck={false} />
        </label>
      )}
      <details className="trigger-rule-key" open={!!draft.constrains || undefined}>
        <summary>Requirement key</summary>
        <label className="field">
          <span>
            Two rules meet only on the same key, and one of them governs it; a project rule on an organization
            rule&apos;s key can tighten it and never loosen it. Empty means trigger:{draft.id || '<id>'}.
          </span>
          <input
            value={draft.constrains}
            onChange={(event) => set('constrains', event.target.value)}
            maxLength={100}
            spellCheck={false}
            aria-label="Requirement key"
          />
        </label>
      </details>
      <label className="trigger-rule-choice">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />
        <span>On</span>
      </label>
      {error && (
        <p className="trigger-rules-error" role="alert">
          {error}
        </p>
      )}
      <div className="trigger-rule-form-acts">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" className="button quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
