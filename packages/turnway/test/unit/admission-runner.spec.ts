import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionRunner } from '../../src/admission/admission-runner';
import type { TurnwayStore } from '../../src/core/turnway.store';
import type { ResolvedAdmissionOptions, ResolvedRoomOptions } from '../../src/types/options';
import { silentLogger } from '../integration/harness';

const ROOM: ResolvedRoomOptions = {
  roomId: 'room-a',
  capacity: 2,
  waitingTtlMs: 1_000,
  sessionTtlMs: 1_000,
  maxSessionDurationMs: 5_000,
  finishedRetentionMs: 1_000,
};

function admissionOptions(overrides: Partial<ResolvedAdmissionOptions> = {}): ResolvedAdmissionOptions {
  return {
    enabled: true,
    intervalMs: 10,
    batchSize: 5,
    expiryScanLimit: 10,
    maxBackoffMs: 100,
    ...overrides,
  };
}

function fakeStore(promote: TurnwayStore['promote']): TurnwayStore {
  return { promote } as unknown as TurnwayStore;
}

describe('AdmissionRunner', () => {
  it('does not start when the worker is disabled', async () => {
    const promote = vi.fn();
    const runner = new AdmissionRunner(
      fakeStore(promote as never),
      new Map([[ROOM.roomId, ROOM]]),
      admissionOptions({ enabled: false }),
      silentLogger(),
    );

    runner.start();
    await sleep(50);

    expect(runner.isRunning).toBe(false);
    expect(promote).not.toHaveBeenCalled();
  });

  it('never overlaps ticks for the same process', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const promote = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(30);
      concurrent -= 1;
      return { roomId: ROOM.roomId, admitted: 0, expired: 0, availableSlots: 2 };
    });

    const runner = new AdmissionRunner(
      fakeStore(promote as never),
      new Map([[ROOM.roomId, ROOM]]),
      admissionOptions(),
      silentLogger(),
    );

    runner.start();
    await sleep(150);
    await runner.stop();

    expect(maxConcurrent).toBe(1);
    expect(promote.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps running after a failure and backs off', async () => {
    const promote = vi.fn(async () => {
      throw new Error('redis is down');
    });

    const runner = new AdmissionRunner(
      fakeStore(promote as never),
      new Map([[ROOM.roomId, ROOM]]),
      admissionOptions({ intervalMs: 10, maxBackoffMs: 40 }),
      silentLogger(),
    );

    runner.start();
    await sleep(150);
    await runner.stop();

    // Failures do not stop the loop, and the growing interval keeps the call count bounded
    expect(promote.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(promote.mock.calls.length).toBeLessThan(15);
  });

  it('waits for the in-flight tick when stopping', async () => {
    let finished = false;

    const promote = vi.fn(async () => {
      await sleep(40);
      finished = true;
      return { roomId: ROOM.roomId, admitted: 0, expired: 0, availableSlots: 2 };
    });

    const runner = new AdmissionRunner(
      fakeStore(promote as never),
      new Map([[ROOM.roomId, ROOM]]),
      admissionOptions(),
      silentLogger(),
    );

    runner.start();
    await sleep(20);
    await runner.stop();

    expect(finished).toBe(true);
    expect(runner.isRunning).toBe(false);
  });

  it('gives up waiting when the in-flight tick outlives the stop timeout', async () => {
    let released: (() => void) | undefined;
    const promote = vi.fn(
      () =>
        new Promise((resolve) => {
          released = () =>
            resolve({ roomId: ROOM.roomId, admitted: 0, expired: 0, availableSlots: 2 });
        }),
    );
    const warn = vi.fn();

    const runner = new AdmissionRunner(
      fakeStore(promote as never),
      new Map([[ROOM.roomId, ROOM]]),
      admissionOptions(),
      { ...silentLogger(), warn },
    );

    runner.start();
    await sleep(20);
    await runner.stop(30);

    expect(warn).toHaveBeenCalledWith(
      'admission tick did not settle before shutdown timeout',
      { timeoutMs: 30 },
    );

    // Release the stalled run so no open handle is left behind
    released?.();
  });
});
