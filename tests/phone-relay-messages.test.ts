/**
 * Relay plan steps 3 and 4 on the desktop: the frames this computer builds for a phone, the gate
 * that paces them, the memory of answered commands, the worker rows, and the handlers that answer
 * a phone's commands through the desktop's own paths. The handlers run here against stand-in
 * ports; phone-relay-desktop.test.ts runs the real ports end to end over a loopback hub.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../server/paths';
import { CommandLedger } from '../server/relay/commands';
import {
  NEED_SUMMARY_MAX_PARTS, boardPages, fileName, fitsFrame, needSummaryParts, resultFrame, turnUpdates, withoutPaths, words, workRowsFrame,
} from '../server/relay/frames';
import {
  ALREADY_ANSWERED, DESKTOP_REFUSALS, PhoneRelayMessages, RelayRefusal, type PhoneRelayPorts, type RelayTurnResult,
} from '../server/relay/messages';
import { OUTBOUND_FRAMES_PER_MINUTE, OutboundGate } from '../server/relay/outbound';
import { RECENT_WORK_MS, payerOf, workRowsOf } from '../server/relay/work-rows';
import {
  RELAY_LIMITS, RELAY_MESSAGE_TIMINGS, parseDesktopToPhone, parsePhoneBound, parseRelayedPhoneMessage,
  type ConversationRef, type DesktopToPhoneMessage, type RelayedPhoneMessage, type ResultMessage, type TurnUpdateMessage,
} from '../services/control-plane/src/relay/protocol';
import { PHONE_RELAY_FEATURE } from '../shared/access';
import type { HandoffEvent } from '../shared/team-delegation';
import type { Change, Conversation, MailboxMessage, Need, Session, Task, TeamMember } from '../shared/types';
import { WORK_CONTROL_CONTRACT_VERSION, type StopReceipt } from '../shared/work-control';
import type { WorkerRow } from '../shared/work-rows';
import { needFixture, sessionFixture } from './workbench-fixtures';
import { fixtureWorkRows } from './work-rows-fixture';

const AT = '2026-10-03T12:00:00.000Z';
const START = Date.parse(AT);
const minutesAgo = (minutes: number) => new Date(START - minutes * 60_000).toISOString();
const ORG = 'org_juniper';
const OTHER_ORG = 'org_harbor';
const DEVICE = 'relay_device_front';
const OWNER = 'person_owner';
/** A folder no frame may ever name. */
const FOLDER = 'C:\\Users\\pat-folder\\Projects\\Winter';

function taskFixture(patch: Partial<Task> = {}): Task {
  return {
    id: 'task_menu', name: 'Draft the winter menu', description: '', from: null, owner: 'you', state: 'todo', reason: null,
    needId: null, sessionIds: [], changeIds: [], createdBy: 'you', createdAt: AT, moves: [], ...patch,
  };
}
const memberFixture = (slotId: string, name: string): TeamMember => ({
  slotId, name, role: 'member', engine: 'claude-code', model: null, status: 'idle', threadId: null, createdAt: AT, lastSeenAt: null,
});
const mailFixture = (patch: Partial<MailboxMessage> = {}): MailboxMessage => ({
  id: 'mail_1', to: 'slot-1', from: 'lead', type: 'message', content: 'Check the prices', read: false, createdAt: AT,
  threadId: null, runId: null, approvalId: null, ...patch,
});
const stopReceipt = (taskId: string, sessionId: string | null, at: string): StopReceipt => ({
  contractVersion: WORK_CONTROL_CONTRACT_VERSION, scope: 'task', taskId, sessionId, at, acknowledged: true, uncertainEffects: [], cancelledFollowUpIds: [],
});
const row = (patch: Partial<WorkerRow> = {}): WorkerRow => ({
  rowId: 'session_menu', kind: 'session', label: 'Claude Code', title: 'Draft the winter menu', state: 'working', startedAt: AT,
  verification: 'not-run', payer: 'your-subscription', ...patch,
});
const isValid = (message: object) => parseDesktopToPhone(JSON.stringify(message)) !== null;

// --- the frames ---------------------------------------------------------------------------

