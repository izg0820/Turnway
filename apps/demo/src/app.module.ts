import { Module } from '@nestjs/common';
import { TurnwayModule } from 'turnway';

/** Room id used by the demo */
export const DEMO_ROOM_ID = 'demo-room';

/** Waiting room configuration for the console demo */
@Module({
  imports: [
    TurnwayModule.forRoot({
      redis: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6399' },
      rooms: [
        {
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
