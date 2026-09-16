# Turnway

A Redis-backed waiting system for Node.js, provided as a library that manages queues and admits users as capacity becomes available. A NestJS module is included, and a framework-free entry point covers Express, Fastify, Hono, or a plain script.

Users join a queue, check their waiting status, and enter when it is their turn.
Services control how many users are admitted at once, while the waiting system manages the queue and admission lifecycle.
It is intended for ticket sales, course registration, limited product drops, and other services with concentrated demand.

> **Status: library core implemented.** Queue, admission, session lifecycle, and admission
> verification are done and covered by unit and real-Redis integration tests
> (`packages/turnway`). The browser demo app and the load/failure validation are not done yet,
> and the package is not published to npm.

## What it provides

| Capability | Purpose |
|---|---|
| Queue management | Register users and maintain their arrival order |
| Waiting status | Let users check their position and admission status |
| Admission control | Admit users in order, up to the configured capacity |
| Access verification | Verify that a user has been admitted before granting access |
| Session lifecycle | Release capacity when users leave or their sessions expire |

## How it works

```text
Join → Wait → Get admitted → Access the service → Leave or expire
```

1. A user joins and receives a waiting pass.
2. While waiting, the application checks the user's status and sends heartbeats to keep the pass valid.
3. When a slot becomes available, the next user receives permission to enter.
4. The service checks that permission before granting access.
5. Departure or session expiry frees a slot for the next waiting user.

Redis stores queue order and active sessions. The design uses sorted sets to track them
and Lua scripts to update queue and admission state atomically.

Waiting passes expire after 60 seconds by default unless renewed by a heartbeat. Checking status
does not renew a pass. Once an admitted session expires, it no longer counts toward capacity,
even if its stored data has not been cleaned up yet.

## Application responsibilities

Turnway maintains queue order, limits active sessions, and verifies pass ownership and admission.
Each user ID can hold one live pass per room.

Applications are responsible for authentication, bot protection, and preventing abuse through
multiple accounts. Derive `userId` from the authenticated user rather than accepting an arbitrary
ID from the client. Run participation checks before calling `join()`, and call `assertAdmitted()`
before protected work.

See the [package README](packages/turnway/README.md) for setup, session settings, and integration.

## Current boundaries

- Capacity is measured in active user sessions, not requests per second.
- A disconnected user may hold a slot until their session expires.
- Admission follows the order in which joins are processed by Redis.
- The initial design targets a single Redis instance. Reliability, failure recovery, and performance have not yet been validated.
