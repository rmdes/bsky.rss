// Some CDNs answer a request with a slow, uncached 404 or error even though the file exists,
// then serve the next identical request straight from cache (seen on middleeasteye.net: first
// request 404 after ~16s with cache-control: no-store, the next four 200 in 10-40ms). One retry
// after a short pause recovers those without hammering a server that is really down.
export const RETRY_DELAY_MS = 1500;

export async function retryOnce<T>(
  attempt: () => Promise<T>,
  delayMs: number = RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await attempt();
  } catch {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return attempt();
  }
}
