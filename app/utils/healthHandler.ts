import http from 'http';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {join, dirname} from 'path';

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
) as {version: string};

const PORT = process.env.HEALTH_CHECK_PORT || 8080;

let isReady = false;
let lastActivityTime = Date.now();
let server: http.Server | null = null;

export function markReady() {
  isReady = true;
}

export function updateActivity() {
  lastActivityTime = Date.now();
}

export function reset() {
  isReady = false;
  lastActivityTime = Date.now();
}

export function start() {
  if (server) {
    return; // Already started
  }

  server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const timeSinceActivity = Date.now() - lastActivityTime;
      const stale = timeSinceActivity >= 600000;
      const status = isReady && !stale ? 200 : 503;
      const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      const mem = process.memoryUsage();

      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          status: status === 200 ? 'healthy' : 'unhealthy',
          ready: isReady,
          stale,
          lastActivity: new Date(lastActivityTime).toISOString(),
          timeSinceActivity: `${Math.round(timeSinceActivity / 1000)}s`,
          uptime: process.uptime(),
          version: packageJson.version,
          // MB, so a leak shows up as steady growth across polls
          memory: {
            rss: toMb(mem.rss),
            heapUsed: toMb(mem.heapUsed),
            heapTotal: toMb(mem.heapTotal),
            external: toMb(mem.external),
          },
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss HEALTH] Health check endpoint listening on port ${PORT}`,
    );
  });
}

export function stop(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(err => {
      if (err) {
        reject(err);
      } else {
        server = null;
        resolve();
      }
    });
  });
}

export default {start, stop, markReady, updateActivity, reset};
