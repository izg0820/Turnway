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

describe('Phase 04 — admission verification', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('returns the active session for an admitted user', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const session = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(session.state).toBe('ADMITTED');
    expect(session.passId).toBe(pass.passId);
    expect(session.expiresAt).toBeGreaterThan(session.admittedAt);
  });

  it('blocks protected work for a waiting user', async () => {
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

  it('blocks access with a pass that has left', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);
    await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    const error = await harness.service
      .assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotAdmittedError);
    expect((error as NotAdmittedError).status.state).toBe('LEFT');
  });

  it('blocks access with a pass owned by another user or an unknown pass', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-2', pass.passId),
    ).rejects.toBeInstanceOf(PassOwnerMismatchError);
    await expect(
      harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', 'no-such-pass'),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('verification neither extends the session nor consumes extra capacity', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    const first = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);
    await sleep(60);
    const second = await harness.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(second.expiresAt).toBe(first.expiresAt);
    expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(1);
  });

  it('runs the whole flow from join to leave through service calls alone', async () => {
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

describe('Phase 04 — room and owner isolation', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ rooms: [testRoom(), testRoom({ roomId: 'other-room' })] });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('a pass from another room cannot pass verification', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    await expect(
      harness.service.assertAdmitted('other-room', 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('a pass owned by another user can neither extend nor leave', async () => {
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

describe('Phase 04 — verifying expired sessions', () => {
  it('blocks an admitted session past its expiry even before cleanup', async () => {
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

describe('Phase 04 — storage failure', () => {
  it('does not treat a Redis failure as a successful admission', async () => {
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

  it('resumes after reconnecting', async () => {
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
