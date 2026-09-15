export { TurnwayModule } from './turnway.module';
export type {
  TurnwayModuleAsyncOptions,
  TurnwayOptionsFactory,
} from './turnway.module';
export { TurnwayService } from './turnway.service';

export {
  TURNWAY_LOGGER,
  TURNWAY_OPTIONS,
  TURNWAY_RESOLVED_OPTIONS,
} from './constants';

export type {
  AdmissionOptions,
  RedisConnectionOptions,
  ResolvedRoomOptions,
  ResolvedTurnwayOptions,
  RoomOptions,
  WaitingRoomLogger,
  TurnwayModuleOptions,
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
