/** Pass state names */
export type WaitingRoomState = 'WAITING' | 'ADMITTED' | 'LEFT' | 'EXPIRED';

/** Identity fields shared by every state */
export interface WaitingPassIdentity {
  /** Room id */
  roomId: string;
  /** User id, authenticated by the calling application */
  userId: string;
  /** Pass id issued on join */
  passId: string;
  /** Monotonic sequence number issued by Redis */
  sequence: number;
  /** Join time in epoch ms, taken from Redis TIME */
  joinedAt: number;
}

/** Waiting in the queue */
export interface WaitingStatus extends WaitingPassIdentity {
  state: 'WAITING';
  /**
   * Queue position, starting at 1.
   * Expired passes not yet pruned may sit ahead, so this is an upper bound on the real position.
   */
  position: number;
  /** Waiting pass expiry in epoch ms */
  expiresAt: number;
}

/** A live admitted session occupying one slot until expiry or departure */
export interface AdmittedStatus extends WaitingPassIdentity {
  state: 'ADMITTED';
  /** Admission time in epoch ms */
  admittedAt: number;
  /** Current session expiry in epoch ms, extendable by heartbeat */
  expiresAt: number;
  /** Hard deadline from first admission. A heartbeat cannot push past it */
  sessionEndsAt: number;
}

/** Terminal state after the user cancelled or left */
export interface LeftStatus extends WaitingPassIdentity {
  state: 'LEFT';
  /** End time in epoch ms */
  endedAt: number;
}

/** Terminal state after the lifetime elapsed */
export interface ExpiredStatus extends WaitingPassIdentity {
  state: 'EXPIRED';
  /** Time the pass was judged expired, in epoch ms */
  endedAt: number;
}

/** Pass status, discriminated by the state field */
export type WaitingRoomStatus = WaitingStatus | AdmittedStatus | LeftStatus | ExpiredStatus;

/** Whether the state is terminal */
export function isTerminal(status: WaitingRoomStatus): status is LeftStatus | ExpiredStatus {
  return status.state === 'LEFT' || status.state === 'EXPIRED';
}

/** Room occupancy stats */
export interface WaitingRoomStats {
  roomId: string;
  /** Live waiting count, based on the expiry index */
  waiting: number;
  /** Live admitted count, based on the expiry index */
  admitted: number;
  /** Configured concurrent admission limit */
  capacity: number;
  /** Remaining capacity */
  availableSlots: number;
}

/** Result of one admission run */
export interface AdmissionRunResult {
  roomId: string;
  /** Users admitted in this run */
  admitted: number;
  /** Expired or stale entries cleaned up in this run, including queue-head cleanup */
  expired: number;
  /** Capacity left after the run */
  availableSlots: number;
}
