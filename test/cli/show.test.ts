// CLI integration test for the `show` subcommands. Spawns the actual binary as
// a subprocess (same path that end-users hit) and asserts the human-readable
// stdout shape. Uses `--account-id=does-not-exist:foo` to force an empty result
// regardless of what the user's real ~/.headless-tracker/accounts.db contains.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "bin", "headless-tracker.ts");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], timeoutMs = 15000): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

describe("CLI: headless-tracker show", () => {
  test("`show` with no thing prints usage and exits 0", async () => {
    const result = await runCli(["show"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: headless-tracker show");
    expect(result.stdout).toContain("holdings");
    expect(result.stdout).toContain("pnl");
    expect(result.stdout).toContain("transactions");
  });

  test("`show invalidthing` exits 1 with usage", async () => {
    const result = await runCli(["show", "invalidthing"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage: headless-tracker show");
  });

  test("`show holdings --account-id=does-not-exist:foo` returns empty result, exit 0", async () => {
    // Forces an empty result independent of the user's real accounts.db.
    const result = await runCli([
      "show",
      "holdings",
      "--account-id=does-not-exist:foo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No holdings found");
  });

  test("`show pnl --account-id=does-not-exist:foo` exits 0 with empty message", async () => {
    const result = await runCli([
      "show",
      "pnl",
      "--account-id=does-not-exist:foo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No P&L data");
  });

  test("`show transactions --since=24h --account-id=does-not-exist:foo` exits 0 with empty message", async () => {
    const result = await runCli([
      "show",
      "transactions",
      "--since=24h",
      "--account-id=does-not-exist:foo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No transactions");
  });

  test("`show tx` is an alias for `show transactions`", async () => {
    // Convenience alias — same code path. Verifies the alias plumbing.
    const result = await runCli([
      "show",
      "tx",
      "--since=24h",
      "--account-id=does-not-exist:foo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No transactions");
  });

  test("`help` mentions the new show commands", async () => {
    const result = await runCli(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("show holdings");
    expect(result.stdout).toContain("show pnl");
    expect(result.stdout).toContain("show transactions");
  });

  test("flag parser handles `--key=value` form", async () => {
    // The `=` form is the recommended syntax in help. Verify it parses.
    const result = await runCli(["show", "holdings", "--account-id=does-not-exist:foo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No holdings found");
  });

  test("flag parser handles `--key value` (space-separated) form", async () => {
    // Some users habitually use spaces. Both should work.
    const result = await runCli(["show", "holdings", "--account-id", "does-not-exist:foo"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No holdings found");
  });
});
