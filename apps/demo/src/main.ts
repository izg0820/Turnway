import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NotAdmittedError, TurnwayService, isWaitingRoomError } from 'turnway';
import { AppModule, DEMO_ROOM_ID } from './app.module';

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
    logger.log(`참여 완료 · pass=${pass.passId} state=${pass.state}`);

    // Poll the status until the admission worker promotes this pass
    let status = await turnway.check(DEMO_ROOM_ID, userId, pass.passId);
    for (let attempt = 0; attempt < 10 && status.state === 'WAITING'; attempt += 1) {
      logger.log(`대기 중 · position=${status.position}`);
      await sleep(500);
      status = await turnway.check(DEMO_ROOM_ID, userId, pass.passId);
    }

    // Verify admission right before running the protected logic
    const session = await turnway.assertAdmitted(DEMO_ROOM_ID, userId, pass.passId);
    logger.log(`입장 확인 · 세션 만료=${new Date(session.expiresAt).toISOString()}`);
    logger.log(`보호 기능 실행 결과 · ${runProtectedWork(userId)}`);

    const left = await turnway.leave(DEMO_ROOM_ID, userId, pass.passId);
    logger.log(`퇴장 완료 · state=${left.state}`);
    logger.log(`현재 인원 · ${JSON.stringify(await turnway.stats(DEMO_ROOM_ID))}`);
  } catch (error) {
    if (error instanceof NotAdmittedError) {
      logger.warn(`아직 입장하지 못함 · state=${error.status.state}`);
    } else if (isWaitingRoomError(error)) {
      logger.error(`대기 시스템 오류 · code=${error.code} message=${error.message}`);
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
