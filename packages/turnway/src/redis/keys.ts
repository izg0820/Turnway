import { InvalidArgumentError } from '../errors';
import { MAX_ID_LENGTH } from '../config/defaults';

/**
 * Per-room key prefix.
 * The braces group the keys visually and do not imply Redis Cluster support.
 */
export function roomPrefix(keyPrefix: string, roomId: string): string {
  return `${keyPrefix}:{${roomId}}:`;
}

export interface RoomKeys {
  /** Join sequence counter */
  seq: string;
  /** Pass id to join sequence */
  waiting: string;
  /** Pass id to waiting expiry time */
  waitingExpiry: string;
  /** Pass id to admitted session expiry time */
  active: string;
  /** Room config currently applied */
  config: string;
  /**
   * Prefix the Lua scripts use to build pass and user keys.
   * redis.call inside Lua bypasses the client prefix, so it is baked in here.
   */
  prefix: string;
}

/**
 * Build the fixed key set of a room.
 *
 * Fixed keys travel as KEYS and ioredis prepends the client prefix, so it is left off here.
 * `prefix` travels as ARGV and is never rewritten, so the client prefix is applied directly.
 * Swapping the two puts the indexes and the passes in different key spaces.
 */
export function buildRoomKeys(
  keyPrefix: string,
  roomId: string,
  clientKeyPrefix = '',
): RoomKeys {
  const prefix = roomPrefix(keyPrefix, roomId);
  return {
    seq: `${prefix}seq`,
    waiting: `${prefix}waiting`,
    waitingExpiry: `${prefix}waiting-expiry`,
    active: `${prefix}active`,
    config: `${prefix}config`,
    prefix: `${clientKeyPrefix}${prefix}`,
  };
}

/** Pass hash key */
export function passKey(prefix: string, passId: string): string {
  return `${prefix}pass:${passId}`;
}

/** User to current pass mapping key */
export function userKey(prefix: string, userId: string): string {
  return `${prefix}user:${userId}`;
}

/** Validate an externally supplied identifier and reject values that break the key layout */
export function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidArgumentError(`"${field}" must be a non-empty string.`, { field });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidArgumentError(`"${field}" must be at most ${MAX_ID_LENGTH} characters.`, {
      field,
      length: value.length,
    });
  }
  if (/[\s{}]/.test(value)) {
    throw new InvalidArgumentError(`"${field}" must not contain whitespace or braces.`, { field });
  }
  return value;
}
