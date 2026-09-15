import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import { AdmissionRunner } from './admission/admission-runner';
import { normalizeOptions } from './config/normalize-options';
import {
  TURNWAY_LOGGER,
  TURNWAY_OPTIONS,
  TURNWAY_RESOLVED_OPTIONS,
} from './constants';
import { TurnwayRuntime } from './core/turnway-runtime';
import { TurnwayStore } from './core/turnway.store';
import { createDefaultLogger } from './logger';
import { createRedisConnection, RedisConnectionRef } from './redis/redis-connection';
import { defineScripts } from './redis/script-loader';
import type {
  ResolvedTurnwayOptions,
  WaitingRoomLogger,
  TurnwayModuleOptions,
} from './types/options';
import { TurnwayCoordinator } from './turnway.coordinator';
import { TurnwayService } from './turnway.service';

/** Contract for a class that supplies options during async registration */
export interface TurnwayOptionsFactory {
  createTurnwayOptions(): Promise<TurnwayModuleOptions> | TurnwayModuleOptions;
}

/** Options for `forRootAsync()` */
export interface TurnwayModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  /** Tokens resolved and passed to `useFactory`, in order */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /**
   * Factory arguments come from `inject` and cannot be correlated with it in the type system,
   * so they are typed the same way Nest types its own factory providers.
   */
  useFactory?: (...args: any[]) => Promise<TurnwayModuleOptions> | TurnwayModuleOptions;
  useClass?: Type<TurnwayOptionsFactory>;
  useExisting?: Type<TurnwayOptionsFactory>;
  /** Register the module globally */
  isGlobal?: boolean;
}

function coreProviders(): Provider[] {
  return [
    {
      provide: TURNWAY_RESOLVED_OPTIONS,
      useFactory: (options: TurnwayModuleOptions): ResolvedTurnwayOptions =>
        normalizeOptions(options),
      inject: [TURNWAY_OPTIONS],
    },
    {
      provide: TURNWAY_LOGGER,
      useFactory: (options: ResolvedTurnwayOptions): WaitingRoomLogger =>
        options.logger ?? createDefaultLogger(),
      inject: [TURNWAY_RESOLVED_OPTIONS],
    },
    {
      provide: RedisConnectionRef,
      useFactory: (options: ResolvedTurnwayOptions): RedisConnectionRef => {
        const connection = createRedisConnection(options.redis);
        defineScripts(connection.client);
        return connection;
      },
      inject: [TURNWAY_RESOLVED_OPTIONS],
    },
    {
      provide: TurnwayStore,
      useFactory: (
        connection: RedisConnectionRef,
        options: ResolvedTurnwayOptions,
      ): TurnwayStore => new TurnwayStore(connection.client, options.keyPrefix),
      inject: [RedisConnectionRef, TURNWAY_RESOLVED_OPTIONS],
    },
    {
      provide: AdmissionRunner,
      useFactory: (
        store: TurnwayStore,
        options: ResolvedTurnwayOptions,
        logger: WaitingRoomLogger,
      ): AdmissionRunner => new AdmissionRunner(store, options.rooms, options.admission, logger),
      inject: [TurnwayStore, TURNWAY_RESOLVED_OPTIONS, TURNWAY_LOGGER],
    },
    {
      provide: TurnwayRuntime,
      useFactory: (
        options: ResolvedTurnwayOptions,
        store: TurnwayStore,
        runner: AdmissionRunner,
        connection: RedisConnectionRef,
        logger: WaitingRoomLogger,
      ): TurnwayRuntime =>
        new TurnwayRuntime(options, store, runner, connection, logger),
      inject: [
        TURNWAY_RESOLVED_OPTIONS,
        TurnwayStore,
        AdmissionRunner,
        RedisConnectionRef,
        TURNWAY_LOGGER,
      ],
    },
    {
      provide: TurnwayService,
      useFactory: (
        options: ResolvedTurnwayOptions,
        store: TurnwayStore,
        runner: AdmissionRunner,
      ): TurnwayService => new TurnwayService(options, store, runner),
      inject: [TURNWAY_RESOLVED_OPTIONS, TurnwayStore, AdmissionRunner],
    },
    TurnwayCoordinator,
  ];
}

const EXPORTED_PROVIDERS = [TurnwayService, TURNWAY_RESOLVED_OPTIONS];

/**
 * Waiting system module.
 * Register the Redis connection and room configuration through `forRoot()` or `forRootAsync()`.
 */
@Module({})
export class TurnwayModule {
  /** Synchronous registration */
  static forRoot(options: TurnwayModuleOptions & { isGlobal?: boolean }): DynamicModule {
    return {
      module: TurnwayModule,
      global: options.isGlobal ?? false,
      providers: [{ provide: TURNWAY_OPTIONS, useValue: options }, ...coreProviders()],
      exports: EXPORTED_PROVIDERS,
    };
  }

  /** Async registration, for options injected from a config module */
  static forRootAsync(options: TurnwayModuleAsyncOptions): DynamicModule {
    return {
      module: TurnwayModule,
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      providers: [...asyncOptionsProviders(options), ...coreProviders()],
      exports: EXPORTED_PROVIDERS,
    };
  }
}

function asyncOptionsProviders(options: TurnwayModuleAsyncOptions): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: TURNWAY_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
    ];
  }

  const factoryType = options.useExisting ?? options.useClass;
  if (!factoryType) {
    throw new Error(
      'TurnwayModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
    );
  }

  const providers: Provider[] = [
    {
      provide: TURNWAY_OPTIONS,
      useFactory: (factory: TurnwayOptionsFactory) => factory.createTurnwayOptions(),
      inject: [factoryType],
    },
  ];

  if (options.useClass) {
    providers.push({ provide: options.useClass, useClass: options.useClass });
  }
  return providers;
}
