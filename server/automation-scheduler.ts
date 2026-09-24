/**
 * Automations Milestone B: the one scheduler for automation slots.
 *
 * It is a timer and nothing else. Every pass takes the store lock — the same
 * lock every Automations route takes, so a pause and a due slot can never
 * interleave (A10) — writes this computer's heartbeat, and asks
 * `AutomationService.schedulePass` to record missed slots and admit a due one
 * through the same admission Run once uses. It starts no run, calls no
 * provider and writes no business file of its own.
 *
 * Why not the H07 Ready queue: that queue's only admission is the Work start
 * path (`admitWork`), which starts a Task on its selected engine route. The
 * weekly brief is a deterministic harness procedure that starts only with the
 * pinned input its occurrence carries (`bridge.start(..., pinned)`), and the
 * Work start path cannot carry it. Feeding a Ready task would either start the
 * wrong route or need a second path into the procedure. The Ready queue also
 * has no clock: it is driven by store changes, and a slot is driven by time.
 * So this module is small and owns only the clock; admission stays single.
 *
 * One host: this computer, explicitly assigned when a schedule is turned on.
 * Nothing here takes over another computer's schedule (A08 is not claimed).
 */
import type { AutomationService } from './automations.js';
import type { Store } from './store.js';

/** Proposed default: a pass every 30 seconds, so a slot starts within about half a minute of its time. */
export const AUTOMATION_TICK_MS = 30_000;

export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pass: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly automations: AutomationService,
    /** Null runs no timer: the caller (a test) drives `tick()` itself. */
    private readonly tickMs: number | null = AUTOMATION_TICK_MS,
  ) {}

  /** The first pass records whatever was missed while this computer was off, then the timer starts. */
  async init() {
    this.automations.schedulerRunning = true;
    await this.tick();
    this.arm();
  }

  private arm() {
    if (this.tickMs === null || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.arm());
    }, this.tickMs);
    this.timer.unref?.();
  }

  /**
   * One pass. Passes run one after another; a second call waits for the one
   * in flight and then makes its own, which finds every slot the first one
   * covered and does nothing with them (A05).
   */
  tick(): Promise<{ admitted: number; recorded: number }> {
    const run = async () => {
      if (this.closed) return { admitted: 0, recorded: 0 };
      try {
        return await this.store.locked(async () => {
          await this.automations.beat();
          return this.automations.schedulePass();
        });
      } catch (error) {
        // A pass that fails is logged and the next one tries again; it never
        // takes the app down, and nothing half-done is left admitting (the
        // occurrence store settles that on restart).
        console.warn('An automation schedule pass failed:', error);
        return { admitted: 0, recorded: 0 };
      }
    };
    const next = this.pass.then(run, run);
    this.pass = next;
    return next;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.automations.schedulerRunning = false;
    await this.pass;
  }
}
