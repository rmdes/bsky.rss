import process from 'process';
import {join} from 'path';
import {createDbHandler} from './utils/dbHandler.ts';
import {createBskyHandler} from './utils/bskyHandler.ts';
import {createQueueHandler} from './utils/queueHandler.ts';
import {createRssHandler} from './utils/rssHandler.ts';
import health from './utils/healthHandler.ts';
import {Logger, parseLogLevel} from '../shared/logging/index.ts';
import 'dotenv/config';

interface ValidatedEnv {
  identifier: string;
  appPassword: string;
  fetchUrl: URL;
  instanceUrl: URL;
  fetchInterval: number;
}

function validateEnvironment(): ValidatedEnv {
  // Check required variables exist
  const required = ['IDENTIFIER', 'APP_PASSWORD', 'FETCH_URL', 'INSTANCE_URL'] as const;
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate and parse FETCH_URL
  let fetchUrl: URL;
  try {
    fetchUrl = new URL(process.env.FETCH_URL!);
  } catch {
    throw new Error(
      `Invalid FETCH_URL: "${process.env.FETCH_URL}" - must be a valid URL (e.g., https://example.com/feed.xml)`,
    );
  }

  // Validate and parse INSTANCE_URL
  let instanceUrl: URL;
  try {
    instanceUrl = new URL(process.env.INSTANCE_URL!);
  } catch {
    throw new Error(
      `Invalid INSTANCE_URL: "${process.env.INSTANCE_URL}" - must be a valid URL (e.g., https://bsky.social)`,
    );
  }

  // Validate and parse FETCH_INTERVAL
  let fetchInterval = 5; // Default
  if (process.env.FETCH_INTERVAL) {
    fetchInterval = parseFloat(process.env.FETCH_INTERVAL);

    if (isNaN(fetchInterval)) {
      throw new Error(`Invalid FETCH_INTERVAL: "${process.env.FETCH_INTERVAL}" - must be a number`);
    }

    if (fetchInterval < 0.002) {
      throw new Error(
        `Invalid FETCH_INTERVAL: ${fetchInterval} - must be >= 0.002 minutes (0.12 seconds)`,
      );
    }
  }

  return {
    identifier: process.env.IDENTIFIER!,
    appPassword: process.env.APP_PASSWORD!,
    fetchUrl,
    instanceUrl,
    fetchInterval,
  };
}

const env = validateEnvironment();

const logger = new Logger({
  defaultLevel: parseLogLevel(process.env.LOG_LEVEL),
});

const db = createDbHandler(join(import.meta.dirname, '../data'));
const bsky = createBskyHandler(db, logger);
const queue = createQueueHandler(bsky, db, logger);
const reader = createRssHandler(queue, db, logger);

void main();
async function main() {
  try {
    /* Start health check endpoint */
    health.start();

    /* Initialize Bluesky/Atproto API */
    await bsky.init(env.instanceUrl.toString());
    await bsky.login({
      identifier: env.identifier,
      password: env.appPassword,
    });

    /* Initialize RSS reader */
    logger.summary(
      'APP',
      `Started RSS reader. Fetching from ${env.fetchUrl} every ${env.fetchInterval} minutes.`,
    );
    await reader.init({
      fetch_interval: env.fetchInterval,
      fetch_url: env.fetchUrl,
    });
    await reader.start();
    await reader.launch();
    await queue.start();

    /* Mark application as ready */
    health.markReady();
    logger.summary('APP', 'Application is ready and healthy');
  } catch (error) {
    if (error instanceof Error && error.message.includes('Rate Limit')) {
      logger.summary('APP', 'Authentication rate limit exceeded');
      // Deliberately leave health.markReady() uncalled: /health stays 503, which is the
      // signal for an external process manager/orchestrator to restart the container.
      // There's no in-process retry-after-rate-limit mechanism for this startup login
      // path, so staying unready (rather than exiting or looping) hands recovery to
      // whatever's supervising the process.
      return;
    }
    logger.summary('APP', `Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
