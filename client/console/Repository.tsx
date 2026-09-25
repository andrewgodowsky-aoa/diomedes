import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DocumentInfo } from '../../shared/types';
import {
  COMMAND_LIMITS,
  SOFTWARE_PACK_REQUESTS,
  WORKTREE_NAME,
  type ChangedFile,
  type CommandRunRecord,
  type RunnableCommand,
  type SoftwarePackView,
  type WorktreeRequest,
} from '../../shared/software-pack';
import { buildDiff, type TextDiff } from '../../shared/text-diff';
import { CONTEXT_ESTIMATOR, estimateTokens, formatTokens } from '../../shared/context-accounting';
import { softwarePackApi } from '../api';
import { time } from '../components';
import { DiffView } from './DiffView';
import './repository.css';

/**
 * P07: the Software Engineering pack's repository section, inside the Files
 * pane. It deepens that pane; it is not a second surface (decision 13), and
 * Shell mounts it only where the pack is on.
 *
 * What it shows is read from the pack's records and a fresh `git` read on the
 * host: branch, changed files, recent commits, declared commands with their
 * recorded runs, and worktrees. Every write here — running a command, adding or
 * removing a worktree — is asked for first and waits for Go ahead on exactly the
 * request shown, which the host binds to the intent it recorded.
 *
 * Context: changed files attach to the open thread's next message through the
 * existing attach path, and a diff of the chosen files is added to the message
 * text where it can be read and edited. Both are then counted by H18's context
 * accounting as project files and message text; nothing else is sent.
 */

const KIND_MARK: Record<ChangedFile['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: 'U',
  'type-changed': 'T',
};
const RUN_WORDS: Record<CommandRunRecord['state'], string> = {
  'waiting-approval': 'Waiting for your OK',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  'timed-out': 'Timed out',
  'output-capped': 'Stopped: too much output',
  declined: 'Declined',
  error: 'Could not run',
  uncertain: 'Not confirmed',
};
const seconds = (ms: number | null) => (ms === null ? '' : `${(ms / 1000).toFixed(1)} s`);
const where = (cwd: string) => (cwd ? cwd : 'the project folder');

