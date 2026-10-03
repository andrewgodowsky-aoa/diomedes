/**
 * What one link sends its person's phones, and when (relay plan step 4).
 *
 * Answers to a phone's commands (`result`, `turn.update`) go in order and are never replaced.
 * Pictures of the desktop's state (`work.rows`, `board.counts`, `need.summary`) are keyed: a newer
 * picture replaces an unsent one with the same key, and each is built only when it goes out, so it
 * shows the state as it is then. At most one picture of a kind per project goes each second, and
 * everything together stays under the hub's 120 frames a minute. Every frame is checked against
 * the contract before it is sent; one that fails is dropped and named by its type only.
 */
import {
  RELAY_LIMITS,
  RELAY_MESSAGE_TIMINGS,
  parseDesktopToPhone,
  serializeFrame,
  type DesktopToPhoneMessage,
} from '../../services/control-plane/src/relay/protocol.js';

/** Frames a link sends in any minute: under the hub's own limit, so a little clock difference never makes the hub drop one. */
export const OUTBOUND_FRAMES_PER_MINUTE = Math.floor(RELAY_LIMITS.desktopFramesPerMinute * 0.85);
const MINUTE_MS = 60_000;

/** A picture is built when it is sent. Null: nothing to show now. */
export type Picture = () => Promise<DesktopToPhoneMessage | null> | DesktopToPhoneMessage | null;

export interface OutboundOptions {
  /** Writes one frame on the link. False when no connection is ready. */
  send(text: string): boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class OutboundGate {
  private readonly answers: DesktopToPhoneMessage[] = [];
  private readonly pictures = new Map<string, { group: string; picture: Picture }>();
  private readonly lastSent = new Map<string, number>();
  private sent: number[] = [];
  private heardAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  private pumping: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: OutboundOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A phone spoke: pictures of changes go for the next five minutes. */
  attend(): void {
    this.heardAt = this.now();
  }

  /** Whether a phone has spoken recently enough to be sent changes. */
  get attending(): boolean {
    return this.now() - this.heardAt < RELAY_MESSAGE_TIMINGS.attentionMs;
  }

  /** An answer to a command: in order, never replaced or held for attention. */
  answer(message: DesktopToPhoneMessage): void {
    if (this.closed) return;
    this.answers.push(message);
    this.kick();
  }

  /** A picture under `key`, replacing an unsent one; `group` (its kind and project) paces it to one a second. */
  picture(key: string, group: string, picture: Picture): void {
    if (this.closed) return;
    this.pictures.set(key, { group, picture });
    this.kick();
  }

  /** Waits until everything due now has gone. For tests and for an orderly close. */
  async settled(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.answers.length = 0;
    this.pictures.clear();
  }

  private kick() {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      // Something arrived after the pump's last look: look again now rather than on a timer.
      if (this.again && !this.closed) this.kick();
      else this.schedule();
    });
  }

  private async pump(): Promise<void> {
    do {
      this.again = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      while (!this.closed) {
        const at = this.now();
        this.sent = this.sent.filter((moment) => moment > at - MINUTE_MS);
        if (this.sent.length >= OUTBOUND_FRAMES_PER_MINUTE) break;
        const answer = this.answers.shift();
        if (answer) {
          this.emit(answer, at);
          continue;
        }
        const due = [...this.pictures].find(([, item]) => this.readyAt(item.group, at) <= at);
        if (!due) break;
        const [key, item] = due;
        this.pictures.delete(key);
        this.lastSent.set(item.group, at);
        let message: DesktopToPhoneMessage | null = null;
        try {
          message = await item.picture();
        } catch {
          message = null;
        }
        if (message && !this.closed) this.emit(message, this.now());
      }
    } while (this.again && !this.closed);
  }

  private readyAt(group: string, at: number): number {
    const last = this.lastSent.get(group);
    return last === undefined ? at : last + RELAY_MESSAGE_TIMINGS.coalesceMs;
  }

  private emit(message: DesktopToPhoneMessage, at: number) {
    const text = serializeFrame(message);
    if (text === null || parseDesktopToPhone(text) === null) {
      this.options.log?.(`Phone relay: a ${message.type} frame did not fit the contract and was not sent.`);
      return;
    }
    if (this.options.send(text)) this.sent.push(at);
  }

  private schedule() {
    if (this.closed || this.timer || this.pumping) return;
    if (this.answers.length === 0 && this.pictures.size === 0) return;
    const at = this.now();
    let next: number;
    if (this.sent.length >= OUTBOUND_FRAMES_PER_MINUTE) next = this.sent[0] + MINUTE_MS;
    else if (this.answers.length > 0) next = at;
    else next = Math.min(...[...this.pictures.values()].map((item) => this.readyAt(item.group, at)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, next - at));
    this.timer.unref?.();
  }
}
