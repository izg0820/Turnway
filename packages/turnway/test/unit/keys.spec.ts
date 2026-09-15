import { describe, expect, it } from 'vitest';
import { assertIdentifier, buildRoomKeys, passKey, userKey } from '../../src/redis/keys';
import { InvalidArgumentError } from '../../src/errors';

describe('buildRoomKeys', () => {
  it('groups every key of a room under one prefix', () => {
    const keys = buildRoomKeys('wr', 'room-a');

    expect(keys).toEqual({
      seq: 'wr:{room-a}:seq',
      waiting: 'wr:{room-a}:waiting',
      waitingExpiry: 'wr:{room-a}:waiting-expiry',
      active: 'wr:{room-a}:active',
      config: 'wr:{room-a}:config',
      prefix: 'wr:{room-a}:',
    });
  });

  it('keeps different rooms on separate key spaces', () => {
    expect(buildRoomKeys('wr', 'a').waiting).not.toBe(buildRoomKeys('wr', 'b').waiting);
  });

  it('applies the client key prefix only to the Lua prefix', () => {
    const keys = buildRoomKeys('wr', 'room-a', 'app:');

    // Fixed keys are left alone because ioredis prepends the prefix
    expect(keys.waiting).toBe('wr:{room-a}:waiting');
    expect(keys.config).toBe('wr:{room-a}:config');
    // The prefix travelling as ARGV is never rewritten, so it is composed here
    expect(keys.prefix).toBe('app:wr:{room-a}:');
    expect(passKey(keys.prefix, 'p1')).toBe('app:wr:{room-a}:pass:p1');
  });
});

describe('pass and user keys', () => {
  it('derives keys from the room prefix', () => {
    const { prefix } = buildRoomKeys('wr', 'room-a');

    expect(passKey(prefix, 'p1')).toBe('wr:{room-a}:pass:p1');
    expect(userKey(prefix, 'u1')).toBe('wr:{room-a}:user:u1');
  });
});

describe('assertIdentifier', () => {
  it('returns the value when it is safe for key construction', () => {
    expect(assertIdentifier('user-1', 'userId')).toBe('user-1');
  });

  it('rejects empty, oversized, and structurally unsafe values', () => {
    expect(() => assertIdentifier('', 'userId')).toThrow(InvalidArgumentError);
    expect(() => assertIdentifier('a'.repeat(257), 'userId')).toThrow(InvalidArgumentError);
    expect(() => assertIdentifier('user 1', 'userId')).toThrow(InvalidArgumentError);
    expect(() => assertIdentifier('user{1}', 'userId')).toThrow(InvalidArgumentError);
    expect(() => assertIdentifier(42 as never, 'userId')).toThrow(InvalidArgumentError);
  });
});
