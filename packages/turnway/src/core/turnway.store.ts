import type { Redis } from 'ioredis';
import { RoomConfigConflictError, StorageFailureError, WaitingRoomError } from '../errors';
import { buildRoomKeys, type RoomKeys } from '../redis/keys';
import { callScript, type ScriptName } from '../redis/script-loader';
import type { ScriptArgs, ScriptReply } from './script-contract';
import type { ResolvedRoomOptions } from '../types/options';
import type { AdmissionRunResult, WaitingRoomStats, WaitingRoomStatus } from '../types/status';
import {
  failureToError,
  isFailure,
  parsePayload,
  toStatus,
  type RawFailurePayload,
  type RawStatusPayload,
} from './raw-payload';

export interface JoinResult {
  status: WaitingRoomStatus;
  /** True when an existing live pass was returned unchanged */
  reused: boolean;
}

/** Redis script calls and conversion to service results and errors */
export class TurnwayStore {
  private readonly keyCache = new Map<string, RoomKeys>();

  constructor(
    private readonly client: Redis,
    private readonly keyPrefix: string,
  ) {}

  private keys(roomId: string): RoomKeys {
    let keys = this.keyCache.get(roomId);
    if (!keys) {
      // ioredis only prefixes KEYS, so the Lua prefix gets the client prefix applied here
      keys = buildRoomKeys(this.keyPrefix, roomId, this.client.options.keyPrefix ?? '');
      this.keyCache.set(roomId, keys);
    }
    return keys;
  }

  /** Run a script, wrapping Redis and reply parsing errors in StorageFailureError */
  private async run<K extends ScriptName>(
    script: K,
    keys: string[],
    args: ScriptArgs<K>,
  ): Promise<ScriptReply<K>> {
    try {
      const raw = await callScript(this.client, script, keys, args);
      return parsePayload(raw) as ScriptReply<K>;
    } catch (error) {
      if (error instanceof WaitingRoomError) throw error;
      throw new StorageFailureError(script, error);
    }
  }

  private roomKeyArgs(roomId: string): { keys: string[]; prefix: string } {
    const keys = this.keys(roomId);
    return {
      keys: [keys.seq, keys.waiting, keys.waitingExpiry, keys.active],
      prefix: keys.prefix,
    };
  }

  private unwrapStatus(
    payload: RawStatusPayload | RawFailurePayload,
    context: { roomId: string; userId: string; passId?: string },
  ): RawStatusPayload {
    if (isFailure(payload)) {
      throw failureToError(payload, context);
    }
    return payload;
  }

  /** Join the queue */
  async join(
    room: ResolvedRoomOptions,
    userId: string,
    passId: string,
    pruneLimit: number,
  ): Promise<JoinResult> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('join', keys, [
      prefix,
      userId,
      passId,
      room.waitingTtlMs,
      room.finishedRetentionMs,
      pruneLimit,
    ]);

    const status = this.unwrapStatus(payload, { roomId: room.roomId, userId, passId });
    return { status: toStatus(room.roomId, status), reused: status.reused === true };
  }

  /** Read the current status */
  async check(
    room: ResolvedRoomOptions,
    userId: string,
    passId: string,
    pruneLimit: number,
  ): Promise<WaitingRoomStatus> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('check', keys, [
      prefix,
      userId,
      passId,
      room.finishedRetentionMs,
      pruneLimit,
    ]);

    return toStatus(
      room.roomId,
      this.unwrapStatus(payload, { roomId: room.roomId, userId, passId }),
    );
  }

  /** Extend the session */
  async heartbeat(
    room: ResolvedRoomOptions,
    userId: string,
    passId: string,
    pruneLimit: number,
  ): Promise<WaitingRoomStatus> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('heartbeat', keys, [
      prefix,
      userId,
      passId,
      room.waitingTtlMs,
      room.sessionTtlMs,
      room.finishedRetentionMs,
      pruneLimit,
    ]);

    return toStatus(
      room.roomId,
      this.unwrapStatus(payload, { roomId: room.roomId, userId, passId }),
    );
  }

  /** Cancel a wait or leave */
  async leave(
    room: ResolvedRoomOptions,
    userId: string,
    passId: string,
  ): Promise<WaitingRoomStatus> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('leave', keys, [
      prefix,
      userId,
      passId,
      room.finishedRetentionMs,
    ]);

    return toStatus(
      room.roomId,
      this.unwrapStatus(payload, { roomId: room.roomId, userId, passId }),
    );
  }

  /** Admission check that reads the current state without writing */
  async verify(
    room: ResolvedRoomOptions,
    userId: string,
    passId: string,
  ): Promise<WaitingRoomStatus> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('verify', keys, [prefix, userId, passId]);

    return toStatus(
      room.roomId,
      this.unwrapStatus(payload, { roomId: room.roomId, userId, passId }),
    );
  }

  /** Run admission once */
  async promote(
    room: ResolvedRoomOptions,
    batchSize: number,
    pruneLimit: number,
  ): Promise<AdmissionRunResult> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('promote', keys, [
      prefix,
      room.capacity,
      room.sessionTtlMs,
      room.maxSessionDurationMs,
      room.finishedRetentionMs,
      batchSize,
      pruneLimit,
    ]);

    return {
      roomId: room.roomId,
      admitted: payload.admitted,
      expired: payload.expired,
      availableSlots: payload.availableSlots,
    };
  }

  /** Occupancy stats */
  async stats(room: ResolvedRoomOptions, pruneLimit: number): Promise<WaitingRoomStats> {
    const { keys, prefix } = this.roomKeyArgs(room.roomId);
    const payload = await this.run('stats', keys, [
      prefix,
      room.capacity,
      room.finishedRetentionMs,
      pruneLimit,
    ]);

    return {
      roomId: room.roomId,
      waiting: payload.waiting,
      admitted: payload.admitted,
      capacity: room.capacity,
      availableSlots: payload.availableSlots,
    };
  }

  /**
   * Register the room config.
   * A different config already in place fails init, which keeps instances from disagreeing.
   */
  async registerConfig(room: ResolvedRoomOptions): Promise<{ applied: boolean }> {
    const keys = this.keys(room.roomId);
    const fields: Array<string | number> = [
      'capacity',
      room.capacity,
      'waitingTtlMs',
      room.waitingTtlMs,
      'sessionTtlMs',
      room.sessionTtlMs,
      'maxSessionDurationMs',
      room.maxSessionDurationMs,
      'finishedRetentionMs',
      room.finishedRetentionMs,
    ];

    const payload = await this.run('register-config', [keys.config], fields);

    if (isFailure(payload)) {
      const failure: RawFailurePayload = payload;
      if (failure.code === 'ROOM_CONFIG_CONFLICT') {
        const incoming: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          incoming[String(fields[i])] = String(fields[i + 1]);
        }
        throw new RoomConfigConflictError(room.roomId, failure.current ?? {}, incoming);
      }
      throw failureToError(failure, { roomId: room.roomId, userId: '' });
    }
    return { applied: payload.applied };
  }
}
