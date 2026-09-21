import { Cluster, Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { normalizeOptions } from '../../src/config/normalize-options';
import { InvalidArgumentError } from '../../src/errors';
import { createRedisConnection } from '../../src/redis/redis-connection';
import type { RedisConnectionOptions } from '../../src/types/options';

const nodes = [{ host: '127.0.0.1', port: 7000 }];
const normalize = (redis: RedisConnectionOptions) => normalizeOptions({
  redis, rooms: [{ roomId: 'room-a', capacity: 2 }],
});

describe('Redis Cluster connection', () => {
  it('accepts startup nodes without additional options', () => {
    expect(normalize({ startupNodes: nodes }).redis).toEqual({ startupNodes: nodes });
  });

  it.each([[], null, [false], [[]], [''], ['http://localhost:7000'], [65536],
    [{ host: '', port: 7000 }], [{ host: 'localhost', port: 0 }]])(
    'rejects invalid startup nodes %j', (startupNodes) => {
      expect(() => normalize({ startupNodes } as never)).toThrow(InvalidArgumentError);
    },
  );

  it.each([7000, 'redis://localhost:7000', 'localhost:7000', { port: 7000 }])(
    'accepts supported ioredis startup node %j', (node) => {
      expect(() => normalize({ startupNodes: [node] })).not.toThrow();
    },
  );

  it('rejects conflicting connection sources', () => {
    expect(() => normalize({ startupNodes: nodes, url: 'redis://localhost' } as never))
      .toThrow(InvalidArgumentError);
  });

  it.each([{ keyPrefix: '{all}:' }, { redisOptions: { keyPrefix: '{all}:' } }])(
    'rejects client prefixes masking room slots %j', (options) => {
      expect(() => normalize({ startupNodes: nodes, options })).toThrow(InvalidArgumentError);
    },
  );

  it('creates and closes an owned cluster', async () => {
    const ref = createRedisConnection({ startupNodes: nodes, options: { lazyConnect: true } });
    expect(ref.client).toBeInstanceOf(Cluster);
    expect(ref.owned).toBe(true);
    await ref.close();
    expect(ref.client.status).toBe('end');
  });

  it('bounds cluster reconnect attempts by default', async () => {
    const ref = createRedisConnection({ startupNodes: nodes, options: { lazyConnect: true } });
    try {
      expect(ref.client).toBeInstanceOf(Cluster);
      if (!(ref.client instanceof Cluster)) throw new Error('Expected Cluster');
      const retry = ref.client.options.clusterRetryStrategy!;
      expect(retry(4)).toBeNull();
      expect(retry(1)).toBe(100);
      expect(retry(3)).toBe(300);
    } finally {
      await ref.close();
    }
  });

  it('preserves caller cluster reconnect policy', async () => {
    const retry = () => 5_000;
    const ref = createRedisConnection({
      startupNodes: nodes,
      options: { lazyConnect: true, clusterRetryStrategy: retry },
    });
    try {
      expect(ref.client).toBeInstanceOf(Cluster);
      if (!(ref.client instanceof Cluster)) throw new Error('Expected Cluster');
      expect(ref.client.options.clusterRetryStrategy).toBe(retry);
    } finally {
      await ref.close();
    }
  });

  it('keeps injected clusters open', async () => {
    const client = new Cluster(nodes, { lazyConnect: true });
    try {
      normalize({ client });
      const quit = vi.spyOn(client, 'quit');
      const disconnect = vi.spyOn(client, 'disconnect');
      const ref = createRedisConnection({ client });
      expect(ref.client).toBe(client);
      await ref.close();
      expect(quit).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      client.disconnect();
    }
  });

  it('rejects an injected cluster with a shared hash tag', () => {
    const client = new Cluster(nodes, { lazyConnect: true, keyPrefix: '{all}:' });
    try {
      expect(() => normalize({ client })).toThrow(InvalidArgumentError);
    } finally {
      client.disconnect();
    }
  });

  it('preserves standalone client prefixes', async () => {
    const ref = createRedisConnection({ options: { lazyConnect: true, keyPrefix: '{all}:' } });
    expect(ref.client).toBeInstanceOf(Redis);
    expect(() => normalize({ client: ref.client })).not.toThrow();
    await ref.close();
  });
});
