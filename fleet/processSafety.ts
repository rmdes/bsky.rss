import {FleetLogger, formatDebugError} from '../shared/logging/logger.ts';

let installed = false;
let unhandledRejectionCount = 0;
const REJECTION_THRESHOLD = 3;
const REJECTION_WINDOW_MS = 60_000;

function exceptionClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

export function installProcessSafetyNet(logger: FleetLogger): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', reason => {
    logger.summary('FATAL', `Unhandled rejection detected: ${exceptionClass(reason)}`);
    logger.debug('FATAL', formatDebugError(reason));

    unhandledRejectionCount++;
    setTimeout(() => unhandledRejectionCount--, REJECTION_WINDOW_MS);

    if (unhandledRejectionCount >= REJECTION_THRESHOLD) {
      logger.summary(
        'FATAL',
        `${REJECTION_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS}ms - exiting`,
      );
      process.exit(1);
    }
  });

  process.on('uncaughtException', error => {
    logger.summary('FATAL', `Uncaught exception (process continues): ${exceptionClass(error)}`);
    logger.debug('FATAL', formatDebugError(error));
  });
}
