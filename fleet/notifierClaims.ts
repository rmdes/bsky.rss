// Only one bot config per Bluesky account polls that account's notifications (several configs
// can share an identity; see documentation/specs/2026-08-09-fleet-identity-dedup-design.md).
// Workers ask on every notification check, so when the holder stops and releases its claim, a
// sibling that is already running takes over on its next check.
export class NotifierClaims {
  private readonly holders = new Map<string, string>(); // identifier -> botId

  claim(botId: string, identifier: string): boolean {
    const holder = this.holders.get(identifier);
    if (holder !== undefined) return holder === botId;
    this.holders.set(identifier, botId);
    return true;
  }

  release(botId: string): string | undefined {
    for (const [identifier, holder] of this.holders) {
      if (holder === botId) {
        this.holders.delete(identifier);
        return identifier;
      }
    }
    return undefined;
  }
}
