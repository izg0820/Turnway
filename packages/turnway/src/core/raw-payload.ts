import { PassNotFoundError, PassOwnerMismatchError, WaitingRoomError } from '../errors';
import type {
  AdmittedStatus,
  ExpiredStatus,
  LeftStatus,
  WaitingRoomStatus,
  WaitingStatus,
} from '../types/status';

/** Status payload returned by the Lua scripts */
export interface RawStatusPayload {
  ok: true;
  state: 'WAITING' | 'ADMITTED' | 'LEFT' | 'EXPIRED';
  passId: string;
  userId: string;
  sequence: number;
  joinedAt: number;
  position?: number;
  expiresAt?: number;
  admittedAt?: number;
  sessionEndsAt?: number;
  endedAt?: number;
}

export interface RawFailurePayload {
  ok: false;
  code: string;
  /** Fields that disagree on a config conflict */
  conflicts?: string[];
  /** Config already applied in Redis on a conflict */
  current?: Record<string, string>;
}

/** One admission run, as returned by promote.lua */
export interface RawAdmissionPayload {
  admitted: number;
  expired: number;
  availableSlots: number;
}

/** Occupancy counts, as returned by stats.lua */
export interface RawStatsPayload {
  waiting: number;
  admitted: number;
  availableSlots: number;
}

/** Config registration result, as returned by register-config.lua */
export interface RawConfigPayload {
  applied: boolean;
}

/** Turn a failure payload into a domain error */
export function failureToError(
  payload: RawFailurePayload,
  context: { roomId: string; userId: string; passId?: string },
): WaitingRoomError {
  if (payload.code === 'PASS_NOT_FOUND') {
    return new PassNotFoundError(context.roomId, context.passId ?? '');
  }

  if (payload.code === 'PASS_OWNER_MISMATCH') {
    return new PassOwnerMismatchError(context.roomId, context.passId ?? '', context.userId);
  }

  return new WaitingRoomError('STORAGE_FAILURE', `Unexpected script failure: ${payload.code}`, {
    ...context,
    code: payload.code,
  });
}

/** Identify an error reply by its ok flag */
export function isFailure(payload: unknown): payload is RawFailurePayload {
  return (payload as { ok?: unknown }).ok === false;
}

/** Lua payload to the public status type */
export function toStatus(roomId: string, payload: RawStatusPayload): WaitingRoomStatus {
  const identity = {
    roomId,
    userId: payload.userId,
    passId: payload.passId,
    sequence: payload.sequence,
    joinedAt: payload.joinedAt,
  };

  if (payload.state === 'WAITING') {
    return {
      ...identity,
      state: 'WAITING',
      position: payload.position ?? 1,
      expiresAt: payload.expiresAt ?? 0,
    } satisfies WaitingStatus;
  }

  if (payload.state === 'ADMITTED') {
    return {
      ...identity,
      state: 'ADMITTED',
      admittedAt: payload.admittedAt ?? 0,
      expiresAt: payload.expiresAt ?? 0,
      sessionEndsAt: payload.sessionEndsAt ?? 0,
    } satisfies AdmittedStatus;
  }

  if (payload.state === 'LEFT') {
    return { ...identity, state: 'LEFT', endedAt: payload.endedAt ?? 0 } satisfies LeftStatus;
  }

  if (payload.state === 'EXPIRED') {
    return { ...identity, state: 'EXPIRED', endedAt: payload.endedAt ?? 0 } satisfies ExpiredStatus;
  }

  throw new WaitingRoomError('STORAGE_FAILURE', `Unknown pass state: ${payload.state}`, {
    roomId,
    state: payload.state,
  });
}
