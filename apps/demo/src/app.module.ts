import { Module } from '@nestjs/common';
import { TurnwayModule } from 'turnway';

/** Room id used by the demo */
export const DEMO_ROOM_ID = 'demo-room';

/**
 * Demo application module.
 * Phase 01 only checks installation and injection; the HTTP interface arrives in Phase 05.
 */
@Module({
  imports: [
    TurnwayModule.forRoot({
      redis: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6399' },
      rooms: [
        {
          // Capacity for the local demo. The TTLs and interval are demo-friendly values too
          roomId: DEMO_ROOM_ID,
          capacity: 2,
          waitingTtlMs: 30_000,
          sessionTtlMs: 30_000,
          maxSessionDurationMs: 300_000,
          finishedRetentionMs: 30_000,
        },
      ],
      admission: { enabled: true, intervalMs: 1_000, batchSize: 10 },
    }),
  ],
})
export class AppModule {}
