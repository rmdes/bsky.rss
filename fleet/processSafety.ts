let installed = false;

export function installProcessSafetyNet(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss FATAL] Unhandled rejection (process continues): ${reason}`
    );
  });

  process.on("uncaughtException", (error) => {
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss FATAL] Uncaught exception (process continues): ${
        error?.stack ?? error
      }`
    );
  });
}
