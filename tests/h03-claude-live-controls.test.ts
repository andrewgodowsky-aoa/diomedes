/**
 * H03: Claude Code persistent input, queued steering, Stop escalation and restart
 * reconciliation, driven end to end through `ClaudeSessionRuns`, the real
 * `ClaudeAdapter` session transport and a scripted stream-json child process.
 * This is fixture proof of the protocol Diomedes speaks, not proof of live Claude
 * Code behaviour: the fixture decides how a turn, an interrupt and a refused
 * `--resume` look.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter, CLAUDE_VERSION } from '../server/engines/claude.js';
import type { TextRequest } from '../server/engines/contract.js';
import { openProcess, type ProcessFactory } from '../server/engines/process.js';
import { FileRunStore } from '../server/harness/run-store.js';
import { RunService } from '../server/harness/run-service.js';
import {
  CLAUDE_SESSION_CAPABILITY,
  ClaudeSessionRuns,
  validateClaudeNativeCheckpoint,
  type ClaudeSessionTurn,
} from '../server/harness/claude-session-run.js';
import { textDispatchAuthorizer } from '../server/harness/text-route.js';

const roots: string[] = [];
const drivers: ClaudeSessionRuns[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.closeAll().catch(() => undefined);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/**
 * One scripted Claude Code. The person's words decide the turn: `[hang]` waits until an
 * interrupt and then closes the turn; `[stuck]` acknowledges an interrupt and never closes the
 * turn; `[slow]` answers after a pause. Every other message is answered at once. A `--resume`
 * of a session this fixture never created exits before the handshake, as a refused resume.
 */
const SCRIPT = `import readline from 'node:readline';
import fs from 'node:fs';
const [,, session, known, log, resumed] = process.argv;
const emit = (x) => console.log(JSON.stringify(x));
const sessions = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').split('\\n') : [];
if (resumed === 'resume' && !sessions.includes(session)) { console.error('No conversation found with session ID: ' + session); process.exit(1); }
if (!sessions.includes(session)) fs.appendFileSync(known, session + '\\n');
fs.appendFileSync(log, JSON.stringify({ pid: process.pid, session, resumed }) + '\\n');
let count = 0, open = null;
const result = (text) => emit({ type: 'result', uuid: session + '-' + process.pid + '-' + count, subtype: 'success', result: text, session_id: session, modelUsage: { 'claude-sonnet-4-6': {} } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    if (m.request.subtype === 'interrupt' && open === 'hang') { open = null; setTimeout(() => emit({ type: 'result', uuid: session + '-' + process.pid + '-stop-' + count, subtype: 'error_during_execution', is_error: true, session_id: session, errors: ['Request was aborted'] }), 20); }
    return;
  }
  if (m.type !== 'user') return;
  count++;
  const words = JSON.parse(m.message.content).request;
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, turn: words }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-4-6', tools: [], mcp_servers: [] });
  emit({ type: 'stream_event', session_id: session, event: { delta: { type: 'text_delta', text: 'Answer' } } });
  if (words.includes('[hang]')) { open = 'hang'; return; }
  if (words.includes('[stuck]')) { open = 'stuck'; return; }
  if (words.includes('[slow]')) return setTimeout(() => result('Answer to ' + words), 300);
  result('Answer to ' + words);
});`;

const base: TextRequest = {
  projectId: 'p',
  threadId: 't',
  requestId: 'one',
  prompt: 'hello',
  documents: [],
  instructions: 'Be concise',
  model: 'sonnet',
  accountRoute: 'claude-code:claude.ai',
};

