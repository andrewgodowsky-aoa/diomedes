import { beforeEach, describe, expect, test, vi } from 'vitest';

// The client half of contract I-1: one identity per message, saved before the first request,
// and carried unchanged by every retry. The server half is tests/interaction-seam.test.ts.

const PROJECT = 'proj-1';
const THREAD = 'thread-1';
const PENDING = `diomedes.conversation.pending.${PROJECT}|${THREAD}`;
const LAST = `diomedes.conversation.last.${PROJECT}|${THREAD}`;
const input = (text = 'Order the usual') => ({ text, mode: 'auto' as const, sources: [] });

function makeStorage() {
  const map = new Map<string, string>();
  let failSet = false;
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem(k: string, v: string) {
      if (failSet) throw new Error('quota');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    failSet() {
      failSet = true;
    },
  };
}

let session: ReturnType<typeof makeStorage>;
let local: ReturnType<typeof makeStorage>;
let fetchMock: ReturnType<typeof vi.fn>;
let mod: typeof import('../client/conversation-send.js');

const sent = (n: number) => JSON.parse(fetchMock.mock.calls[n][1].body);
const answered = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    runId: 'run-1',
    commandId: sent(fetchMock.mock.calls.length - 1).commandId,
    sourceMessageId: 'sm.' + 'a'.repeat(32),
    answerText: 'Done.',
    interrupted: false,
    outcome: { status: 'answered' },
  }),
});
const refused = (status: number) => ({
  ok: false,
  status,
  json: async () => ({ error: { message: `refused ${status}` } }),
});

beforeEach(async () => {
  vi.resetModules();
  session = makeStorage();
  local = makeStorage();
  fetchMock = vi.fn();
  let n = 0;
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` });
  mod = await import('../client/conversation-send.js');
});

describe('sending one message', () => {
  test('the message is saved before the first request, and cleared once it is confirmed', async () => {
    fetchMock.mockImplementationOnce(async () => {
      expect(JSON.parse(session.getItem(PENDING)!).commandId).toBe('uuid-1');
      return answered();
    });
    const result = await mod.sendMessage(PROJECT, THREAD, input());
    expect(result.answerText).toBe('Done.');
    expect(sent(0)).toEqual({ ...input(), commandId: 'uuid-1', consent: true });
    expect(session.getItem(PENDING)).toBeNull();
    expect(local.getItem(LAST)).toBe('uuid-1');
    expect(mod.lastCommand(PROJECT, THREAD)).toBe('uuid-1');
  });

  test('an uncertain failure retries once with the same identity and the same body', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual(sent(0));
  });

  test('two uncertain failures keep the message, and sending it again reuses its identity', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(mod.pendingMessage(PROJECT, THREAD)).toMatchObject({
      commandId: 'uuid-1',
      input: input(),
    });
    fetchMock.mockReset().mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(0).commandId).toBe('uuid-1');
    expect(session.getItem(PENDING)).toBeNull();
  });

  test('a first attempt the server refuses is cleared, so the next send is a new message', async () => {
    fetchMock.mockResolvedValueOnce(refused(409));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toMatchObject({ status: 409 });
    expect(session.getItem(PENDING)).toBeNull();
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input());
    expect(sent(1).commandId).toBe('uuid-2');
  });

  test('a refusal after an uncertain attempt keeps the message: the first attempt may have landed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(refused(409));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toMatchObject({ status: 409 });
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });

  test('a different text while one is unconfirmed sends nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow();
    fetchMock.mockReset();
    await expect(mod.sendMessage(PROJECT, THREAD, input('Order double'))).rejects.toThrow(
      /never confirmed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // Discarding is the person's own act; after it the new text is a new message.
    mod.discardPendingMessage(PROJECT, THREAD);
    fetchMock.mockImplementationOnce(answered);
    await mod.sendMessage(PROJECT, THREAD, input('Order double'));
    expect(sent(0).commandId).toBe('uuid-2');
  });

  test('stopping keeps the message and does not retry', async () => {
    const stop = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      stop.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(mod.sendMessage(PROJECT, THREAD, input(), stop.signal)).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });

  test('a second identical send while the first is in flight is the same request', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(answered()))),
    );
    const first = mod.sendMessage(PROJECT, THREAD, input());
    const second = mod.sendMessage(PROJECT, THREAD, input());
    release();
    expect(await second).toBe(await first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('nothing is sent when the message cannot be saved first', async () => {
    session.failSet();
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/cannot save/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a damaged saved message sends nothing, and a reply for another command confirms nothing', async () => {
    session.setItem(PENDING, JSON.stringify({ commandId: 'x', projectId: 'other', threadId: THREAD }));
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toThrow(/damaged/);
    expect(fetchMock).not.toHaveBeenCalled();
    session.clear();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ commandId: 'someone-else', outcome: { status: 'answered' } }),
    });
    await expect(mod.sendMessage(PROJECT, THREAD, input())).rejects.toBeInstanceOf(
      mod.UnconfirmedMessage,
    );
    expect(mod.pendingMessage(PROJECT, THREAD)?.commandId).toBe('uuid-1');
  });
});

describe('starting a proposal, and reading an outcome', () => {
  const started = {
    ok: true,
    status: 200,
    json: async () => ({ commandId: 'c1', outcome: { status: 'started' } }),
  };
  const selection = { proposalDigest: 'd'.repeat(64), projectId: 'target' };

  test('a selection carries consent, the digest and the target, to the message it belongs to', async () => {
    fetchMock.mockResolvedValueOnce(started);
    await mod.selectProposal(PROJECT, THREAD, 'c1', selection);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/projects/${PROJECT}/threads/${THREAD}/messages/c1/select`,
    );
    expect(sent(0)).toEqual({ ...selection, consent: true });
  });

  test('a selection retries once when uncertain and never after a refusal', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(started);
    await mod.selectProposal(PROJECT, THREAD, 'c1', selection);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockResolvedValueOnce(refused(409));
    await expect(mod.selectProposal(PROJECT, THREAD, 'c1', selection)).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an outcome this thread never held reads as null, and any other failure is a failure', async () => {
    fetchMock.mockResolvedValueOnce(refused(404));
    expect(await mod.readOutcome(PROJECT, THREAD, 'c1')).toBeNull();
    fetchMock.mockResolvedValueOnce(refused(500));
    await expect(mod.readOutcome(PROJECT, THREAD, 'c1')).rejects.toMatchObject({ status: 500 });
  });

  test('a stored last command that is not a command identity is ignored', () => {
    local.setItem(LAST, 'not a command id!');
    expect(mod.lastCommand(PROJECT, THREAD)).toBeNull();
  });
});
