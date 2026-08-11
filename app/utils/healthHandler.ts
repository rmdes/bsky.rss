import http from 'http';
import { createLogger } from '../../shared/logging/logger';

const logger = createLogger('app');
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
      const isStale = timeSinceActivity > 600000; // 10 minutes
      const status = isReady && !isStale ? 200 : 503;
      const memUsage = process.memoryUsage();

      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          status: status === 200 ? 'healthy' : 'unhealthy',
          ready: isReady,
          stale: isStale,
          lastActivity: new Date(lastActivityTime).toISOString(),
          timeSinceActivity: `${Math.round(timeSinceActivity / 1000)}s`,
          uptime: process.uptime(),
          version: require('../../package.json').version,
          memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
          },
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Health check endpoint listening');
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
