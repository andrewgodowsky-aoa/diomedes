import type { Need, Session } from '../shared/types.js';
import { ApiError } from './paths.js';
import { hash, identifier, now, Store } from './store.js';

interface Run {
  projectId: string;
  sessionId: string;
  taskId: string;
  target: string | null;
  targetSha: string | null;
  instruction: string;
  demo: boolean;
  allow: boolean;
  stage: 'start' | 'read' | 'create' | 'append' | 'finish';
  timer?: ReturnType<typeof setTimeout>;
}

export class WorkService {
  private runs = new Map<string, Run>();
  constructor(
    readonly store: Store,
    private stepMs = 1500,
  ) {}
  running(id: string) {
    return this.runs.has(id);
  }
  async start(projectId: string, taskId: string, instruction = '', demo = false) {
    const state = this.store.state(projectId);
    if (
      this.runs.has(projectId) ||
      state.sessions.some((s) => ['queued', 'working', 'waiting'].includes(s.state))
    )
      throw new ApiError(409, 'This project already has work in progress.');
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new ApiError(404, 'This task was not found.');
    const documents = await this.store.listDocuments(projectId);
    if (state.project.missing) throw new ApiError(409, 'The project folder is missing.');
    const target =
      task.from?.plan ??
      state.project.plans[0] ??
      documents.find((d) => d.kind === 'markdown')?.path ??
      null;
    const targetSha = target ? hash(await this.store.current(projectId, target)) : null;
    const session: Session = {
      id: identifier('S'),
      taskId,
      state: 'queued',
      startedAt: now(),
      endedAt: null,
      sample: true,
      log: [],
      entryIds: [],
      needId: null,
      engine: {
        name: 'Sample worker',
        model: null,
        worker: 1,
        branch: null,
        context: null,
        events: 0,
      },
    };
    const run: Run = {
      projectId,
      sessionId: session.id,
      taskId,
      target,
      targetSha,
      instruction,
      demo,
      allow: false,
      stage: 'start',
    };
    this.runs.set(projectId, run);
    try {
      await this.store.snapshot(projectId, null, session.id);
      const fresh = this.store.state(projectId);
      fresh.sessions.push(session);
      task.sessionIds.push(session.id);
      task.reason = null;
      if (this.store.settings.permissions.changingFiles) await this.need(run, 'start');
      else {
        session.state = 'working';
        this.store.moveTask(fresh, task, 'working', 'diomedes');
        this.log(session, 'Read the plan and the task.');
        run.stage = 'read';
        await this.store.persist(fresh);
        this.schedule(run);
      }
      return this.session(run);
    } catch (error) {
      this.runs.delete(projectId);
      throw error;
    }
  }
  private session(run: Run) {
    const session = this.store.state(run.projectId).sessions.find((s) => s.id === run.sessionId);
    if (!session) throw new Error('The active work session is missing.');
    return session;
  }
  private log(session: Session, sentence: string) {
    session.engine.events += 1;
    session.log.push(
      { time: now(), sentence, level: 'plain' },
      { time: now(), sentence: `event ${session.engine.events}: ${sentence}`, level: 'technical' },
    );
  }
  private schedule(run: Run, delay = this.stepMs) {
    run.timer = setTimeout(() => {
      void this.store
        .locked(async () => {
          if (this.runs.get(run.projectId) !== run) return;
          try {
            await this.advance(run);
          } catch (error) {
            await this.fail(run, error);
          }
        })
        .catch((error) => {
          console.error('Could not persist the worker failure:', error);
        });
    }, delay);
    run.timer.unref();
  }
  private async need(run: Run, stage: 'start' | 'create') {
    const state = this.store.state(run.projectId);
    const session = this.session(run);
    const task = state.tasks.find((t) => t.id === run.taskId)!;
    run.stage = stage;
    const need: Need = {
      id: identifier('N'),
      sessionId: session.id,
      taskId: task.id,
      what:
        stage === 'start'
          ? `start working on ${task.name}`
          : 'add a file called Sample work notes.md to the project folder',
      why:
        stage === 'start'
          ? 'This sample will change files in the project folder. Everything is recorded in History.'
          : 'It records what the sample work did.',
      consequence:
        stage === 'start'
          ? 'If you say go ahead, the sample work starts.'
          : 'If you say go ahead, the file is created and listed in History.',
      files:
        stage === 'start'
          ? [run.target, 'Sample work notes.md'].filter((p): p is string => p !== null)
          : ['Sample work notes.md'],
      state: 'open',
      createdAt: now(),
      decidedAt: null,
      decidedFrom: 'desktop',
      allowForTask: false,
    };
    state.needs.push(need);
    session.needId = need.id;
    session.state = 'waiting';
    task.needId = need.id;
    task.reason = 'needs-ok';
    this.store.moveTask(state, task, 'waiting', 'diomedes');
    this.log(
      session,
      stage === 'start'
        ? `Waiting for your OK to start ${task.name}.`
        : 'Waiting for your OK to add a file.',
    );
    await this.store.persist(state);
    if (run.allow) await this.resolve(run.projectId, need.id, 'go-ahead', true, true);
  }
  async resolve(
    projectId: string,
    needId: string,
    resolution: 'go-ahead' | 'declined',
    allowForTask = false,
    automatic = false,
  ) {
    const state = this.store.state(projectId);
    const need = state.needs.find((n) => n.id === needId);
    if (!need) throw new ApiError(404, 'This request was not found.');
    if (need.state !== 'open') throw new ApiError(409, 'This request has already been decided.');
    const run = this.runs.get(projectId);
    if (!run || run.sessionId !== need.sessionId)
      throw new ApiError(409, 'This work session is no longer running.');
    const session = this.session(run);
    const task = state.tasks.find((t) => t.id === run.taskId)!;
    need.state = resolution;
    need.decidedAt = now();
    need.allowForTask = resolution === 'go-ahead' && allowForTask;
    session.needId = null;
    task.needId = null;
    task.reason = null;
    if (need.allowForTask) run.allow = true;
    this.store.addEntry(state, {
      kind: 'decision',
      sentence: `${automatic ? 'Allowed by your earlier OK' : resolution === 'go-ahead' ? 'You said go ahead' : 'You declined'}: ${need.what}`,
      sessionId: session.id,
      taskId: task.id,
      sample: true,
    });
    if (automatic) this.log(session, `Allowed by your earlier OK: ${need.what}`);
    if (run.stage === 'start' && resolution === 'declined') {
      session.state = 'stopped';
      session.endedAt = now();
      this.log(session, 'Not started.');
      this.store.moveTask(state, task, 'todo', 'diomedes');
      this.runs.delete(projectId);
    } else {
      session.state = 'working';
      this.store.moveTask(state, task, 'working', 'diomedes');
      if (run.stage === 'start') {
        this.log(session, 'Read the plan and the task.');
        run.stage = 'read';
      } else if (resolution === 'declined') {
        this.log(session, 'Skipped adding the file.');
        run.stage = 'append';
      }
      await this.store.persist(state);
      this.schedule(run, Math.max(10, this.stepMs / 3));
      return need;
    }
    await this.store.persist(state);
    return need;
  }
  private async advance(run: Run) {
    let state = this.store.state(run.projectId);
    let session = this.session(run);
    if (run.stage === 'read') {
      if (run.target) {
        await this.store.readDocument(run.projectId, run.target);
        this.log(session, `Read ${run.target}.`);
      } else this.log(session, 'This project has no Markdown document to append to.');
      await this.store.persist(state);
      await this.need(run, 'create');
      return;
    }
    if (run.stage === 'create') {
      const name = 'Sample work notes.md';
      const current = await this.store.current(run.projectId, name);
      if (current !== null)
        this.log(
          session,
          'Sample work notes.md already exists. Kept its contents and skipped adding it.',
        );
      else {
        await this.store.writeRecorded(
          run.projectId,
          [
            {
              path: name,
              expected: null,
              text: `# Sample work notes\n\nDiomedes created this file during a sample work session on ${now()}.\nNo AI service was involved; the steps were scripted to show how work, Needs your OK, Review and History behave.\nYou can undo this in Review or restore it from History.\n`,
            },
          ],
          {
            actor: 'diomedes-with-ok',
            kind: 'changed',
            sessionId: run.sessionId,
            taskId: run.taskId,
            sample: true,
            review: true,
          },
        );
        state = this.store.state(run.projectId);
        session = this.session(run);
        this.log(session, 'Added Sample work notes.md.');
        if (run.demo)
          throw new Error('The requested sample fault occurred after the first recorded change.');
      }
      run.stage = 'append';
    } else if (run.stage === 'append') {
      if (run.target) {
        const current = await this.store.current(run.projectId, run.target);
        if (hash(current) !== run.targetSha)
          throw new ApiError(
            409,
            `${run.target} changed after this work started. Its newer contents were preserved.`,
          );
        await this.store.writeRecorded(
          run.projectId,
          [
            {
              path: run.target,
              expected: run.targetSha,
              text: `${current ?? ''}\n\n## Sample work (Diomedes)\n\nThis paragraph was added by a sample work session on ${now()}. It exists to show that a change to an existing file is recorded with a way back. Undo it in Review, or restore the file from History.\n`,
            },
          ],
          {
            actor: 'diomedes',
            kind: 'changed',
            sessionId: run.sessionId,
            taskId: run.taskId,
            sample: true,
            review: true,
          },
        );
        state = this.store.state(run.projectId);
        session = this.session(run);
        this.log(session, `Wrote a note at the end of ${run.target}.`);
        if (run.demo && this.changedCount(run) === 1)
          throw new Error('The requested sample fault occurred after the first recorded change.');
      }
      run.stage = 'finish';
    } else if (run.stage === 'finish') {
      const task = state.tasks.find((t) => t.id === run.taskId)!;
      const count = this.changedCount(run);
      session.state = 'done';
      session.endedAt = now();
      this.log(session, `Finished ${task.name}. ${count} changes are ready to look at.`);
      this.store.moveTask(state, task, count ? 'waiting' : 'done', 'diomedes');
      task.reason = count ? 'changes-ready' : null;
      this.runs.delete(run.projectId);
      await this.store.persist(state);
      return;
    }
    await this.store.persist(state);
    this.schedule(run);
  }
  private changedCount(run: Run) {
    return this.store
      .state(run.projectId)
      .history.filter((e) => e.sessionId === run.sessionId && e.kind === 'changed')
      .reduce((n, e) => n + e.files.length, 0);
  }
  private async fail(run: Run, error: unknown) {
    const state = this.store.state(run.projectId),
      session = this.session(run),
      task = state.tasks.find((t) => t.id === run.taskId)!;
    const count = this.changedCount(run);
    session.state = 'failed';
    session.endedAt = now();
    session.needId = null;
    task.needId = null;
    const sentence = `Something went wrong in ${task.name}. ${count} ${count === 1 ? 'file was' : 'files were'} changed; ${count === 1 ? "it's" : "they're"} in History.`;
    this.log(session, sentence);
    session.log.push({
      time: now(),
      sentence: error instanceof Error ? error.message : String(error),
      level: 'technical',
    });
    this.store.moveTask(state, task, 'waiting', 'diomedes');
    task.reason = 'went-wrong';
    for (const need of state.needs.filter(
      (n) => n.sessionId === session.id && n.state === 'open',
    )) {
      need.state = 'expired';
      need.decidedAt = now();
    }
    this.store.addEntry(state, {
      kind: 'fault',
      sentence,
      sessionId: session.id,
      taskId: task.id,
      sample: true,
    });
    this.runs.delete(run.projectId);
    await this.store.persist(state);
  }
  async stop(projectId: string, sessionId: string) {
    const state = this.store.state(projectId);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new ApiError(404, 'This work session was not found.');
    if (['done', 'failed', 'stopped'].includes(session.state)) return session;
    const run = this.runs.get(projectId);
    if (run?.timer) clearTimeout(run.timer);
    const count = run ? this.changedCount(run) : 0;
    const task = state.tasks.find((t) => t.id === session.taskId)!;
    session.state = 'stopped';
    session.endedAt = now();
    session.needId = null;
    task.needId = null;
    task.reason = null;
    const sentence = `Stopped. ${count} files were changed before the stop; they're in History.`;
    this.log(session, sentence);
    this.store.moveTask(state, task, 'todo', 'diomedes');
    this.store.addEntry(state, {
      kind: 'stop',
      sentence,
      sessionId,
      taskId: task.id,
      sample: true,
    });
    for (const need of state.needs.filter((n) => n.sessionId === sessionId && n.state === 'open')) {
      need.state = 'expired';
      need.decidedAt = now();
    }
    this.runs.delete(projectId);
    await this.store.persist(state);
    return session;
  }
  async note(projectId: string, sessionId: string, text: string) {
    const state = this.store.state(projectId);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new ApiError(404, 'This work session was not found.');
    this.log(session, `Noted: ${text.slice(0, 4000)}`);
    await this.store.persist(state);
    return session;
  }
  async close() {
    for (const run of [...this.runs.values()])
      await this.store.locked(() => this.stop(run.projectId, run.sessionId));
  }
}
