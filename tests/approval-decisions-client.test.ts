import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../client/api.js';
import type { Need } from '../shared/types.js';

const PREFIX = 'diomedes.approval.pending.';
const PROJECT = 'proj-1';
const NEED = 'need-1';
const TASK = 'task-1';
const SESSION = 'sess-1';

const PROPOSAL = `sha256:${'a'.repeat(64)}`;
const ACTION = `sha256:${'b'.repeat(64)}`;
const BASE = `sha256:${'c'.repeat(64)}`;
const PAYLOAD = `sha256:${'d'.repeat(64)}`;
const CREATED = '2026-09-08T00:00:00.000Z';
const EXPIRES = '2026-09-08T01:00:00.000Z';
const DECIDED = '2026-09-08T00:10:00.000Z';

function baseNeed(overrides: Record<string, unknown> = {}): Need {
  return {
    id: NEED,
    sessionId: SESSION,
    taskId: TASK,
    what: 'do thing',
    why: 'reason',
    consequence: 'none',
    files: ['a.txt'],
    state: 'open',
    createdAt: CREATED,
    decidedAt: null,
    decidedFrom: '',
    allowForTask: false,
    preview: [
      {
        id: 'change-1',
        entryId: 'entry-1',
        sessionId: SESSION,
        taskId: TASK,
        path: 'a.txt',
        op: 'modified',
        summary: 'edit',
        before: 'old',
        after: 'new',
        current: 'old',
        changedSince: null,
        hunks: [{ value: 'diff' }],
        state: 'waiting',
      },
    ],
    approval: {
      protocolVersion: 1,
      proposalDigest: PROPOSAL,
      actionDigest: ACTION,
      baseDigest: BASE,
      expiresAt: EXPIRES,
      sources: [{ path: 'a.txt', sha: 'e'.repeat(64) }],
    },
    ...overrides,
  } as Need;
}

function legacyNeed(): Need {
  const need = baseNeed();
  delete (need as Partial<Need>).approval;
  delete (need as Partial<Need>).approvalReceipt;
  delete (need as Partial<Need>).execution;
  return need;
}

function makeStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem(k: string): string | null {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
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
  };
  return store;
}

type Store = ReturnType<typeof makeStorage>;
let storage: Store;
let fetchMock: ReturnType<typeof vi.fn>;
let uuidCount: number;
let decideApproval: (typeof import('../client/approval-decisions.js'))['decideApproval'];
let reconcileApprovals: (typeof import('../client/approval-decisions.js'))['reconcileApprovals'];

function pendingKey(projectId = PROJECT, needId = NEED) {
  return `${PREFIX}${encodeURIComponent(projectId)}|${encodeURIComponent(needId)}`;
}

function readPending(projectId = PROJECT, needId = NEED) {
  const raw = storage.getItem(pendingKey(projectId, needId));
  return raw ? (JSON.parse(raw) as { commandId?: string; command: { commandId: string } }) : null;
}

function readRaw(projectId = PROJECT, needId = NEED) {
  return storage.getItem(pendingKey(projectId, needId));
}

function receiptFor(commandId: string, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    commandId,
    payloadDigest: PAYLOAD,
    projectId: PROJECT,
    approvalId: NEED,
    taskId: TASK,
    sessionId: SESSION,
    actor: 'local-client',
    scope: 'local-prototype',
    proposalDigest: PROPOSAL,
    actionDigest: ACTION,
    baseDigest: BASE,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    decision: 'go-ahead',
    decidedAt: DECIDED,
    eventId: 'event-1',
    ...overrides,
  };
}

function decidedNeed(
  commandId: string,
  resolution: 'go-ahead' | 'declined' = 'go-ahead',
  receiptOverrides: Record<string, unknown> = {},
  needOverrides: Record<string, unknown> = {},
): Need {
  const need = baseNeed({
    state: resolution,
    decidedAt: DECIDED,
    decidedFrom: 'you',
    ...needOverrides,
  });
  (need as { approvalReceipt?: unknown }).approvalReceipt = receiptFor(commandId, {
    decision: resolution,
    ...receiptOverrides,
  });
  return need;
}

function okFetchFor(need: Need) {
  return { ok: true, status: 200, json: async () => need };
}

function errFetch(status: number, body: unknown = { error: { message: `err ${status}` } }) {
  return { ok: false, status, json: async () => body };
}

