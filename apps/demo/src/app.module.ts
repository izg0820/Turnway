import { Module } from '@nestjs/common';
import { TurnwayModule } from 'turnway';
import { DEMO_ROOM_ID } from './constants';
import { DemoController } from './demo.controller';

/** Waiting room configuration for the demo. Capacity, TTLs and intervals are tuned for a local walkthrough */
@Module({
  imports: [
    TurnwayModule.forRoot({
      redis: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6399' },
      keyPrefix: process.env.TURNWAY_KEY_PREFIX,
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
  controllers: [DemoController],
})
export class AppModule {}
