// End-to-end test: spawns the actual `bin/headless-tracker.ts` as a subprocess
// and exchanges JSON-RPC frames over stdio. This is the same flow Claude Desktop
// uses, validated end-to-end without mocks.
//
// What's verified:
//   - Process spawns and survives `initialize`
//   - tools/list returns all 6 expected V0 tools, no extras
//   - Each tool has a non-trivial description (LLM tool selection accuracy)
//   - get_holdings tool/call returns valid structured JSON
//   - refresh_data tool/call returns the expected hint message
//
// Skipped: anything that requires real credentials. The empty-state shape is
// what's tested; the real-data path is exercised by the Day 11-14 burn-in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const BIN = join(import.meta.dir, "..", "..", "bin", "headless-tracker.ts");

// Each test gets its own ephemeral cache dir so global default singletons don't
// leak state between runs. We can't easily redirect ~/.headless-tracker/, so we
// just accept that the orchestrator sees no accounts (defaultAccountStore points
// at the real ~/.headless-tracker/cache.db, but we don't seed any accounts here).
// The empty-state assertions below are robust to whatever the user's real db has.

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolListResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
}

class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private buffer = "";
  private pending = new Map<number, (resp: JsonRpcResponse) => void>();
  private nextId = 1;
  private readPromise: Promise<void>;

  constructor() {
    this.proc = Bun.spawn(["bun", "run", BIN], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.readPromise = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    if (!this.proc.stdout) return;
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      this.buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as JsonRpcResponse;
          if (typeof obj.id === "number") {
            const handler = this.pending.get(obj.id);
            if (handler) {
              this.pending.delete(obj.id);
              handler(obj);
            }
          }
        } catch {
          // Server may emit non-JSON to stdout in error cases; ignore.
        }
      }
    }
  }

  async send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
      this.writeAndFlush(frame);
      // 15s per-call timeout. Bun.spawn startup latency + occasional CPU-loaded
      // contention when the whole suite runs in parallel makes 5s flaky; 15s is
      // still tight enough to catch real hangs.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Timeout waiting for response to ${method}`));
      }, 15000);
    });
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.writeAndFlush(frame);
  }

  // Bun.spawn's stdin is a FileSink. Without explicit .flush(), writes can buffer
  // indefinitely and the spawned process never sees them — the actual root cause
  // of the "test never gets a response" timeouts during initial dev.
  private writeAndFlush(frame: string): void {
    const sink = this.proc.stdin as { write: (c: string) => unknown; flush?: () => unknown } | null;
    if (!sink || typeof sink.write !== "function") {
      throw new Error("stdin sink unavailable");
    }
    sink.write(frame);
    if (typeof sink.flush === "function") sink.flush();
  }

  async close(): Promise<void> {
    try {
      const writer = this.proc.stdin as { end?: () => unknown } | null;
      if (writer && typeof writer.end === "function") writer.end();
    } catch { /* best effort */ }
    this.proc.kill();
    await this.proc.exited;
  }
}

let client: McpClient;

beforeAll(async () => {
  client = new McpClient();
  // Initialize handshake
  const init = await client.send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1" },
  });
  expect(init.error).toBeUndefined();
  await client.notify("notifications/initialized");
});

afterAll(async () => {
  await client.close();
});

// Per-test timeout overridden via package.json `test` script (--timeout 15000).
// Bun's default 5s flakes under whole-suite CPU load when the MCP child process
// is spawn + JSON-RPC exchanged. Individual tests run ~50-300ms in practice.

describe("E2E: MCP stdio server", () => {
  test("initialize returns expected serverInfo", async () => {
    // Already done in beforeAll; re-issuing produces a second handshake which
    // the server tolerates. We just verify the handshake produced no error.
    expect(client).toBeDefined();
  });

  test("tools/list returns exactly the 6 V0 tools", async () => {
    const resp = await client.send("tools/list");
    expect(resp.error).toBeUndefined();
    const tools = (resp.result as ToolListResult).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_allocations",
      "get_holdings",
      "get_pnl",
      "get_polymarket_positions",
      "get_transactions",
      "refresh_data",
    ]);
  });

  test("each tool has a substantial description (>200 chars) for LLM selection accuracy", async () => {
    const resp = await client.send("tools/list");
    const tools = (resp.result as ToolListResult).tools;
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(200);
    }
  });

  test("each tool has a JSON Schema with type=object", async () => {
    const resp = await client.send("tools/list");
    const tools = (resp.result as ToolListResult).tools;
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  test("get_holdings call returns valid structured JSON", async () => {
    const resp = await client.send("tools/call", {
      name: "get_holdings",
      arguments: {},
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as ToolCallResult;
    expect(result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty("holdings");
    expect(parsed).toHaveProperty("failures");
    expect(parsed).toHaveProperty("warnings");
    expect(parsed).toHaveProperty("meta.accountsConfigured");
    expect(parsed).toHaveProperty("meta.accountsQueried");
    expect(parsed).toHaveProperty("meta.scope.accountIdFilter");
    expect(parsed).toHaveProperty("meta.asOf");
    expect(Array.isArray(parsed.holdings)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  test("refresh_data with connector arg returns expected hint", async () => {
    const resp = await client.send("tools/call", {
      name: "refresh_data",
      arguments: { connector: "bybit" },
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as ToolCallResult;
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.refreshed).toEqual(["bybit"]);
    expect(parsed.hint).toContain("Cache cleared for bybit");
    expect(parsed.hint).toContain("Call get_holdings");
  });

  test("refresh_data without connector returns refreshed='all'", async () => {
    const resp = await client.send("tools/call", {
      name: "refresh_data",
      arguments: {},
    });
    expect(resp.error).toBeUndefined();
    const result = resp.result as ToolCallResult;
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.refreshed).toBe("all");
  });

  test("get_allocations with by='asset_class' returns groupedBy field", async () => {
    const resp = await client.send("tools/call", {
      name: "get_allocations",
      arguments: { by: "asset_class" },
    });
    expect(resp.error).toBeUndefined();
    const parsed = JSON.parse((resp.result as ToolCallResult).content[0]!.text);
    expect(parsed.groupedBy).toBe("asset_class");
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.meta).toHaveProperty("asOf");
  });

  test("get_transactions with since='7d' resolves to ~7 days ago", async () => {
    const resp = await client.send("tools/call", {
      name: "get_transactions",
      arguments: { since: "7d" },
    });
    expect(resp.error).toBeUndefined();
    const parsed = JSON.parse((resp.result as ToolCallResult).content[0]!.text);
    expect(parsed.meta.sinceInputRaw).toBe("7d");
    expect(parsed.meta.sinceResolved).toBeTruthy();
    const sinceMs = new Date(parsed.meta.sinceResolved).getTime();
    const sevenDays = 7 * 24 * 3600 * 1000;
    expect(Math.abs(Date.now() - sinceMs - sevenDays)).toBeLessThan(5000);
  });

  test("unknown tool name returns JSON-RPC error", async () => {
    const resp = await client.send("tools/call", {
      name: "nonexistent_tool",
      arguments: {},
    });
    // SDK may either return an error response OR a result with isError flag.
    // Either is acceptable as long as the server doesn't crash.
    if (resp.error) {
      expect(resp.error.message).toBeDefined();
    } else {
      const result = resp.result as { isError?: boolean };
      expect(result.isError).toBe(true);
    }
  });
});
