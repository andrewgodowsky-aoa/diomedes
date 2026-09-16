import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTask, pendingTaskCreation } from '../client/task-create';

const input = { name: 'Prepare the weekly brief', description: 'Use the approved plan.' };
const projectId = 'project-one';
const key = `diomedes.task-create.pending.${projectId}`;
let values: Map<string, string>;
let storage: Storage;
let send: ReturnType<typeof vi.fn<typeof fetch>>;
const bodyAt = (index = 0) => JSON.parse(send.mock.calls[index][1]!.body as string);
function accepted(_url: unknown, options?: RequestInit) {
  const command = JSON.parse(options!.body as string);
  return new Response(
    JSON.stringify({
      id: 'T1',
      creationReceipt: {
        protocolVersion: 1,
        commandId: command.commandId,
        projectId,
        taskId: 'T1',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        eventId: 'E1',
        admittedAt: '2026-09-12T00:00:00.000Z',
        actor: 'local-client',
        scope: 'local-prototype',
      },
    }),
    { status: 200 },
  );
}
beforeEach(() => {
  values = new Map();
  storage = {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
  send = vi.fn<typeof fetch>(async (url, options) => accepted(url, options));
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('fetch', send);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Console task creation transport', () => {
  test('saves before dispatch and coalesces concurrent equivalent submissions', async () => {
    send.mockImplementation(async (url, options) => {
      expect(values.has(key)).toBe(true);
      return accepted(url, options);
    });
    const [a, b] = await Promise.all([
      createTask(projectId, input),
      createTask(projectId, { ...input, name: ` ${input.name} ` }),
    ]);
    expect(a).toEqual(b);
    expect(send).toHaveBeenCalledTimes(1);
    expect(bodyAt()).toMatchObject({ protocolVersion: 1, owner: 'you', ...input });
    expect(values.size).toBe(0);
  });

  test('lost response retries the exact command; a later intentional create gets a fresh identity', async () => {
    send.mockRejectedValueOnce(new TypeError('Lost response'));
    await createTask(projectId, input);
    expect(send).toHaveBeenCalledTimes(2);
    expect(bodyAt(1)).toEqual(bodyAt());
    await createTask(projectId, input);
    expect(bodyAt(2).commandId).not.toBe(bodyAt().commandId);
  });

  test('keeps uncertain requests through module reload and rejects a changed payload', async () => {
    send.mockRejectedValue(new TypeError('Offline'));
    await expect(createTask(projectId, input)).rejects.toThrow('could not be confirmed');
    expect(pendingTaskCreation(projectId)).toEqual(input);
    const commandId = bodyAt().commandId;
    vi.resetModules();
    const reloaded = await import('../client/task-create');
    await expect(
      reloaded.createTask(projectId, { ...input, description: 'Changed' }),
    ).rejects.toThrow('saved task request');
    expect(send).toHaveBeenCalledTimes(2);
    send.mockImplementation(async (url, options) => accepted(url, options));
    await reloaded.createTask(projectId, input);
    expect(bodyAt(2).commandId).toBe(commandId);
    expect(values.size).toBe(0);
  });

  test('definitive first refusal clears the request; refusal after an uncertain result keeps it', async () => {
    send.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(createTask(projectId, input)).rejects.toThrow();
    expect(values.size).toBe(0);
    send.mockRejectedValueOnce(new TypeError('Lost response'));
    send.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(createTask(projectId, input)).rejects.toThrow();
    expect(pendingTaskCreation(projectId)).toEqual(input);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('a missing or mismatched receipt never confirms a task', async () => {
    send.mockImplementation(
      async () => new Response(JSON.stringify({ id: 'T1' }), { status: 200 }),
    );
    await expect(createTask(projectId, input)).rejects.toThrow('could not be confirmed');
    expect(values.has(key)).toBe(true);
    send.mockImplementation(async (url, options) => {
      const response = await accepted(url, options).json();
      response.creationReceipt.projectId = 'other';
      return new Response(JSON.stringify(response));
    });
    await expect(createTask(projectId, input)).rejects.toThrow('could not be confirmed');
    expect(values.has(key)).toBe(true);
  });

  test('a saved request keeps its document; the retry re-sends exactly that document', async () => {
    const withDocument = { ...input, sourceDocument: 'Reopening plan.md' };
    send.mockRejectedValue(new TypeError('Offline'));
    await expect(createTask(projectId, withDocument)).rejects.toThrow('could not be confirmed');
    expect(pendingTaskCreation(projectId)).toEqual(withDocument);
    expect(bodyAt()).toMatchObject({ protocolVersion: 1, owner: 'you', ...withDocument });
    // The same words without the document are a different request, not a retry.
    await expect(createTask(projectId, input)).rejects.toThrow('saved task request');
    send.mockImplementation(async (url, options) => accepted(url, options));
    await createTask(projectId, withDocument);
    expect(bodyAt(2)).toEqual(bodyAt());
    expect(values.size).toBe(0);
  });

  test.each([{ sourceDocument: '' }, { sourceDocument: 7 }, { sourceDocument: 'x'.repeat(1001) }])(
    'a request with an unusable document is refused before sending: %j',
    async (extra) => {
      await expect(
        createTask(projectId, { ...input, ...extra } as Parameters<typeof createTask>[1]),
      ).rejects.toThrow('could not be checked');
      expect(send).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
    },
  );

  test('malformed saved input is retained and never sent', async () => {
    values.set(key, '{broken');
    expect(() => pendingTaskCreation(projectId)).toThrow('could not be checked');
    await expect(createTask(projectId, input)).rejects.toThrow('could not be checked');
    expect(values.get(key)).toBe('{broken');
    expect(send).not.toHaveBeenCalled();
  });

  test.each(['getItem', 'setItem'] as const)(
    'storage %s failure prevents dispatch',
    async (method) => {
      vi.spyOn(storage, method).mockImplementation(() => {
        throw new Error('Blocked storage');
      });
      await expect(createTask(projectId, input)).rejects.toThrow('storage is unavailable');
      expect(send).not.toHaveBeenCalled();
    },
  );

  test('cleanup failure does not resend an accepted request', async () => {
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('Blocked cleanup');
    });
    await expect(createTask(projectId, input)).rejects.toThrow('could not clear');
    expect(send).toHaveBeenCalledTimes(1);
    expect(values.has(key)).toBe(true);
  });

  test('another project does not consume or replace an uncertain request', async () => {
    send.mockRejectedValue(new TypeError('Offline'));
    await expect(createTask(projectId, input)).rejects.toThrow();
    await expect(createTask('project-two', input)).rejects.toThrow();
    expect(values.size).toBe(2);
    expect(bodyAt(2).commandId).not.toBe(bodyAt().commandId);
    expect(pendingTaskCreation(projectId)).toEqual(input);
    expect(pendingTaskCreation('project-two')).toEqual(input);
  });
});
