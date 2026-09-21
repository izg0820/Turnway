import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cluster } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnway, type Turnway } from '../../src/standalone';
import { NotAdmittedError, PassOwnerMismatchError, RoomConfigConflictError, StorageFailureError } from '../../src/errors';

const startupNodes = [6401, 6402, 6403].map((port) => ({ host: '127.0.0.1', port }));
const handles: Turnway[] = [];
const clients: Cluster[] = [];
const prefixes: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  const cleanup = new Cluster(startupNodes);
  try {
    await cleanup.ping();
    for (const prefix of prefixes.splice(0)) {
      for (const node of cleanup.nodes('master')) {
        let cursor = '0';
        do {
          const [next, keys] = await node.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = next;
          // Delete keys individually to avoid cross-slot commands
          await Promise.all(keys.map((key) => cleanup.del(key)));
        } while (cursor !== '0');
      }
    }
  } finally {
    cleanup.disconnect();
    for (const client of clients.splice(0)) client.disconnect();
  }
});

describe('Redis Cluster', () => {
  it('fails initialization when all startup nodes are unavailable', async () => {
    await expect(createTurnway({
      redis: { startupNodes: [{ host: '127.0.0.1', port: 1 }], options: { redisOptions: { connectTimeout: 100 } } },
      rooms: [{ roomId: 'unavailable', capacity: 1 }],
      admission: { enabled: false },
    })).rejects.toBeInstanceOf(StorageFailureError);
  });

  it('preserves FIFO admission, capacity, ownership, and session lifecycle across distributed rooms', async () => {
    const keyPrefix = `cluster-test-${randomUUID()}`;
    prefixes.push(keyPrefix);
    const client = new Cluster(startupNodes);
    clients.push(client);
    const rooms = Array.from({ length: 30 }, (_, i) => ({ roomId: `room-${i}`, capacity: 2 }));
    const handle = await createTurnway({ redis: { client }, keyPrefix, rooms, admission: { enabled: false } });
    handles.push(handle);
    const { service } = handle;
    await Promise.all(rooms.map(async ({ roomId }) => {
      const first = await service.join(roomId, 'first');
      const second = await service.join(roomId, 'second');
      const third = await service.join(roomId, 'third');
      expect((await service.join(roomId, 'first')).passId).toBe(first.passId);
      await expect(service.check(roomId, 'other', first.passId)).rejects.toBeInstanceOf(PassOwnerMismatchError);
      const runs = await Promise.all(Array.from({ length: 4 }, () => service.runAdmission(roomId)));
      expect(runs.reduce((sum, run) => sum + run.admitted, 0)).toBe(2);
      await expect(service.assertAdmitted(roomId, 'first', first.passId)).resolves.toMatchObject({ state: 'ADMITTED' });
      await expect(service.assertAdmitted(roomId, 'second', second.passId)).resolves.toMatchObject({ state: 'ADMITTED' });
      await expect(service.assertAdmitted(roomId, 'third', third.passId)).rejects.toBeInstanceOf(NotAdmittedError);
      expect((await service.heartbeat(roomId, 'first', first.passId)).state).toBe('ADMITTED');
      expect((await service.heartbeat(roomId, 'third', third.passId)).state).toBe('WAITING');
      await service.leave(roomId, 'first', first.passId);
      expect((await service.runAdmission(roomId)).admitted).toBe(1);
      expect(await service.stats(roomId)).toMatchObject({ waiting: 0, admitted: 2 });
    }));
    const perMaster = await Promise.all(client.nodes('master').map((node) => node.keys(`${keyPrefix}:*:config`)));
    expect(perMaster).toHaveLength(3);
    expect(perMaster.every((keys) => keys.length > 0)).toBe(true);
    expect(perMaster.flat()).toHaveLength(30);
    await handle.close();
    await expect(client.ping()).resolves.toBe('PONG');
  });

  it('handles config conflicts and expiration with an owned Cluster', async () => {
    const keyPrefix = `cluster-test-${randomUUID()}`;
    prefixes.push(keyPrefix);
    const options = {
      redis: { startupNodes }, keyPrefix,
      rooms: [{ roomId: 'expiry', capacity: 1, waitingTtlMs: 100, sessionTtlMs: 100 }],
      admission: { enabled: false },
    };
    const handle = await createTurnway(options);
    handles.push(handle);
    const pass = await handle.service.join('expiry', 'user');
    await handle.service.runAdmission('expiry');
    await sleep(150);
    expect((await handle.service.check('expiry', 'user', pass.passId)).state).toBe('EXPIRED');
    expect(await handle.service.stats('expiry')).toMatchObject({ waiting: 0, admitted: 0 });
    await expect(createTurnway({ ...options, rooms: [{ ...options.rooms[0]!, capacity: 2 }] }))
      .rejects.toBeInstanceOf(RoomConfigConflictError);
  });

  it('applies the injected Cluster keyPrefix to dynamic Lua keys', async () => {
    const prefix = `injected-${randomUUID()}:`;
    prefixes.push(prefix);
    const client = new Cluster(startupNodes, { redisOptions: { keyPrefix: prefix } });
    clients.push(client);
    const handle = await createTurnway({ redis: { client }, rooms: [{ roomId: 'prefix', capacity: 1 }], admission: { enabled: false } });
    handles.push(handle);
    const pass = await handle.service.join('prefix', 'user');
    expect((await handle.service.check('prefix', 'user', pass.passId)).passId).toBe(pass.passId);
    expect((await handle.service.runAdmission('prefix')).admitted).toBe(1);
    await expect(handle.service.assertAdmitted('prefix', 'user', pass.passId)).resolves.toMatchObject({ state: 'ADMITTED' });
  });
});
