import 'reflect-metadata';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { demoUserMiddleware } from './demo-user';
import { WaitingRoomErrorFilter } from './waiting-room-error.filter';

/** Browser demo: static page plus a small HTTP API over the injected waiting room service */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(demoUserMiddleware);
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.useGlobalFilters(new WaitingRoomErrorFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '127.0.0.1');
  new Logger('Demo').log(`Open http://localhost:${port} in different browsers or profiles to act as different users`);
}

void bootstrap();
