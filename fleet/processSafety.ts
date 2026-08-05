import {FleetLogger, formatDebugError} from './logging.ts';

let installed = false;

function exceptionClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

export function installProcessSafetyNet(logger: FleetLogger): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', reason => {
    logger.summary('FATAL', `Unhandled rejection (process continues): ${exceptionClass(reason)}`);
    logger.debug('FATAL', formatDebugError(reason));
  });

  process.on('uncaughtException', error => {
    logger.summary('FATAL', `Uncaught exception (process continues): ${exceptionClass(error)}`);
    logger.debug('FATAL', formatDebugError(error));
  });
}
