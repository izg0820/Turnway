import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { TurnwayModule } from '../../src/turnway.module';
import { TurnwayService } from '../../src/turnway.service';
import type { RoomOptions, TurnwayModuleOptions } from '../../src/types/options';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';

export const TEST_ROOM_ID = 'test-room';

/** Default room for integration tests. Short TTLs reproduce expiry boundaries quickly */
export function testRoom(overrides: Partial<RoomOptions> = {}): RoomOptions {
  return {
    roomId: TEST_ROOM_ID,
    capacity: 2,
    waitingTtlMs: 2_000,
    sessionTtlMs: 2_000,
    maxSessionDurationMs: 10_000,
    finishedRetentionMs: 2_000,
    ...overrides,
  };
}

export interface Harness {
  moduleRef: TestingModule;
  service: TurnwayService;
  keyPrefix: string;
  redis: Redis;
  close(): Promise<void>;
}

/** Boot a NestJS module with a key prefix unique to each test */
export async function createHarness(
  overrides: Partial<TurnwayModuleOptions> = {},
): Promise<Harness> {
  // Pass a prefix to reproduce several instances sharing one room
  const keyPrefix = overrides.keyPrefix ?? `turnway-test-${randomUUID().slice(0, 8)}`;

  const moduleRef = await Test.createTestingModule({
    imports: [
      TurnwayModule.forRoot({
        redis: { url: REDIS_URL },
        rooms: [testRoom()],
        keyPrefix,
        // The test drives promotion timing itself
        admission: { enabled: false, intervalMs: 50, batchSize: 10, expiryScanLimit: 50 },
        logger: silentLogger(),
        ...overrides,
      }),
    ],
  }).compile();

  await moduleRef.init();

  const redis = new Redis(REDIS_URL);

  return {
    moduleRef,
    service: moduleRef.get(TurnwayService),
    keyPrefix,
    redis,
    close: async () => {
      await deleteKeys(redis, keyPrefix);
      await redis.quit();
      await moduleRef.close();
    },
  };
}

/** Delete only the keys this test created */
export async function deleteKeys(redis: Redis, keyPrefix: string): Promise<void> {
  const keys = await redis.keys(`${keyPrefix}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export function silentLogger() {
  return { debug: () => undefined, warn: () => undefined, error: () => undefined };
}

/** Wait until the connection can actually accept commands */
export async function waitForReady(client: Redis, timeoutMs = 5_000): Promise<Redis> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      if (client.status === 'end') {
        await client.connect().catch(() => undefined);
      }
      await client.ping();
      return client;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(20);
    }
  }
}

export { sleep };
