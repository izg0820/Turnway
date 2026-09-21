import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createTurnway } from '../dist/standalone.js';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

function percentiles(values) {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  const pick = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: pick(1) };
}

// Verify percentile calculations and empty sample handling
assert.deepEqual(percentiles(Array.from({ length: 100 }, (_, i) => i + 1)), {
  p50: 50, p95: 95, p99: 99, max: 100,
});
assert.equal(percentiles([]), null);
const smoke = process.argv.includes('--smoke');
const poll10s = process.argv.includes('--poll-10s');
const cluster = process.argv.includes('--cluster');
const multiRoom = cluster || process.argv.includes('--multi-room');
const population = smoke ? 1000 : 500_000;
const durationMs = poll10s ? 60_000 : smoke ? 2000 : 20_000;
const rates = poll10s ? [population / 10] : smoke ? [1000] : [10_000, 25_000, 50_000, 100_000];
if (process.argv.includes('--self-check')) {
  if (process.argv.includes('--poll-10s')) {
    assert.equal(durationMs, 60_000);
    assert.deepEqual(rates, [population / 10]);
  }
  console.log('percentile and workload self-check passed');
  process.exit(0);
}
const concurrency = 512;
const maxInFlight = 20_000;
const keyPrefix = `load-${randomUUID()}`;
const roomIds = Array.from({ length: multiRoom ? 30 : 1 }, (_, i) => `sale-${i}`);
const roomFor = (index) => roomIds[index % roomIds.length];
const clients = [];
const handles = [];
const passes = new Array(population);
const report = {
  createdAt: new Date().toISOString(),
  environment: { node: process.version, cpu: cpus()[0].model, cpuCount: cpus().length, memory: totalmem() },
  config: { population, durationMs, rates, concurrency, maxInFlight, connections: 16, cluster, roomIds,
    pollIntervalMs: poll10s ? 10_000 : null,
    waitingTtlMs: 3_600_000, sessionTtlMs: 3_600_000, capacity: 5000,
    batchSize: 50, expiryScanLimit: 100, admissionIntervalMs: 1000, admissionScope: 'all rooms sequentially per tick, skip overlapping ticks',
    mix: poll10s ? 'check 100%, heartbeat 0%; users evenly staggered over 10 seconds' : 'check 80%, heartbeat 20%',
    transport: `public service -> ioredis -> localhost Docker Redis:${cluster ? '6401-6403' : '6400'}` },
  stages: [],
};
const outputDir = new URL('../../../docs/benchmarks/', import.meta.url);
mkdirSync(outputDir, { recursive: true });
const output = new URL(`${smoke ? 'smoke' : 'load-500k'}${poll10s ? '-poll-10s' : ''}${cluster ? '-cluster' : multiRoom ? '-multi-room' : ''}-${Date.now()}.json`, outputDir);
function save() { writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
async function info() {
  const wanted = /^(redis_version|used_memory|used_memory_peak|used_memory_rss|aof_enabled|aof_current_size|aof_last_write_status|evicted_keys|total_error_replies|used_cpu_sys|used_cpu_user|cmdstat_evalsha|cmdstat_eval):/;
  const nodes = cluster ? clients[0].nodes('master') : [clients[0]];
  return Promise.all(nodes.map(async (node) => ({ port: node.options.port,
    info: (await node.info()).split('\r\n').filter((line) => wanted.test(line)) })));
}

async function stats() {
  const rooms = await Promise.all(roomIds.map((roomId) => handles[0].service.stats(roomId)));
  for (const room of rooms) assert.ok(room.admitted <= room.capacity);
  return { waiting: rooms.reduce((sum, room) => sum + room.waiting, 0),
    admitted: rooms.reduce((sum, room) => sum + room.admitted, 0), rooms };
}

try {
  for (let i = 0; i < 16; i++) {
    const redisOptions = { retryStrategy: () => null, maxRetriesPerRequest: 0, commandTimeout: 30_000 };
    const client = cluster
      ? new Redis.Cluster([6401, 6402, 6403].map((port) => ({ host: '127.0.0.1', port })), {
        lazyConnect: true, clusterRetryStrategy: () => null, redisOptions })
      : new Redis({ host: '127.0.0.1', port: 6400, lazyConnect: true, ...redisOptions });
    client.on('error', (error) => console.error(error.message));
    clients.push(client);
    await client.connect();
    handles.push(await createTurnway({ redis: { client }, keyPrefix,
      rooms: roomIds.map((roomId) => ({ roomId, capacity: 5000, waitingTtlMs: 3_600_000,
        sessionTtlMs: 3_600_000, maxSessionDurationMs: 3_600_000 })),
      admission: { enabled: false },
    }));
  }
  report.redisBefore = await info();
  console.log(JSON.stringify({ phase: 'start', ...report.config }));

  // Queue simultaneous arrivals in the load generator and limit concurrent calls
  const joinStart = performance.now();
  const joinServiceMs = [];
  const joinArrivalMs = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const service = handles[worker % handles.length].service;
    while (next < population) {
      const index = next++;
      const start = performance.now();
      const result = await service.join(roomFor(index), `user-${index}`);
      const end = performance.now();
      assert.equal(result.state, 'WAITING');
      passes[index] = result.passId;
      joinServiceMs.push(end - start);
      joinArrivalMs.push(end - joinStart);
      if (joinServiceMs.length % 100_000 === 0) console.log(JSON.stringify({ phase: 'join', done: joinServiceMs.length }));
    }
  }));
  const joinElapsedMs = performance.now() - joinStart;
  const initialStats = await stats();
  assert.equal(initialStats.waiting, population);
  assert.equal(new Set(passes).size, population);
  if (cluster) {
    report.distribution = await Promise.all(clients[0].nodes('master').map(async (node) => {
      const keys = await node.keys(`${keyPrefix}:*:waiting`);
      const counts = await Promise.all(keys.map((key) => node.zcard(key)));
      return { port: node.options.port, rooms: keys.length, users: counts.reduce((sum, count) => sum + count, 0) };
    }));
    assert.equal(report.distribution.length, 3);
    assert.ok(report.distribution.every((node) => node.users > 0));
    assert.equal(report.distribution.reduce((sum, node) => sum + node.users, 0), population);
  }
  report.stages.push({ name: 'join-burst-bounded-dispatch', count: population,
    elapsedMs: joinElapsedMs, throughput: population / (joinElapsedMs / 1000),
    serviceMs: percentiles(joinServiceMs), arrivalToCompletionMs: percentiles(joinArrivalMs),
    stats: initialStats, redis: await info() });
  console.log(JSON.stringify(report.stages.at(-1)));
  save();

  for (const rate of rates) {
    const start = performance.now();
    const planned = Math.floor(rate * durationMs / 1000);
    const buckets = { check: [], heartbeat: [] };
    const userPolls = poll10s ? new Uint32Array(population) : null;
    const serviceMs = [];
    const schedulingMs = [];
    const errorMs = [];
    const errorMessages = {};
    const promotionMs = [];
    const pending = new Set();
    let offered = 0;
    let dropped = 0;
    let completedWithinWindow = 0;
    let admissionErrors = 0;
    let promotionBusy = false;
    let promotionPromise = Promise.resolve();
    const admissionTimer = setInterval(() => {
      if (promotionBusy) return;
      promotionBusy = true;
      const before = performance.now();
      promotionPromise = (async () => {
        for (const roomId of roomIds) await handles[0].service.runAdmission(roomId);
      })()
        .then(() => promotionMs.push(performance.now() - before))
        .catch((error) => { admissionErrors++; errorMessages[error.message] = (errorMessages[error.message] ?? 0) + 1; })
        .finally(() => { promotionBusy = false; });
    }, 1000);
    try {
      // Schedule arrivals independently of response times and count dropped requests at saturation
      while (offered < planned) {
        const due = Math.min(planned, Math.floor((performance.now() - start) * rate / 1000));
        while (offered < due) {
          const sequence = offered++;
          if (pending.size >= maxInFlight) { dropped++; continue; }
          const scheduled = start + sequence * 1000 / rate;
          const dispatched = performance.now();
          const kind = poll10s ? 'check' : Math.floor(sequence / roomIds.length) % 5 === 0 ? 'heartbeat' : 'check';
          // Cycle evenly through all users in each stage
          const userIndex = (sequence * 7919) % population;
          const service = handles[sequence % handles.length].service;
          schedulingMs.push(dispatched - scheduled);
          let request;
          request = service[kind](roomFor(userIndex), `user-${userIndex}`, passes[userIndex])
            .then((result) => {
              assert.ok(result.state === 'WAITING' || result.state === 'ADMITTED');
              const end = performance.now();
              buckets[kind].push(end - scheduled);
              if (userPolls) userPolls[userIndex]++;
              serviceMs.push(end - dispatched);
              if (end <= start + durationMs) completedWithinWindow++;
            })
            .catch((error) => {
              errorMs.push(performance.now() - scheduled);
              errorMessages[error.message] = (errorMessages[error.message] ?? 0) + 1;
            })
            .finally(() => pending.delete(request));
          pending.add(request);
        }
        if (offered < planned) await sleep(1);
      }
      await Promise.all(pending);
    } finally {
      clearInterval(admissionTimer);
      await promotionPromise;
    }
    const elapsedMs = performance.now() - start;
    const successful = buckets.check.length + buckets.heartbeat.length;
    assert.equal(successful + errorMs.length + dropped, planned);
    const occupancy = await stats();
    assert.equal(occupancy.waiting + occupancy.admitted, population);
    const stage = { name: 'mixed-open-loop', rate, planned, successful, errors: errorMs.length,
      perUserSuccessfulPolls: userPolls ? {
        min: userPolls.reduce((min, count) => Math.min(min, count), Infinity),
        max: userPolls.reduce((max, count) => Math.max(max, count), 0),
      } : null,
      dropped, admissionErrors, elapsedMs, completedWithinWindow,
      withinWindowRps: completedWithinWindow / (durationMs / 1000),
      drainInclusiveRps: successful / (elapsedMs / 1000),
      latencyMs: percentiles([...buckets.check, ...buckets.heartbeat]),
      checkMs: percentiles(buckets.check), heartbeatMs: percentiles(buckets.heartbeat),
      serviceMs: percentiles(serviceMs), schedulingMs: percentiles(schedulingMs),
      errorMs: percentiles(errorMs), errorMessages,
      promotionMs: percentiles(promotionMs), promotionSamples: promotionMs.length,
      stats: occupancy, redis: await info() };
    report.stages.push(stage);
    console.log(JSON.stringify(stage));
    save();
  }
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.fatal = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await Promise.allSettled(handles.map((handle) => handle.close()));
  for (const client of clients) client.disconnect();
  save();
  console.log(`Result: ${output.pathname}`);
}
