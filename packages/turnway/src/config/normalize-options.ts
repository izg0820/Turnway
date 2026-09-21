import { Cluster, type ClusterNode, type ClusterOptions } from 'ioredis';
import { InvalidArgumentError } from '../errors';
import type {
  AdmissionOptions,
  ResolvedAdmissionOptions,
  ResolvedRoomOptions,
  ResolvedTurnwayOptions,
  RoomOptions,
  TurnwayModuleOptions,
} from '../types/options';
import {
  DEFAULT_ADMISSION_OPTIONS,
  DEFAULT_FINISHED_RETENTION_MS,
  DEFAULT_KEY_PREFIX,
  DEFAULT_MAX_SESSION_DURATION_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_WAITING_TTL_MS,
  ROOM_ID_PATTERN,
} from './defaults';

/** Validate a positive integer */
function positiveInt(value: unknown, field: string, fallback?: number): number {
  const resolved = value === undefined ? fallback : value;
  if (resolved === undefined) {
    throw new InvalidArgumentError(`"${field}" is required.`, { field });
  }
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved <= 0) {
    throw new InvalidArgumentError(`"${field}" must be a positive integer.`, {
      field,
      value: resolved,
    });
  }
  return resolved;
}

/** Normalize one room configuration */
export function normalizeRoom(room: RoomOptions): ResolvedRoomOptions {
  if (!room || typeof room !== 'object') {
    throw new InvalidArgumentError('Each entry of "rooms" must be an object.');
  }
  if (typeof room.roomId !== 'string' || !ROOM_ID_PATTERN.test(room.roomId)) {
    throw new InvalidArgumentError(
      '"roomId" must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.',
      { roomId: room.roomId },
    );
  }

  const sessionTtlMs = positiveInt(room.sessionTtlMs, 'sessionTtlMs', DEFAULT_SESSION_TTL_MS);
  const maxSessionDurationMs = positiveInt(
    room.maxSessionDurationMs,
    'maxSessionDurationMs',
    DEFAULT_MAX_SESSION_DURATION_MS,
  );

  if (maxSessionDurationMs < sessionTtlMs) {
    throw new InvalidArgumentError(
      '"maxSessionDurationMs" must be greater than or equal to "sessionTtlMs".',
      { roomId: room.roomId, sessionTtlMs, maxSessionDurationMs },
    );
  }

  // Prevent changes to the configuration registered in Redis
  return Object.freeze({
    roomId: room.roomId,
    capacity: positiveInt(room.capacity, 'capacity'),
    waitingTtlMs: positiveInt(room.waitingTtlMs, 'waitingTtlMs', DEFAULT_WAITING_TTL_MS),
    sessionTtlMs,
    maxSessionDurationMs,
    finishedRetentionMs: positiveInt(
      room.finishedRetentionMs,
      'finishedRetentionMs',
      DEFAULT_FINISHED_RETENTION_MS,
    ),
  });
}

/** Normalize the admission worker configuration */
export function normalizeAdmission(admission: AdmissionOptions = {}): ResolvedAdmissionOptions {
  const enabled = admission.enabled ?? DEFAULT_ADMISSION_OPTIONS.enabled;
  if (typeof enabled !== 'boolean') {
    throw new InvalidArgumentError('"admission.enabled" must be a boolean.', { enabled });
  }

  return {
    enabled,
    intervalMs: positiveInt(
      admission.intervalMs,
      'admission.intervalMs',
      DEFAULT_ADMISSION_OPTIONS.intervalMs,
    ),
    batchSize: positiveInt(
      admission.batchSize,
      'admission.batchSize',
      DEFAULT_ADMISSION_OPTIONS.batchSize,
    ),
    expiryScanLimit: positiveInt(
      admission.expiryScanLimit,
      'admission.expiryScanLimit',
      DEFAULT_ADMISSION_OPTIONS.expiryScanLimit,
    ),
    maxBackoffMs: positiveInt(
      admission.maxBackoffMs,
      'admission.maxBackoffMs',
      DEFAULT_ADMISSION_OPTIONS.maxBackoffMs,
    ),
  };
}

