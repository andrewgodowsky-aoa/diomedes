import { api, ApiError } from './api';
import { mintCommandId } from './work-start';
import type { Task, TaskCreationInput } from '../shared/types';

type Input = Pick<TaskCreationInput, 'name' | 'description'>;
interface Pending {
  projectId: string;
  commandId: string;
  input: Input;
}
const PREFIX = 'diomedes.task-create.pending.';
const flights = new Map<string, { input: string; promise: Promise<Task> }>();
const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const invalid = () =>
  new Error(
    'The saved task request could not be checked. It has been kept; check the Board before creating another task.',
  );
const unavailable = () =>
  new Error('Task request storage is unavailable; the request was not sent.');
const unresolved = () =>
  new Error('Task creation could not be confirmed. Retry create checks the same request.');
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalize(value: unknown): Input {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['name', 'description'].includes(key)) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.trim().length > 200 ||
    typeof value.description !== 'string' ||
    value.description.length > 10_000
  )
    throw invalid();
  return { name: value.name.trim(), description: value.description };
}
function storageFor(projectId: string) {
  if (!projectId.trim() || projectId.length > 100) throw invalid();
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) throw unavailable();
    return { storage, key: `${PREFIX}${encodeURIComponent(projectId)}` };
  } catch {
    throw unavailable();
  }
}
function read(storage: Storage, key: string, projectId: string): Pending | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw unavailable();
  }
  if (raw === null) return null;
  if (raw.length > 80_000) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !record(value) ||
    Object.keys(value).some((field) => !['projectId', 'commandId', 'input'].includes(field)) ||
    value.projectId !== projectId ||
    typeof value.commandId !== 'string' ||
    !pattern.test(value.commandId)
  )
    throw invalid();
  return { projectId, commandId: value.commandId, input: normalize(value.input) };
}
/** Restore only the pending transport request. Task state stays on the server. */
export function pendingTaskCreation(projectId: string): Input | null {
  const { storage, key } = storageFor(projectId);
  return read(storage, key, projectId)?.input ?? null;
}
function clear(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    throw new Error(
      'This browser could not clear its saved task request. Check the Board before creating another task.',
    );
  }
}
function confirms(task: Task, pending: Pending) {
  const receipt = task?.creationReceipt;
  return (
    typeof task?.id === 'string' &&
    task.id.length > 0 &&
    receipt?.protocolVersion === 1 &&
    receipt.commandId === pending.commandId &&
    receipt.projectId === pending.projectId &&
    receipt.taskId === task.id &&
    receipt.actor === 'local-client' &&
    receipt.scope === 'local-prototype' &&
    typeof receipt.eventId === 'string' &&
    receipt.eventId.length > 0 &&
    Number.isFinite(Date.parse(receipt.admittedAt)) &&
    /^sha256:[a-f0-9]{64}$/.test(receipt.payloadDigest)
  );
}
async function dispatch(
  storage: Storage,
  key: string,
  pending: Pending,
  uncertain: boolean,
): Promise<Task> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let task: Task;
    try {
      task = await api<Task>(`/projects/${encodeURIComponent(pending.projectId)}/tasks`, 'POST', {
        protocolVersion: 1,
        commandId: pending.commandId,
        ...pending.input,
        owner: 'you',
      });
      if (!confirms(task, pending)) throw unresolved();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        if (!uncertain) clear(storage, key);
        throw error;
      }
      uncertain = true;
      if (attempt === 1) throw unresolved();
      continue;
    }
    clear(storage, key);
    return task;
  }
  throw unresolved();
}

/** One pending create per project in this tab, saved before sending and reused after reload. */
export async function createTask(projectId: string, input: Input): Promise<Task> {
  const normalized = normalize(input);
  const inputJson = JSON.stringify(normalized);
  const { storage, key } = storageFor(projectId);
  let pending = read(storage, key, projectId);
  if (pending && JSON.stringify(pending.input) !== inputJson)
    throw new Error('Retry the saved task request before creating a different task.');
  const flight = flights.get(key);
  if (flight) {
    if (flight.input !== inputJson) throw unresolved();
    return flight.promise;
  }
  const uncertain = pending !== null;
  if (!pending) {
    pending = { projectId, commandId: mintCommandId(), input: normalized };
    try {
      storage.setItem(key, JSON.stringify(pending));
    } catch {
      throw unavailable();
    }
  }
  const promise = dispatch(storage, key, pending, uncertain).finally(() => flights.delete(key));
  flights.set(key, { input: inputJson, promise });
  return promise;
}
