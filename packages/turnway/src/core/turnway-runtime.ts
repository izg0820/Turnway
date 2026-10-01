import type { AdmissionRunner } from '../admission/admission-runner';
import type { RedisConnectionRef } from '../redis/redis-connection';
import type { ResolvedTurnwayOptions, WaitingRoomLogger } from '../types/options';
import type { TurnwayStore } from './turnway.store';

/**
 * Lifecycle hooks without a NestJS runtime dependency.
 * Shares the startup and shutdown order between the NestJS module and the standalone factory.
 */
export class TurnwayRuntime {
  constructor(
    private readonly options: ResolvedTurnwayOptions,
    private readonly store: TurnwayStore,
    private readonly runner: AdmissionRunner,
    private readonly connection: RedisConnectionRef,
    private readonly logger: WaitingRoomLogger,
  ) {}

  /** Register the config, then start admission. On failure the owned connection is cleaned up and the error propagates */
  async onModuleInit(): Promise<void> {
    try {
      for (const room of this.options.rooms.values()) {
        const { applied } = await this.store.registerConfig(room);
        this.logger.debug('waiting room registered', {
          roomId: room.roomId,
          capacity: room.capacity,
          configWritten: applied,
        });
      }

      this.runner.start();
    } catch (error) {
      // A failed start never reaches the shutdown path, so the owned connection is closed here
      await this.cleanupAfterFailedStart();
      throw error;
    }
  }

  /** Stop the admission worker only */
  async onModuleDestroy(): Promise<void> {
    await this.runner.stop();
  }

  /** Close only an owned connection */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }

  /** Stop the worker, then close the connection */
  async stop(): Promise<void> {
    await this.onModuleDestroy();
    await this.onApplicationShutdown();
  }

  /**
   * Cleanup for the failed-start path.
   * Errors during cleanup are logged and swallowed so the original failure stays visible.
   */
  private async cleanupAfterFailedStart(): Promise<void> {
    try {
      await this.onModuleDestroy();
    } catch (error) {
      this.logger.error('admission runner cleanup failed during start rollback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.onApplicationShutdown();
    } catch (error) {
      this.logger.error('redis connection cleanup failed during start rollback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
