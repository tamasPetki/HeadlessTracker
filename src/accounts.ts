// Account registry — durable list of "configured accounts" (vs. cache_entries which is ephemeral).
// Lives in the same SQLite file as the cache (~/.headless-tracker/cache.db) but
// in a separate table with no TTL. Used by:
//   - `headless-tracker list-accounts` (CLI command)
//   - MCP tools when called without an account_id filter (iterate all accounts)
//   - Setup flow (writes a new row alongside the vault credential write)

import { openDatabase, type SqliteDb } from "./sqlite.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import type { Account, ConnectorId } from "./types.ts";

const DEFAULT_DB_DIR = join(homedir(), ".headless-tracker");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "cache.db");

export interface AccountStoreOptions {
  dbPath?: string;
}

interface AccountRow {
  id: string;
  connector_id: string;
  label: string;
  created_at: number;
  metadata: string;
}

export class AccountStore {
  private db: SqliteDb;

  constructor(opts: AccountStoreOptions = {}) {
    const path = opts.dbPath ?? DEFAULT_DB_PATH;
    if (path !== ":memory:") {
      mkdirSync(DEFAULT_DB_DIR, { recursive: true });
    }
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_connector ON accounts(connector_id)`);
  }

  upsert(account: Account): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO accounts (id, connector_id, label, created_at, metadata) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        account.id,
        account.connectorId,
        account.label,
        account.createdAt,
        JSON.stringify(account.metadata ?? {})
      );
  }

  get(id: string): Account | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id) as AccountRow | undefined;
    return row ? rowToAccount(row) : null;
  }

  list(): Account[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY created_at ASC")
      .all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  listByConnector(connectorId: ConnectorId): Account[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts WHERE connector_id = ? ORDER BY created_at ASC")
      .all(connectorId) as AccountRow[];
    return rows.map(rowToAccount);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    connectorId: row.connector_id as ConnectorId,
    label: row.label,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

let _defaultStore: AccountStore | null = null;
export function defaultAccountStore(): AccountStore {
  if (!_defaultStore) {
    _defaultStore = new AccountStore();
  }
  return _defaultStore;
}
