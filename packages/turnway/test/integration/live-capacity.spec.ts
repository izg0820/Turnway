import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_ROOM_ID, testRoom, type Harness } from './harness';

describe('만료 데이터 정리와 유효 정원 계산 분리', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      rooms: [testRoom({ capacity: 3, sessionTtlMs: 60_000, maxSessionDurationMs: 60_000 })],
      admission: { enabled: false, batchSize: 3, expiryScanLimit: 1 },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function expireAdmittedSessions(): Promise<string> {
    const passes = await Promise.all(
      ['old-a', 'old-b', 'old-c'].map((user) => harness.service.join(TEST_ROOM_ID, user)),
    );
    await harness.service.runAdmission(TEST_ROOM_ID);
    const key = `${harness.keyPrefix}:{${TEST_ROOM_ID}}:active`;
    // Move all three session expiry times into the past without sleeps or timers
    await harness.redis.zadd(key, ...passes.flatMap((pass) => [0, pass.passId]));
    return key;
  }

  it('정리되지 않은 만료 세션이 있어도 입장 후 빈자리를 정확히 반환', async () => {
    const key = await expireAdmittedSessions();
    const next = await harness.service.join(TEST_ROOM_ID, 'next');

    const result = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(result).toMatchObject({ admitted: 1, availableSlots: 2 });
    expect(await harness.redis.zcount(key, '-inf', 0)).toBeGreaterThan(0);
    await expect(harness.service.assertAdmitted(TEST_ROOM_ID, 'next', next.passId))
      .resolves.toMatchObject({ state: 'ADMITTED' });
    expect(await harness.service.stats(TEST_ROOM_ID)).toMatchObject({
      admitted: 1, availableSlots: 2,
    });
  });

  it('만료 적체 중 동시 입장 작업도 유효 정원만큼 선착순 입장', async () => {
    const key = await expireAdmittedSessions();
    // Restore an expired backlog exceeding the cleanup limit after joins have pruned it
    const passes = [];
    for (let i = 0; i < 5; i++) {
      passes.push(await harness.service.join(TEST_ROOM_ID, `next-${i}`));
    }
    await harness.redis.zadd(key, 0, 'stale-a', 0, 'stale-b', 0, 'stale-c');

    const results = await Promise.all([
      harness.service.runAdmission(TEST_ROOM_ID),
      harness.service.runAdmission(TEST_ROOM_ID),
    ]);

    expect(results[0]).toMatchObject({ admitted: 3, availableSlots: 0 });
    expect(results.reduce((sum, result) => sum + result.admitted, 0)).toBe(3);
    for (const [i, pass] of passes.entries()) {
      expect((await harness.service.check(TEST_ROOM_ID, `next-${i}`, pass.passId)).state)
        .toBe(i < 3 ? 'ADMITTED' : 'WAITING');
    }
  });
});