describe('the frames a phone is sent', () => {
  it('names a file or a path by its last part, and leaves words alone', () => {
    expect(withoutPaths('Saved C:\\Users\\pat\\menus\\winter.md and notes/winter/menu.md')).toBe('Saved winter.md and menu.md');
    expect(withoutPaths('Read /etc/hosts, then ~/drafts/plan.txt.')).toBe('Read hosts, then plan.txt.');
    expect(withoutPaths('Choose and/or decline; 1/2 done')).toBe('Choose and/or decline; 1/2 done');
    expect(fileName(`${FOLDER}\\notes\\prices.csv`)).toBe('prices.csv');
    const title = words(`Fix\tthe ${'very '.repeat(30)}long title`, 80);
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it("summarizes a Need in parts that each fit one frame, carrying its consequence whole and only file names", () => {
    const consequence = 'If you say go ahead, the menu on your computer changes. '.repeat(90);
    const parts = needSummaryParts({
      needId: 'need_menu', projectId: 'project_menu', taskTitle: `Draft ${FOLDER}\\menu.md`, what: `Save ${FOLDER}\\menu.md`, why: 'The draft is finished.',
      consequence, files: [`${FOLDER}\\menu.md`, 'notes/menu.md', `${FOLDER}\\notes\\prices.csv`], expiresAt: AT,
    });
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) {
      expect(fitsFrame(part)).toBe(true);
      expect(isValid(part)).toBe(true);
      expect(JSON.stringify(part)).not.toContain('pat-folder');
    }
    expect(parts.map((part) => [part.part, part.parts])).toEqual(parts.map((_, index) => [index + 1, parts.length]));
    expect(parts[0]).toMatchObject({ taskTitle: 'Draft menu.md', what: 'Save menu.md', why: 'The draft is finished.' });
    expect(parts.map((part) => part.consequence).join('')).toBe(consequence);
    expect(parts.flatMap((part) => part.files)).toEqual(['menu.md', 'prices.csv']);
  });

  it('says so in words when a summary would pass its part limit, instead of stopping silently', () => {
    const parts = needSummaryParts({
      needId: 'need_menu', projectId: 'project_menu', taskTitle: 'Winter menu', what: 'Save the menu', why: '',
      consequence: 'x'.repeat(600 * (NEED_SUMMARY_MAX_PARTS + 3)), files: [], expiresAt: AT,
    });
    expect(parts).toHaveLength(NEED_SUMMARY_MAX_PARTS);
    expect(parts.every(isValid)).toBe(true);
    expect(parts.at(-1)!.consequence.endsWith('Open it on your computer to read the rest.')).toBe(true);
  });

  it("pages the Board: every column's count, at most ten cards a page, what waits on the person first", () => {
    const tasks = Array.from({ length: 23 }, (_, index) => taskFixture({ id: `task_${index}`, name: `Task ${index}`, createdAt: minutesAgo(index) }));
    const input = {
      projectId: 'project_menu', tasks,
      sessions: [sessionFixture({ id: 'session_7', taskId: 'task_7', state: 'working', startedAt: AT })],
      needs: [needFixture({ id: 'need_3', taskId: 'task_3' })], changes: [] as Change[], at: AT,
      labelOf: () => `Claude Code in ${FOLDER}\\menu.md`,
      payerOf: (session: Session | null) => (session ? ('your-subscription' as const) : ('unknown' as const)),
    };
    const pages = boardPages(input);
    expect(pages.map((page) => [page.page, page.pages, page.cards.length])).toEqual([[1, 3, 10], [2, 3, 10], [3, 3, 3]]);
    expect(pages[0].columns).toEqual([
      { name: 'Inbox', count: 0 }, { name: 'Ready', count: 21 }, { name: 'Queued', count: 0 }, { name: 'Working', count: 1 },
      { name: 'Review', count: 1 }, { name: 'Blocked', count: 0 }, { name: 'Done', count: 0 },
    ]);
    expect(pages[0].cards.slice(0, 3)).toEqual([
      { taskId: 'task_3', title: 'Task 3', column: 'Review', workerLabel: null, payer: 'unknown' },
      { taskId: 'task_7', title: 'Task 7', column: 'Working', workerLabel: 'Claude Code in menu.md', payer: 'your-subscription' },
      { taskId: 'task_0', title: 'Task 0', column: 'Ready', workerLabel: null, payer: 'unknown' },
    ]);
    expect(pages.every(isValid)).toBe(true);
    // An empty Board is still one page, every column counted.
    expect(boardPages({ ...input, tasks: [] })).toEqual([{
      v: 1, type: 'board.counts', projectId: 'project_menu', columns: pages[0].columns.map((column) => ({ ...column, count: 0 })),
      cards: [], page: 1, pages: 1, at: AT,
    }]);
  });

  it('carries at most eight worker rows, in words', () => {
    const rows = Array.from({ length: 11 }, (_, index) => row({ rowId: `session_${index}`, title: `Edit ${FOLDER}\\winter-${index}.md` }));
    const message = workRowsFrame({ projectId: 'project_menu', rootRunId: null, taskTitle: 'y'.repeat(200), rows, at: AT });
    expect(message.rows).toHaveLength(8);
    expect(message.rows[0].title).toBe('Edit winter-0.md');
    expect(message.taskTitle).toHaveLength(80);
    expect(isValid(message)).toBe(true);
  });

  it('sends an answer as frames in order, every one but the last running', () => {
    const frames = turnUpdates({ kind: 'home' }, 'command_0001', 'done', 'a'.repeat(7_000), 1);
    expect(frames.map((frame) => [frame.seq, frame.status, frame.text.length])).toEqual([[1, 'running', 3_000], [2, 'running', 3_000], [3, 'done', 1_000]]);
    // Wide characters: each frame still fits.
    const wide = turnUpdates({ kind: 'project', projectId: 'project_menu' }, 'command_0001', 'stopped', 'é'.repeat(5_000), 1);
    expect(wide.every((frame) => fitsFrame(frame) && isValid(frame))).toBe(true);
    expect(wide.map((frame) => frame.text).join('')).toBe('é'.repeat(5_000));
    expect(turnUpdates({ kind: 'home' }, 'command_0001', 'failed', '', 1)).toEqual([
      { v: 1, type: 'turn.update', conversation: { kind: 'home' }, turnId: 'command_0001', status: 'failed', text: '', seq: 1 },
    ]);
    expect(resultFrame('command_0001', 'refused', 'cap_question', 'z'.repeat(300)).message).toHaveLength(200);
  });
});

// --- the outbound gate ----------------------------------------------------------------------

describe('what a link sends, and when', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function gate(log?: (line: string) => void) {
    const sent: DesktopToPhoneMessage[] = [];
    const outbound = new OutboundGate({
      send: (text) => {
        sent.push(JSON.parse(text) as DesktopToPhoneMessage);
        return true;
      },
      log,
    });
    return { outbound, sent };
  }
  const rows = (projectId: string, taskTitle: string) => workRowsFrame({ projectId, rootRunId: null, taskTitle, rows: [row()], at: AT });
  const titles = (sent: DesktopToPhoneMessage[]) => sent.map((message) => (message.type === 'work.rows' ? message.taskTitle : message.type));

  it('sends answers in order and never replaces one', async () => {
    const { outbound, sent } = gate();
    outbound.answer(resultFrame('command_0001', 'accepted'));
    outbound.answer(resultFrame('command_0002', 'refused', 'updating', DESKTOP_REFUSALS.updating));
    outbound.answer(resultFrame('command_0003', 'accepted'));
    await outbound.settled();
    expect(sent.map((message) => (message as ResultMessage).commandId)).toEqual(['command_0001', 'command_0002', 'command_0003']);
  });

  it('replaces an unsent picture, builds each only as it goes, and sends one of a kind per project a second', async () => {
    const { outbound, sent } = gate();
    const built: string[] = [];
    const picture = (projectId: string, title: string) => () => {
      built.push(title);
      return rows(projectId, title);
    };
    outbound.picture('work.rows:a', 'work.rows:a', picture('a', 'first'));
    await outbound.settled();
    outbound.picture('work.rows:a', 'work.rows:a', picture('a', 'second'));
    outbound.picture('work.rows:a', 'work.rows:a', picture('a', 'third'));
    outbound.picture('work.rows:b', 'work.rows:b', picture('b', 'other project'));
    await outbound.settled();
    expect(titles(sent)).toEqual(['first', 'other project']);
    await vi.advanceTimersByTimeAsync(RELAY_MESSAGE_TIMINGS.coalesceMs - 1);
    await outbound.settled();
    expect(titles(sent)).toEqual(['first', 'other project']);
    await vi.advanceTimersByTimeAsync(1);
    await outbound.settled();
    expect(titles(sent)).toEqual(['first', 'other project', 'third']);
    expect(built).toEqual(['first', 'other project', 'third']);
  });

  it("stays under the hub's frames a minute, sending the rest when the minute has passed", async () => {
    const { outbound, sent } = gate();
    expect(OUTBOUND_FRAMES_PER_MINUTE).toBeLessThan(RELAY_LIMITS.desktopFramesPerMinute);
    for (let index = 0; index < OUTBOUND_FRAMES_PER_MINUTE + 5; index++)
      outbound.answer(resultFrame(`command_${String(index).padStart(4, '0')}`, 'accepted'));
    await outbound.settled();
    expect(sent).toHaveLength(OUTBOUND_FRAMES_PER_MINUTE);
    await vi.advanceTimersByTimeAsync(60_000);
    await outbound.settled();
    expect(sent).toHaveLength(OUTBOUND_FRAMES_PER_MINUTE + 5);
  });

  it('attends for five minutes after a phone speaks', () => {
    const { outbound } = gate();
    expect(outbound.attending).toBe(false);
    outbound.attend();
    vi.advanceTimersByTime(RELAY_MESSAGE_TIMINGS.attentionMs - 1);
    expect(outbound.attending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(outbound.attending).toBe(false);
  });

  it('drops a frame outside the contract and names it by its type only', async () => {
    const lines: string[] = [];
    const { outbound, sent } = gate((line) => lines.push(line));
    outbound.answer({ ...resultFrame('command_0001', 'accepted'), code: `C:\\${'x'.repeat(50)}` });
    outbound.picture('work.rows:a', 'work.rows:a', () => ({ ...rows('a', 'menu'), rows: Array.from({ length: 9 }, () => row()) }));
    await outbound.settled();
    expect(sent).toEqual([]);
    expect(lines).toEqual([
      'Phone relay: a result frame did not fit the contract and was not sent.',
      'Phone relay: a work.rows frame did not fit the contract and was not sent.',
    ]);
  });

  it('sends nothing more once closed', async () => {
    const { outbound, sent } = gate();
    outbound.picture('work.rows:a', 'work.rows:a', () => rows('a', 'first'));
    await outbound.settled();
    outbound.picture('work.rows:a', 'work.rows:a', () => rows('a', 'second'));
    outbound.close();
    outbound.answer(resultFrame('command_0001', 'accepted'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles(sent)).toEqual(['first']);
  });
});

// --- the command memory -------------------------------------------------------------------------

describe('the commands this computer has answered', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-relay-commands-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const file = () => path.join(dir, 'relay', 'commands.json');

  it('acts once per computer and command id, answers a repeat with the first answer, and keeps that across a restart for a day', async () => {
    let clock = START;
    const ledger = new CommandLedger(dir, () => clock);
    await ledger.init();
    let acts = 0;
    const act = (commandId: string) => async () => {
      acts += 1;
      return resultFrame(commandId, 'accepted');
    };
    const [first, racing] = await Promise.all([ledger.once(DEVICE, 'command_0001', act('command_0001')), ledger.once(DEVICE, 'command_0001', act('command_0001'))]);
    expect(first).toEqual({ result: resultFrame('command_0001', 'accepted'), repeat: false });
    expect(racing).toEqual({ result: first.result, repeat: true });
    expect(await ledger.once(DEVICE, 'command_0001', act('command_0001'))).toEqual({ result: first.result, repeat: true });
    // Another computer's command with the same id is its own.
    expect((await ledger.once('relay_device_other', 'command_0001', act('command_0001'))).repeat).toBe(false);
    expect(acts).toBe(2);
    await ledger.settled();

    const restarted = new CommandLedger(dir, () => clock);
    await restarted.init();
    expect(await restarted.once(DEVICE, 'command_0001', act('command_0001'))).toEqual({ result: first.result, repeat: true });
    expect(acts).toBe(2);
    clock += RELAY_MESSAGE_TIMINGS.commandMemoryMs;
    expect((await restarted.once(DEVICE, 'command_0001', act('command_0001'))).repeat).toBe(false);
    expect(acts).toBe(3);
    await restarted.settled();
  });

  it('keeps only ids, times and answers, and starts empty from a file it cannot read', async () => {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), '{not json');
    const ledger = new CommandLedger(dir, () => START);
    await ledger.init();
    const refused = resultFrame('command_0002', 'refused', 'cap_question', DESKTOP_REFUSALS.cap_question);
    expect(await ledger.once(DEVICE, 'command_0002', async () => refused)).toEqual({ result: refused, repeat: false });
    await ledger.settled();
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual({ v: 1, commands: [{ deviceId: DEVICE, commandId: 'command_0002', at: START, result: refused }] });

    // A kept answer that is no longer a result from the closed set is not trusted.
    await fs.writeFile(file(), JSON.stringify({ v: 1, commands: [{ deviceId: DEVICE, commandId: 'command_0003', at: START, result: { v: 1, type: 'result', commandId: 'command_0003', outcome: 'maybe' } }] }));
    const reread = new CommandLedger(dir, () => START);
    await reread.init();
    expect((await reread.once(DEVICE, 'command_0003', async () => resultFrame('command_0003', 'accepted'))).repeat).toBe(false);
    await reread.settled();
  });
});

