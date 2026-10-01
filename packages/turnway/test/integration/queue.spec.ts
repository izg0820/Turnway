import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidArgumentError,
  PassNotFoundError,
  PassOwnerMismatchError,
  RoomNotRegisteredError,
} from '../../src/errors';
import { createHarness, sleep, TEST_ROOM_ID, testRoom, type Harness } from './harness';

describe('Phase 02 — joining and checking status', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('concurrent joins by the same user converge on one live pass', async () => {

    const attempts = 20;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => harness.service.join(TEST_ROOM_ID, 'user-1')),
    );

    const passIds = new Set(results.map((status) => status.passId));
    expect(passIds.size).toBe(1);

    const waiting = await harness.redis.zcard(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting`);
    expect(waiting).toBe(1);
  });

  it('sequence numbers of different users follow Redis processing order', async () => {

    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join(TEST_ROOM_ID, 'user-2');
    const third = await harness.service.join(TEST_ROOM_ID, 'user-3');

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first).toMatchObject({ state: 'WAITING', position: 1 });
    expect(second).toMatchObject({ state: 'WAITING', position: 2 });
    expect(third).toMatchObject({ state: 'WAITING', position: 3 });
  });

  it('concurrent joins produce no duplicate sequences or missing queue entries', async () => {

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        harness.service.join(TEST_ROOM_ID, `user-${index}`),
      ),
    );

    const sequences = results.map((status) => status.sequence).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(30);
    expect(sequences).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));

    const waiting = await harness.redis.zcard(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:waiting`);
    expect(waiting).toBe(30);
  });

  it('rejects checking a pass owned by another user', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await expect(harness.service.check(TEST_ROOM_ID, 'user-2', pass.passId)).rejects.toBeInstanceOf(
      PassOwnerMismatchError,
    );
  });

  it('reports an unknown pass with a distinct error', async () => {
    await expect(
      harness.service.check(TEST_ROOM_ID, 'user-1', 'no-such-pass'),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('rejects calls to an unregistered room', async () => {
    await expect(harness.service.join('unknown-room', 'user-1')).rejects.toBeInstanceOf(
      RoomNotRegisteredError,
    );
  });

  it('rejects identifiers that would break the key layout', async () => {
    await expect(harness.service.join(TEST_ROOM_ID, 'user 1')).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('rejoining after finishing gets a new pass and sequence that cleanup of the old pass does not remove', async () => {

    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.leave(TEST_ROOM_ID, 'user-1', first.passId);

    const second = await harness.service.join(TEST_ROOM_ID, 'user-1');
    // Another expiry and cleanup pass must leave the new pass alive
    await harness.service.runAdmission(TEST_ROOM_ID);
    const checked = await harness.service.check(TEST_ROOM_ID, 'user-1', second.passId);

    expect(second.passId).not.toBe(first.passId);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(checked.state).not.toBe('LEFT');

    const mapped = await harness.redis.get(`${harness.keyPrefix}:{${TEST_ROOM_ID}}:user:user-1`);
    expect(mapped).toBe(second.passId);
  });

  it('rejoining while admitted returns the existing admitted session', async () => {

    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await harness.service.runAdmission(TEST_ROOM_ID);

    // a refresh retries the join
    const rejoined = await harness.service.join(TEST_ROOM_ID, 'user-1');

    expect(rejoined.passId).toBe(pass.passId);
    expect(rejoined.state).toBe('ADMITTED');
    expect((await harness.service.stats(TEST_ROOM_ID)).admitted).toBe(1);
  });

  it('checking after leaving returns the terminal state, unchanged by repeated leaves', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    const left = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);
    const again = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(left.state).toBe('LEFT');
    // Check that repeat calls keep the same end time
    expect(again).toEqual(left);
  });
});

describe('Phase 02 — waiting expiry', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({ rooms: [testRoom({ waitingTtlMs: 300 })] });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('a pass past its expiry is reported expired even before cleanup', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await sleep(350);
    const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(status.state).toBe('EXPIRED');
  });

  it('leaving with a pass past its expiry settles it as expired', async () => {
    // cleanup has not run, so the hash still reads WAITING
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await sleep(350);

    const left = await harness.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    // the leave result never splits into LEFT/EXPIRED based on cleanup order
    expect(left.state).toBe('EXPIRED');
  });

  it('rejoining after expiry issues a new pass', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    await sleep(350);

    const second = await harness.service.join(TEST_ROOM_ID, 'user-1');

    expect(second.passId).not.toBe(first.passId);
    expect(second.state).toBe('WAITING');
  });

  it('a heartbeat extends the waiting pass', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await sleep(200);
    const beat = await harness.service.heartbeat(TEST_ROOM_ID, 'user-1', pass.passId);
    await sleep(200);
    const status = await harness.service.check(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(beat.state).toBe('WAITING');
    expect(status.state).toBe('WAITING');
  });
});

describe('Phase 02 — room isolation', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      rooms: [testRoom(), testRoom({ roomId: 'other-room' })],
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rejects checking a pass from another room', async () => {
    const pass = await harness.service.join(TEST_ROOM_ID, 'user-1');

    await expect(
      harness.service.check('other-room', 'user-1', pass.passId),
    ).rejects.toBeInstanceOf(PassNotFoundError);
  });

  it('the same user can join different rooms separately', async () => {
    const first = await harness.service.join(TEST_ROOM_ID, 'user-1');
    const second = await harness.service.join('other-room', 'user-1');

    expect(first.passId).not.toBe(second.passId);
    expect(first.roomId).toBe(TEST_ROOM_ID);
    expect(second.roomId).toBe('other-room');
  });
});
