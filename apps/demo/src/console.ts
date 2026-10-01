import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NotAdmittedError, TurnwayService, isWaitingRoomError } from 'turnway';
import { AppModule } from './app.module';
import { DEMO_ROOM_ID } from './constants';

/**
 * Minimal example of an installing application driving the whole flow through the service alone.
 * Join, wait for admission, run the protected work, then leave, all printed to the console.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Demo');
  const app = await NestFactory.createApplicationContext(AppModule, { abortOnError: false });
  app.enableShutdownHooks();

  const turnway = app.get(TurnwayService);
  const userId = `demo-user-${process.pid}`;

  try {
    const pass = await turnway.join(DEMO_ROOM_ID, userId);
    logger.log(`Joined · pass=${pass.passId} state=${pass.state}`);

    // Poll the status until the admission worker promotes this pass
    let status = await turnway.check(DEMO_ROOM_ID, userId, pass.passId);
    for (let attempt = 0; attempt < 10 && status.state === 'WAITING'; attempt += 1) {
      logger.log(`Waiting · position=${status.position}`);
      await sleep(500);
      status = await turnway.check(DEMO_ROOM_ID, userId, pass.passId);
    }

    // Verify admission right before running the protected logic
    const session = await turnway.assertAdmitted(DEMO_ROOM_ID, userId, pass.passId);
    logger.log(`Admission verified · session expires=${new Date(session.expiresAt).toISOString()}`);
    logger.log(`Protected work result · ${runProtectedWork(userId)}`);

    const left = await turnway.leave(DEMO_ROOM_ID, userId, pass.passId);
    logger.log(`Left · state=${left.state}`);
    logger.log(`Current occupancy · ${JSON.stringify(await turnway.stats(DEMO_ROOM_ID))}`);
  } catch (error) {
    if (error instanceof NotAdmittedError) {
      logger.warn(`Not admitted yet · state=${error.status.state}`);
    } else if (isWaitingRoomError(error)) {
      logger.error(`Waiting room error · code=${error.code} message=${error.message}`);
    } else {
      throw error;
    }
  } finally {
    await app.close();
  }
}

/** Stand-in for real booking or payment work, showing only the admission result */
function runProtectedWork(userId: string): string {
  return `protected-work-done-for-${userId}`;
}

void bootstrap();