// --- worker rows --------------------------------------------------------------------------------

describe("worker rows from this computer's records", () => {
  const noChanges = () => () => {};

  it('says who pays from the route alone', () => {
    expect(['nectovia', 'aws-bedrock', 'oh-my-pi', 'codex', 'claude-code', 'sample', 'mystery', null].map((route) => payerOf(route))).toEqual([
      'nectovia-credits', 'your-key', 'your-key', 'your-subscription', 'your-subscription', 'local', 'unknown', 'unknown',
    ]);
  });

  it('lists running work first, newest first, then what finished in the last half hour, with a Stop shown until the run ends', async () => {
    const tasks = [
      taskFixture({ id: 'task_menu', stopReceipts: [stopReceipt('task_menu', 'session_running', minutesAgo(1))] }),
      taskFixture({ id: 'task_old', name: 'Price the drinks' }),
    ];
    const sessions = [
      sessionFixture({ id: 'session_running', taskId: 'task_menu', state: 'working', startedAt: minutesAgo(20), route: 'nectovia' }),
      sessionFixture({ id: 'session_member', taskId: 'task_menu', state: 'waiting', startedAt: minutesAgo(10), slotId: 'slot-1', route: 'claude-code' }),
      sessionFixture({ id: 'session_recent', taskId: 'task_old', state: 'done', startedAt: minutesAgo(40), endedAt: minutesAgo(10), route: 'codex' }),
      sessionFixture({ id: 'session_stale', taskId: 'task_old', state: 'failed', startedAt: minutesAgo(90), endedAt: new Date(START - RECENT_WORK_MS - 1).toISOString() }),
    ];
    const snapshot = await workRowsOf({
      state: () => ({ tasks, sessions, history: [], team: { members: [memberFixture('slot-1', 'Ada')] } }),
      projectIds: () => ['project_menu'], onChange: noChanges, now: () => START,
    }, 'project_menu');
    expect(snapshot).toMatchObject({ projectId: 'project_menu', rootRunId: null, taskTitle: 'Draft the winter menu', at: AT });
    expect(snapshot!.rows.map((item) => [item.rowId, item.kind, item.label, item.state, item.payer, item.verification])).toEqual([
      ['session_member', 'team-member', 'Ada', 'waiting', 'your-subscription', 'not-run'],
      ['session_running', 'session', 'Nectovia', 'stop-requested', 'nectovia-credits', 'not-run'],
      ['session_recent', 'external-worker', 'ChatGPT', 'answered', 'your-subscription', 'not-run'],
    ]);
    expect(await workRowsOf({ state: () => ({ tasks, sessions: [], history: [] }), projectIds: () => [], onChange: noChanges, now: () => START }, 'project_menu')).toBeNull();
  });

  it('shows the workers of the newest H14 lead still running, read from the handoff ledger and the runs', async () => {
    const opened = (leadRunId: string, childRunId: string, route: string, task: string) =>
      ({ v: 1, kind: 'opened', at: minutesAgo(5), handoffId: `handoff_${childRunId}`, leadRunId, role: 'worker', childRunId, task, route }) as unknown as HandoffEvent;
    const events = [
      opened('lead_old', 'child_a', 'claude-code', 'Old step'),
      opened('lead_new', 'child_b', 'aws-bedrock', 'Price the menu'),
      opened('lead_new', 'child_c', 'codex', 'Check the notes'),
      { v: 1, kind: 'settled', at: minutesAgo(1), handoffId: 'handoff_child_c', leadRunId: 'lead_new', childRunId: 'child_c', state: 'completed' } as unknown as HandoffEvent,
    ];
    const runs = [
      { id: 'lead_old', state: 'completed', taskId: 'task_menu' },
      { id: 'lead_new', state: 'running', taskId: 'task_menu' },
      { id: 'child_b', state: 'running', taskId: null },
    ];
    const snapshot = await workRowsOf({
      state: () => ({ tasks: [taskFixture()], sessions: [], history: [] }), projectIds: () => ['project_menu'], onChange: noChanges,
      runs: async () => runs, handoffs: async () => events, now: () => START,
    }, 'project_menu');
    expect(snapshot).toMatchObject({ rootRunId: 'lead_new', taskTitle: 'Draft the winter menu' });
    expect(snapshot!.rows.map((item) => [item.rowId, item.kind, item.label, item.title, item.state, item.payer, item.startedAt])).toEqual([
      ['child_b', 'h14-worker', 'AWS Bedrock', 'Price the menu', 'working', 'your-key', minutesAgo(5)],
      ['child_c', 'h14-worker', 'ChatGPT', 'Check the notes', 'answered', 'your-subscription', minutesAgo(5)],
    ]);
  });
});

