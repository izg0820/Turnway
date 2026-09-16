import { AdmissionRunner } from './admission/admission-runner';
import { normalizeOptions } from './config/normalize-options';
import { createConsoleLogger } from './console-logger';
import { TurnwayRuntime } from './core/turnway-runtime';
import { TurnwayStore } from './core/turnway.store';
import { createRedisConnection } from './redis/redis-connection';
import { defineScripts } from './redis/script-loader';
import type { TurnwayModuleOptions } from './types/options';
import { TurnwayService } from './turnway.service';

/** Registration options outside NestJS. Same shape as the module options */
export type TurnwayOptions = TurnwayModuleOptions;

/** Handle returned by `createTurnway()` */
export interface Turnway {
  /** Join, check, heartbeat, leave, and admission checks */
  readonly service: TurnwayService;
  /** Stop the admission worker and clean up the owned connection */
  close(): Promise<void>;
}

/**
 * Create a waiting room service without NestJS.
 *
 * Registers room configuration and starts the worker if admission.enabled is true.
 * If configuration registration fails, closes the owned connection and rejects.
 */
export async function createTurnway(options: TurnwayOptions): Promise<Turnway> {
  const resolved = normalizeOptions(options);
  const logger = resolved.logger ?? createConsoleLogger();

  const connection = createRedisConnection(resolved.redis);
  defineScripts(connection.client);

  const store = new TurnwayStore(connection.client, resolved.keyPrefix);
  const runner = new AdmissionRunner(store, resolved.rooms, resolved.admission, logger);
  const runtime = new TurnwayRuntime(resolved, store, runner, connection, logger);

  await runtime.onModuleInit();

  return {
    service: new TurnwayService(resolved, store, runner),
    close: () => runtime.stop(),
  };
}

export { TurnwayService } from './turnway.service';
export { createConsoleLogger } from './console-logger';

export type {
  AdmissionOptions,
  RedisConnectionOptions,
  ResolvedRoomOptions,
  ResolvedTurnwayOptions,
  RoomOptions,
  WaitingRoomLogger,
} from './types/options';

export type {
  AdmissionRunResult,
  AdmittedStatus,
  ExpiredStatus,
  LeftStatus,
  WaitingPassIdentity,
  WaitingRoomState,
  WaitingRoomStats,
  WaitingRoomStatus,
  WaitingStatus,
} from './types/status';
export { isTerminal } from './types/status';

export {
  InvalidArgumentError,
  NotAdmittedError,
  PassNotFoundError,
  PassOwnerMismatchError,
  RoomConfigConflictError,
  RoomNotRegisteredError,
  StorageFailureError,
  WaitingRoomError,
  isWaitingRoomError,
} from './errors';
export type { WaitingRoomErrorCode } from './errors';
