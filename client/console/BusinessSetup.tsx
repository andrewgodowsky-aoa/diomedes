import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AnswerValue, BusinessSetupView, QuestionView } from '../../shared/business-setup';
import { api } from '../api';
import { Button, Modal } from '../components';
import './workspace.css';

/**
 * The Business questionnaire.
 *
 * The host decides which question is next and whether the draft is finished;
 * this draws its answer. That is why `step` comes from the response rather than
 * from local state — a renderer that computed its own order could show a
 * question the host would refuse, or hide one it still requires.
 *
 * Every answer is sent with the digest the host last reported, so a second
 * administrator editing at the same time gets a conflict rather than quietly
 * losing their work.
 */

interface Props {
  organizationId: string;
  onClose(): void;
  onDone(): Promise<void> | void;
  report(error: unknown): void;
}

export function BusinessSetup({ organizationId, onClose, onDone, report }: Props) {
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [setup, setSetup] = useState<BusinessSetupView | null>(null);
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [schema, current] = await Promise.all([
      api<{ questions: QuestionView[] }>('/workspace/questions'),
      api<BusinessSetupView>(`/workspace/organizations/${organizationId}/setup`),
    ]);
    setQuestions(schema.questions);
    setSetup(current);
  }, [organizationId]);

  useEffect(() => {
    load().catch((e) => {
      setError(e instanceof Error ? e.message : 'This setup could not be opened.');
      report(e);
    });
  }, [load, report]);

  const question = useMemo(
    () => (setup ? (questions.find((item) => item.id === setup.step) ?? null) : null),
    [questions, setup],
  );

  // Load the saved answer into the controls whenever the question changes.
  useEffect(() => {
    if (!question || !setup) return;
    const saved = setup.answers[question.id];
    const value = saved && !saved.unknown ? saved.value : null;
    if (question.kind === 'multi') {
      setChosen(Array.isArray(value) ? value.map(String) : []);
      setText('');
      setOther(false);
    } else if (question.kind === 'choice') {
      const id = typeof value === 'string' ? value : '';
      const known = question.options?.some((option) => option.id === id) ?? false;
      setChosen(known ? [id] : []);
      setOther(!known && id !== '');
      setText(known ? '' : id);
    } else {
      setChosen([]);
      setOther(false);
      setText(value == null ? '' : String(value));
    }
  }, [question, setup]);

  const act = useCallback(
    async (call: () => Promise<BusinessSetupView>) => {
      setBusy(true);
      setError('');
      try {
        setSetup(await call());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That answer could not be saved.');
        report(e);
      } finally {
        setBusy(false);
      }
    },
    [report],
  );

  const base = `/workspace/organizations/${organizationId}/setup`;

  const send = (value: AnswerValue, unknown: boolean) =>
    act(() =>
      api<BusinessSetupView>(`${base}/answer`, 'POST', {
        questionId: question?.id,
        value,
        unknown,
        expectedDigest: setup?.digest,
      }),
    );

  const current = (): AnswerValue => {
    if (!question) return null;
    if (question.kind === 'multi') return chosen;
    if (question.kind === 'choice') return other ? text.trim() : (chosen[0] ?? '');
    if (question.kind === 'money') {
      const amount = Number(text.trim());
      return text.trim() === '' || Number.isNaN(amount) ? null : amount;
    }
    return text.trim();
  };

  const answerable = () => {
    const value = current();
    if (value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim() !== '';
    return true;
  };

  const title = setup ? `Set up ${setup.organization.name}` : 'Business setup';

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="ws-setup">
        {!setup ? (
          <p className="caption">Opening…</p>
        ) : setup.state === 'not-started' ? (
          <>
            <p className="prose">
              A short set of questions about how the business works, asked once. Answers are
              recorded as facts. They do not connect anything, grant access, approve spending or
              invite anyone.
            </p>
            <p className="caption">
              You can stop at any point and pick it up here later. Anything you do not know can be
              left unanswered.
            </p>
            <div className="ws-actions">
              <Button tone="quiet" onClick={onClose}>
                Not now
              </Button>
              <Button
                tone="primary"
                disabled={busy}
                onClick={() => void act(() => api<BusinessSetupView>(`${base}/start`, 'POST', {}))}
              >
                Start
              </Button>
            </div>
          </>
        ) : setup.stale ? (
          <>
            <p className="prose">
              This setup was saved when the questions were different (revision{' '}
              {setup.schemaRevision}; this version asks revision {setup.currentSchemaRevision}).
              Resuming starts a fresh draft rather than reinterpreting the old answers as if they
              meant the same thing.
            </p>
            <div className="ws-actions">
              <Button tone="quiet" onClick={onClose}>
                Leave it
              </Button>
              <Button
                tone="primary"
                disabled={busy}
                onClick={() => void act(() => api<BusinessSetupView>(`${base}/resume`, 'POST', {}))}
              >
                Resume with the current questions
              </Button>
            </div>
          </>
        ) : question ? (
          <>
            <p className="caption">
              Question {setup.progress.answered + 1} of {setup.progress.total}
            </p>
            <h3 className="ws-question">{question.prompt}</h3>
            <p className="caption ws-reason">{question.reason}</p>

            {question.kind === 'multi' && question.options && (
              <div className="ws-choices" role="group" aria-label={question.prompt}>
                {question.options.map((option) => (
                  <label
                    key={option.id}
                    className={`ws-choice ${chosen.includes(option.id) ? 'on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.includes(option.id)}
                      onChange={(e) =>
                        setChosen((list) =>
                          e.target.checked
                            ? [...list, option.id]
                            : list.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            )}

            {question.kind === 'choice' && question.options && (
              <div className="ws-choices" role="radiogroup" aria-label={question.prompt}>
                {question.options.map((option) => (
                  <label
                    key={option.id}
                    className={`ws-choice ${!other && chosen[0] === option.id ? 'on' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`q-${question.id}`}
                      checked={!other && chosen[0] === option.id}
                      onChange={() => {
                        setOther(false);
                        setChosen([option.id]);
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                {question.allowOther && (
                  <label className={`ws-choice ${other ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name={`q-${question.id}`}
                      checked={other}
                      onChange={() => {
                        setOther(true);
                        setChosen([]);
                      }}
                    />
                    <span>Something else</span>
                  </label>
                )}
                {other && (
                  <input
                    className="ws-input"
                    aria-label="Describe the work"
                    value={text}
                    maxLength={question.maxLength ?? 200}
                    onChange={(e) => setText(e.target.value)}
                  />
                )}
              </div>
            )}

            {question.kind === 'text' && (
              <textarea
                className="ws-input ws-text"
                aria-label={question.prompt}
                value={text}
                maxLength={question.maxLength ?? 400}
                rows={3}
                onChange={(e) => setText(e.target.value)}
              />
            )}

            {question.kind === 'money' && (
              <label className="ws-money">
                <span className="mono">USD / month</span>
                <input
                  className="ws-input"
                  aria-label={question.prompt}
                  inputMode="numeric"
                  value={text}
                  onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
                />
              </label>
            )}

            {error && (
              <p className="ws-error" role="alert">
                {error}
              </p>
            )}

            <div className="ws-actions">
              <Button
                tone="quiet"
                disabled={busy || !setup.previous}
                onClick={() => void act(() => api<BusinessSetupView>(`${base}/back`, 'POST', {}))}
              >
                Back
              </Button>
              {!question.required && (
                <Button
                  tone="quiet push-right"
                  disabled={busy}
                  onClick={() => void send(null, true)}
                >
                  I don&apos;t know
                </Button>
              )}
              <Button
                tone="primary"
                disabled={busy || !answerable()}
                onClick={() => void send(current(), false)}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="ws-question">Here is what you told us</h3>
            <p className="caption ws-reason">
              Change any answer before this becomes a proposal. Nothing here has been applied.
            </p>
            <dl className="ws-facts">
              {setup.facts.map((fact) => (
                <div
                  key={fact.questionId}
                  className={fact.origin === 'unresolved' ? 'unresolved' : ''}
                >
                  <dt>{fact.prompt}</dt>
                  <dd>{fact.display}</dd>
                </div>
              ))}
            </dl>
            <p className="caption ws-boundary">{setup.afterProposal}</p>
            {error && (
              <p className="ws-error" role="alert">
                {error}
              </p>
            )}
            <div className="ws-actions">
              <Button
                tone="quiet"
                disabled={busy || !setup.previous}
                onClick={() => void act(() => api<BusinessSetupView>(`${base}/back`, 'POST', {}))}
              >
                Change an answer
              </Button>
              <Button tone="primary" disabled={busy} onClick={() => void onDone()}>
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
