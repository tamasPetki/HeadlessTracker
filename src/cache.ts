// Local SQLite cache for connector responses.
// Eng review F4 critical gap: WAL mode + retry-on-SQLITE_BUSY for concurrent MCP tool calls.
// Eng review 1F: per-connector default TTL, callers can override.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import type { ConnectorId } from "./types.ts";

const DEFAULT_DB_DIR = join(homedir(), ".headless-tracker");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "cache.db");

// Per-connector default TTL in seconds (eng review 1F).
// Module-internal namespaces (e.g. "_prices") may also use this cache; they
// must always pass an explicit ttlSec to set() since they aren't ConnectorId-typed.
const DEFAULT_TTL_SEC: Record<ConnectorId, number> = {
  metamask: 60,
  bybit: 120,
  polymarket: 30,
};

// Fallback TTL for any namespace not in DEFAULT_TTL_SEC (defensive — prices.ts
// always passes explicit ttl, but we don't want NaN if someone forgets).
const FALLBACK_TTL_SEC = 60;

// Retry budget for SQLITE_BUSY (eng review F4).
// WAL mode makes concurrent reads always succeed and concurrent writes serialize,
// but a writer can still hit BUSY if another writer holds the lock briefly.
const SQLITE_BUSY_RETRIES = 5;
const SQLITE_BUSY_BACKOFF_MS = 25;

export interface CacheOptions {
  dbPath?: string;
}

export class Cache {
  private db: Database;

  constructor(opts: CacheOptions = {}) {
    const path = opts.dbPath ?? DEFAULT_DB_PATH;
    if (path !== ":memory:") {
      mkdirSync(DEFAULT_DB_DIR, { recursive: true });
    }
    this.db = new Database(path, { create: true });

    // WAL mode: concurrent readers + serialized writers, far better SQLite concurrency
    // than the default rollback journal. Critical when MCP host fans out tool calls.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        connector TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (connector, key)
      )
    `);
  }

  get<T>(connector: ConnectorId | string, key: string): { value: T; storedAt: number; stale: boolean } | null {
    const row = this.db
      .query<
        { value: string; stored_at: number; expires_at: number },
        [string, string]
      >("SELECT value, stored_at, expires_at FROM cache_entries WHERE connector = ? AND key = ?")
      .get(connector, key);

    if (!row) return null;

    return {
      value: JSON.parse(row.value) as T,
      storedAt: row.stored_at,
      stale: Date.now() > row.expires_at,
    };
  }

  set<T>(connector: ConnectorId | string, key: string, value: T, ttlSec?: number): void {
    const ttl = ttlSec ?? DEFAULT_TTL_SEC[connector as ConnectorId] ?? FALLBACK_TTL_SEC;
    const now = Date.now();
    const expiresAt = now + ttl * 1000;
    const serialized = JSON.stringify(value);

    this.runWithRetry(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO cache_entries (connector, key, value, stored_at, expires_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(connector, key, serialized, now, expiresAt);
    });
  }

  invalidate(connector: ConnectorId | string, key?: string): void {
    this.runWithRetry(() => {
      if (key) {
        this.db.prepare("DELETE FROM cache_entries WHERE connector = ? AND key = ?").run(connector, key);
      } else {
        this.db.prepare("DELETE FROM cache_entries WHERE connector = ?").run(connector);
      }
    });
  }

  invalidateAll(): void {
    this.runWithRetry(() => {
      this.db.exec("DELETE FROM cache_entries");
    });
  }

  close(): void {
    this.db.close();
  }

  // SQLITE_BUSY retry loop. Bun's sqlite throws an Error with code "SQLITE_BUSY"
  // when a write conflicts; busy_timeout above usually handles this but the explicit
  // retry is belt-and-suspenders for high MCP fan-out scenarios.
  private runWithRetry(fn: () => void): void {
    let lastError: unknown;
    for (let attempt = 0; attempt <= SQLITE_BUSY_RETRIES; attempt++) {
      try {
        fn();
        return;
      } catch (e) {
        lastError = e;
        const isBusy =
          e instanceof Error &&
          (e.message.includes("SQLITE_BUSY") || e.message.includes("database is locked"));
        if (!isBusy || attempt === SQLITE_BUSY_RETRIES) {
          throw e;
        }
        Bun.sleepSync(SQLITE_BUSY_BACKOFF_MS * (attempt + 1));
      }
    }
    throw lastError;
  }
}

// Module-level default singleton — most callers can just import { defaultCache }.
let _defaultCache: Cache | null = null;
export function defaultCache(): Cache {
  if (!_defaultCache) {
    _defaultCache = new Cache();
  }
  return _defaultCache;
}
