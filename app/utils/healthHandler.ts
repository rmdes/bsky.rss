import http from 'http';

const PORT = process.env.HEALTH_CHECK_PORT || 8080;

let isReady = false;
let lastActivityTime = Date.now();

export function markReady() {
  isReady = true;
}

export function updateActivity() {
  lastActivityTime = Date.now();
}

export function start() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const timeSinceActivity = Date.now() - lastActivityTime;
      const status = isReady && timeSinceActivity < 600000 ? 200 : 503;

      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          status: status === 200 ? 'healthy' : 'unhealthy',
          ready: isReady,
          lastActivity: new Date(lastActivityTime).toISOString(),
          timeSinceActivity: `${Math.round(timeSinceActivity / 1000)}s`,
          uptime: process.uptime(),
          version: require('../../package.json').version,
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log(
      `[${new Date().toUTCString()}] - [bsky.rss HEALTH] Health check endpoint listening on port ${PORT}`
    );
  });
}

export default {start, markReady, updateActivity};