export function Repository({
  projectId,
  documents,
  onAttach,
  onInsert,
}: {
  projectId: string;
  documents: readonly DocumentInfo[];
  /** Attach a file to the open thread's next message; absent when no thread is open. */
  onAttach?(path: string): void;
  /** Add text to the open thread's next message; absent when no thread is open. */
  onInsert?(text: string): void;
}) {
  const [view, setView] = useState<SoftwarePackView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState<{ path: string; diff: TextDiff } | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [draft, setDraft] = useState('');
  const [worktreeName, setWorktreeName] = useState('');

  const refresh = useCallback(async () => {
    try {
      setView(await softwarePackApi.view(projectId));
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The repository could not be read.');
    }
  }, [projectId]);
  useEffect(() => {
    setView(null);
    setOpen(null);
    setChosen(null);
    void refresh();
  }, [refresh]);
  const busy =
    view?.runs.some((run) => run.state === 'running') || view?.worktreeRequests.some((item) => item.state === 'running');
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => void refresh(), 700);
    return () => clearTimeout(timer);
  }, [busy, view, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setProblem(null);
    setNote(null);
    try {
      await action();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setWorking(false);
      await refresh();
    }
  };

  const repository = view?.repository ?? null;
  const changes = repository?.changes ?? [];
  const selected = useMemo(() => chosen ?? new Set(changes.map((change) => change.path)), [chosen, changes]);
  const sizes = useMemo(() => new Map(documents.map((file) => [file.path, file.size])), [documents]);
  const attachable = changes.filter((change) => selected.has(change.path) && sizes.has(change.path));
  const attachBytes = attachable.reduce((sum, change) => sum + (sizes.get(change.path) ?? 0), 0);

  const showDiff = (path: string) =>
    act(async () => {
      const file = await softwarePackApi.file(projectId, path);
      setOpen({
        path,
        diff: buildDiff({ path, before: file.before, after: file.after, binary: file.binary }),
      });
    });

  if (failure && !view)
    return (
      <section className="repo" aria-label="Repository">
        <p className="caption files-fail">{failure}</p>
      </section>
    );
  if (!view || !repository)
    return (
      <section className="repo" aria-label="Repository">
        <p className="caption">Reading the repository...</p>
      </section>
    );

  if (open)
    return (
      <section className="repo" aria-label="Repository">
        <div className="repo-head">
          <button type="button" className="repo-link" onClick={() => setOpen(null)}>
            ← Repository
          </button>
        </div>
        <p className="caption repo-caption">Against HEAD{repository.head ? ` ${repository.head.slice(0, 12)}` : ''}.</p>
        <DiffView diff={open.diff} />
      </section>
    );

  const waitingRun = view.runs.find((run) => run.state === 'waiting-approval') ?? null;
  const waitingTree = view.worktreeRequests.find((item) => item.state === 'waiting-approval') ?? null;
  const projectCommands = view.commands.filter((command) => command.source === 'project');
  const live = view.worktrees.filter((item) => !item.removedAt);

  return (
    <section className="repo" aria-label="Repository">
      <div className="repo-head">
        <h3>Repository</h3>
        {repository.state === 'repository' && (
          <span className="mono lc repo-branch" title={`${repository.branch ?? 'detached'} ${repository.head ?? ''}`}>
            {repository.detached ? 'detached' : (repository.branch ?? '')}
            {repository.head ? ` · ${repository.head.slice(0, 7)}` : ' · no commit yet'}
          </span>
        )}
        <button type="button" className="repo-link" onClick={() => void refresh()} disabled={working}>
          Refresh
        </button>
      </div>
      {problem && (
        <p className="caption files-fail repo-caption" role="alert">
          {problem}
        </p>
      )}
      {note && (
        <p className="caption repo-caption" role="status">
          {note}
        </p>
      )}
      {repository.state !== 'repository' ? (
        <p className="caption repo-caption" role="status">
          {repository.detail}
        </p>
      ) : (
        <>
          {repository.upstream && (
            <p className="caption repo-caption">
              Tracks <span className="mono lc">{repository.upstream}</span>
              {repository.ahead !== null && ` · ${repository.ahead} ahead, ${repository.behind} behind`}
            </p>
          )}
          <h4 className="repo-sub">
            Changes <span className="repo-count">{changes.length + repository.moreChanges}</span>
          </h4>
          {changes.length === 0 ? (
            <p className="caption repo-caption">Nothing changed since the last commit.</p>
          ) : (
            <ul className="repo-list" aria-label="Changed files">
              {changes.map((change) => (
                <li key={change.path} className="repo-change">
                  <input
                    type="checkbox"
                    aria-label={`Use ${change.path} as context`}
                    checked={selected.has(change.path)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (!next.delete(change.path)) next.add(change.path);
                      setChosen(next);
                    }}
                  />
                  <span className={`mono lc repo-kind k-${change.kind}`} title={change.kind}>
                    {KIND_MARK[change.kind]}
                  </span>
                  <button
                    type="button"
                    className="repo-path"
                    title={change.from ? `${change.from} → ${change.path}` : change.path}
                    onClick={() => void showDiff(change.path)}
                  >
                    {change.path}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(repository.moreChanges > 0 || repository.privateChanges > 0) && (
            <p className="caption repo-caption">
              {repository.moreChanges > 0 && `${repository.moreChanges} more not listed. `}
              {repository.privateChanges > 0 &&
                `${repository.privateChanges} private ${repository.privateChanges === 1 ? 'file' : 'files'} not shown.`}
            </p>
          )}
          {changes.length > 0 && (onAttach || onInsert) && (
            <div className="repo-actions">
              {onAttach && (
                <button
                  type="button"
                  className="repo-button"
                  disabled={!attachable.length}
                  title={`Estimated ${formatTokens(Math.ceil(attachBytes / 4))} tokens (${CONTEXT_ESTIMATOR})`}
                  onClick={() => {
                    for (const change of attachable) onAttach(change.path);
                    setNote(
                      `Attached ${attachable.length === 1 ? '1 file' : `${attachable.length} files`} to your next message · ~${formatTokens(
                        Math.ceil(attachBytes / 4),
                      )} tokens estimated.`,
                    );
                  }}
                >
                  Attach changed files
                </button>
              )}
              {onInsert && (
                <button
                  type="button"
                  className="repo-button"
                  disabled={working || selected.size === 0}
                  onClick={() =>
                    void act(async () => {
                      const paths = changes.filter((change) => selected.has(change.path)).map((change) => change.path);
                      const diff = await softwarePackApi.diff(projectId, paths);
                      if (diff.tooLarge) {
                        setProblem('The diff of these files is too large to add whole. Choose fewer files.');
                        return;
                      }
                      if (!diff.text) {
                        setProblem('These files have no text differences to add.');
                        return;
                      }
                      const text = `\`\`\`diff\n${diff.text.replace(/\n$/, '')}\n\`\`\``;
                      onInsert(text);
                      setNote(
                        `Added the diff of ${paths.length === 1 ? '1 file' : `${paths.length} files`} to your message · ~${formatTokens(
                          estimateTokens(text),
                        )} tokens estimated. Edit it there before sending.`,
                      );
                    })
                  }
                >
                  Add diff to message
                </button>
              )}
            </div>
          )}
          <h4 className="repo-sub">Recent commits</h4>
          {repository.commits.length === 0 ? (
            <p className="caption repo-caption">No commits yet.</p>
          ) : (
            <ol className="repo-list repo-commits" aria-label="Recent commits">
              {repository.commits.map((commit) => (
                <li key={commit.sha} title={`${commit.sha}\n${commit.author}, ${commit.date}`}>
                  <span className="mono lc repo-sha">{commit.sha.slice(0, 7)}</span>
                  <span className="repo-subject">{commit.subject}</span>
                  <span className="repo-author">{commit.author}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <h4 className="repo-sub">Commands</h4>
      {waitingRun && (
        <Approval
          question={`Run ${waitingRun.command} in ${where(waitingRun.cwd)}?`}
          detail={`It runs as exactly these words, without a shell, with a minimal environment and a ${Math.round(
            waitingRun.timeoutMs / 1000,
          )} s limit that ends everything it starts. Nothing runs until you say go ahead, and your OK covers this one run.`}
          working={working}
          onAnswer={(decision) =>
            act(() => softwarePackApi.answerRun(projectId, waitingRun.id, decision, waitingRun.intentHash))
          }
        />
      )}
      {view.commands.length === 0 && <p className="caption repo-caption">No commands declared. Declaring one runs nothing.</p>}
      <ul className="repo-list" aria-label="Declared commands">
        {view.commands.map((command) => (
          <CommandRow
            key={command.id}
            command={command}
            last={view.runs.find((run) => run.commandId === command.id) ?? null}
            disabled={working || !!waitingRun || !!busy}
            onRun={() => act(() => softwarePackApi.run(projectId, command.id))}
            onRemove={
              command.source === 'project'
                ? () =>
                    act(() =>
                      softwarePackApi.declare(
                        projectId,
                        projectCommands
                          .filter((item) => item.id !== command.id)
                          .map((item) => ({ command: item.command, label: item.label, kind: item.kind, cwd: item.cwd, timeoutMs: item.timeoutMs })),
                      ),
                    )
                : undefined
            }
          />
        ))}
      </ul>
      <form
        className="repo-form"
        onSubmit={(event) => {
          event.preventDefault();
          const command = draft.trim();
          if (!command) return;
          void act(async () => {
            await softwarePackApi.declare(projectId, [
              ...projectCommands.map((item) => ({ command: item.command, label: item.label, kind: item.kind, cwd: item.cwd, timeoutMs: item.timeoutMs })),
              { command },
            ]);
            setDraft('');
          });
        }}
      >
        <input
          className="mono lc"
          aria-label="Command to declare"
          placeholder="npm test"
          maxLength={COMMAND_LIMITS.maxLength}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="repo-button" disabled={working || !draft.trim()}>
          Declare
        </button>
      </form>

      {repository.state === 'repository' && (
        <>
          <h4 className="repo-sub">Worktrees</h4>
          {waitingTree && (
            <Approval
              question={
                waitingTree.operation === 'add'
                  ? `Add ${waitingTree.path} on a new branch ${waitingTree.branch}?`
                  : `Remove ${waitingTree.path}?`
              }
              detail={
                waitingTree.operation === 'add'
                  ? 'Work there happens on its own branch; your checkout is not touched.'
                  : 'It is removed only if nothing in it is uncommitted. Its branch and commits are kept.'
              }
              working={working}
              onAnswer={(decision) =>
                act(() => softwarePackApi.answerWorktree(projectId, waitingTree.id, decision, waitingTree.intentHash))
              }
            />
          )}
          <LastWorktree request={view.worktreeRequests.find((item) => item.state !== 'waiting-approval') ?? null} />
          {live.length > 0 && (
            <ul className="repo-list" aria-label="Worktrees">
              {live.map((tree) => (
                <li key={tree.id} className="repo-command">
                  <span className="mono lc repo-path-text" title={`${tree.path} · ${tree.branch}`}>
                    {tree.path}
                  </span>
                  <span className="mono lc repo-author" title={tree.branch}>
                    {tree.branch}
                  </span>
                  <button
                    type="button"
                    className="repo-link"
                    disabled={working || !!waitingTree}
                    onClick={() => void act(() => softwarePackApi.worktree(projectId, { operation: 'remove', name: tree.name }))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="repo-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = worktreeName.trim();
              if (!WORKTREE_NAME.test(name)) {
                setProblem('A worktree name is lowercase letters, digits and dashes.');
                return;
              }
              void act(async () => {
                await softwarePackApi.worktree(projectId, { operation: 'add', name });
                setWorktreeName('');
              });
            }}
          >
            <input
              className="mono lc"
              aria-label="Worktree name"
              placeholder="task-name"
              maxLength={40}
              value={worktreeName}
              onChange={(event) => setWorktreeName(event.target.value)}
            />
            <button type="submit" className="repo-button" disabled={working || !!waitingTree || !worktreeName.trim()}>
              Add worktree
            </button>
          </form>
        </>
      )}

      <p className="caption repo-caption repo-requests">
        Requests · Trust decides at use: {SOFTWARE_PACK_REQUESTS.map((item) => item.capability).join(', ')}.
      </p>
    </section>
  );
}

function Approval({
  question,
  detail,
  working,
  onAnswer,
}: {
  question: string;
  detail: string;
  working: boolean;
  onAnswer(decision: 'go-ahead' | 'declined'): void;
}) {
  return (
    <div className="repo-approval" role="group" aria-label="Approval needed">
      <p className="repo-question">{question}</p>
      <p className="caption">{detail}</p>
      <div className="repo-actions">
        <button type="button" className="repo-button primary" disabled={working} onClick={() => onAnswer('go-ahead')}>
          Go ahead
        </button>
        <button type="button" className="repo-button" disabled={working} onClick={() => onAnswer('declined')}>
          Decline
        </button>
      </div>
    </div>
  );
}

function CommandRow({
  command,
  last,
  disabled,
  onRun,
  onRemove,
}: {
  command: RunnableCommand;
  last: CommandRunRecord | null;
  disabled: boolean;
  onRun(): void;
  onRemove?: () => void;
}) {
  const settled = last && last.state !== 'waiting-approval';
  return (
    <li className="repo-command-block">
      <div className="repo-command">
        <span className="mono lc repo-path-text" title={`${command.command} · in ${where(command.cwd)}`}>
          {command.command}
        </span>
        {command.source === 'acceptance' && <span className="repo-author">task check</span>}
        <button
          type="button"
          className="repo-link"
          disabled={disabled || !command.parsed.ok}
          title={command.parsed.ok ? 'Asks before it runs' : command.parsed.message}
          onClick={onRun}
        >
          Run
        </button>
        {onRemove && (
          <button type="button" className="repo-link" disabled={disabled} aria-label={`Remove ${command.command}`} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {!command.parsed.ok && <p className="caption files-fail repo-caption">{command.parsed.message}</p>}
      {settled && (
        <details className="repo-result">
          <summary>
            <span className={`repo-state s-${last.state}`}>{RUN_WORDS[last.state]}</span>
            {last.exitCode !== null && <span className="mono lc"> · exit {last.exitCode}</span>}
            {last.durationMs !== null && <span> · {seconds(last.durationMs)}</span>}
            {last.endedAt && <span> · {time(last.endedAt)}</span>}
          </summary>
          {last.state !== 'passed' && last.state !== 'failed' && <p className="caption">{last.detail}</p>}
          {(last.stdoutTail || last.stderrTail) && (
            <pre className="repo-output">{[last.stdoutTail, last.stderrTail].filter(Boolean).join('\n')}</pre>
          )}
        </details>
      )}
    </li>
  );
}

function LastWorktree({ request }: { request: WorktreeRequest | null }) {
  if (!request || request.state === 'running' || request.state === 'done') {
    return request?.state === 'running' ? <p className="caption repo-caption">{request.detail}</p> : null;
  }
  return (
    <p className={`caption repo-caption${request.state === 'refused' || request.state === 'error' ? ' files-fail' : ''}`} role="status">
      {request.detail}
    </p>
  );
}