// --- the handlers -------------------------------------------------------------------------------

interface Records {
  tasks: Task[];
  sessions: Session[];
  needs: Need[];
  changes: Change[];
  conversations: Conversation[];
  team: { members: TeamMember[]; messages: MailboxMessage[] } | null;
}

/** A stand-in desktop: records per project, the business that owns each, and every acting port's calls. */
function desktop() {
  const records = new Map<string, Records>();
  const owners = new Map<string, string | null>();
  const changeListeners = new Set<(projectId: string) => void>();
  const turnListeners = new Set<(event: { projectId: string; threadId: string; requestId: string }) => void>();
  const rows = fixtureWorkRows();
  const world = {
    records, owners, rows,
    person: OWNER as string | null,
    included: true,
    home: null as string | null,
    closing: false,
    warns: { message: false, wake: false },
    decided: 'decided' as 'decided' | 'already-answered',
    stopError: null as unknown,
    calls: [] as { port: string; input: unknown }[],
    /** The conversation's answer to a phone's message; it says the turn started first. */
    answer: async (): Promise<RelayTurnResult> => ({ answerText: 'The menu is drafted.', interrupted: false }),
    project(projectId: string, organizationId: string | null, patch: Partial<Records> = {}) {
      records.set(projectId, { tasks: [], sessions: [], needs: [], changes: [], conversations: [], team: null, ...patch });
      owners.set(projectId, organizationId);
      return records.get(projectId)!;
    },
    change(projectId: string) {
      for (const listener of [...changeListeners]) listener(projectId);
    },
    listeners: () => changeListeners.size + turnListeners.size + rows.listeners(),
    called: (port: string) => world.calls.filter((call) => call.port === port).map((call) => call.input),
  };
  const ports: PhoneRelayPorts = {
    personId: () => world.person,
    includes: (organizationId, feature) => world.included && organizationId === ORG && feature === PHONE_RELAY_FEATURE,
    organizationFor: (projectId) => (projectId === null ? ORG : (owners.get(projectId) ?? null)),
    projectIds: () => [...records.keys()],
    homeProjectId: () => world.home,
    state: (projectId) => {
      const found = records.get(projectId);
      if (!found) throw new ApiError(404, 'This project was not found.');
      return found;
    },
    workRows: rows.source,
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    onTurnStarted: (listener) => {
      turnListeners.add(listener);
      return () => {
        turnListeners.delete(listener);
      };
    },
    mutation: async (action) => {
      if (world.closing) throw new RelayRefusal('updating');
      return action();
    },
    decide: async (input) => {
      world.calls.push({ port: 'decide', input });
      if (world.decided === 'decided') records.get(input.projectId)!.needs.find((need) => need.id === input.needId)!.state = input.decision;
      return world.decided;
    },
    stop: async (projectId, target) => {
      world.calls.push({ port: 'stop', input: { projectId, target } });
      if (world.stopError) throw world.stopError;
    },
    thread: async (conversation) => {
      world.calls.push({ port: 'thread', input: conversation });
      return { projectId: conversation.kind === 'home' ? world.home! : conversation.projectId, threadId: 'thread_main', mode: 'auto' };
    },
    messageWarns: async () => world.warns.message,
    message: async (input) => {
      world.calls.push({ port: 'message', input });
      for (const listener of [...turnListeners]) listener({ projectId: input.projectId, threadId: input.threadId, requestId: input.commandId });
      return world.answer();
    },
    memberMessage: async (projectId, slotId, text) => {
      world.calls.push({ port: 'memberMessage', input: { projectId, slotId, text } });
    },
    wakeWarns: async () => world.warns.wake,
    wake: async (projectId, slotId) => {
      world.calls.push({ port: 'wake', input: { projectId, slotId } });
    },
  };
  return { world, ports };
}

