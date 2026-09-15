import type { Redis, RedisOptions } from 'ioredis';

/** Configuration for a single room */
export interface RoomOptions {
  /** Room identifier. Whitespace and braces are rejected */
  roomId: string;
  /** Concurrent admission limit, counted in active sessions */
  capacity: number;
  /** Waiting pass lifetime in ms. Defaults to 60_000 */
  waitingTtlMs?: number;
  /** Admitted session lifetime in ms, extended by heartbeats. Defaults to 60_000 */
  sessionTtlMs?: number;
  /** Max stay in ms measured from first admission. Defaults to 600_000 */
  maxSessionDurationMs?: number;
  /** Retention of finished passes in ms. Defaults to 60_000 */
  finishedRetentionMs?: number;
}

/** Room configuration with defaults filled in, used internally */
export type ResolvedRoomOptions = Required<RoomOptions>;

/** Admission worker configuration */
export interface AdmissionOptions {
  /** Start automatically on module init. Defaults to true */
  enabled?: boolean;
  /** Run interval in ms. Defaults to 1_000 */
  intervalMs?: number;
  /** Max users admitted per run. Defaults to 50 */
  batchSize?: number;
  /** Max expired entries pruned per run. Defaults to 100 */
  expiryScanLimit?: number;
  /** Upper bound of the backoff interval in ms after repeated failures. Defaults to 30_000 */
  maxBackoffMs?: number;
}

export type ResolvedAdmissionOptions = Required<AdmissionOptions>;

/** Inject an existing ioredis connection. The caller keeps ownership */
export interface ExistingRedisConnection {
  client: Redis;
}

/** Create a connection from a URL. The library owns it and closes it on shutdown */
export interface RedisUrlConnection {
  url: string;
  options?: RedisOptions;
}

/** Create a connection from ioredis options. The library owns it */
export interface RedisOptionsConnection {
  options: RedisOptions;
}

export type RedisConnectionOptions =
  | ExistingRedisConnection
  | RedisUrlConnection
  | RedisOptionsConnection;

/** Logger for background work and configuration failures */
export interface WaitingRoomLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Module registration options */
export interface TurnwayModuleOptions {
  /** An existing Redis connection, or how to create one */
  redis: RedisConnectionOptions;
  /** Rooms to register. At least one is required */
  rooms: RoomOptions[];
  /** Admission worker configuration */
  admission?: AdmissionOptions;
  /** Redis key prefix. Defaults to 'wr' */
  keyPrefix?: string;
  /** Logger. Falls back to the NestJS Logger when omitted */
  logger?: WaitingRoomLogger;
}

export interface ResolvedTurnwayOptions {
  redis: RedisConnectionOptions;
  rooms: Map<string, ResolvedRoomOptions>;
  admission: ResolvedAdmissionOptions;
  keyPrefix: string;
  logger?: WaitingRoomLogger;
}
