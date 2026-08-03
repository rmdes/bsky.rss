export function formatBytesAsMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatMemoryLogLine(usage: NodeJS.MemoryUsage): string {
  return `rss=${formatBytesAsMegabytes(usage.rss)} heapUsed=${formatBytesAsMegabytes(usage.heapUsed)} heapTotal=${formatBytesAsMegabytes(usage.heapTotal)} external=${formatBytesAsMegabytes(
    usage.external
  )}`;
}
