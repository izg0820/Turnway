import type { Redis, RedisOptions } from 'ioredis';

/** Configuration for a single room */
export interface RoomOptions {
  /** 1–64 characters: letters, digits, dots, underscores or hyphens; first character alphanumeric */
  roomId: string;
  /** Concurrent admission limit, counted in active sessions */
  capacity: number;
  /** Waiting pass TTL in ms, renewed by heartbeat. Defaults to 60_000 */
  waitingTtlMs?: number;
  /** Admitted session lifetime in ms, extended by heartbeats. Defaults to 60_000 */
  sessionTtlMs?: number;
  /** Max stay in ms measured from first admission. Defaults to 600_000 */
  maxSessionDurationMs?: number;
  /** Retention of finished passes in ms. Defaults to 60_000 */
  finishedRetentionMs?: number;
}

/** Validated, frozen room configuration with defaults applied */
export type ResolvedRoomOptions = Readonly<Required<RoomOptions>>;

/** Admission worker configuration */
export interface AdmissionOptions {
  /** Start the worker during initialization. Defaults to true */
  enabled?: boolean;
  /** Delay in ms after each completed run. Defaults to 1_000 */
  intervalMs?: number;
  /** Max users admitted per run. Defaults to 50 */
  batchSize?: number;
  /**
   * Per-room limit for the initial expiry cleanup. Defaults to 100.
   * Admission may also remove expired passes while scanning the queue head.
   */
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
  /** Defaults to NestJS Logger in the module, or stderr logging in createTurnway() */
  logger?: WaitingRoomLogger;
}

export interface ResolvedTurnwayOptions {
  redis: RedisConnectionOptions;
  rooms: Map<string, ResolvedRoomOptions>;
  admission: ResolvedAdmissionOptions;
  keyPrefix: string;
  logger?: WaitingRoomLogger;
}
