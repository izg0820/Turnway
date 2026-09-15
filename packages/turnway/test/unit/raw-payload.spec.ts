import { describe, expect, it } from 'vitest';
import { failureToError, isFailure, toStatus } from '../../src/core/raw-payload';
import { PassNotFoundError, PassOwnerMismatchError, WaitingRoomError } from '../../src/errors';
import type { RawStatusPayload } from '../../src/core/raw-payload';

function payload(overrides: Partial<RawStatusPayload> = {}): RawStatusPayload {
  return {
    ok: true,
    state: 'WAITING',
    passId: 'p1',
    userId: 'u1',
    sequence: 7,
    joinedAt: 1_000,
    ...overrides,
  } as RawStatusPayload;
}

describe('toStatus', () => {
  it('maps a waiting payload with position and expiry', () => {
    const status = toStatus('room-a', payload({ position: 3, expiresAt: 2_000 }));

    expect(status).toEqual({
      roomId: 'room-a',
      userId: 'u1',
      passId: 'p1',
      sequence: 7,
      joinedAt: 1_000,
      state: 'WAITING',
      position: 3,
      expiresAt: 2_000,
    });
  });

  it('maps an admitted payload with the max stay deadline', () => {
    const status = toStatus(
      'room-a',
      payload({ state: 'ADMITTED', admittedAt: 1_500, expiresAt: 2_500, sessionEndsAt: 9_000 }),
    );

    expect(status).toMatchObject({
      state: 'ADMITTED',
      admittedAt: 1_500,
      expiresAt: 2_500,
      sessionEndsAt: 9_000,
    });
  });

  it('maps terminal payloads to their end time', () => {
    expect(toStatus('room-a', payload({ state: 'LEFT', endedAt: 3_000 }))).toMatchObject({
      state: 'LEFT',
      endedAt: 3_000,
    });
    expect(toStatus('room-a', payload({ state: 'EXPIRED', endedAt: 4_000 }))).toMatchObject({
      state: 'EXPIRED',
      endedAt: 4_000,
    });
  });

  it('rejects an unknown state instead of guessing', () => {
    expect(() => toStatus('room-a', payload({ state: 'UNKNOWN' as never }))).toThrow(
      WaitingRoomError,
    );
  });
});

describe('failure payloads', () => {
  it('detects failures by the ok flag', () => {
    expect(isFailure({ ok: false, code: 'PASS_NOT_FOUND' })).toBe(true);
    expect(isFailure(payload())).toBe(false);
  });

  it('maps known codes to distinguishable domain errors', () => {
    const context = { roomId: 'room-a', userId: 'u1', passId: 'p1' };

    expect(failureToError({ ok: false, code: 'PASS_NOT_FOUND' }, context)).toBeInstanceOf(
      PassNotFoundError,
    );
    expect(failureToError({ ok: false, code: 'PASS_OWNER_MISMATCH' }, context)).toBeInstanceOf(
      PassOwnerMismatchError,
    );
  });

  it('does not hide an unknown code as a normal state', () => {
    const error = failureToError({ ok: false, code: 'SOMETHING_ELSE' }, {
      roomId: 'room-a',
      userId: 'u1',
    });

    expect(error.code).toBe('STORAGE_FAILURE');
  });
});
