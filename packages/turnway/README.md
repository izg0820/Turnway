# turnway

A Redis-backed virtual waiting room for Node.js. Users join a queue, the library admits them in
arrival order up to a configured capacity, and your application verifies admission before running
protected work.

Ships a NestJS module and a framework-free entry point, so it also runs on Express, Fastify,
Hono, or a plain script.

> **Status:** the library core is implemented and covered by unit and real-Redis integration
> tests. A browser demo and load/failure validation are not yet available, and the package is
> not published to npm.

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

### Heartbeats and expiry

A waiting pass expires 60 seconds after joining by default. Each heartbeat renews that TTL;
`check()` only reads status and does not extend it. If heartbeats stop, for example after a browser
tab closes, the pass expires and the user loses their place. Rejoining after expiry creates a new
pass at the back of the queue.

After admission, heartbeats extend `sessionTtlMs` without exceeding `maxSessionDurationMs`,
measured from the first admission. Heartbeats cannot revive an expired pass. Use `leave()` to
cancel a wait or release an admitted session early.

Expired admitted sessions stop counting toward capacity immediately. Redis data cleanup is
bounded per operation; pending deletion does not hold a slot. Expired waiting entries can still
affect the reported queue position until cleaned up.

Choose a heartbeat interval shorter than the applicable TTL, allowing for network delays.
Setting `waitingTtlMs` to 24 hours still renews it on each heartbeat; it does not impose a fixed
24-hour deadline from joining.

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

`createTurnway()` registers the config and starts the admission worker when enabled before
resolving. It loads no NestJS packages. The handle exposes the same
`service` described below.

## Use the service

```ts
import { Injectable } from '@nestjs/common';
import { TurnwayService } from 'turnway';

@Injectable()
export class TicketService {
  constructor(private readonly turnway: TurnwayService) {}

  async enterQueue(userId: string) {
    return this.turnway.join('ticket-sale', userId);
  }

  async withAdmission<T>(userId: string, passId: string, work: () => Promise<T>): Promise<T> {
    // Verify admission immediately before the protected work
    await this.turnway.assertAdmitted('ticket-sale', userId, passId);
    return work();
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

### Request flow

1. Authenticate the request and apply participation rules before calling `enterQueue()`.
   Pass the authenticated user's ID, not a user-supplied ID.
2. Return the pass to the client. While waiting, use `check()` to poll status and `heartbeat()`
   to renew the pass. Both require the authenticated user's ID and the pass ID.
3. Once admitted, verify admission again on each protected request. For example,
   `withAdmission(user.id, passId, () => bookingService.reserve(user.id))` checks admission on
   the server before making the reservation.
4. Keep sending heartbeats if the admitted session must stay active. Call `leave()` when the
   user finishes or cancels; otherwise the session holds its slot until expiry.
5. Stop heartbeats when the pass is `LEFT` or `EXPIRED`. If the pass has already been deleted,
   handle `PASS_NOT_FOUND`. A new attempt starts with `join()`.

## Errors

Waiting and expiry are returned as pass states. `assertAdmitted()` throws `NotAdmittedError`
for a waiting or finished pass; a deleted pass produces `PassNotFoundError`. Every library error
extends `WaitingRoomError` and carries a `code`:

`INVALID_ARGUMENT`, `ROOM_NOT_REGISTERED`, `ROOM_CONFIG_CONFLICT`, `PASS_NOT_FOUND`,
`PASS_OWNER_MISMATCH`, `NOT_ADMITTED`, `STORAGE_FAILURE`.

HTTP status codes and `HttpException` are not part of the public contract — map errors to
responses in your own application.

## What the library does and does not do

Turnway maintains queue order, capacity, pass ownership, admission state, and expiry. Repeated
joins for the same `userId` return that user's existing live pass in the room. Different user IDs
are separate participants; the library does not determine whether they belong to the same person.

Your application is responsible for authentication, bot protection, preventing abuse through
multiple accounts, access policy, transport, and error translation. Apply these checks in a guard,
middleware, or service before calling `join()`. No Turnway-specific guard interface is required.

Derive `userId` from the authenticated request on every call. A `passId` identifies a pass;
possession of it does not authenticate the caller. Verify admission with `assertAdmitted()` on
the server before protected work, even if the client previously received an admitted status.

## Current boundaries

- Capacity is measured in active sessions, not requests per second.
- A disconnected user holds a slot until the session expires.
- Admission follows the order in which joins are processed by Redis.
- Targets a single Redis instance. Redis Cluster is not supported.
- `position` is an upper bound: expired waiters that have not been cleaned up yet can still be
  counted ahead of you.
- Throughput has not been measured. Treat the default timings as starting points.

## Redis requirements

Waiting state is the source of truth, so the instance must not evict it: run with
`maxmemory-policy noeviction`, and enable AOF persistence if you need state to survive a restart.