async function world() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h03-claude-'));
  roots.push(root);
  const script = path.join(root, 'claude.mjs');
  const known = path.join(root, 'known.txt');
  const log = path.join(root, 'log.jsonl');
  await fs.writeFile(script, SCRIPT);
  const launches: string[][] = [];
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    const resume = options.args.includes('--resume');
    const session = resume
      ? options.args[options.args.indexOf('--resume') + 1]
      : options.args[options.args.indexOf('--session-id') + 1];
    return openProcess({
      ...options,
      file: process.execPath,
      args: [script, session, known, log, resume ? 'resume' : 'new'],
      timeoutMs: 10_000,
    });
  };
  const adapter = new ClaudeAdapter('claude.exe', root, {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com' }),
  });
  const store = path.join(root, 'runs');
  /** A Diomedes process: its own RunService and driver over the one durable run store. */
  const boot = async (recover = false) => {
    const settings = { 'claude-code': true, 'claude-codeAccountRoute': base.accountRoute };
    const authorize = textDispatchAuthorizer(() => settings, [CLAUDE_SESSION_CAPABILITY.id]);
    const runs: RunService = new RunService(new FileRunStore(store), {
      validateNativeCheckpoint: validateClaudeNativeCheckpoint,
      authorizeEgress: async (runId, intent, _principal, phase) =>
        authorize(await runs.get(runId), intent, phase),
    });
    const driver = new ClaudeSessionRuns(runs, { stopGraceMs: 400 });
    driver.setSharingPolicy(() => {});
    drivers.push(driver);
    // Exclusive host startup, as `host.ts` runs it for every saved native conversation.
    if (recover) await driver.recover(await runs.get('claude-run'));
    return driver;
  };
  const turn = (
    mode: ClaudeSessionTurn['mode'],
    requestId: string,
    prompt: string,
    extra: Partial<ClaudeSessionTurn> = {},
  ): ClaudeSessionTurn => ({
    mode,
    runId: 'claude-run',
    input: { ...base, requestId, prompt },
    admit: async () => ({
      location: 'claude.exe',
      version: CLAUDE_VERSION,
      model: base.model,
      accountRoute: base.accountRoute,
    }),
    open: (_admission, input, options) =>
      adapter.openSession(input, options as never) as never,
    ...extra,
  });
  const lines = async () =>
    (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; session?: string; resumed?: string; turn?: string });
  return { boot, turn, launches, lines };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as T | undefined, error }),
  );
