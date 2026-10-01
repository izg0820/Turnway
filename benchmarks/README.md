# Benchmarks

Local load tests of the public `TurnwayService` against one Redis, 500,000 users per run.
Each configuration was run once on 2026-09-17/18. The 1-room mixed run used an earlier revision
of the load script, so its JSON lacks some config fields the current script records.
These numbers show how the library behaves on one machine. They are not a production capacity claim.

## Setup

- Apple M4 Pro (14 logical CPUs, 48 GiB), Node.js v24.19.0, Redis 7.4.11 in Docker Desktop.
- Load generator, library and Redis on the same machine. Calls go service → ioredis → localhost Redis.
  No HTTP, TLS or authentication in the path.
- 16 ioredis connections. Joins are dispatched with at most 512 in flight.
- Redis: 1,536 MiB memory limit, `noeviction`, AOF `appendfsync everysec`, no RDB snapshots.
- Waiting and session TTLs raised to 1 hour so the population stays at 500,000.
  Renewal and expiry under the default 60 s TTL were not measured.
- Room capacity 5,000, admitting up to 50 per room every second.
- Sustained stages are open-loop: requests are sent on schedule regardless of earlier replies.
  At 20,000 outstanding requests, new requests are not sent and are counted as **unsent**.
  Latency is measured from the scheduled time to the reply, for successful requests only.

## Registration

| Rooms | 500,000 joins | Throughput | `join()` p99 |
|---|---:|---:|---:|
| 1 | 10.0 s | 49,779/s | 21.0 ms |
| 30 | 10.1 s | 49,718/s | 18.2 ms |

## Mixed load: 80% `check()`, 20% `heartbeat()`

20 s per stage, with 500,000 users in the queue.

| Target RPS | Rooms | Completed RPS | p50 | p95 | p99 | Unsent |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 1 | 9,999 | 1.9 ms | 4.0 ms | 9.3 ms | 0 |
| | 30 | 9,999 | 1.8 ms | 3.3 ms | 5.0 ms | 0 |
| 25,000 | 1 | 24,998 | 1.8 ms | 4.3 ms | 9.5 ms | 0 |
| | 30 | 24,998 | 1.8 ms | 4.3 ms | 7.0 ms | 0 |
| 50,000 | 1 | 49,985 | 14.1 ms | 108.0 ms | 126.8 ms | 0 |
| | 30 | 48,140 | 227.2 ms | 426.9 ms | 449.3 ms | 1.74% |
| 100,000 | 1 | 52,361 | 378.3 ms | 401.7 ms | 412.4 ms | 46.64% |
| | 30 | 48,377 | 409.7 ms | 428.9 ms | 437.9 ms | 50.62% |

One Redis saturates near 50,000 RPS in this setup. The two runs at that rate differ noticeably,
so treat that row as the edge rather than a stable figure. 100,000 RPS was not reached.
Latency at that rate covers only the requests that were sent.

## Every user polls every 10 s

500,000 users in one room each call `check()` once every 10 s for 60 s (50,000 RPS,
3,000,000 calls), spread evenly over the interval. No heartbeats.

| Successful | Unsent | p50 | p95 | p99 |
|---:|---:|---:|---:|---:|
| 2,962,772 | 1.24% | 12.4 ms | 351.5 ms | 586.0 ms |

## Not covered

HTTP and browser overhead, separate load-generator machines, repeated runs, default TTL expiry
at this scale, and Redis failure.

## Reproduce

Requires Docker. The script expects a dedicated Redis on port 6400.

```sh
docker run -d --rm --name turnway-load -p 127.0.0.1:6400:6379 --memory 2g redis:7-alpine \
  redis-server --maxmemory 1536mb --maxmemory-policy noeviction --appendonly yes --appendfsync everysec --save ''
pnpm build
node packages/turnway/scripts/load-500k.mjs                # 1 room
node packages/turnway/scripts/load-500k.mjs --multi-room   # 30 rooms
node packages/turnway/scripts/load-500k.mjs --poll-10s     # 10 s polling
docker stop turnway-load
```

Add `--smoke` for a 1,000-user run. Each run writes its JSON to `docs/benchmarks/`, which is git-ignored;
copy a run into `results/` to publish it.

## Raw results

| Run | File |
|---|---|
| 1 room, mixed | [load-500k-1789621509152.json](results/load-500k-1789621509152.json) |
| 30 rooms, mixed | [load-500k-multi-room-1789709338894.json](results/load-500k-multi-room-1789709338894.json) |
| 1 room, 10 s polling | [load-500k-poll-10s-1789716559212.json](results/load-500k-poll-10s-1789716559212.json) |