const stamp = { personId: OWNER, sessionId: 'session_phone' };
/** A phone frame as the hub relays it: checked against the contract first, so no test sends what a link never would. */
function relayed(frame: Record<string, unknown>): RelayedPhoneMessage {
  const parsed = parseRelayedPhoneMessage(JSON.stringify({ v: 1, deviceId: DEVICE, from: stamp, ...frame }));
  if (!parsed) throw new Error(`Not a relayed phone frame: ${JSON.stringify(frame)}`);
  return parsed;
}
const hello = (from = stamp) => relayed({ type: 'hello', from });
const boardPage = (projectId: string, page: number) => relayed({ type: 'board.page', projectId, page });
const decision = (commandId: string, needId = 'need_menu', choice: 'go-ahead' | 'declined' = 'go-ahead') =>
  relayed({ type: 'need.decision', commandId, needId, decision: choice });
const stopTask = (commandId: string, projectId = 'project_menu', from = stamp) =>
  relayed({ type: 'stop.request', commandId, projectId, target: { kind: 'task', taskId: 'task_menu' }, from });
const stopRun = (commandId: string, runId: string) => relayed({ type: 'stop.request', commandId, projectId: 'project_menu', target: { kind: 'run', runId } });
const send = (commandId: string, conversation: ConversationRef, text: string) => relayed({ type: 'message.send', commandId, conversation, text });
const wake = (commandId: string, slotId: string) => relayed({ type: 'member.wake', commandId, projectId: 'project_menu', slotId });
const refusal = (commandId: string, code: keyof typeof DESKTOP_REFUSALS): ResultMessage =>
  ({ v: 1, type: 'result', commandId, outcome: 'refused', code, message: DESKTOP_REFUSALS[code] });
const accepted = (commandId: string): ResultMessage => ({ v: 1, type: 'result', commandId, outcome: 'accepted' });

