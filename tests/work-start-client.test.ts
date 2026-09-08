import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../client/api.js';
import type { Session } from '../shared/types.js';

const PREFIX = 'diomedes.work-start.pending.';
const TARGET_PROJECT = 'proj-1';
const TARGET_TASK = 'task-1';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TARGET_TASK,
    route: 'codex' as const,
    sources: ['a'],
    consent: true,
    instruction: 'do it',
    threadId: 'thread-1',
    ...overrides,
  };
}

function makeStorage() {
  const map = new Map<string, string>();
  let getItemImpl: ((k: string) => string | null) | null = null;
  let setItemImpl: ((k: string, v: string) => void) | null = null;
  const store = {
    getItem(k: string): string | null {
      if (getItemImpl) return getItemImpl(k);
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
      if (setItemImpl) return setItemImpl(k, v);
      map.set(String(k), String(v));
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    clear(): void {
      map.clear();
    },
    key(i: number): string | null {
      return Array.from(map.keys())[i] ?? null;
    },
    get length(): number {
      return map.size;
    },
    __map: map,
    __failGet(err: Error) {
      getItemImpl = () => {
        throw err;
      };
    },
    __failSet(err: Error) {
      setItemImpl = () => {
        throw err;
      };
    },
    __resetImpls() {
      getItemImpl = null;
      setItemImpl = null;
    },
  };
  return store;
}

type Store = ReturnType<typeof makeStorage>;
let storage: Store;
let fetchMock: ReturnType<typeof vi.fn>;
let uuidCount: number;
let startWork: (typeof import('../client/work-start.js'))['startWork'];
let reconcileWorkStarts: (typeof import('../client/work-start.js'))['reconcileWorkStarts'];

function pendingKey(projectId: string, taskId: string) {
  return `${PREFIX}${encodeURIComponent(projectId)}|${encodeURIComponent(taskId)}`;
}

function readPending(projectId = TARGET_PROJECT, taskId = TARGET_TASK) {
  const raw = storage.getItem(pendingKey(projectId, taskId));
  return raw ? (JSON.parse(raw) as { commandId: string }) : null;
}

function okSession(id = 'sess-1') {
  return {
    id,
    taskId: TARGET_TASK,
    state: 'working' as const,
    startedAt: '2026-09-08T00:00:00.000Z',
    endedAt: null,
    sample: false,
    log: [],
    entryIds: [],
    needId: null,
    engine: { name: 'codex', model: null, worker: 1, branch: null, context: null, events: 0 },
  };
}

function okFetch(session: ReturnType<typeof okSession>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ...session,
      receipt: {
        protocolVersion: 1,
        commandId: JSON.parse(fetchMock.mock.calls.at(-1)![1].body).commandId,
        projectId: TARGET_PROJECT,
        taskId: TARGET_TASK,
        sessionId: session.id,
        scope: 'local-prototype',
        route: 'codex',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
      },
    }),
  };
}

function errFetch(status: number, body: unknown = { error: { message: `err ${status}` } }) {
  return { ok: false, status, json: async () => body };
}

async function freshModule() {
  vi.resetModules();
  const mod = await import('../client/work-start.js');
  startWork = mod.startWork;
  reconcileWorkStarts = mod.reconcileWorkStarts;
}

beforeEach(async () => {
  storage = makeStorage();
  vi.stubGlobal('sessionStorage', storage);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  uuidCount = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    (() => `test-uuid-${++uuidCount}`) as typeof globalThis.crypto.randomUUID,
  );
  await freshModule();
});

