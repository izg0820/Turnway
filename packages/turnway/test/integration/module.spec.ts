import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, RoomConfigConflictError } from '../../src/errors';
import type { TurnwayModuleOptions } from '../../src/types/options';
import { RedisConnectionRef } from '../../src/redis/redis-connection';
import { TurnwayModule, type TurnwayOptionsFactory } from '../../src/turnway.module';
import { TurnwayService } from '../../src/turnway.service';
import {
  deleteKeys,
  REDIS_URL,
  silentLogger,
  TEST_ROOM_ID,
  testRoom,
  waitForReady,
} from './harness';

function moduleOptions(overrides: Partial<TurnwayModuleOptions> = {}): TurnwayModuleOptions {
  return {
    redis: { url: REDIS_URL },
    rooms: [testRoom()],
    keyPrefix: `turnway-module-${randomUUID().slice(0, 8)}`,
    admission: { enabled: false },
    logger: silentLogger(),
    ...overrides,
  };
}

describe('Phase 01 — 모듈 등록과 설정 검증', () => {
  it('잘못된 설정은 초기화 단계에서 실패', async () => {
    const build = Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ rooms: [testRoom({ capacity: 0 })] }))],
    }).compile();

    await expect(build).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('대기열 설정이 이미 다르게 적용돼 있으면 초기화 실패', async () => {
    const keyPrefix = `turnway-conflict-${randomUUID().slice(0, 8)}`;
    const first = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix }))],
    }).compile();
    await first.init();

    const second = await Test.createTestingModule({
      imports: [
        TurnwayModule.forRoot(
          moduleOptions({ keyPrefix, rooms: [testRoom({ capacity: 5 })] }),
        ),
      ],
    }).compile();

    try {
      const error = await second.init().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RoomConfigConflictError);
      expect((error as RoomConfigConflictError).details).toMatchObject({ roomId: TEST_ROOM_ID });
    } finally {
      const cleanup = new Redis(REDIS_URL);
      await deleteKeys(cleanup, keyPrefix);
      await cleanup.quit();
      // close() on a module whose init failed rethrows the same error, so only clean up
      await second.close().catch(() => undefined);
      await first.close();
    }
  });

  it('같은 설정으로 여러 인스턴스를 띄우는 것은 허용', async () => {
    const keyPrefix = `turnway-same-${randomUUID().slice(0, 8)}`;
    const first = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix }))],
    }).compile();
    const second = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix }))],
    }).compile();

    await first.init();
    await expect(second.init()).resolves.toBeDefined();

    const cleanup = new Redis(REDIS_URL);
    await deleteKeys(cleanup, keyPrefix);
    await cleanup.quit();
    await second.close();
    await first.close();
  });
});

describe('Phase 01 — 연결 소유권', () => {
  it('라이브러리가 만든 연결은 모듈 종료 시 정리', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions())],
    }).compile();
    await moduleRef.init();

    const connection = moduleRef.get(RedisConnectionRef);
    expect(connection.owned).toBe(true);
    expect(connection.client.status).toBe('ready');

    await moduleRef.close();

    expect(connection.client.status).toBe('end');
  });

  it('초기화가 실패해도 소유한 연결을 남기지 않음', async () => {
    // Arrange: register a different capacity for the same room so init fails
    const keyPrefix = `turnway-init-fail-${randomUUID().slice(0, 8)}`;
    const first = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix }))],
    }).compile();
    await first.init();

    const second = await Test.createTestingModule({
      imports: [
        TurnwayModule.forRoot(moduleOptions({ keyPrefix, rooms: [testRoom({ capacity: 5 })] })),
      ],
    }).compile();
    const connection = second.get(RedisConnectionRef);

    // Act
    await expect(second.init()).rejects.toBeInstanceOf(RoomConfigConflictError);

    // Assert: the shutdown hook is never reached, so the init path must close it
    expect(connection.client.status).toBe('end');

    const cleanup = new Redis(REDIS_URL);
    await deleteKeys(cleanup, keyPrefix);
    await cleanup.quit();
    await second.close().catch(() => undefined);
    await first.close();
  });

  it('외부에서 주입한 연결은 모듈 종료 후에도 유지', async () => {
    const client = await waitForReady(new Redis(REDIS_URL));
    const moduleRef = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ redis: { client } }))],
    }).compile();
    await moduleRef.init();

    const connection = moduleRef.get(RedisConnectionRef);
    expect(connection.owned).toBe(false);

    await moduleRef.close();

    expect(client.status).not.toBe('end');
    await expect(client.ping()).resolves.toBe('PONG');
    await client.quit();
  });
});

