function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatMemoryLogLine(usage: NodeJS.MemoryUsage): string {
  return `rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)} heapTotal=${mb(usage.heapTotal)} external=${mb(
    usage.external
  )}`;
}
