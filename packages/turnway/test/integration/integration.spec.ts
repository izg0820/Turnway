import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  NotAdmittedError,
  PassNotFoundError,
  PassOwnerMismatchError,
  StorageFailureError,
} from '../../src/errors';
import {
  createHarness,
  REDIS_URL,
  sleep,
  TEST_ROOM_ID,
  testRoom,
  waitForReady,
  type Harness,
} from './harness';

describe('Phase 04 — 입장 검증', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('입장한 사용자에게 활성 세션을 반환', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const session = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(session.state).toBe('ADMITTED');
    expect(session.passId).toBe(pass.passId);
    expect(session.expiresAt).toBeGreaterThan(session.admittedAt);
  });

  it('대기 중인 사용자의 보호 기능 접근 차단', async () => {
    await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const error = await harness.service
      .assertAdmitted(TEST_ROOM_ID, 'user-3', third.passId)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotAdmittedError);
    expect((error as NotAdmittedError).code).toBe('NOT_ADMITTED');
    expect((error as NotAdmittedError).status.state).toBe('WAITING');
  });

  it('퇴장한 대기표 접근 차단', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);
    await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    const error = await harness.service
      .assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotAdmittedError);
    expect((error as NotAdmittedError).status.state).toBe('LEFT');
  });

  it('타인 대기표와 알 수 없는 대기표 접근 차단', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-2', pass.passId),
    ).rejects.toBeInstanceOf(PassOwnerMismatchError);
    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', 'no-such-pass'),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('검증은 세션을 연장하거나 추가 정원을 소비하지 않음', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const first = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);
    await sleep(60);
    const second = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(second.expiresAt).toBe(first.expiresAt);
    expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(1);
  });

  it('참여부터 퇴장까지 전체 흐름을 서비스 호출만으로 실행', async () => {
    // 1. join
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    expect(pass.state).toBe('WAITING');

    // 2. check the waiting status
    expect((await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId)).state).toBe('WAITING');
    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(NotAdmittedError);

    // 3. admission
    await harness.service.runAdmission(TEST_ROOM_ID);
    const session = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);
    expect(session.state).toBe('ADMITTED');

    // 4. extend the session
    expect((await harness.service.heartbeat(TEST_ROOM_ID, 'user-1', pass.passId)).state).toBe(
      'ADMITTED',
    );

    // 5. access is blocked after leaving
    expect((await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId)).state).toBe('LEFT');
    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(NotAdmittedError);
    expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(0);
  });
});

describe('Phase 04 — 대기열·소유자 격리', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ rooms: [testRoom(), testRoom({ roomId: 'other-room' })] });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('다른 대기열의 대기표로는 입장 검증 불가', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    await expect(
      harness.service.assertAdmitted('other-room', 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('타인 대기표로는 연장·퇴장도 불가', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await expect(
      harness.service.heartbeat(TEST_ROOM_ID, 'user-2', pass.passId),
    ).rejects.toBeInstanceOf(PassOwnerMismatchError);
    await expect(harness.service.leave(TEST_ROOM_ID, 'user-2', pass.passId)).rejects.toBeInstanceOf(
      PassOwnerMismatchError,
    );

    // A rejected request must not change the real owner's state
    expect((await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId)).state).toBe('WAITING');
  });
});

describe('Phase 04 — 만료된 세션 검증', () => {
  it('만료 시각이 지난 입장 세션은 청소 전이라도 접근 차단', async () => {
    const harness = await createHarness({ rooms: [testRoom({ sessionTtlMs: 300 })] });

    try {
      const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
      await harness.service.runAdmission(TEST_ROOM_ID);
      await sleep(350);

      const error = await harness.service
        .assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotAdmittedError);
      expect((error as NotAdmittedError).status.state).toBe('EXPIRED');
    } finally {
      await harness.close();
    }
  });
});

describe('Phase 04 — 저장소 장애', () => {
  it('Redis 접근 실패를 입장 성공으로 처리하지 않음', async () => {
    // inject an external connection with the offline queue disabled so failures surface at once
    const client = await waitForReady(
      new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
    );
    const harness = await createHarness({ redis: { client } });

    try {
      const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
      await harness.service.runAdmission(TEST_ROOM_ID);
      await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);

      // trigger a storage failure
      client.disconnect();

      const error = await harness.service
        .assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StorageFailureError);
      expect((error as StorageFailureError).code).toBe('STORAGE_FAILURE');

      await expect(harness.service.join(TEST_ROOM_ID, 'user-2')).rejects.toBeInstanceOf(
        StorageFailureError,
      );
    } finally {
      await waitForReady(client).catch(() => undefined);
      await harness.close();
      client.disconnect();
    }
  });

  it('재연결 이후 처리 재개', async () => {
    const client = await waitForReady(
      new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
    );
    const harness = await createHarness({ redis: { client } });

    try {
      client.disconnect();
      await expect(harness.service.join(TEST_ROOM_ID, 'user-1')).rejects.toBeInstanceOf(
        StorageFailureError,
      );

      // Once auto-reconnect finishes, work resumes without any recovery step
      await waitForReady(client);
      const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

      expect(pass.state).toBe('WAITING');
    } finally {
      await harness.close();
      client.disconnect();
    }
  });
});
