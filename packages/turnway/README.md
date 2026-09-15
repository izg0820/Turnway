# turnway

A Redis-backed virtual waiting room for Node.js. Users join a queue, the library admits them in
arrival order up to a configured capacity, and your application verifies admission before running
protected work.

Ships a NestJS module and a framework-free entry point, so it also runs on Express, Fastify,
Hono, or a plain script.

> **Status:** the library core is implemented and covered by unit and real-Redis integration
> tests. The browser demo app and the load/failure validation described in the project plan are
> not done yet, and the package is not published to npm.

## Install

```bash
pnpm add turnway ioredis
```

`ioredis` is the only required peer dependency. `@nestjs/common`, `@nestjs/core`, and
`reflect-metadata` are optional peers, needed only for the NestJS entry point.

## Register the module (NestJS)

```ts
import { Module } from '@nestjs/common';
import { TurnwayModule } from 'turnway';

@Module({
  imports: [
    TurnwayModule.forRoot({
      redis: { url: process.env.REDIS_URL! },
      rooms: [{ roomId: 'ticket-sale', capacity: 500 }],
    }),
  ],
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` is available when the options come from another
module. `useClass` / `useExisting` accept a `TurnwayOptionsFactory`.

You can also hand over an existing client with `redis: { client }`. The library closes only the
connections it created; an injected client stays open after the module shuts down.

### Room options

| Option | Default | Meaning |
|---|---|---|
| `capacity` | required | Maximum number of concurrent admitted sessions |
| `waitingTtlMs` | `60000` | How long a waiting pass stays valid without a heartbeat |
| `sessionTtlMs` | `60000` | How long an admitted session stays valid without a heartbeat |
| `maxSessionDurationMs` | `600000` | Hard limit on a session, measured from first admission |
| `finishedRetentionMs` | `60000` | How long finished passes are kept before deletion |

Admission runs as a background job inside the module: `admission: { enabled, intervalMs,
batchSize, expiryScanLimit, maxBackoffMs }`. Turn `enabled` off on instances that should not
promote, and call `runAdmission(roomId)` yourself when you need to control timing.

## Without NestJS

```ts
import { createTurnway } from 'turnway/standalone';

const turnway = await createTurnway({
  redis: { url: process.env.REDIS_URL! },
  rooms: [{ roomId: 'ticket-sale', capacity: 500 }],
});

await turnway.service.join('ticket-sale', userId);

// on shutdown
await turnway.close();
```

`createTurnway()` resolves once the config is registered and the admission worker has started, so
there is no separate start step. It pulls in no NestJS packages. The handle exposes the same
`service` described below.

## Use the service

```ts
import { Injectable } from '@nestjs/common';
import { NotAdmittedError, TurnwayService } from 'turnway';

@Injectable()
export class TicketService {
  constructor(private readonly turnway: TurnwayService) {}

  async enterQueue(userId: string) {
    return this.turnway.join('ticket-sale', userId);
  }

  async reserve(userId: string, passId: string) {
    // Verify admission immediately before the protected work
    await this.turnway.assertAdmitted('ticket-sale', userId, passId);
    return this.doReserve(userId);
  }
}
```

| Method | Returns |
|---|---|
| `join(roomId, userId)` | A new pass, or the caller's existing valid pass |
| `check(roomId, userId, passId)` | Current state, queue position, expiry |
| `heartbeat(roomId, userId, passId)` | Extends a valid session, never revives an expired one |
| `leave(roomId, userId, passId)` | Cancels a wait or ends a session |
| `assertAdmitted(roomId, userId, passId)` | The active session, or throws `NotAdmittedError` |
| `stats(roomId)` | Valid waiting and admitted counts |
| `runAdmission(roomId)` | Runs one admission pass on demand |

State is a discriminated union on `state`: `WAITING`, `ADMITTED`, `LEFT`, `EXPIRED`.

## Errors

Normal waiting and expiry are returned as state, not thrown. Errors are thrown only when the call
itself does not hold. Every error extends `WaitingRoomError` and carries a `code`:

`INVALID_ARGUMENT`, `ROOM_NOT_REGISTERED`, `ROOM_CONFIG_CONFLICT`, `PASS_NOT_FOUND`,
`PASS_OWNER_MISMATCH`, `NOT_ADMITTED`, `STORAGE_FAILURE`.

HTTP status codes and `HttpException` are not part of the public contract — map errors to
responses in your own application.

## What the library does and does not do

The library owns queue order, capacity, duplicate participation, pass ownership, admission state,
and expiry. Your application owns authentication, passing a trusted `userId`, access policy,
transport, and error translation. A `passId` is an identifier, not a credential.

## Current boundaries

- Capacity is measured in active sessions, not requests per second.
- A disconnected user holds a slot until the session expires.
- Admission follows arrival order; bot and multi-account abuse prevention are out of scope.
- Targets a single Redis instance. Redis Cluster is not supported.
- `position` is an upper bound: expired waiters that have not been cleaned up yet can still be
  counted ahead of you.
- Throughput has not been measured. Treat the default timings as starting points.

## Redis requirements

Waiting state is the source of truth, so the instance must not evict it: run with
`maxmemory-policy noeviction`, and enable AOF persistence if you need state to survive a restart.
