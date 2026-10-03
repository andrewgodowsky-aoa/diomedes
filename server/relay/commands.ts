/**
 * The phone commands this computer has answered, per device, for a day (relay plan step 4).
 *
 *   <data>/relay/commands.json
 *
 * A phone mints a command id once and sends the same id again only when it didn't hear the
 * answer. A repeat gets the first answer and acts once; a repeat that arrives while the first is
 * still being answered waits for it. Only ids and answers are kept, never what a command said.
 */
import path from 'node:path';
import { z } from 'zod';
import {
  RELAY_COMMAND_ID,
  RELAY_MESSAGE_TIMINGS,
  parseDesktopToPhone,
  type ResultMessage,
} from '../../services/control-plane/src/relay/protocol.js';
import { durableWrite, readJson } from '../store.js';

/** The most answers one device's commands keep. The oldest go first. */
const MAX_PER_DEVICE = 1_000;

const entrySchema = z.object({
  deviceId: z.string().min(1).max(128),
  commandId: z.string().regex(RELAY_COMMAND_ID),
  at: z.number().int().nonnegative(),
  result: z.unknown(),
});
interface Entry {
  deviceId: string;
  commandId: string;
  at: number;
  result: ResultMessage;
}
const fileSchema = z.object({ v: z.literal(1), commands: z.array(entrySchema).max(100_000) });

/** A kept answer, read back only when it is still a result from the closed set. */
function keptResult(value: unknown): ResultMessage | null {
  const parsed = parseDesktopToPhone(JSON.stringify(value));
  return parsed?.type === 'result' ? parsed : null;
}

export class CommandLedger {
  private entries: Entry[] = [];
  private readonly running = new Map<string, Promise<ResultMessage>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get file() {
    return path.join(this.dataDir, 'relay', 'commands.json');
  }

  async init(): Promise<void> {
    const saved = await readJson<unknown>(this.file, () => ({ v: 1, commands: [] })).catch(() => null);
    const parsed = fileSchema.safeParse(saved);
    this.entries = [];
    if (!parsed.success) return;
    for (const entry of parsed.data.commands) {
      const result = keptResult(entry.result);
      if (result && result.commandId === entry.commandId) this.entries.push({ ...entry, result });
    }
    this.prune();
  }

  /** The first answer to a device's command. `act` runs at most once per device and command id in a day. */
  async once(deviceId: string, commandId: string, act: () => Promise<ResultMessage>): Promise<{ result: ResultMessage; repeat: boolean }> {
    this.prune();
    const kept = this.entries.find((entry) => entry.deviceId === deviceId && entry.commandId === commandId);
    if (kept) return { result: kept.result, repeat: true };
    const key = `${deviceId}\n${commandId}`;
    const running = this.running.get(key);
    if (running) return { result: await running, repeat: true };
    const answer = act()
      .then((result) => {
        this.entries.push({ deviceId, commandId, at: this.now(), result });
        this.prune();
        void this.save();
        return result;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, answer);
    return { result: await answer, repeat: false };
  }

  /** Waits for every write so far. */
  async settled(): Promise<void> {
    await this.writes;
  }

  private prune() {
    const cutoff = this.now() - RELAY_MESSAGE_TIMINGS.commandMemoryMs;
    this.entries = this.entries.filter((entry) => entry.at > cutoff);
    const counts = new Map<string, number>();
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const count = (counts.get(this.entries[index].deviceId) ?? 0) + 1;
      counts.set(this.entries[index].deviceId, count);
      if (count > MAX_PER_DEVICE) this.entries.splice(index, 1);
    }
  }

  /** One write at a time: a lost write only means a repeat is answered again, never acted twice in this run. */
  private save() {
    const body = JSON.stringify({ v: 1, commands: this.entries }, null, 2);
    this.writes = this.writes.then(() => durableWrite(this.file, body)).catch(() => {});
    return this.writes;
  }
}
