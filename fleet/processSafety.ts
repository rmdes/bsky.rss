let installed = false;
let unhandledRejectionCount = 0;
const REJECTION_THRESHOLD = 3;
const REJECTION_WINDOW_MS = 60_000;

export function installProcessSafetyNet(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const timestamp = new Date().toUTCString();
    console.error(
      `[${timestamp}] - [bsky.rss FATAL] Unhandled rejection detected: ${reason instanceof Error ? reason.stack : String(reason)}`
    );

    unhandledRejectionCount++;
    setTimeout(() => unhandledRejectionCount--, REJECTION_WINDOW_MS);

    if (unhandledRejectionCount >= REJECTION_THRESHOLD) {
      console.error(
        `[${timestamp}] - [bsky.rss FATAL] ${REJECTION_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS}ms - exiting`
      );
      process.exit(1);
    }
  });

  process.on("uncaughtException", (error) => {
    console.error(
      `[${new Date().toUTCString()}] - [bsky.rss FATAL] Uncaught exception (process continues): ${
        error?.stack ?? error
      }`
    );
  });
}