async function freshModule() {
  vi.resetModules();
  const mod = await import('../client/approval-decisions.js');
  decideApproval = mod.decideApproval;
  reconcileApprovals = mod.reconcileApprovals;
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

describe('approval-decisions client', () => {
  test('legacy need without approval sends plain POST once without retries', async () => {
    const returned = baseNeed({ state: 'go-ahead', decidedAt: DECIDED });
    delete (returned as Partial<Need>).approval;
    fetchMock.mockResolvedValueOnce(okFetchFor(returned));
    const result = await decideApproval(PROJECT, legacyNeed(), 'go-ahead');
    expect(result.state).toBe('go-ahead');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `/api/projects/${encodeURIComponent(PROJECT)}/needs/${encodeURIComponent(NEED)}/resolve`,
    );
    const body = JSON.parse(init.body as string);
    expect(body.resolution).toBe('go-ahead');
    expect(body).not.toHaveProperty('commandId');
    expect(body).not.toHaveProperty('protocolVersion');
    expect(storage.length).toBe(0);
  });

  test('legacy failure does not retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('down'));
    await expect(decideApproval(PROJECT, legacyNeed(), 'declined')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.length).toBe(0);
  });

  test('new exact need stores compact pending before POST without file text', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      const stored = readRaw();
      expect(stored).not.toBeNull();
      expect(stored).not.toContain('do thing');
      expect(stored).not.toContain('a.txt');
      expect(stored).not.toContain('sources');
      expect(stored).not.toContain('preview');
      const parsed = JSON.parse(stored as string);
      expect(Object.keys(parsed).sort()).toEqual([
        'command',
        'needId',
        'projectId',
        'sessionId',
        'taskId',
      ]);
      expect(Object.keys(parsed.command).sort()).toEqual([
        'actionDigest',
        'baseDigest',
        'commandId',
        'proposalDigest',
        'protocolVersion',
        'resolution',
      ]);
      const body = JSON.parse(init.body);
      expect(body.commandId).toBe(parsed.command.commandId);
      return okFetchFor(decidedNeed(parsed.command.commandId));
    });
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(readPending()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects allowForTask for new exact native need without sending', async () => {
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead', true)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  });

  test('rejects invalid digest strings without sending', async () => {
    const bad = baseNeed({
      approval: {
        protocolVersion: 1,
        proposalDigest: 'bad',
        actionDigest: ACTION,
        baseDigest: BASE,
        expiresAt: EXPIRES,
        sources: [],
      },
    });
    await expect(decideApproval(PROJECT, bad, 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects unsupported approval protocol without sending', async () => {
    const bad = baseNeed({
      approval: {
        protocolVersion: 2,
        proposalDigest: PROPOSAL,
        actionDigest: ACTION,
        baseDigest: BASE,
        expiresAt: EXPIRES,
        sources: [],
      },
    });
    await expect(decideApproval(PROJECT, bad, 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('lost response retry reuses exactly the same command', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockImplementationOnce(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        return okFetchFor(decidedNeed(body.commandId));
      });
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(first.commandId).toBe('test-uuid-1');
    expect(second).toEqual(first);
    expect(first.protocolVersion).toBe(1);
    expect(readPending()).toBeNull();
  });

  test('both responses lost keeps pending and stops at two attempts', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow(
      'could not be confirmed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPending()?.command.commandId).toBe('test-uuid-1');
  });

  test('both lost plus reload reuses pending identity', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(readPending()?.command.commandId).toBe('test-uuid-1');
    await freshModule();
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      return okFetchFor(decidedNeed(body.commandId));
    });
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uuidCount).toBe(1);
    expect(readPending()).toBeNull();
  });

  test('opposite decision under pending request is refused', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    fetchMock.mockClear();
    await expect(decideApproval(PROJECT, baseNeed(), 'declined')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPending()?.command.commandId).toBe('test-uuid-1');
  });

  test('changed identity under pending request is refused', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    fetchMock.mockClear();
    const changed = baseNeed({
      approval: {
        protocolVersion: 1,
        proposalDigest: `sha256:${'f'.repeat(64)}`,
        actionDigest: ACTION,
        baseDigest: BASE,
        expiresAt: EXPIRES,
        sources: [{ path: 'a.txt', sha: 'e'.repeat(64) }],
      },
    });
    await expect(decideApproval(PROJECT, changed, 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('mere 200 without matching receipt stays uncertain', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => baseNeed() });
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow(
      'could not be confirmed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPending()).not.toBeNull();
  });

  test('need.state alone without receipt is not confirmation', async () => {
    const noReceipt = baseNeed({ state: 'go-ahead', decidedAt: DECIDED });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => noReceipt });
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(readPending()).not.toBeNull();
  });

  test('receipt scope mismatch is not confirmation', async () => {
    fetchMock.mockImplementation(async () =>
      okFetchFor(decidedNeed('test-uuid-1', 'go-ahead', { scope: 'other-scope' })),
    );
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPending()).not.toBeNull();
  });

  test('receipt command mismatch is not confirmation', async () => {
    fetchMock.mockImplementation(async () => okFetchFor(decidedNeed('other-id')));
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(readPending()).not.toBeNull();
  });

  test('valid receipt with pending execution still confirms', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const need = decidedNeed(body.commandId);
      (need as { execution?: unknown }).execution = {
        state: 'not-applied',
        eventId: null,
        completedAt: null,
        reason: 'waiting',
        conflicts: [],
      };
      return okFetchFor(need);
    });
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(readPending()).toBeNull();
  });

  test('conclusive new 4xx clears only when not already uncertain', async () => {
    fetchMock.mockResolvedValueOnce(errFetch(400));
    const err = await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch((e) => e as Error);
    const { ApiError: Fresh } = await import('../client/api.js');
    expect(err).toBeInstanceOf(Fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPending()).toBeNull();
  });

  test('ambiguous failure then 4xx retains pending', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('reset')).mockResolvedValueOnce(errFetch(422));
    const err = await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch((e) => e as Error);
    const { ApiError: Fresh } = await import('../client/api.js');
    expect(err).toBeInstanceOf(Fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readPending()?.command.commandId).toBe('test-uuid-1');
  });

  test('408 is retried as ambiguous', async () => {
    fetchMock
      .mockResolvedValueOnce(errFetch(408))
      .mockImplementationOnce(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        return okFetchFor(decidedNeed(body.commandId));
      });
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('concurrent identical calls join into one request', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => void (release = resolve as (v: unknown) => void)),
    );
    const need = baseNeed();
    const a = decideApproval(PROJECT, need, 'go-ahead');
    const b = decideApproval(PROJECT, need, 'go-ahead');
    release(okFetchFor(decidedNeed('test-uuid-1')));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(rb.approvalReceipt?.commandId).toBe('test-uuid-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('storage denied blocks dispatch', async () => {
    vi.stubGlobal('sessionStorage', {
      get getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {},
      key() {
        return null;
      },
      get length() {
        throw new Error('denied');
      },
    });
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('corrupt stored record blocks dispatch and is retained', async () => {
    storage.setItem(pendingKey(), '{not-json');
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem(pendingKey())).toBe('{not-json');
  });

  test('oversized stored record blocks dispatch', async () => {
    storage.setItem(pendingKey(), 'x'.repeat(160_001));
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('unknown fields in stored record are rejected', async () => {
    storage.setItem(
      pendingKey(),
      JSON.stringify({
        projectId: PROJECT,
        needId: NEED,
        taskId: TASK,
        sessionId: SESSION,
        command: {
          protocolVersion: 1,
          commandId: 'test-uuid-9',
          resolution: 'go-ahead',
          proposalDigest: PROPOSAL,
          actionDigest: ACTION,
          baseDigest: BASE,
        },
        extra: 'nope',
      }),
    );
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('receipt cleanup failure surfaces without retrying confirmed send', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      return okFetchFor(decidedNeed(body.commandId));
    });
    const origRemove = storage.removeItem.bind(storage);
    void origRemove;
    storage.removeItem = () => {
      throw new Error('Storage denied');
    };
    await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPending()).not.toBeNull();
  });

  test('pending capacity denies new command but permits existing retry', async () => {
    for (let i = 0; i < 32; i++) {
      storage.setItem(
        `${PREFIX}other${i}|otherneed${i}`,
        JSON.stringify({
          projectId: `other${i}`,
          needId: `otherneed${i}`,
          taskId: `othertask${i}`,
          sessionId: `othersess${i}`,
          command: {
            protocolVersion: 1,
            commandId: `other-id-${i}`,
            resolution: 'go-ahead',
            proposalDigest: PROPOSAL,
            actionDigest: ACTION,
            baseDigest: BASE,
          },
        }),
      );
    }
    await expect(
      decideApproval('brand-new', baseNeed({ id: 'brand-new-need' }), 'go-ahead'),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    storage.clear();
    for (let i = 0; i < 31; i++) {
      storage.setItem(
        `${PREFIX}other${i}|otherneed${i}`,
        JSON.stringify({
          projectId: `other${i}`,
          needId: `otherneed${i}`,
          taskId: `othertask${i}`,
          sessionId: `othersess${i}`,
          command: {
            protocolVersion: 1,
            commandId: `other-id-${i}`,
            resolution: 'go-ahead',
            proposalDigest: PROPOSAL,
            actionDigest: ACTION,
            baseDigest: BASE,
          },
        }),
      );
    }
    storage.setItem(
      pendingKey(),
      JSON.stringify({
        projectId: PROJECT,
        needId: NEED,
        taskId: TASK,
        sessionId: SESSION,
        command: {
          protocolVersion: 1,
          commandId: 'kept-id',
          resolution: 'go-ahead',
          proposalDigest: PROPOSAL,
          actionDigest: ACTION,
          baseDigest: BASE,
        },
      }),
    );
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async () => okFetchFor(decidedNeed('kept-id')));
    const result = await decideApproval(PROJECT, baseNeed(), 'go-ahead');
    expect(result.approvalReceipt?.commandId).toBe('kept-id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reconcile clears matching receipt without another request', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const commandId = readPending()?.command.commandId as string;
    await freshModule();
    fetchMock.mockClear();
    const err = reconcileApprovals(PROJECT, [decidedNeed(commandId)]);
    expect(err).toBeUndefined();
    expect(readPending()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reconcile keeps corrupt entry and reports error while clearing good entry', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const goodId = readPending()?.command.commandId as string;
    const badKey = pendingKey(PROJECT, 'need-bad');
    storage.setItem(badKey, '{broken');
    const err = reconcileApprovals(PROJECT, [decidedNeed(goodId)]);
    expect(err?.message).toContain('could not be checked');
    expect(storage.getItem(badKey)).toBe('{broken');
    expect(readPending()).toBeNull();
  });

  test('reconcile keeps mismatched receipt and reports error', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const commandId = readPending()?.command.commandId as string;
    const mismatched = decidedNeed(commandId, 'go-ahead', { scope: 'other-scope' });
    const err = reconcileApprovals(PROJECT, [mismatched]);
    expect(err?.message).toContain('could not be checked');
    expect(readPending()).not.toBeNull();
  });

  test('reconcile keeps pending with no receipt silently', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const err = reconcileApprovals(PROJECT, [baseNeed()]);
    expect(err).toBeUndefined();
    expect(readPending()).not.toBeNull();
  });

  test('expired receipt window still reconciles', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const commandId = readPending()?.command.commandId as string;
    const expired = decidedNeed(commandId);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(Date.parse(expired.approvalReceipt!.expiresAt)).toBeLessThan(Date.now());
    const err = reconcileApprovals(PROJECT, [expired]);
    clock.mockRestore();
    expect(err).toBeUndefined();
    expect(readPending()).toBeNull();
  });

  test.each(['createdAt', 'expiresAt', 'decidedAt'])(
    'an inconsistent receipt %s cannot clear pending state',
    async (field) => {
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        return okFetchFor(
          decidedNeed(body.commandId, 'go-ahead', { [field]: '2020-01-01T00:00:00.000Z' }),
        );
      });
      await expect(decideApproval(PROJECT, baseNeed(), 'go-ahead')).rejects.toThrow(
        'could not be confirmed',
      );
      expect(readPending()).not.toBeNull();
    },
  );

  test('reconcile is per project', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    await decideApproval(PROJECT, baseNeed(), 'go-ahead').catch(() => undefined);
    const commandId = readPending()?.command.commandId as string;
    const err = reconcileApprovals('other-project', [decidedNeed(commandId)]);
    expect(err).toBeUndefined();
    expect(readPending()).not.toBeNull();
    const ok = reconcileApprovals(PROJECT, [decidedNeed(commandId)]);
    expect(ok).toBeUndefined();
    expect(readPending()).toBeNull();
  });

  test('unavailable storage returns reportable reconcile issue', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(reconcileApprovals(PROJECT, [])?.message).toContain('storage is unavailable');
  });
});
