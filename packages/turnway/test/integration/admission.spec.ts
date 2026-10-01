import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdmissionRunner } from '../../src/admission/admission-runner';
import type { AdmittedStatus } from '../../src/types/status';
import { createHarness, deleteKeys, sleep, TEST_ROOM_ID, testRoom, type Harness } from './harness';

function activeKey(harness: Harness): string {
  return `${harness.keyPrefix}:{${TEST_ROOM_ID}}:active`;
}

function waitingKey(harness: Harness): string {
  return `${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting`;
}

describe('Phase 03 — expiry cleanup budget', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      rooms: [testRoom({ capacity: 1, waitingTtlMs: 400, sessionTtlMs: 300 })],
      // Limit cleanup to one entry so expired data remains during admission
      admission: { enabled: false, batchSize: 10, expiryScanLimit: 1 },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('expired admitted sessions stop holding capacity even with a backlog of expired passes', async () => {
    // one admitted session, one live waiter at the head, two stale waiters behind it
    const admitted = await harness.service.join(TEST_ROOM_ID, 'user-a');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const live = await harness.service.join(TEST_ROOM_ID, 'user-b');
    await harness.service.join(TEST_ROOM_ID, 'user-c');
    await harness.service.join(TEST_ROOM_ID, 'user-d');

    // Keep the head alive while everything else ages out
    await sleep(200);
    await harness.service.heartbeat(TEST_ROOM_ID, 'user-b', live.passId);
    await sleep(250);

    // the session expired long ago, so its slot must come back
    const result = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(result.admitted).toBe(1);
    expect((await harness.service.check(TEST_ROOM_ID, 'user-b', live.passId)).state).toBe(
      'ADMITTED',
    );
    expect(
      (await harness.service.check(TEST_ROOM_ID, 'user-a', admitted.passId)).state,
    ).toBe('EXPIRED');
  });
});

describe('Phase 03 — admission and capacity', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('admits in arrival order up to capacity', async () => {
    // capacity 2
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');

    const result = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(result.admitted).toBe(2);
    expect(result.availableSlots).toBe(0);
    expect((await harness.service.check(TEST_ROOM_ID, 'user-1', first.passId)).state).toBe(
      'ADMITTED',
    );
    expect((await harness.service.check(TEST_ROOM_ID, 'user-2', second.passId)).state).toBe(
      'ADMITTED',
    );
    expect(await harness.service.check(TEST_ROOM_ID, 'user-3', third.passId)).toMatchObject({
      state: 'WAITING',
      position: 1,
    });
  });

  it('admits no one when capacity is full', async () => {
    await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.join(TEST_ROOM_ID, 'user-2');
    await harness.service.join(TEST_ROOM_ID, 'user-3');

    await harness.service.runAdmission(TEST_ROOM_ID);
    const second = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(second.admitted).toBe(0);
    expect(await harness.redis.zcard(activeKey(harness))).toBe(2);
  });

  it('concurrent promotion from several instances neither exceeds capacity nor reorders', async () => {
    // a second instance sharing the same room
    const shared = await createHarness({ keyPrefix: harness.keyPrefix });

    try {
      const joined = [];
      for (let index = 1; index <= 10; index += 1) {
        joined.push(await harness.service.join(TEST_ROOM_ID, `user-${index}`));
      }

      // four promotion requests run concurrently across the two instances
      const results = await Promise.all([
        harness.service.runAdmission(TEST_ROOM_ID),
        shared.service.runAdmission(TEST_ROOM_ID),
        harness.service.runAdmission(TEST_ROOM_ID),
        shared.service.runAdmission(TEST_ROOM_ID),
      ]);

      const total = results.reduce((sum, result) => sum + result.admitted, 0);
      expect(total).toBe(2);
      expect(await harness.redis.zcard(activeKey(harness))).toBe(2);

      const admitted = await harness.redis.zrange(activeKey(harness), 0, -1);
      const admittedSequences = await Promise.all(
        admitted.map(async (passId) => {
          const seq = await harness.redis.hget(
            `${harness.keyPrefix}:{${TEST_ROOM_ID}}:pass:${passId}`,
            'seq',
          );
          return Number(seq);
        }),
      );
      expect(admittedSequences.sort((a, b) => a - b)).toEqual([
        joined[0]!.sequence,
        joined[1]!.sequence,
      ]);
    } finally {
      await shared.moduleRef.close();
      await shared.redis.quit();
    }
  });

  it('after a leave, the next waiter is admitted on the next run', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');
    await harness.service.runAdmission(TEST_ROOM_ID);

    await harness.service.leave(TEST_ROOM_ID, 'user-1', first.passId);
    const result = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(result.admitted).toBe(1);
    expect((await harness.service.check(TEST_ROOM_ID, 'user-3', third.passId)).state).toBe(
      'ADMITTED',
    );
  });

  it('a cancel racing a promotion leaves the pass in neither the queue nor the active set', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await Promise.all([
      harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId),
      harness.service.runAdmission(TEST_ROOM_ID),
    ]);

    const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);
    expect(status.state).toBe('LEFT');
    expect(await harness.redis.zscore(waitingKey(harness), pass.passId)).toBeNull();
    expect(await harness.redis.zscore(activeKey(harness), pass.passId)).toBeNull();
  });

  it('stats count only live entries according to the expiry index', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.join(TEST_ROOM_ID, 'user-2');
    await harness.service.join(TEST_ROOM_ID, 'user-3');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const before = await harness.service.stats(TEST_ROOM_ID);
    await harness.service.leave(TEST_ROOM_ID, 'user-1', first.passId);
    const after = await harness.service.stats(TEST_ROOM_ID);

    expect(before).toMatchObject({ waiting: 1, admitted: 2, capacity: 2, availableSlots: 0 });
    expect(after).toMatchObject({ waiting: 1, admitted: 1, availableSlots: 1 });
  });
});

