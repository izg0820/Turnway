import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTurnway, type Turnway } from '../../src/standalone';
import { deleteKeys, REDIS_URL, silentLogger, TEST_ROOM_ID, testRoom } from './harness';

describe('Phase 01 — NestJS 없이 사용', () => {
  let room: Turnway;
  let keyPrefix: string;

  beforeEach(async () => {
    keyPrefix = `turnway-standalone-${randomUUID().slice(0, 8)}`;
    room = await createTurnway({
      redis: { url: REDIS_URL },
      rooms: [testRoom()],
      keyPrefix,
      admission: { enabled: false },
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    await room.close();
    const cleanup = new Redis(REDIS_URL);
    await deleteKeys(cleanup, keyPrefix);
    await cleanup.quit();
  });

  it('참여부터 퇴장까지 모듈 없이 동작', async () => {
    // Arrange & Act
    const pass = await room.service.join(TEST_ROOM_ID, 'user-1');
    const checked = await room.service.check(TEST_ROOM_ID, 'user-1', pass.passId);
    await room.service.runAdmission(TEST_ROOM_ID);
    const admitted = await room.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);
    const left = await room.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    // Assert
    expect(checked.state).toBe('WAITING');
    expect(admitted.state).toBe('ADMITTED');
    expect(left.state).toBe('LEFT');
  });

  it('반환 시점에 설정 등록이 끝나 있음', async () => {
    const probe = new Redis(REDIS_URL);
    const config = await probe.hgetall(`${keyPrefix}:{${TEST_ROOM_ID}}:config`);
    await probe.quit();

    expect(config.capacity).toBe(String(testRoom().capacity));
  });

  it('close() 는 소유한 연결까지 정리', async () => {
    await room.close();

    // Calling it again after it is already closed must not throw
    await expect(room.close()).resolves.toBeUndefined();
  });
});

describe('Phase 01 — standalone 진입점의 의존성', () => {
  it('@nestjs 패키지를 하나도 로드하지 않음', () => {
    // Load the build output in a separate process to inspect the real require graph
    const script = `
      require('./dist/standalone.js');
      const nest = Object.keys(require.cache).filter((p) => p.includes('node_modules/@nestjs'));
      process.stdout.write(String(nest.length));
    `;
    const loaded = execFileSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(loaded).toBe('0');
  });
});
