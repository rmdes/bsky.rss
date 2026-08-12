// A stalled network call (no response, connection never closes) leaves the caller's
// await pending forever - unlike an HTTP error or timeout at the TCP layer, nothing
// ever rejects. @atproto/api's BskyAgent (and Agent) never applies a timeout of its
// own, so a hung request to a PDS can wedge whatever await is waiting on it
// indefinitely. Wrapping fetch with AbortController bounds that wait.
export function createTimeoutFetch(
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // init.signal is always undefined for every call site in this codebase today, but
    // combining rather than overwriting keeps this correct if that ever changes.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      return await fetchImpl(input, {...init, signal});
    } finally {
      clearTimeout(timer);
    }
  };
}
