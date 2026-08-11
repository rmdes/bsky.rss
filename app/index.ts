import process from "process";
import bsky from "./utils/bskyHandler";
import reader from "./utils/rssHandler";
import queue from "./utils/queueHandler";
import health from "./utils/healthHandler";

require("dotenv").config();

function validateEnv() {
  const required = ['IDENTIFIER', 'APP_PASSWORD', 'FETCH_URL', 'INSTANCE_URL'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. See .env.example for reference.`);
  }

  // Validate FETCH_URL is a valid URL
  try {
    new URL(process.env.FETCH_URL!);
  } catch (error) {
    throw new Error(`Invalid FETCH_URL: ${process.env.FETCH_URL}. Must be a valid HTTP/HTTPS URL.`);
  }

  // Validate INSTANCE_URL is a valid URL
  try {
    new URL(process.env.INSTANCE_URL!);
  } catch (error) {
    throw new Error(`Invalid INSTANCE_URL: ${process.env.INSTANCE_URL}. Must be a valid HTTP/HTTPS URL.`);
  }

  // Validate and parse FETCH_INTERVAL
  let fetchInterval = 5;
  if (process.env.FETCH_INTERVAL) {
    fetchInterval = parseFloat(process.env.FETCH_INTERVAL);
    if (isNaN(fetchInterval)) {
      throw new Error(`Invalid FETCH_INTERVAL: ${process.env.FETCH_INTERVAL}. Must be a number.`);
    }
    if (fetchInterval < 0.002) {
      throw new Error(`Invalid FETCH_INTERVAL: ${fetchInterval}. Must be >= 0.002 (minimum ~7 seconds).`);
    }
  }

  return { fetchInterval };
}

const { fetchInterval: fetch_interval } = validateEnv();

main();
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
      } every ${fetch_interval} minutes.`
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
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss APP] Application is ready and healthy`
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('Rate Limit')) {
      console.log(
        `[${new Date().toUTCString()}] - [bsky.rss APP] Authentication rate limit exceeded`
      );
      return;
    }
    console.error(`[${new Date().toUTCString()}] - [bsky.rss APP] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
