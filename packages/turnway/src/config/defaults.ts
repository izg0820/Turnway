import type { ResolvedAdmissionOptions } from '../types/options';

/**
 * These defaults assume local development and testing. Revisit them after load testing.
 */
export const DEFAULT_WAITING_TTL_MS = 60_000;
export const DEFAULT_SESSION_TTL_MS = 60_000;
export const DEFAULT_MAX_SESSION_DURATION_MS = 600_000;
export const DEFAULT_FINISHED_RETENTION_MS = 60_000;
export const DEFAULT_KEY_PREFIX = 'wr';

/**
 * Upper bound on waiting for an in-flight admission run during shutdown.
 * Keeps application shutdown from hanging on a stalled Redis command.
 */
export const DEFAULT_ADMISSION_STOP_TIMEOUT_MS = 5_000;

export const DEFAULT_ADMISSION_OPTIONS: ResolvedAdmissionOptions = {
  enabled: true,
  intervalMs: 1_000,
  batchSize: 50,
  expiryScanLimit: 100,
  maxBackoffMs: 30_000,
};

/** Allowed room id characters, limited to what keeps key layout and hash tags intact */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Max length of a user id or pass id */
export const MAX_ID_LENGTH = 256;
