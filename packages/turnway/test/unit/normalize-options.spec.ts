import { describe, expect, it } from 'vitest';
import { normalizeAdmission, normalizeOptions, normalizeRoom } from '../../src/config/normalize-options';
import { InvalidArgumentError } from '../../src/errors';
import type { TurnwayModuleOptions } from '../../src/types/options';

function baseOptions(): TurnwayModuleOptions {
  return {
    redis: { url: 'redis://127.0.0.1:6399' },
    rooms: [{ roomId: 'room-a', capacity: 5 }],
  };
}

describe('normalizeRoom', () => {
  it('fills defaults for optional timings', () => {

    const room = { roomId: 'room-a', capacity: 3 };

    const resolved = normalizeRoom(room);

    expect(resolved).toEqual({
      roomId: 'room-a',
      capacity: 3,
      waitingTtlMs: 60_000,
      sessionTtlMs: 60_000,
      maxSessionDurationMs: 600_000,
      finishedRetentionMs: 60_000,
    });
  });

  it('rejects a roomId that would break key construction', () => {
    expect(() => normalizeRoom({ roomId: 'room {a}', capacity: 1 })).toThrow(InvalidArgumentError);
    expect(() => normalizeRoom({ roomId: '', capacity: 1 })).toThrow(InvalidArgumentError);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => normalizeRoom({ roomId: 'room-a', capacity: 0 })).toThrow(InvalidArgumentError);
    expect(() => normalizeRoom({ roomId: 'room-a', capacity: 1.5 })).toThrow(InvalidArgumentError);
  });

  it('rejects a max stay shorter than the session ttl', () => {
    expect(() =>
      normalizeRoom({
        roomId: 'room-a',
        capacity: 1,
        sessionTtlMs: 10_000,
        maxSessionDurationMs: 5_000,
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe('normalizeAdmission', () => {
  it('enables the worker by default', () => {
    expect(normalizeAdmission()).toEqual({
      enabled: true,
      intervalMs: 1_000,
      batchSize: 50,
      expiryScanLimit: 100,
      maxBackoffMs: 30_000,
    });
  });

  it('keeps an explicit disabled flag', () => {
    expect(normalizeAdmission({ enabled: false }).enabled).toBe(false);
  });

  it('rejects a non-positive interval', () => {
    expect(() => normalizeAdmission({ intervalMs: 0 })).toThrow(InvalidArgumentError);
  });
});

describe('normalizeOptions', () => {
  it('indexes rooms by id', () => {
    const resolved = normalizeOptions({
      ...baseOptions(),
      rooms: [
        { roomId: 'room-a', capacity: 1 },
        { roomId: 'room-b', capacity: 2 },
      ],
    });

    expect([...resolved.rooms.keys()]).toEqual(['room-a', 'room-b']);
    expect(resolved.keyPrefix).toBe('wr');
  });

  it('rejects duplicate room ids', () => {
    expect(() =>
      normalizeOptions({
        ...baseOptions(),
        rooms: [
          { roomId: 'room-a', capacity: 1 },
          { roomId: 'room-a', capacity: 2 },
        ],
      }),
    ).toThrow(InvalidArgumentError);
  });

  it('requires at least one room', () => {
    expect(() => normalizeOptions({ ...baseOptions(), rooms: [] })).toThrow(InvalidArgumentError);
  });

  it('requires a redis connection source', () => {
    expect(() =>
      normalizeOptions({ ...baseOptions(), redis: {} as never }),
    ).toThrow(InvalidArgumentError);
  });

  it('rejects mixing an injected client with connection settings', () => {
    expect(() =>
      normalizeOptions({
        ...baseOptions(),
        redis: { client: {} as never, url: 'redis://localhost:6379' } as never,
      }),
    ).toThrow(InvalidArgumentError);
  });

  it('rejects a key prefix containing braces', () => {
    expect(() => normalizeOptions({ ...baseOptions(), keyPrefix: 'wr{1}' })).toThrow(
      InvalidArgumentError,
    );
  });
});
