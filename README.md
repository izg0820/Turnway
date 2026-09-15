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
2. While waiting, the user can check their queue position and status.
3. When a slot becomes available, the next user receives permission to enter.
4. The service checks that permission before granting access.
5. Departure or session expiry frees a slot for the next waiting user.

Redis stores queue order and active sessions. The design uses sorted sets to track them
and Lua scripts to update queue and admission state atomically.

## Current boundaries

- Capacity is measured in active user sessions, not requests per second.
- A disconnected user may hold a slot until their session expires.
- Admission follows arrival order; bot detection and multi-account abuse prevention are outside the current scope.
- The initial design targets a single Redis instance. Reliability, failure recovery, and performance have not yet been validated.
