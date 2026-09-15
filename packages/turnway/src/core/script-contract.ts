import type { ScriptName } from '../redis/script-loader';
import type {
  RawAdmissionPayload,
  RawConfigPayload,
  RawFailurePayload,
  RawStatsPayload,
  RawStatusPayload,
} from './raw-payload';

/** A script that reports pass state, or fails with a domain code */
type StatusReply = RawStatusPayload | RawFailurePayload;

/**
 * ARGV and reply contract of every Lua script.
 *
 * Each entry mirrors the `-- ARGV:` header of the matching file in `src/lua`.
 * Changing one side means changing the other — the type only binds the
 * TypeScript callers, so a Lua edit still needs the integration tests.
 */
export interface ScriptContract {
  join: {
    args: [
      prefix: string,
      userId: string,
      passId: string,
      waitingTtlMs: number,
      retentionMs: number,
      pruneLimit: number,
    ];
    reply: StatusReply;
  };
  check: {
    args: [
      prefix: string,
      userId: string,
      passId: string,
      retentionMs: number,
      pruneLimit: number,
    ];
    reply: StatusReply;
  };
  heartbeat: {
    args: [
      prefix: string,
      userId: string,
      passId: string,
      waitingTtlMs: number,
      sessionTtlMs: number,
      retentionMs: number,
      pruneLimit: number,
    ];
    reply: StatusReply;
  };
  leave: {
    args: [prefix: string, userId: string, passId: string, retentionMs: number];
    reply: StatusReply;
  };
  verify: {
    args: [prefix: string, userId: string, passId: string];
    reply: StatusReply;
  };
  promote: {
    args: [
      prefix: string,
      capacity: number,
      sessionTtlMs: number,
      maxSessionDurationMs: number,
      retentionMs: number,
      batchSize: number,
      pruneLimit: number,
    ];
    reply: RawAdmissionPayload;
  };
  stats: {
    args: [prefix: string, capacity: number, retentionMs: number, pruneLimit: number];
    reply: RawStatsPayload;
  };
  /** Field/value pairs, so the argument count varies with the config */
  'register-config': {
    args: Array<string | number>;
    reply: RawConfigPayload | RawFailurePayload;
  };
}

/** Compile-time check that every registered script has a contract entry */
type AssertComplete = ScriptName extends keyof ScriptContract ? true : never;
const _complete: AssertComplete = true;
void _complete;

export type ScriptArgs<K extends ScriptName> = ScriptContract[K]['args'];
export type ScriptReply<K extends ScriptName> = ScriptContract[K]['reply'];
