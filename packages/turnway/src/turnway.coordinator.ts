import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { TurnwayRuntime } from './core/turnway-runtime';

/**
 * Thin adapter wiring the NestJS lifecycle to the runtime.
 * `TurnwayRuntime` owns the actual order and failure handling.
 */
@Injectable()
export class TurnwayCoordinator implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  constructor(
    @Inject(TurnwayRuntime)
    private readonly runtime: TurnwayRuntime,
  ) {}

  /** Register the config in Redis and start the admission worker */
  async onModuleInit(): Promise<void> {
    await this.runtime.start();
  }

  /** Clear timers and let an in-flight run finish */
  async onModuleDestroy(): Promise<void> {
    await this.runtime.stopWorker();
  }

  /** Close only an owned connection, after the worker has been cleaned up */
  async onApplicationShutdown(): Promise<void> {
    await this.runtime.closeConnection();
  }
}
