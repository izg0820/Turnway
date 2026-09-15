import { DEFAULT_ADMISSION_STOP_TIMEOUT_MS } from '../config/defaults';
import type { TurnwayStore } from '../core/turnway.store';
import type {
  ResolvedAdmissionOptions,
  ResolvedRoomOptions,
  WaitingRoomLogger,
} from '../types/options';
import type { AdmissionRunResult } from '../types/status';

/**
 * Background admission worker.
 * Within a process the next run is scheduled only after the previous one finishes;
 * contention across processes is resolved inside the Redis Lua scripts.
 */
export class AdmissionRunner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly store: TurnwayStore,
    private readonly rooms: Map<string, ResolvedRoomOptions>,
    private readonly options: ResolvedAdmissionOptions,
    private readonly logger: WaitingRoomLogger,
  ) {}

  /** Whether the worker is running */
  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Start the automatic run loop. Does nothing when disabled by configuration */
  start(): void {
    if (!this.options.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(this.options.intervalMs);
  }

  /**
   * Clear the timer, then wait for an in-flight run to finish.
   * A storage failure can stall the run, so the wait is bounded.
   */
  async stop(timeoutMs: number = DEFAULT_ADMISSION_STOP_TIMEOUT_MS): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const settled = await this.awaitInFlight(timeoutMs);
    if (!settled) {
      // The in-flight Redis command cannot be cancelled
      this.logger.warn('admission tick did not settle before shutdown timeout', { timeoutMs });
    }
  }

  /** Wait for the in-flight run. True when it finished within the timeout */
  private async awaitInFlight(timeoutMs: number): Promise<boolean> {
    const inFlight = this.inFlight;
    if (!inFlight) return true;

    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([inFlight.then(() => true, () => true), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Process one room once, for tests and manual runs */
  async runOnce(room: ResolvedRoomOptions): Promise<AdmissionRunResult> {
    return this.store.promote(room, this.options.batchSize, this.options.expiryScanLimit);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, delayMs);

    // Unref so the timer never holds the process open
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let failed = false;

    for (const room of this.rooms.values()) {
      if (this.stopped) break;

      try {
        const result = await this.runOnce(room);
        if (result.admitted > 0 || result.expired > 0) {
          this.logger.debug('admission tick', {
            roomId: result.roomId,
            admitted: result.admitted,
            expired: result.expired,
            availableSlots: result.availableSlots,
          });
        }
      } catch (error) {
        failed = true;
        this.logger.error('admission tick failed', {
          roomId: room.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;
    this.schedule(this.nextDelayMs());
  }

  /** Grow the retry interval within a bounded range after consecutive failures */
  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.options.intervalMs;

    const backoff = this.options.intervalMs * 2 ** Math.min(this.consecutiveFailures, 10);
    return Math.min(backoff, this.options.maxBackoffMs);
  }
}
