import process from 'process';
import {join} from 'path';
import {createDbHandler} from './utils/dbHandler.ts';
import {createBskyHandler} from './utils/bskyHandler.ts';
import {createQueueHandler} from './utils/queueHandler.ts';
import {createRssHandler} from './utils/rssHandler.ts';
import health from './utils/healthHandler.ts';
import 'dotenv/config';

if (!process.env.IDENTIFIER) throw new Error('No identifier provided.');
if (!process.env.APP_PASSWORD) throw new Error('No app password provided.');
if (!process.env.FETCH_URL) throw new Error('No fetch URL provided.');
if (!process.env.INSTANCE_URL) throw new Error('No instance URL provided.');

let fetch_interval: number;
if (!process.env.FETCH_INTERVAL) fetch_interval = 5;
else fetch_interval = parseFloat(process.env.FETCH_INTERVAL);

const db = createDbHandler(join(import.meta.dirname, '../data'));
const bsky = createBskyHandler(db);
const queue = createQueueHandler(bsky, db);
const reader = createRssHandler(queue, db);

void main();
async function main() {
  try {
    /* Start health check endpoint */
    health.start();

    /* Initialize Bluesky/Atproto API */
    await bsky.init(String(process.env.INSTANCE_URL));
    await bsky.login({
      identifier: String(process.env.IDENTIFIER),
      password: String(process.env.APP_PASSWORD),
    });

    /* Initialize RSS reader */
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss APP] Started RSS reader. Fetching from ${
        process.env.FETCH_URL
      } every ${fetch_interval} minutes.`,
    );
    await reader.init({
      fetch_interval,
      fetch_url: new URL(String(process.env.FETCH_URL)),
    });
    await reader.start();
    await reader.launch();
    await queue.start();

    /* Mark application as ready */
    health.markReady();
    console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] Application is ready and healthy`);
  } catch (e) {
    if (e === 'Error: Rate Limit Exceeded') {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss APP] Authentication rate limit exceeded`,
      );
      return;
    }
    console.log(`[${new Date().toUTCString()}] - [bsky.rss APP] ${e}`);
  }
}
