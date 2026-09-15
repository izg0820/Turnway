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

describe('Phase 03 — 입장과 정원', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('정원만큼만 선착순으로 입장', async () => {
    // Arrange — capacity 2
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');

    // Act
    const result = await harness.service.runAdmission(TEST_ROOM_ID);

    // Assert
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

  it('정원이 찼으면 추가 입장 없음', async () => {
    await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.join(TEST_ROOM_ID, 'user-2');
    await harness.service.join(TEST_ROOM_ID, 'user-3');

    await harness.service.runAdmission(TEST_ROOM_ID);
    const second = await harness.service.runAdmission(TEST_ROOM_ID);

    expect(second.admitted).toBe(0);
    expect(await harness.redis.zcard(activeKey(harness))).toBe(2);
  });

  it('여러 인스턴스가 동시에 승급해도 정원 초과와 순서 역전 없음', async () => {
    // Arrange: a second instance sharing the same room
    const shared = await createHarness({ keyPrefix: harness.keyPrefix });

    try {
      const joined = [];
      for (let index = 1; index <= 10; index += 1) {
        joined.push(await harness.service.join(TEST_ROOM_ID, `user-${index}`));
      }

      // Act: four promotion requests run concurrently across the two instances
      const results = await Promise.all([
        harness.service.runAdmission(TEST_ROOM_ID),
        shared.service.runAdmission(TEST_ROOM_ID),
        harness.service.runAdmission(TEST_ROOM_ID),
        shared.service.runAdmission(TEST_ROOM_ID),
      ]);

      // Assert
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

  it('퇴장하면 다음 대기자가 다음 작업에서 입장', async () => {
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

  it('취소와 승급이 경합해도 대기·활성 양쪽에 남지 않음', async () => {
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

  it('통계는 만료 인덱스를 반영한 유효 인원만 계산', async () => {
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

describe('Phase 03 — 세션 만료와 하트비트', () => {
  it('만료된 입장 세션은 하트비트로 부활하지 않음', async () => {
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

  it('하트비트로 최대 체류 시간을 넘길 수 없음', async () => {
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

  it('만료된 입장 세션이 정리되면 다음 대기자가 입장', async () => {
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

describe('Phase 03 — 배치 제한과 백그라운드 작업', () => {
  it('한 번에 입장시키는 수를 배치 크기로 제한', async () => {
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

  it('대량 만료도 제한된 배치로 정리하면서 후속 입장 진행', async () => {
    const harness = await createHarness({
      rooms: [testRoom({ capacity: 1 })],
      admission: { enabled: false, intervalMs: 50, batchSize: 1, expiryScanLimit: 1 },
    });

    try {
      // Arrange: six expired passes stacked ahead of one live waiter
      const stale = [];
      for (let index = 1; index <= 6; index += 1) {
        stale.push(await harness.service.join(TEST_ROOM_ID, `stale-${index}`));
      }
      const expiryKey = `${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting-expiry`;
      for (const pass of stale) {
        await harness.redis.zadd(expiryKey, 1, pass.passId);
      }
      const valid = await harness.service.join(TEST_ROOM_ID, 'user-valid');

      // Act: a single run cannot prune them all
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

      // Assert
      expect(admittedTotal).toBe(1);
      expect(await harness.redis.zcard(activeKey(harness))).toBe(1);
      expect((await harness.service.check(TEST_ROOM_ID, 'user-valid', valid.passId)).state).toBe(
        'ADMITTED',
      );
    } finally {
      await harness.close();
    }
  });

  it('자동 실행 작업이 참여 호출 없이도 대기자를 승급하고 종료 시 정리', async () => {
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