const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe('H03 Claude Code live controls over a fixture stream-json process', () => {
  it('keeps one process across turns: a follow-up goes into the same live stdin', async () => {
    const w = await world();
    const driver = await w.boot();
    const first = await driver.request(w.turn('start', 'one', 'first'));
    expect(first.response?.text).toBe('Answer to first');
    const second = await driver.request(w.turn('follow-up', 'two', 'second'));
    expect(second.response?.text).toBe('Answer to second');
    expect(w.launches).toHaveLength(1);
    const turns = (await w.lines()).filter((line) => line.turn);
    expect(new Set(turns.map((line) => line.pid)).size).toBe(1);
    const status = await driver.status('p', 'claude-run');
    expect(status.continuity.state).toBe('live');
    // Attribution is the runtime-reported model, never the alias that was asked for.
    expect(status.requestedModel).toBe('sonnet');
    expect(status.reportedModel).toBe('claude-sonnet-4-6');
  });

  it('queues a message sent while an answer runs and sends it next, on the same process', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const running = driver.request(w.turn('follow-up', 'two', 'long [slow]'));
    await tick(50);
    // Without `queued` a second message is still refused as busy: nothing waits by accident.
    await expect(driver.request(w.turn('follow-up', 'three', 'refused'))).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    const queued = driver.request(w.turn('follow-up', 'four', 'steer this', { queued: true }));
    const waiting = await driver.status('p', 'claude-run');
    expect(waiting.busy).toBe(true);
    expect(waiting.steering).toEqual([
      expect.objectContaining({ commandId: 'four', state: 'pending', nativeSession: null }),
    ]);
    expect((await running).response?.text).toBe('Answer to long [slow]');
    const answered = await queued;
    expect(answered.response?.text).toBe('Answer to steer this');
    const after = await driver.status('p', 'claude-run');
    expect(after.steering).toEqual([
      expect.objectContaining({ commandId: 'four', state: 'delivered' }),
    ]);
    // It reached the model after the turn ahead of it, in the same process: never mid-turn.
    const turns = (await w.lines()).filter((line) => line.turn).map((line) => line.turn);
    expect(turns).toEqual(['first', 'long [slow]', 'steer this']);
    expect(w.launches).toHaveLength(1);
    // A second ask for the same queued command reads its answer back, never sends it again.
    expect((await driver.request(w.turn('follow-up', 'four', 'steer this', { queued: true }))).response?.text).toBe(
      'Answer to steer this',
    );
  });

  it('a queued conversation message and a steered one share the queue: each settles with its own turn, and only the steered one is projected by onDelivered', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const running = driver.request(w.turn('follow-up', 'two', 'long [slow]'));
    await tick(50);
    const queued = driver.request(w.turn('follow-up', 'three', 'queued turn', { queued: true }));
    const projected: { requestId: string; prompt: string; text: string | undefined }[] = [];
    const ack = await driver.steer('p', 'claude-run', 'four', 'steered message', {
      onDelivered: async (result, input) => {
        projected.push({ requestId: input.requestId, prompt: input.prompt, text: result.response?.text });
      },
    });
    expect(ack).toMatchObject({ commandId: 'four', state: 'pending' });
    expect((await running).response?.text).toBe('Answer to long [slow]');
    // The queued turn's caller gets its own answer, never the steered message's.
    expect((await queued).response?.text).toBe('Answer to queued turn');
    for (let i = 0; i < 40 && projected.length === 0; i += 1) await tick(50);
    // H08's projection fired once, for the steered message only, before it read delivered.
    expect(projected).toEqual([
      { requestId: 'four', prompt: 'steered message', text: 'Answer to steered message' },
    ]);
    const after = await driver.status('p', 'claude-run');
    expect(after.steering).toEqual([
      expect.objectContaining({ commandId: 'three', state: 'delivered' }),
      expect.objectContaining({
        commandId: 'four',
        state: 'delivered',
        detail: 'Sent as the next message once the answer it waited for finished.',
      }),
    ]);
    const turns = (await w.lines()).filter((line) => line.turn).map((line) => line.turn);
    expect(turns).toEqual(['first', 'long [slow]', 'queued turn', 'steered message']);
    expect(w.launches).toHaveLength(1);
  });

  it('Stop withdraws a queued message, and stopping the running turn refuses the rest with a reason', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const running = settle(driver.request(w.turn('follow-up', 'two', 'wait [hang]')));
    await tick();
    const withdrawn = settle(driver.request(w.turn('follow-up', 'three', 'withdraw me', { queued: true })));
    const dropped = settle(driver.request(w.turn('follow-up', 'four', 'drop me', { queued: true })));
    expect(await driver.interruptCommand('p', 'claude-run', 'three')).toEqual({ state: 'requested', stop: 'withdrawn' });
    expect((await withdrawn).error).toMatchObject({ code: 'STEER_CANCELLED', message: 'Withdrawn by Stop before it was sent.' });
    expect(await driver.interruptCommand('p', 'claude-run', 'two')).toEqual({ state: 'requested', stop: 'interrupted' });
    expect((await running).value).toMatchObject({ interrupted: true, stop: 'interrupted', response: null });
    expect((await dropped).error).toMatchObject({ code: 'STEER_CANCELLED' });
    const turns = (await w.lines()).filter((line) => line.turn).map((line) => line.turn);
    expect(turns).toEqual(['first', 'wait [hang]']);
  });

  it('a graceful Stop keeps the session live and resumable; the next message uses the same process', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const running = driver.request(w.turn('follow-up', 'two', 'wait [hang]'));
    await tick();
    expect(await driver.interruptCommand('p', 'claude-run', 'two')).toEqual({ state: 'requested', stop: 'interrupted' });
    expect(await running).toMatchObject({ interrupted: true, stop: 'interrupted' });
    expect(await driver.turnResult('p', 'claude-run', 'two')).toEqual({ answered: false, interrupted: true });
    expect((await driver.status('p', 'claude-run')).continuity.state).toBe('live');
    expect((await driver.request(w.turn('follow-up', 'three', 'again'))).response?.text).toBe('Answer to again');
    expect(w.launches).toHaveLength(1);
  });

  it('a caller that goes away stops its turn the same graceful way, not by killing the process', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const caller = new AbortController();
    const base = w.turn('follow-up', 'two', 'wait [hang]');
    const running = driver.request({ ...base, input: { ...base.input, signal: caller.signal } });
    await tick();
    caller.abort();
    expect(await running).toMatchObject({ interrupted: true, stop: 'interrupted' });
    // A Stop pressed after the caller left joins the same stop and asks for nothing more.
    expect(await driver.interruptCommand('p', 'claude-run', 'two')).toEqual({ state: 'idle' });
    expect((await driver.status('p', 'claude-run')).continuity.state).toBe('live');
    expect((await driver.request(w.turn('follow-up', 'three', 'again'))).response?.text).toBe('Answer to again');
    expect(w.launches).toHaveLength(1);
  });

  it('a Stop the turn ignores ends the process after the grace, records why, and never resumes it', async () => {
    const w = await world();
    const driver = await w.boot();
    await driver.request(w.turn('start', 'one', 'first'));
    const running = settle(driver.request(w.turn('follow-up', 'two', 'wait [stuck]')));
    await tick();
    const started = Date.now();
    expect(await driver.interruptCommand('p', 'claude-run', 'two')).toEqual({ state: 'requested', stop: 'killed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect((await running).error).toMatchObject({ code: 'STOP_FORCED' });
    const status = await driver.status('p', 'claude-run');
    expect(status.state).toBe('reconcile_required');
    expect(status.busy).toBe(false);
    expect(status.continuity.state).toBe('start-again');
    expect(status.continuity.detail).toMatch(/^Couldn't resume\. Claude Code did not stop when asked, so its process was ended\./);
    await expect(driver.request(w.turn('resume', 'three', 'again'))).rejects.toMatchObject({
      code: 'RECONCILE_REQUIRED',
    });
  });

  it('after a Diomedes restart an idle conversation resumes its saved native session by id', async () => {
    const w = await world();
    const first = await w.boot();
    await first.request(w.turn('start', 'one', 'first'));
    const saved = await first.status('p', 'claude-run');
    await first.closeAll();
    const second = await w.boot(true);
    const status = await second.status('p', 'claude-run');
    expect(status.continuity).toMatchObject({ state: 'resumable' });
    expect(status.continuity.cursor).toBeGreaterThan(0);
    expect(status.busy).toBe(false);
    // Follow-up is not a silent resume: it is refused until the resume is explicit.
    await expect(second.request(w.turn('follow-up', 'two', 'next'))).rejects.toMatchObject({
      code: 'RESUME_REQUIRED',
    });
    const resumed = await second.request(w.turn('resume', 'three', 'next'));
    expect(resumed.response?.text).toBe('Answer to next');
    expect(resumed.nativeSession?.opaqueRef).toBe(saved.nativeSession?.opaqueRef);
    expect(w.launches.at(-1)).toEqual(expect.arrayContaining(['--resume', saved.nativeSession!.opaqueRef]));
  });

  it('a restart while Claude Code was answering reads as couldn\'t resume, never as still running', async () => {
    const w = await world();
    const first = await w.boot();
    await first.request(w.turn('start', 'one', 'first'));
    void settle(first.request(w.turn('follow-up', 'two', 'wait [stuck]')));
    await tick();
    expect((await first.status('p', 'claude-run')).busy).toBe(true);
    // The old process's driver is gone without finishing: a crash, as the record sees it.
    const second = await w.boot(true);
    const status = await second.status('p', 'claude-run');
    expect(status.busy).toBe(false);
    expect(status.state).toBe('reconcile_required');
    expect(status.continuity).toMatchObject({
      state: 'start-again',
      detail: "Couldn't resume. Diomedes stopped while Claude Code was answering, so that answer's outcome is unknown. The next message starts a new session.",
    });
    await first.closeAll().catch(() => undefined);
  });

  it('a resume Claude Code refuses is said as couldn\'t resume, and is not resent', async () => {
    const w = await world();
    const first = await w.boot();
    await first.request(w.turn('start', 'one', 'first'));
    await first.closeAll();
    // Claude Code no longer holds the saved session.
    await fs.writeFile(path.join(roots.at(-1)!, 'known.txt'), `${randomUUID()}\n`);
    const second = await w.boot(true);
    await expect(second.request(w.turn('resume', 'two', 'next'))).rejects.toMatchObject({ code: 'RESUME_FAILED' });
    const status = await second.status('p', 'claude-run');
    expect(status.continuity).toMatchObject({ state: 'start-again' });
    expect(status.continuity.detail).toContain('Claude Code could not resume the saved session');
    const attempts = (await w.lines()).filter((line) => line.turn === 'next');
    expect(attempts).toEqual([]);
  });
});