describe('Phase 03 — session expiry and heartbeats', () => {
  it('a heartbeat does not revive an expired admitted session', async () => {
    const harness = await createHarness({ rooms: [testRoom({ sessionTtlMs: 300 })] });

    try {
      const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
      await harness.service.runAdmission(TEST_ROOM_ID);

      await sleep(350);
      const beat = await harness.service.heartbeat(TEST_ROOM_ID, 'user-1', pass.passId);

      expect(beat.state).toBe('EXPIRED');
      expect(await harness.redis.zcard(activeKey(harness))).toBe(0);
      expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('heartbeats cannot extend past the maximum session duration', async () => {
    const harness = await createHarness({
      rooms: [testRoom({ sessionTtlMs: 400, maxSessionDurationMs: 600 })],
    });

    try {
      const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
      await harness.service.runAdmission(TEST_ROOM_ID);

      await sleep(300);
      const beat = (await harness.service.heartbeat(
        TEST_ROOM_ID,
        'user-1',
        pass.passId,
      )) as AdmittedStatus;

      // When request time + sessionTtl passes the max-stay deadline, it is clamped to the deadline
      expect(beat.state).toBe('ADMITTED');
      expect(beat.expiresAt).toBe(beat.sessionEndsAt);

      await sleep(400);
      const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);
      expect(status.state).toBe('EXPIRED');
    } finally {
      await harness.close();
    }
  });

  it('the next waiter is admitted once an expired session is cleaned up', async () => {
    const harness = await createHarness({
      rooms: [testRoom({ capacity: 1, sessionTtlMs: 300 })],
    });

    try {
      await harness.service.join(TEST_ROOM_ID, 'user-1');
      const second = await harness.service.join(TEST_ROOM_ID, 'user-2');
      await harness.service.runAdmission(TEST_ROOM_ID);

      await sleep(350);
      const result = await harness.service.runAdmission(TEST_ROOM_ID);

      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect(result.admitted).toBe(1);
      expect((await harness.service.check(TEST_ROOM_ID, 'user-2', second.passId)).state).toBe(
        'ADMITTED',
      );
    } finally {
      await harness.close();
    }
  });
});

describe('Phase 03 — batch limits and the background worker', () => {
  it('limits admissions per run to the batch size', async () => {
    const harness = await createHarness({
      rooms: [testRoom({ capacity: 10 })],
      admission: { enabled: false, intervalMs: 50, batchSize: 3, expiryScanLimit: 50 },
    });

    try {
      for (let index = 1; index <= 8; index += 1) {
        await harness.service.join(TEST_ROOM_ID, `user-${index}`);
      }

      const first = await harness.service.runAdmission(TEST_ROOM_ID);
      const second = await harness.service.runAdmission(TEST_ROOM_ID);

      expect(first.admitted).toBe(3);
      expect(second.admitted).toBe(3);
      expect(await harness.redis.zcard(activeKey(harness))).toBe(6);
    } finally {
      await harness.close();
    }
  });

  it('cleans up mass expiry in bounded batches while admissions continue', async () => {
    const harness = await createHarness({
      rooms: [testRoom({ capacity: 1 })],
      admission: { enabled: false, intervalMs: 50, batchSize: 1, expiryScanLimit: 1 },
    });

    try {
      // six expired passes stacked ahead of one live waiter
      const stale = [];
      for (let index = 1; index <= 6; index += 1) {
        stale.push(await harness.service.join(TEST_ROOM_ID, `stale-${index}`));
      }
      const expiryKey = `${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting-expiry`;
      for (const pass of stale) {
        await harness.redis.zadd(expiryKey, 1, pass.passId);
      }
      const valid = await harness.service.join(TEST_ROOM_ID, 'user-valid');

      // a single run cannot prune them all
      const first = await harness.service.runAdmission(TEST_ROOM_ID);
      expect(first.admitted).toBe(0);
      expect(first.expired).toBeLessThanOrEqual(3);

      let runs = 1;
      let admittedTotal = first.admitted;
      while (admittedTotal === 0 && runs < 10) {
        const result = await harness.service.runAdmission(TEST_ROOM_ID);
        admittedTotal += result.admitted;
        runs += 1;
      }

      expect(admittedTotal).toBe(1);
      expect(await harness.redis.zcard(activeKey(harness))).toBe(1);
      expect((await harness.service.check(TEST_ROOM_ID, 'user-valid', valid.passId)).state).toBe(
        'ADMITTED',
      );
    } finally {
      await harness.close();
    }
  });

  it('the background worker promotes waiters without join calls and stops on shutdown', async () => {
    const harness = await createHarness({
      admission: { enabled: true, intervalMs: 30, batchSize: 10, expiryScanLimit: 50 },
    });

    try {
      await harness.service.join(TEST_ROOM_ID, 'user-1');
      await harness.service.join(TEST_ROOM_ID, 'user-2');
      await harness.service.join(TEST_ROOM_ID, 'user-3');

      await sleep(200);
      const stats = await harness.service.stats(TEST_ROOM_ID);

      expect(stats.admitted).toBe(2);
      expect(stats.waiting).toBe(1);

      const runner = harness.moduleRef.get(AdmissionRunner);
      expect(runner.isRunning).toBe(true);

      await harness.moduleRef.close();
      expect(runner.isRunning).toBe(false);
    } finally {
      // The module was already closed above, so only the keys and probe connection remain
      await deleteKeys(harness.redis, harness.keyPrefix);
      await harness.redis.quit();
    }
  });
});
