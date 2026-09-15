import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidArgumentError,
  PassNotFoundError,
  PassOwnerMismatchError,
  RoomNotRegisteredError,
} from '../../src/errors';
import { createHarness, sleep, TEST_ROOM_ID, testRoom, type Harness } from './harness';

describe('Phase 02 — 대기 참여와 상태 조회', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('같은 사용자의 동시 참여가 하나의 유효 대기표로 수렴', async () => {
    // Arrange
    const attempts = 20;

    // Act
    const results = await Promise.all(
      Array.from({ length: attempts }, () => harness.service.join(TEST_ROOM_ID, 'user-1')),
    );

    // Assert
    const passIds = new Set(results.map((status) => status.passId));
    expect(passIds.size).toBe(1);

    const waiting = await harness.redis.zcard(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting`);
    expect(waiting).toBe(1);
  });

  it('서로 다른 사용자 순번이 Redis 처리 순서와 일치', async () => {
    // Act
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');

    // Assert
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first).toMatchObject({ state: 'WAITING', position: 1 });
    expect(second).toMatchObject({ state: 'WAITING', position: 2 });
    expect(third).toMatchObject({ state: 'WAITING', position: 3 });
  });

  it('동시 참여에서도 순번 중복과 대기 인덱스 누락이 없음', async () => {
    // Act
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        harness.service.join(TEST_ROOM_ID, `user-${index}`),
      ),
    );

    // Assert
    const sequences = results.map((status) => status.sequence).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(30);
    expect(sequences).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));

    const waiting = await harness.redis.zcard(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting`);
    expect(waiting).toBe(30);
  });

  it('타인 대기표 조회 거부', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await expect(harness.service.check(TEST_ROOM_ID, 'user-2', pass.passId)).rejects.toBeInstanceOf(
      PassOwnerMismatchError,
    );
  });

  it('알 수 없는 대기표는 구별 가능한 오류로 전달', async () => {
    await expect(
      harness.service.check(TEST_ROOM_ID, 'user-1', 'no-such-pass'),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('등록되지 않은 대기열 호출 거부', async () => {
    await expect(harness.service.join('unknown-room', 'user-1')).rejects.toBeInstanceOf(
      RoomNotRegisteredError,
    );
  });

  it('키 구조를 깨는 식별자 거부', async () => {
    await expect(harness.service.join(TEST_ROOM_ID, 'user 1')).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('종료 후 재참여는 새 대기표와 새 순번을 받고 이전 대기표 청소에 지워지지 않음', async () => {
    // Arrange
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.leave(TEST_ROOM_ID, 'user-1', first.passId);

    // Act
    const second = await harness.service.join(TEST_ROOM_ID, 'user-1');
    // Another expiry and cleanup pass must leave the new pass alive
    await harness.service.runAdmission(TEST_ROOM_ID);
    const checked = await harness.service.check(TEST_ROOM_ID, 'user-1', second.passId);

    // Assert
    expect(second.passId).not.toBe(first.passId);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(checked.state).not.toBe('LEFT');

    const mapped = await harness.redis.get(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:user:user-1`);
    expect(mapped).toBe(second.passId);
  });

  it('입장한 사용자의 재참여 요청은 기존 입장 세션을 그대로 반환', async () => {
    // Arrange
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    // Act: a refresh retries the join
    const rejoined = await harness.service.join(TEST_ROOM_ID, 'user-1');

    // Assert
    expect(rejoined.passId).toBe(pass.passId);
    expect(rejoined.state).toBe('ADMITTED');
    expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(1);
  });

  it('퇴장 후 상태 조회는 종료 상태를 반환하고 반복 퇴장에도 변하지 않음', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    const left = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);
    const again = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(left.state).toBe('LEFT');
    // Check that repeat calls keep the same end time
    expect(again).toEqual(left);
  });
});

describe('Phase 02 — 대기 만료', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ rooms: [testRoom({ waitingTtlMs: 300 })] });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('만료 시각이 지난 대기표는 청소 작업 전이라도 만료로 판정', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await sleep(350);
    const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(status.state).toBe('EXPIRED');
  });

  it('만료 시각이 지난 대기표의 퇴장 요청은 만료로 확정', async () => {
    // Arrange: cleanup has not run, so the hash still reads WAITING
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await sleep(350);

    // Act
    const left = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    // Assert: the leave result never splits into LEFT/EXPIRED based on cleanup order
    expect(left.state).toBe('EXPIRED');
  });

  it('만료 후 재참여는 새 대기표를 발급', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await sleep(350);

    const second = await harness.service.join(TEST_ROOM_ID, 'user-1');

    expect(second.passId).not.toBe(first.passId);
    expect(second.state).toBe('WAITING');
  });

  it('하트비트로 대기 세션을 연장', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await sleep(200);
    const beat = await harness.service.heartbeat(TEST_ROOM_ID, 'user-1', pass.passId);
    await sleep(200);
    const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(beat.state).toBe('WAITING');
    expect(status.state).toBe('WAITING');
  });
});

describe('Phase 02 — 대기열 격리', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      rooms: [testRoom(), testRoom({ roomId: 'other-room' })],
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('다른 대기열의 대기표 조회 거부', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await expect(
      harness.service.check('other-room', 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('같은 사용자가 서로 다른 대기열에는 각각 참여', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join('other-room', 'user-1');

    expect(first.passId).not.toBe(second.passId);
    expect(first.roomId).toBe(TEST_ROOM_ID);
    expect(second.roomId).toBe('other-room');
  });
});