describe('work-start client', () => {
  test.each(['broken', '%invalid'])(
    'a damaged pending key %s cannot block another confirmed request',
    async (badKey) => {
      const key = `${PREFIX}${TARGET_PROJECT}|${badKey}`;
      storage.setItem(key, '{broken');
      fetchMock.mockRejectedValue(new TypeError('lost both responses'));
      await expect(startWork(TARGET_PROJECT, baseInput())).rejects.toThrow(
        'could not be confirmed',
      );
      const session: Session = {
        ...okSession(),
        receipt: {
          protocolVersion: 1,
          commandId: readPending()!.commandId,
          projectId: TARGET_PROJECT,
          taskId: TARGET_TASK,
          sessionId: 'sess-1',
          route: 'codex',
          scope: 'local-prototype',
          payloadDigest: `sha256:${'a'.repeat(64)}`,
          eventId: 'event-1',
          admittedAt: '2026-09-08T00:00:00.000Z',
        },
      };
      expect(reconcileWorkStarts(TARGET_PROJECT, [session])?.message).toContain('could not be checked');
      expect(storage.getItem(key)).toBe('{broken');
      expect(readPending()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  test('unavailable browser storage returns a reportable issue without throwing into state loading', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(reconcileWorkStarts(TARGET_PROJECT, [])?.message).toContain('storage is unavailable');
  });

  test('reload reconciles an ambiguous start from host state without another request', async () => {
    fetchMock.mockRejectedValue(new TypeError('lost both responses'));
    await expect(startWork(TARGET_PROJECT, baseInput())).rejects.toThrow('could not be confirmed');
    const commandId = readPending()!.commandId;
    await freshModule();
    const session: Session = {
      ...okSession(),
      receipt: {
        protocolVersion: 1,
        commandId,
        projectId: TARGET_PROJECT,
        taskId: TARGET_TASK,
        sessionId: 'sess-1',
        route: 'codex',
        scope: 'local-prototype',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        eventId: 'event-1',
        admittedAt: '2026-09-08T00:00:00.000Z',
      },
    };
    reconcileWorkStarts(TARGET_PROJECT, [
      { ...session, receipt: { ...session.receipt!, projectId: 'another' } },
    ]);
    expect(readPending()?.commandId).toBe(commandId);
    reconcileWorkStarts(TARGET_PROJECT, [session]);
    expect(readPending()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uuidCount).toBe(1);
  });

  test('a snapshot with no matching receipt keeps the unresolved request', async () => {
    fetchMock.mockRejectedValue(new TypeError('host offline'));
    await expect(startWork(TARGET_PROJECT, baseInput())).rejects.toThrow('could not be confirmed');
    reconcileWorkStarts(TARGET_PROJECT, [okSession()]);
    expect(readPending()?.commandId).toBe('test-uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('lost response retry reuses exactly the same ID and body', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockResolvedValueOnce(okFetch(okSession()));
    const result = await startWork(TARGET_PROJECT, baseInput());
    expect(result.id).toBe('sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(first.commandId).toBe('test-uuid-1');
    expect(second.commandId).toBe('test-uuid-1');
    expect(second).toEqual(first);
    expect(first.protocolVersion).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${encodeURIComponent(TARGET_PROJECT)}/work/start`,
    );
    expect(readPending()).toBeNull();
  });

  test('exhausted ambiguous retries keep pending and stop at 2 attempts', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((err as Error).message)).toContain('Work start could not be confirmed');
    expect(String((err as Error).message)).toContain(
      'retrying the same task checks the original request',
    );
    const pending = readPending();
    expect(pending?.commandId).toBe('test-uuid-1');
    const ids = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).commandId);
    expect(ids).toEqual(['test-uuid-1', 'test-uuid-1']);
  });

  test('module reset (reload) reuses pending identity', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await startWork(TARGET_PROJECT, baseInput()).catch(() => undefined);
    expect(readPending()?.commandId).toBe('test-uuid-1');
    await freshModule();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(okFetch(okSession()));
    const result = await startWork(TARGET_PROJECT, baseInput());
    expect(result.id).toBe('sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.commandId).toBe('test-uuid-1');
    expect(readPending()).toBeNull();
  });

  test('concurrent identical calls join into one request', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => void (release = resolve as (v: unknown) => void)),
    );
    const a = startWork(TARGET_PROJECT, baseInput());
    const b = startWork(TARGET_PROJECT, baseInput());
    release(okFetch(okSession()));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.id).toBe('sess-1');
    expect(rb.id).toBe('sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('changed body is blocked without a new fetch or ID', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await startWork(TARGET_PROJECT, baseInput({ instruction: 'original' })).catch(() => undefined);
    expect(readPending()?.commandId).toBe('test-uuid-1');
    fetchMock.mockClear();
    const err = await startWork(TARGET_PROJECT, baseInput({ instruction: 'changed' })).catch(
      (e) => e as Error,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String((err as Error).message)).toContain(
      'must be resolved by retrying its original request',
    );
    expect(readPending()?.commandId).toBe('test-uuid-1');
  });

  test('conclusive first 4xx retries nothing and leaves no pending', async () => {
    fetchMock.mockResolvedValueOnce(errFetch(400));
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { ApiError: Fresh } = await import('../client/api.js');
    expect(err).toBeInstanceOf(Fresh);
    expect((err as ApiError).status).toBe(400);
    expect(readPending()).toBeNull();
  });

  test('ambiguous failure followed by 4xx retains the pending ID', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('reset')).mockResolvedValueOnce(errFetch(422));
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { ApiError: Fresh } = await import('../client/api.js');
    expect(err).toBeInstanceOf(Fresh);
    expect((err as ApiError).status).toBe(422);
    expect(readPending()?.commandId).toBe('test-uuid-1');
  });

  test('reload pending plus later 4xx retains identity', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await startWork(TARGET_PROJECT, baseInput()).catch(() => undefined);
    await freshModule();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(errFetch(403));
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    const { ApiError: Fresh } = await import('../client/api.js');
    expect(err).toBeInstanceOf(Fresh);
    expect((err as ApiError).status).toBe(403);
    expect(readPending()?.commandId).toBe('test-uuid-1');
  });

  test('storage failure blocks dispatch', async () => {
    storage.__failGet(new Error('storage denied'));
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String((err as Error).message.length > 0)).toBe('true');
  });

  test('malformed stored record blocks dispatch', async () => {
    storage.getItem = (() => '{not-json') as typeof storage.getItem;
    const err = await startWork(TARGET_PROJECT, baseInput()).catch((e) => e as Error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String((err as Error).message.length > 0)).toBe('true');
  });

  test('success allows a later deliberate fresh ID', async () => {
    fetchMock.mockResolvedValueOnce(okFetch(okSession('s1')));
    await startWork(TARGET_PROJECT, baseInput({ instruction: 'one' }));
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(okFetch(okSession('s2')));
    const second = await startWork(TARGET_PROJECT, baseInput({ instruction: 'two' }));
    expect(second.id).toBe('s2');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.commandId).toBe('test-uuid-2');
    expect(body.commandId).not.toBe('test-uuid-1');
  });

  test('pending capacity denies a new command but permits an existing retry', async () => {
    for (let i = 0; i < 32; i++) {
      storage.setItem(
        `${PREFIX}other${i}|othertask${i}`,
        JSON.stringify({
          commandId: `other-id-${i}`,
          projectId: `other${i}`,
          taskId: `othertask${i}`,
          input: {
            taskId: `othertask${i}`,
            route: 'codex',
            sources: [],
            consent: true,
          },
        }),
      );
    }
    const err = await startWork('brand-new', baseInput({ taskId: 'brand-new-task' })).catch(
      (e) => e as Error,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String((err as Error).message.length > 0)).toBe('true');
    // Existing pending retry is still permitted at capacity: reuse its identity.
    storage.clear();
    for (let i = 0; i < 31; i++) {
      storage.setItem(
        `${PREFIX}other${i}|othertask${i}`,
        JSON.stringify({
          commandId: `other-id-${i}`,
          projectId: `other${i}`,
          taskId: `othertask${i}`,
          input: {
            taskId: `othertask${i}`,
            route: 'codex',
            sources: [],
            consent: true,
          },
        }),
      );
    }
    storage.setItem(
      pendingKey(TARGET_PROJECT, TARGET_TASK),
      JSON.stringify({
        commandId: 'kept-id',
        projectId: TARGET_PROJECT,
        taskId: TARGET_TASK,
        input: {
          taskId: TARGET_TASK,
          route: 'codex',
          sources: ['a'],
          consent: true,
          instruction: 'do it',
          threadId: 'thread-1',
        },
      }),
    );
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(okFetch(okSession()));
    const result = await startWork(TARGET_PROJECT, baseInput());
    expect(result.id).toBe('sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.commandId).toBe('kept-id');
  });
  test('a response without the matching receipt stays uncertain and keeps the command', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => okSession() });
    await expect(startWork(TARGET_PROJECT, baseInput())).rejects.toThrow('could not be confirmed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPending()).not.toBeNull();
  });
  test('receipt cleanup failure is explicit and does not retry a confirmed send', async () => {
    storage.removeItem = () => {
      throw new Error('Storage denied');
    };
    fetchMock.mockResolvedValueOnce(okFetch(okSession()));
    await expect(startWork(TARGET_PROJECT, baseInput())).rejects.toThrow('Work was accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPending()).not.toBeNull();
  });
});
