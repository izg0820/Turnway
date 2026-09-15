import { Logger } from '@nestjs/common';
import type { WaitingRoomLogger } from './types/options';

/** Append context as JSON without redacting its fields */
function format(message: string, context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) return message;
  return `${message} ${JSON.stringify(context)}`;
}

/** Default logger for the NestJS module */
export function createDefaultLogger(): WaitingRoomLogger {
  const logger = new Logger('Turnway');

  return {
    debug: (message, context) => logger.debug(format(message, context)),
    warn: (message, context) => logger.warn(format(message, context)),
    error: (message, context) => logger.error(format(message, context)),
  };
}
