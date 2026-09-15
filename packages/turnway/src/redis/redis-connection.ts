import { Redis, type RedisOptions } from 'ioredis';
import type { RedisConnectionOptions } from '../types/options';

/**
 * Redis connection and its ownership.
 * Only a connection the library created is closed on shutdown; an injected one stays with the caller.
 */
export class RedisConnectionRef {
  constructor(
    readonly client: Redis,
    readonly owned: boolean,
  ) {}

  /**
   * Close only an owned connection. An injected one is left untouched.
   * Waits for the socket to actually close so no open handle is left behind.
   */
  async close(timeoutMs = 2_000): Promise<void> {
    if (!this.owned) return;
    if (this.client.status === 'end') return;

    const closed = this.waitForEnd(timeoutMs);

    try {
      await this.client.quit();
    } catch {
      // An already broken connection only needs its handle torn down
      this.client.disconnect();
    }

    await closed;
  }

  /** Wait for the 'end' event. Force a disconnect once the timeout passes */
  private waitForEnd(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.client.status === 'end') {
        resolve();
        return;
      }

      const finish = (): void => {
        clearTimeout(timer);
        this.client.removeListener('end', finish);
        resolve();
      };

      const timer = setTimeout(() => {
        this.client.disconnect();
        finish();
      }, timeoutMs);
      timer.unref?.();

      this.client.once('end', finish);
    });
  }
}

/** Create a connection or reuse the injected one, depending on the options */
export function createRedisConnection(options: RedisConnectionOptions): RedisConnectionRef {
  if ('client' in options && options.client) {
    return new RedisConnectionRef(options.client, false);
  }

  // A lower retry count so a storage failure is not held onto for long. Callers may override it
  const defaults: RedisOptions = { maxRetriesPerRequest: 3 };

  if ('url' in options && options.url) {
    return new RedisConnectionRef(new Redis(options.url, { ...defaults, ...options.options }), true);
  }

  const optionsOnly = options as { options: RedisOptions };
  return new RedisConnectionRef(new Redis({ ...defaults, ...optionsOnly.options }), true);
}
