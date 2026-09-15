import type { WaitingRoomStatus } from './types/status';

/** Error codes for validation, pass access, configuration and storage failures */
export type WaitingRoomErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ROOM_NOT_REGISTERED'
  | 'ROOM_CONFIG_CONFLICT'
  | 'PASS_NOT_FOUND'
  | 'PASS_OWNER_MISMATCH'
  | 'NOT_ADMITTED'
  | 'STORAGE_FAILURE';

/** Base class for every library error */
export class WaitingRoomError extends Error {
  readonly code: WaitingRoomErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: WaitingRoomErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Argument validation failed */
export class InvalidArgumentError extends WaitingRoomError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_ARGUMENT', message, details);
  }
}

/** Room is not registered with the module */
export class RoomNotRegisteredError extends WaitingRoomError {
  constructor(roomId: string) {
    super('ROOM_NOT_REGISTERED', `Waiting room "${roomId}" is not registered in this module.`, {
      roomId,
    });
  }
}

/** Init attempted with a config that differs from the one already applied in Redis */
export class RoomConfigConflictError extends WaitingRoomError {
  constructor(roomId: string, applied: Record<string, string>, incoming: Record<string, string>) {
    super(
      'ROOM_CONFIG_CONFLICT',
      `Waiting room "${roomId}" is already configured with different settings in Redis.`,
      { roomId, applied, incoming },
    );
  }
}

/** Unknown or already deleted pass */
export class PassNotFoundError extends WaitingRoomError {
  constructor(roomId: string, passId: string) {
    super('PASS_NOT_FOUND', `Pass "${passId}" was not found in waiting room "${roomId}".`, {
      roomId,
      passId,
    });
  }
}

/** Pass owner does not match the requesting user */
export class PassOwnerMismatchError extends WaitingRoomError {
  constructor(roomId: string, passId: string, userId: string) {
    super('PASS_OWNER_MISMATCH', `Pass "${passId}" does not belong to user "${userId}".`, {
      roomId,
      passId,
      userId,
    });
  }
}

/** No live admitted session. Carries the current status */
export class NotAdmittedError extends WaitingRoomError {
  readonly status: WaitingRoomStatus;

  constructor(status: WaitingRoomStatus) {
    super(
      'NOT_ADMITTED',
      `User "${status.userId}" has no active admission in waiting room "${status.roomId}" (state: ${status.state}).`,
      { roomId: status.roomId, userId: status.userId, passId: status.passId, state: status.state },
    );
    this.status = status;
  }
}

/** Redis command or reply parsing failure, retaining the original cause */
export class StorageFailureError extends WaitingRoomError {
  constructor(operation: string, cause: unknown) {
    super('STORAGE_FAILURE', `Waiting room storage operation "${operation}" failed.`, {
      operation,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    this.cause = cause;
  }
}

/** Whether the value is a library domain error */
export function isWaitingRoomError(error: unknown): error is WaitingRoomError {
  return error instanceof WaitingRoomError;
}
