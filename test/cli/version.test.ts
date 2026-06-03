// CLI integration test for the `version` command. Spawns the actual binary
// (the same path end-users hit) and asserts it prints the package.json version
// and exits 0 for each accepted form.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "bin", "headless-tracker.ts");
const PKG_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

async function runCli(args: string[], timeoutMs = 15000): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  return { exitCode: proc.exitCode ?? -1, stdout };
}

describe("CLI: headless-tracker version", () => {
  for (const form of ["version", "--version", "-v"]) {
    test(`\`${form}\` prints the package version and exits 0`, async () => {
      const result = await runCli([form]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`headless-tracker v${PKG_VERSION}`);
    });
  }
});
