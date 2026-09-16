import { randomUUID } from 'node:crypto';
import { AdmissionRunner } from './admission/admission-runner';
import { TurnwayStore } from './core/turnway.store';
import { NotAdmittedError, RoomNotRegisteredError } from './errors';
import { assertIdentifier } from './redis/keys';
import type { ResolvedRoomOptions, ResolvedTurnwayOptions } from './types/options';
import type {
  AdmissionRunResult,
  AdmittedStatus,
  WaitingRoomStats,
  WaitingRoomStatus,
} from './types/status';

/**
 * Public service for joining, checking, extending, leaving, and verifying admission.
 *
 * Authenticating the user and passing a trustworthy `userId` is the caller's responsibility.
 * A `passId` is not a credential; ownership is confirmed against Redis state.
 *
 * Available through TurnwayModule or createTurnway().
 */
export class TurnwayService {
  constructor(
    private readonly options: ResolvedTurnwayOptions,
    private readonly store: TurnwayStore,
    private readonly admission: AdmissionRunner,
  ) {}

  /** Ids of the registered rooms */
  get roomIds(): string[] {
    return [...this.options.rooms.keys()];
  }


  /**
   * Join the queue.
   * A user who already holds a live pass gets that pass back instead of a new one.
   * There is no fast path that skips the queue, even when capacity is free.
   */
  async join(roomId: string, userId: string): Promise<WaitingRoomStatus> {
    const room = this.requireRoom(roomId);
    assertIdentifier(userId, 'userId');

    return this.store.join(room, userId, randomUUID(), this.pruneLimit);
  }

  /** Read the waiting state, position, and expiry */
  async check(roomId: string, userId: string, passId: string): Promise<WaitingRoomStatus> {
    const room = this.requireRoom(roomId);
    assertIdentifier(userId, 'userId');
    assertIdentifier(passId, 'passId');

    return this.store.check(room, userId, passId, this.pruneLimit);
  }

  /**
   * Extend a live session only.
   * An already expired pass is not revived; the expired status is returned.
   */
  async heartbeat(roomId: string, userId: string, passId: string): Promise<WaitingRoomStatus> {
    const room = this.requireRoom(roomId);
    assertIdentifier(userId, 'userId');
    assertIdentifier(passId, 'passId');

    return this.store.heartbeat(room, userId, passId, this.pruneLimit);
  }

  /**
   * Cancel a wait or leave a session.
   * Repeat calls within the retention window change neither capacity nor anyone else's state.
   */
  async leave(roomId: string, userId: string, passId: string): Promise<WaitingRoomStatus> {
    const room = this.requireRoom(roomId);
    assertIdentifier(userId, 'userId');
    assertIdentifier(passId, 'passId');

    return this.store.leave(room, userId, passId);
  }

  /**
   * Admission check to call right before running protected logic.
   * Neither extends the session nor consumes extra capacity.
   *
   * @throws NotAdmittedError if the pass is waiting, left or expired
   * @throws PassNotFoundError if the pass is missing or has been deleted
   * @throws PassOwnerMismatchError if the pass belongs to another user
   */
  async assertAdmitted(roomId: string, userId: string, passId: string): Promise<AdmittedStatus> {
    const room = this.requireRoom(roomId);
    assertIdentifier(userId, 'userId');
    assertIdentifier(passId, 'passId');

    const status = await this.store.verify(room, userId, passId);
    if (status.state !== 'ADMITTED') {
      throw new NotAdmittedError(status);
    }
    return status;
  }

  /** Live waiting and admitted counts */
  async stats(roomId: string): Promise<WaitingRoomStats> {
    const room = this.requireRoom(roomId);
    return this.store.stats(room, this.pruneLimit);
  }

  /**
   * Run admission once.
   * For tests or setups with the worker disabled, where promotion timing is driven by hand.
   */
  async runAdmission(roomId: string): Promise<AdmissionRunResult> {
    return this.admission.runOnce(this.requireRoom(roomId));
  }

  private get pruneLimit(): number {
    return this.options.admission.expiryScanLimit;
  }

  private requireRoom(roomId: string): ResolvedRoomOptions {
    const room = this.options.rooms.get(roomId);
    if (!room) {
      throw new RoomNotRegisteredError(roomId);
    }
    return room;
  }
}
