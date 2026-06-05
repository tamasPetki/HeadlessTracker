// Runtime-portable SQLite.
//
// There is no single SQLite driver that loads in both Bun and Node:
//   - bun:sqlite      → Bun only (Node: ERR_UNKNOWN_BUILTIN_MODULE)
//   - node:sqlite     → Node only (Bun: ERR_UNKNOWN_BUILTIN_MODULE)
//   - better-sqlite3  → Node only (Bun can't load its native addon, oven-sh/bun#4290)
//
// So we choose the engine at runtime: bun:sqlite when running under Bun
// (dev / `bun test` / CI), node:sqlite when running under Node (the published
// `npx headless-tracker` artifact). node:sqlite is built into Node, so the
// package ships with ZERO native dependencies — nothing to compile or download
// at install time, which is the single biggest cause of "npx tool silently
// breaks on someone's machine".
//
// Both engines expose the same surface we use: exec(), prepare().get/all/run,
// close(). The only differences are the import and the constructor, both hidden
// behind openDatabase().

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function openDatabase(path: string): SqliteDb {
  if (isBun) {
    // Only reached under Bun; Node never evaluates this require().
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string, opts?: { create?: boolean }) => SqliteDb;
    };
    return new Database(path, { create: true });
  }

  // node:sqlite is flagged experimental and emits a one-time ExperimentalWarning
  // on stderr. For an MCP server that speaks JSON-RPC over stdout that's
  // harmless, but it's noise on the CLI — suppress just that one warning.
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : (warning as Error)?.message;
    if (message && message.includes("SQLite is an experimental feature")) return;
    return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => SqliteDb;
    };
    return new DatabaseSync(path);
  } catch (e) {
    const version = process.versions?.node ?? "unknown";
    throw new Error(
      `HeadlessTracker needs Node 22.5+ with built-in SQLite (node:sqlite), or Bun. ` +
        `Detected Node ${version}. Upgrade to Node 22.5+ (or run it under Bun). ` +
        `Original error: ${(e as Error).message}`
    );
  }
}
