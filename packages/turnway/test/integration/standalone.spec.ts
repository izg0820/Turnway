import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTurnway, type Turnway } from '../../src/standalone';
import { deleteKeys, REDIS_URL, silentLogger, TEST_ROOM_ID, testRoom } from './harness';

describe('Phase 01 — usage without NestJS', () => {
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

  it('works from join to leave without the module', async () => {

    const pass = await room.service.join(TEST_ROOM_ID, 'user-1');
    const checked = await room.service.check(TEST_ROOM_ID, 'user-1', pass.passId);
    await room.service.runAdmission(TEST_ROOM_ID);
    const admitted = await room.service.assertAdmitted(TEST_ROOM_ID, 'user-1', pass.passId);
    const left = await room.service.leave(TEST_ROOM_ID, 'user-1', pass.passId);

    expect(checked.state).toBe('WAITING');
    expect(admitted.state).toBe('ADMITTED');
    expect(left.state).toBe('LEFT');
  });

  it('room configuration is registered by the time it resolves', async () => {
    const probe = new Redis(REDIS_URL);
    const config = await probe.hgetall(`${keyPrefix}:{${TEST_ROOM_ID}}:config`);
    await probe.quit();

    expect(config.capacity).toBe(String(testRoom().capacity));
  });

  it('close() also closes the owned connection', async () => {
    await room.close();

    // Calling it again after it is already closed must not throw
    await expect(room.close()).resolves.toBeUndefined();
  });
});

describe('Phase 01 — standalone entry point dependencies', () => {
  it('loads no @nestjs packages', () => {
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