/** Validate startup node addresses and ports */
function validClusterNode(node: ClusterNode): boolean {
  const validPort = (port: unknown): boolean =>
    typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
  if (typeof node === 'number') return validPort(node);
  if (typeof node === 'string') {
    try {
      const url = new URL(node.includes('://') ? node : `redis://${node}`);
      return ['redis:', 'rediss:'].includes(url.protocol) && !!url.hostname &&
        (url.port === '' || validPort(Number(url.port)));
    } catch {
      return false;
    }
  }
  return !!node && typeof node === 'object' && !Array.isArray(node) &&
    (node.host === undefined || (typeof node.host === 'string' && node.host.trim().length > 0)) &&
    (node.port === undefined || validPort(node.port));
}

/** Reject Cluster prefixes that override room hash tags */
function assertClusterPrefix(options: ClusterOptions | undefined): void {
  for (const prefix of [options?.keyPrefix, options?.redisOptions?.keyPrefix]) {
    if (prefix !== undefined && (typeof prefix !== 'string' || /[{}]/.test(prefix))) {
      throw new InvalidArgumentError('Redis Cluster client keyPrefix must be a string without braces.');
    }
  }
}

/** Validate the Redis connection options */
function assertRedisOptions(options: TurnwayModuleOptions): void {
  const redis = options.redis;
  if (!redis || typeof redis !== 'object') {
    throw new InvalidArgumentError('"redis" is required.');
  }

  const hasClient = 'client' in redis && redis.client !== undefined;
  const hasUrl = 'url' in redis && redis.url !== undefined;
  const hasNodes = 'startupNodes' in redis && redis.startupNodes !== undefined;
  const hasOptions = 'options' in redis && redis.options !== undefined;

  if (!hasClient && !hasUrl && !hasOptions && !hasNodes) {
    throw new InvalidArgumentError('"redis" must provide one of "client", "url", "startupNodes", or "options".');
  }
  if ((hasClient && (hasUrl || hasOptions || hasNodes)) || (hasNodes && hasUrl)) {
    throw new InvalidArgumentError(
      '"redis.client", "redis.url", and "redis.startupNodes" cannot be combined; injected clients cannot have "redis.options".',
    );
  }
  if ('startupNodes' in redis) {
    if (!Array.isArray(redis.startupNodes) || redis.startupNodes.length === 0 ||
      !redis.startupNodes.every(validClusterNode)) {
      throw new InvalidArgumentError('"redis.startupNodes" must contain valid Redis Cluster nodes.');
    }
    assertClusterPrefix(redis.options);
  }
  if ('client' in redis && redis.client instanceof Cluster) {
    assertClusterPrefix(redis.client.options);
  }
  if (hasUrl && typeof (redis as { url: unknown }).url !== 'string') {
    throw new InvalidArgumentError('"redis.url" must be a string.');
  }
}

/** Normalize every module option. Invalid configuration fails at init */
export function normalizeOptions(options: TurnwayModuleOptions): ResolvedTurnwayOptions {
  if (!options || typeof options !== 'object') {
    throw new InvalidArgumentError('Waiting room module options are required.');
  }
  assertRedisOptions(options);

  if (!Array.isArray(options.rooms) || options.rooms.length === 0) {
    throw new InvalidArgumentError('"rooms" must contain at least one waiting room.');
  }

  const rooms = new Map<string, ResolvedRoomOptions>();
  for (const room of options.rooms) {
    const resolved = normalizeRoom(room);
    if (rooms.has(resolved.roomId)) {
      throw new InvalidArgumentError(`Duplicate roomId "${resolved.roomId}" in "rooms".`, {
        roomId: resolved.roomId,
      });
    }
    rooms.set(resolved.roomId, resolved);
  }

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0 || /[\s{}]/.test(keyPrefix)) {
    throw new InvalidArgumentError(
      '"keyPrefix" must be a non-empty string without whitespace or braces.',
      { keyPrefix },
    );
  }

  return {
    redis: options.redis,
    rooms,
    admission: normalizeAdmission(options.admission),
    keyPrefix,
    logger: options.logger,
  };
}
