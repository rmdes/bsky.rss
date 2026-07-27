import { DatabaseSync } from "node:sqlite";

export class BotStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_item_date TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_items (
        value TEXT PRIMARY KEY,
        seen_at TEXT NOT NULL
      );
    `);
  }

  writeSession(data: unknown): void {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(json, now);
  }

  readSession<T>(): T | null {
    const row = this.db.prepare(`SELECT data FROM session WHERE id = 1`).get() as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }

  writeCursor(date: Date): void {
    this.db
      .prepare(
        `INSERT INTO cursor (id, last_item_date) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_item_date = excluded.last_item_date`
      )
      .run(date.toISOString());
  }

  readCursor(): string {
    const row = this.db.prepare(`SELECT last_item_date FROM cursor WHERE id = 1`).get() as
      | { last_item_date: string }
      | undefined;
    return row ? row.last_item_date : "";
  }

  seenValueExists(value: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM seen_items WHERE value = ?`).get(value);
    return row !== undefined;
  }

  writeSeenValue(value: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO seen_items (value, seen_at) VALUES (?, ?)`).run(value, now);
  }

  cleanupOldSeenValues(maxAgeHours: number): void {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    this.db.prepare(`DELETE FROM seen_items WHERE seen_at < ?`).run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
