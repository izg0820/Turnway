import type { WaitingRoomLogger } from './types/options';

/**
 * Default standalone logger. Writes warnings and errors to stderr; ignores debug messages.
 */
export function createConsoleLogger(): WaitingRoomLogger {
  const write = (level: string, message: string, context?: Record<string, unknown>): void => {
    const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
    process.stderr.write(`[turnway] ${level} ${message}${suffix}\n`);
  };

  return {
    debug: () => undefined,
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
  };
}