describe('Phase 01 — 클라이언트 키 접두사', () => {
  it('주입한 연결의 keyPrefix 가 다르면 대기열 전체가 분리', async () => {
    // Arrange: same room id and keyPrefix, only the client prefix differs
    const keyPrefix = `turnway-client-prefix-${randomUUID().slice(0, 8)}`;
    const clientA = await waitForReady(new Redis(REDIS_URL, { keyPrefix: 'tenant-a:' }));
    const clientB = await waitForReady(new Redis(REDIS_URL, { keyPrefix: 'tenant-b:' }));

    const moduleA = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix, redis: { client: clientA } }))],
    }).compile();
    const moduleB = await Test.createTestingModule({
      imports: [TurnwayModule.forRoot(moduleOptions({ keyPrefix, redis: { client: clientB } }))],
    }).compile();

    try {
      await moduleA.init();
      await moduleB.init();

      // Act: join as the same user from both instances
      const passA = await moduleA.get(TurnwayService).join(TEST_ROOM_ID, 'user-1');
      const passB = await moduleB.get(TurnwayService).join(TEST_ROOM_ID, 'user-1');

      // Assert: passes and user mappings are separated, so neither touches the other's state
      expect(passB.passId).not.toBe(passA.passId);

      const stillWaiting = await moduleA
        .get(TurnwayService)
        .check(TEST_ROOM_ID, 'user-1', passA.passId);
      expect(stillWaiting.state).toBe('WAITING');
    } finally {
      await moduleB.close().catch(() => undefined);
      await moduleA.close().catch(() => undefined);

      const cleanup = new Redis(REDIS_URL);
      await deleteKeys(cleanup, `tenant-a:${keyPrefix}`);
      await deleteKeys(cleanup, `tenant-b:${keyPrefix}`);
      await cleanup.quit();
      await clientA.quit();
      await clientB.quit();
    }
  });
});

describe('Phase 01 — 비동기 등록', () => {
  it('useFactory 로 옵션을 주입', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TurnwayModule.forRootAsync({
          useFactory: () => moduleOptions(),
        }),
      ],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(TurnwayService);
    expect(service.roomIds).toEqual([TEST_ROOM_ID]);

    await moduleRef.close();
  });

  it('inject 로 넘긴 토큰이 순서대로 useFactory 인자가 됨', async () => {
    // Arrange: two providers the factory must receive in order
    const PREFIX = Symbol('PREFIX');

    @Module({
      providers: [
        { provide: PREFIX, useValue: `turnway-inject-${randomUUID().slice(0, 8)}` },
        { provide: 'CAPACITY', useValue: 7 },
      ],
      exports: [PREFIX, 'CAPACITY'],
    })
    class SettingsModule {}

    let received: unknown[] = [];

    const moduleRef = await Test.createTestingModule({
      imports: [
        TurnwayModule.forRootAsync({
          imports: [SettingsModule],
          inject: [PREFIX, 'CAPACITY'],
          useFactory: (keyPrefix: string, capacity: number) => {
            received = [keyPrefix, capacity];
            return moduleOptions({ keyPrefix, rooms: [testRoom({ capacity })] });
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    // Assert
    expect(received).toEqual([expect.stringContaining('turnway-inject-'), 7]);

    const service = moduleRef.get(TurnwayService);
    expect((await service.stats(TEST_ROOM_ID)).capacity).toBe(7);

    const cleanup = new Redis(REDIS_URL);
    await deleteKeys(cleanup, received[0] as string);
    await cleanup.quit();
    await moduleRef.close();
  });

  it('useClass 로 옵션 팩토리를 주입', async () => {
    class OptionsProvider implements TurnwayOptionsFactory {
      createTurnwayOptions(): TurnwayModuleOptions {
        return moduleOptions();
      }
    }

    @Module({ providers: [OptionsProvider], exports: [OptionsProvider] })
    class OptionsModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        TurnwayModule.forRootAsync({
          imports: [OptionsModule],
          useExisting: OptionsProvider,
        }),
      ],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(TurnwayService);
    expect(await service.stats(TEST_ROOM_ID)).toMatchObject({ waiting: 0, admitted: 0 });

    await moduleRef.close();
  });

  it('옵션 제공 방법이 없으면 등록 자체를 거부', () => {
    expect(() => TurnwayModule.forRootAsync({})).toThrow(/useFactory/);
  });
});
