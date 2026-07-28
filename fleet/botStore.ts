import { DatabaseSync } from "node:sqlite";

export interface QueueItemRow {
  id: number;
  title: string;
  content: string;
  embedJson: string | null;
  languagesJson: string | null;
  itemDate: string;
  dedupeKey: string;
  status: "queued" | "publishing" | "published" | "skipped" | "failed";
  enqueuedAt: string;
  publishedAt: string | null;
}

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
      CREATE TABLE IF NOT EXISTS queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        embed_json TEXT,
        languages_json TEXT,
        item_date TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        enqueued_at TEXT NOT NULL,
        published_at TEXT
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

  enqueue(item: {
    title: string;
    content: string;
    embedJson: string | null;
    languagesJson: string | null;
    itemDate: string;
    dedupeKey: string;
  }): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO queue_items (title, content, embed_json, languages_json, item_date, dedupe_key, status, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(item.title, item.content, item.embedJson, item.languagesJson, item.itemDate, item.dedupeKey, now);
    return Number(result.lastInsertRowid);
  }

  listQueued(): QueueItemRow[] {
    return this.db
      .prepare(
        `SELECT id, title, content, embed_json as embedJson, languages_json as languagesJson,
                item_date as itemDate, dedupe_key as dedupeKey, status, enqueued_at as enqueuedAt, published_at as publishedAt
         FROM queue_items WHERE status = 'queued' ORDER BY item_date ASC`
      )
      .all() as QueueItemRow[];
  }

  setQueueItemStatus(id: number, status: QueueItemRow["status"]): void {
    const publishedAt = status === "published" ? new Date().toISOString() : null;
    this.db
      .prepare(`UPDATE queue_items SET status = ?, published_at = COALESCE(?, published_at) WHERE id = ?`)
      .run(status, publishedAt, id);
  }

  countQueued(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM queue_items WHERE status = 'queued'`).get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