async function until(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(5);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

describe("a computer answering its person's phone", () => {
  let dir: string;
  const opened: { handler: PhoneRelayMessages; commands: CommandLedger }[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ now: START });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-relay-messages-'));
  });
  afterEach(async () => {
    for (const { handler } of opened) handler.close();
    vi.useRealTimers();
    for (const { commands } of opened.splice(0)) await commands.settled();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function link(ports: PhoneRelayPorts) {
    const sent: string[] = [];
    const commands = new CommandLedger(dir);
    await commands.init();
    const handler = new PhoneRelayMessages({
      organizationId: ORG, deviceId: DEVICE, ports, commands,
      send: (text) => {
        sent.push(text);
        return true;
      },
    });
    opened.push({ handler, commands });
    const frames = () => sent.map((text) => JSON.parse(text) as DesktopToPhoneMessage);
    const results = () => frames().filter((frame): frame is ResultMessage => frame.type === 'result');
    return {
      handler, sent, frames, results,
      receive: (message: RelayedPhoneMessage) => handler.receive(message),
      async result(commandId: string) {
        await until(() => results().some((item) => item.commandId === commandId), `the answer to ${commandId}`);
        return results().filter((item) => item.commandId === commandId).at(-1)!;
      },
      turns: () => frames().filter((frame): frame is TurnUpdateMessage => frame.type === 'turn.update'),
      take() {
        const taken = frames();
        sent.length = 0;
        return taken;
      },
      async idle() {
        await vi.advanceTimersByTimeAsync(3_000);
        await handler.settled();
      },
    };
  }

  /** One business project with a running task, an open Need that names files, and its rows; another business's project beside it. */
  function bakery() {
    const { world, ports } = desktop();
    const menu = world.project('project_menu', ORG, {
      tasks: [taskFixture({ name: `Draft ${FOLDER}\\menu.md` })],
      sessions: [sessionFixture({ id: 'session_menu', taskId: 'task_menu', state: 'waiting', startedAt: minutesAgo(3), route: 'claude-code' })],
      needs: [needFixture({
        id: 'need_menu', sessionId: 'session_menu', taskId: 'task_menu', what: `Save ${FOLDER}\\menu.md`, why: 'The draft is finished.',
        consequence: 'The menu document on your computer changes.', files: [`${FOLDER}\\menu.md`, `${FOLDER}\\notes\\prices.csv`],
      })],
    });
    world.project('project_harbor', OTHER_ORG, { tasks: [taskFixture({ id: 'task_harbor' })], needs: [needFixture({ id: 'need_harbor', taskId: 'task_harbor' })] });
    world.rows.set({ projectId: 'project_menu', rootRunId: null, taskTitle: 'Draft the winter menu', rows: [row({ rowId: 'session_menu', state: 'waiting' })], at: AT });
    world.rows.set({ projectId: 'project_harbor', rootRunId: null, taskTitle: 'Harbor work', rows: [row({ rowId: 'session_harbor' })], at: AT });
    return { world, ports, menu };
  }

  it("answers the signed-in person's hello with the rows, the Board and each open Need of this business only, naming files, never folders", async () => {
    const { world, ports } = bakery();
    world.home = 'project_home';
    world.project('project_home', ORG, { tasks: [taskFixture({ id: 'task_home' })] });
    const phone = await link(ports);
    phone.receive(hello());
    await until(() => phone.frames().length >= 3, 'the pictures');
    await phone.idle();
    const frames = phone.frames();
    expect(frames.map((frame) => frame.type)).toEqual(['work.rows', 'board.counts', 'need.summary']);
    expect(frames.every((frame) => 'projectId' in frame && frame.projectId === 'project_menu')).toBe(true);
    expect(frames[2]).toEqual({
      v: 1, type: 'need.summary', needId: 'need_menu', projectId: 'project_menu', taskTitle: 'Draft menu.md', what: 'Save menu.md',
      why: 'The draft is finished.', consequence: 'The menu document on your computer changes.', files: ['menu.md', 'prices.csv'],
      expiresAt: new Date(START + RELAY_MESSAGE_TIMINGS.needDecisionMs).toISOString(), part: 1, parts: 1,
    });
    for (const text of phone.sent) {
      expect(parsePhoneBound(text)).not.toBeNull();
      expect(text).not.toContain('pat-folder');
    }
    expect(world.calls).toEqual([]);
  });

  it('answers nothing to a hello or a page request from anyone but the signed-in person, or without phone access', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    phone.receive(hello({ personId: 'person_other', sessionId: 'session_other' }));
    world.person = null;
    phone.receive(hello());
    phone.receive(boardPage('project_menu', 1));
    world.person = OWNER;
    world.included = false;
    phone.receive(hello());
    await phone.idle();
    expect(phone.sent).toEqual([]);
    // Another business's project is not this link's to show.
    world.included = true;
    phone.receive(boardPage('project_harbor', 1));
    await phone.idle();
    expect(phone.sent).toEqual([]);
  });

  it('refuses a command from anyone but the person signed in on this computer, and without phone access, before any path runs', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    phone.receive(stopTask('command_0001', 'project_menu', { personId: 'person_other', sessionId: 'session_other' }));
    expect(await phone.result('command_0001')).toEqual(refusal('command_0001', 'not_signed_in_person'));
    world.person = null;
    phone.receive(stopTask('command_0002'));
    expect(await phone.result('command_0002')).toEqual(refusal('command_0002', 'not_signed_in_person'));
    world.person = OWNER;
    world.included = false;
    phone.receive(stopTask('command_0003'));
    expect(await phone.result('command_0003')).toEqual(refusal('command_0003', 'phone_relay_not_included'));
    expect(world.calls).toEqual([]);
  });

  it('takes a decision through the Need answer path once, only inside the window its summary opened', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    // No summary was sent this run, so no window is open.
    phone.receive(decision('command_0001'));
    expect(await phone.result('command_0001')).toMatchObject({ outcome: 'expired', code: 'expired', message: expect.any(String) });
    phone.receive(hello());
    await until(() => phone.frames().some((frame) => frame.type === 'need.summary'), 'the summary');
    phone.receive(decision('command_0002'));
    expect(await phone.result('command_0002')).toEqual(accepted('command_0002'));
    expect(world.called('decide')).toEqual([{ projectId: 'project_menu', needId: 'need_menu', decision: 'go-ahead', commandId: 'command_0002', personId: OWNER }]);
    // The phone didn't hear the answer and sends the same command again: the same answer, nothing done twice.
    phone.receive(decision('command_0002'));
    await until(() => phone.results().filter((item) => item.commandId === 'command_0002').length === 2, 'the repeated answer');
    expect(phone.results().filter((item) => item.commandId === 'command_0002')).toEqual([accepted('command_0002'), accepted('command_0002')]);
    phone.receive(decision('command_0003', 'need_menu', 'declined'));
    expect(await phone.result('command_0003')).toEqual({
      v: 1, type: 'result', commandId: 'command_0003', outcome: 'already-done', code: 'already_answered', message: ALREADY_ANSWERED,
    });
    expect(world.called('decide')).toHaveLength(1);
  });

  it('lets the window close ten minutes after the summary, and says when the computer answered first', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    phone.receive(hello());
    await until(() => phone.frames().some((frame) => frame.type === 'need.summary'), 'the summary');
    await vi.advanceTimersByTimeAsync(RELAY_MESSAGE_TIMINGS.needDecisionMs);
    phone.receive(decision('command_0004'));
    expect(await phone.result('command_0004')).toMatchObject({ outcome: 'expired', code: 'expired' });
    // A hello sends the summary again and opens a new window.
    phone.take();
    phone.receive(hello());
    await until(() => phone.frames().some((frame) => frame.type === 'need.summary'), 'the summary again');
    world.decided = 'already-answered';
    phone.receive(decision('command_0005'));
    expect(await phone.result('command_0005')).toMatchObject({ outcome: 'already-done', code: 'already_answered', message: ALREADY_ANSWERED });
    // A Need not on this computer, or another business's, is not found.
    phone.receive(decision('command_0006', 'need_gone'));
    expect(await phone.result('command_0006')).toEqual(refusal('command_0006', 'need_not_found'));
    phone.receive(decision('command_0007', 'need_harbor'));
    expect(await phone.result('command_0007')).toEqual(refusal('command_0007', 'need_not_found'));
  });

  it("stops a task or a run through Work control, and names a missing run without repeating the error's words", async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    phone.receive(stopTask('command_0010'));
    expect(await phone.result('command_0010')).toEqual(accepted('command_0010'));
    phone.receive(stopTask('command_0011', 'project_harbor'));
    expect(await phone.result('command_0011')).toEqual(refusal('command_0011', 'not_this_business'));
    world.stopError = new ApiError(404, `${FOLDER}\\run.json was not found.`, { code: 'run_not_found' });
    phone.receive(stopRun('command_0012', 'session_gone'));
    expect(await phone.result('command_0012')).toEqual(refusal('command_0012', 'run_not_found'));
    world.stopError = new ApiError(404, 'This task was not found.');
    phone.receive(stopTask('command_0013'));
    expect(await phone.result('command_0013')).toEqual(refusal('command_0013', 'task_not_found'));
    world.stopError = new Error(`EPERM: operation not permitted, open '${FOLDER}\\lock'`);
    phone.receive(stopTask('command_0014'));
    expect(await phone.result('command_0014')).toMatchObject({ outcome: 'refused', code: 'refused' });
    expect(world.called('stop')).toEqual([
      { projectId: 'project_menu', target: { kind: 'task', taskId: 'task_menu' } },
      { projectId: 'project_menu', target: { kind: 'run', runId: 'session_gone' } },
      { projectId: 'project_menu', target: { kind: 'task', taskId: 'task_menu' } },
      { projectId: 'project_menu', target: { kind: 'task', taskId: 'task_menu' } },
    ]);
    for (const text of phone.sent) expect(text).not.toContain('pat-folder');
  });

  it('wakes a Team member through the Team wake path, refusing when nothing waits, documents would go, or the cap would ask', async () => {
    const { world, ports, menu } = bakery();
    menu.team = { members: [memberFixture('slot-1', 'Ada')], messages: [] };
    const phone = await link(ports);
    phone.receive(wake('command_0020', 'slot-9'));
    expect(await phone.result('command_0020')).toEqual(refusal('command_0020', 'member_not_found'));
    phone.receive(wake('command_0021', 'slot-1'));
    expect(await phone.result('command_0021')).toEqual(refusal('command_0021', 'nothing_waiting'));
    menu.team.messages = [mailFixture({ files: [`${FOLDER}\\menu.md`] })];
    phone.receive(wake('command_0022', 'slot-1'));
    expect(await phone.result('command_0022')).toEqual(refusal('command_0022', 'names_documents'));
    menu.team.messages = [mailFixture()];
    world.warns.wake = true;
    phone.receive(wake('command_0023', 'slot-1'));
    expect(await phone.result('command_0023')).toEqual(refusal('command_0023', 'cap_question'));
    world.warns.wake = false;
    phone.receive(wake('command_0024', 'slot-1'));
    expect(await phone.result('command_0024')).toEqual(accepted('command_0024'));
    expect(world.called('wake')).toEqual([{ projectId: 'project_menu', slotId: 'slot-1' }]);
  });

  it("puts a message to a Team member in its mailbox, as the owner's", async () => {
    const { world, ports, menu } = bakery();
    menu.team = { members: [memberFixture('slot-1', 'Ada')], messages: [] };
    const phone = await link(ports);
    phone.receive(send('command_0030', { kind: 'member', projectId: 'project_menu', slotId: 'slot-1' }, 'Use the summer prices.'));
    expect(await phone.result('command_0030')).toEqual(accepted('command_0030'));
    phone.receive(send('command_0031', { kind: 'member', projectId: 'project_menu', slotId: 'slot-9' }, 'Hello?'));
    expect(await phone.result('command_0031')).toEqual(refusal('command_0031', 'member_not_found'));
    expect(world.called('memberMessage')).toEqual([{ projectId: 'project_menu', slotId: 'slot-1', text: 'Use the summer prices.' }]);
    expect(phone.turns()).toEqual([]);
  });

  it('sends a message as the conversation\'s next one, accepted once the turn starts, then the saved answer in order', async () => {
    const { world, ports } = bakery();
    let finish!: (result: RelayTurnResult) => void;
    world.answer = () => new Promise<RelayTurnResult>((resolve) => (finish = resolve));
    const phone = await link(ports);
    const conversation = { kind: 'project', projectId: 'project_menu' } as const;
    phone.receive(send('command_0040', conversation, '  How is the menu going?  '));
    expect(await phone.result('command_0040')).toEqual(accepted('command_0040'));
    await until(() => phone.turns().length === 1, 'the running update');
    expect(phone.turns()).toEqual([{ v: 1, type: 'turn.update', conversation, turnId: 'command_0040', status: 'running', text: '', seq: 0 }]);
    expect(world.called('message')).toEqual([{ projectId: 'project_menu', threadId: 'thread_main', commandId: 'phone.command_0040', text: 'How is the menu going?', mode: 'auto' }]);

    const answer = `It is drafted in ${FOLDER}\\menu.md. ${'The soups are seasonal. '.repeat(160)}`;
    finish({ answerText: answer, interrupted: false });
    await until(() => phone.turns().at(-1)?.status === 'done', 'the answer');
    const turns = phone.turns();
    expect(turns.map((turn) => [turn.seq, turn.status])).toEqual([[0, 'running'], [1, 'running'], [2, 'done']]);
    expect(turns.map((turn) => turn.text).join('')).toBe(answer.replace(`${FOLDER}\\menu.md`, 'menu.md'));
    expect(phone.sent.every((text) => parsePhoneBound(text) !== null && !text.includes('pat-folder'))).toBe(true);
  });

  it('says how a turn ended when it was stopped, failed, or never started', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    const conversation = { kind: 'project', projectId: 'project_menu' } as const;
    world.answer = async () => ({ answerText: 'Half a menu.', interrupted: true });
    phone.receive(send('command_0050', conversation, 'Go on.'));
    await until(() => phone.turns().at(-1)?.status === 'stopped', 'the stopped turn');
    world.answer = async () => ({ answerText: null, interrupted: false });
    phone.receive(send('command_0051', conversation, 'Try again.'));
    await until(() => phone.turns().at(-1)?.status === 'failed', 'the failed turn');
    expect(phone.turns().at(-1)).toMatchObject({ turnId: 'command_0051', text: '', seq: 1 });
    // A path that refuses before the turn starts answers with its own code, and no turn follows.
    ports.message = async () => {
      throw new ApiError(409, 'Another answer is still running.', { code: 'conversation_busy' });
    };
    phone.receive(send('command_0052', conversation, 'And now?'));
    expect(await phone.result('command_0052')).toMatchObject({ outcome: 'refused', code: 'conversation_busy' });
    await phone.idle();
    expect(phone.turns().some((turn) => turn.turnId === 'command_0052')).toBe(false);
  });

  it("refuses a message the job cap would question, and Home unless it exists and is this business's", async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    world.warns.message = true;
    phone.receive(send('command_0060', { kind: 'project', projectId: 'project_menu' }, 'Draft three more menus.'));
    expect(await phone.result('command_0060')).toEqual(refusal('command_0060', 'cap_question'));
    world.warns.message = false;
    phone.receive(send('command_0061', { kind: 'home' }, 'Good morning.'));
    expect(await phone.result('command_0061')).toEqual(refusal('command_0061', 'not_this_business'));
    world.home = 'project_home';
    world.project('project_home', null);
    phone.receive(send('command_0062', { kind: 'home' }, 'Good morning.'));
    expect(await phone.result('command_0062')).toEqual(refusal('command_0062', 'not_this_business'));
    world.owners.set('project_home', ORG);
    phone.receive(send('command_0063', { kind: 'home' }, 'Good morning.'));
    expect(await phone.result('command_0063')).toEqual(accepted('command_0063'));
    expect(world.called('thread')).toEqual([{ kind: 'project', projectId: 'project_menu' }, { kind: 'home' }]);
    expect(world.called('message')).toEqual([{ projectId: 'project_home', threadId: 'thread_main', commandId: 'phone.command_0063', text: 'Good morning.', mode: 'auto' }]);
  });

  it('refuses every change while the app closes for an update', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    phone.receive(hello());
    await until(() => phone.frames().some((frame) => frame.type === 'need.summary'), 'the summary');
    world.closing = true;
    phone.receive(stopTask('command_0070'));
    phone.receive(decision('command_0071'));
    expect(await phone.result('command_0070')).toEqual(refusal('command_0070', 'updating'));
    expect(await phone.result('command_0071')).toEqual(refusal('command_0071', 'updating'));
    expect(world.calls).toEqual([]);
  });

  it('sends changes only while a phone attends, and only what changed, one picture of a kind per project a second', async () => {
    const { world, ports, menu } = bakery();
    const phone = await link(ports);
    world.change('project_menu');
    await phone.idle();
    expect(phone.sent).toEqual([]);

    phone.receive(hello());
    await until(() => phone.frames().length >= 3, 'the pictures');
    phone.take();
    menu.needs.push(needFixture({ id: 'need_prices', sessionId: 'session_menu', taskId: 'task_menu', what: 'Change the prices' }));
    world.change('project_menu');
    world.change('project_harbor');
    await until(() => phone.frames().length >= 2, 'the changes');
    await phone.idle();
    const changed = phone.take();
    expect(changed.map((frame) => frame.type).sort()).toEqual(['board.counts', 'need.summary']);
    expect(changed.find((frame) => frame.type === 'need.summary')).toMatchObject({ needId: 'need_prices' });
    world.rows.set({ projectId: 'project_menu', rootRunId: null, taskTitle: 'Draft the winter menu', rows: [row({ rowId: 'session_menu', state: 'working' })], at: AT });
    world.rows.set({ projectId: 'project_harbor', rootRunId: null, taskTitle: 'Harbor work', rows: [row({ state: 'failed' })], at: AT });
    await phone.idle();
    expect(phone.take()).toEqual([expect.objectContaining({ type: 'work.rows', projectId: 'project_menu', rows: [expect.objectContaining({ state: 'working' })] })]);

    // Five minutes without a word from the phone: nothing more is sent.
    await vi.advanceTimersByTimeAsync(RELAY_MESSAGE_TIMINGS.attentionMs);
    world.change('project_menu');
    await phone.idle();
    expect(phone.sent).toEqual([]);
  });

  it('sends the Board page a phone asks for', async () => {
    const { world, ports, menu } = bakery();
    menu.tasks.push(...Array.from({ length: 22 }, (_, index) => taskFixture({ id: `task_${index}`, name: `Task ${index}`, createdAt: minutesAgo(index + 1) })));
    const phone = await link(ports);
    phone.receive(boardPage('project_menu', 3));
    await until(() => phone.frames().length === 1, 'the page');
    expect(phone.frames()[0]).toMatchObject({ type: 'board.counts', page: 3, pages: 3, cards: expect.any(Array) });
    phone.receive(boardPage('project_menu', 9));
    await until(() => phone.frames().length === 2, 'the last page');
    expect(phone.frames()[1]).toMatchObject({ type: 'board.counts', page: 3, pages: 3 });
    expect(world.calls).toEqual([]);
  });

  it('lets go of every subscription when its link closes', async () => {
    const { world, ports } = bakery();
    const phone = await link(ports);
    expect(world.listeners()).toBe(2);
    phone.handler.close();
    expect(world.listeners()).toBe(0);
    phone.receive(hello());
    await phone.idle();
    expect(phone.sent).toEqual([]);
  });
});
