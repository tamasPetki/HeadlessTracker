// CLI integration test for the `demo` command. Spawns the actual binary and
// asserts it renders the sample portfolio with no accounts configured and no
// network — the zero-credential "try it in one command" path — and that the
// "not financial advice" disclaimer is present.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "bin", "headless-tracker.ts");

async function runCli(args: string[], timeoutMs = 15000): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.exitCode ?? -1, stdout };
}

describe("CLI: headless-tracker demo", () => {
  test("renders the sample portfolio and exits 0 with no setup", async () => {
    const { exitCode, stdout } = await runCli(["demo"]);
    expect(exitCode).toBe(0);
    // Headline total and venue count (snapshot guard on the dataset).
    expect(stdout).toContain("Total: $104126");
    expect(stdout).toContain("across 5 venues");
    // The multi-venue story: at least the exchange + a wallet + the prediction market.
    expect(stdout).toContain("bybit:UNIFIED");
    expect(stdout).toContain("solana:");
    expect(stdout).toContain("polymarket:");
    // Sells the agent experience.
    expect(stdout).toContain("get_holdings");
    // Compliance disclaimer must survive.
    expect(stdout.toLowerCase()).toContain("not financial advice");
  });
});
