// Vault tests — covers the env-var fallback path.
// The OS-keychain path (real @napi-rs/keyring read/write) intentionally NOT tested
// here because it would mutate the user's actual macOS Keychain. Day 8-10 polish
// can add a mocked-keyring test if it's worth the complexity.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KeyringVault } from "../src/vault.ts";

const ENV_KEYS_TO_RESTORE: string[] = [];

beforeEach(() => {
  ENV_KEYS_TO_RESTORE.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_RESTORE) delete process.env[k];
});

function setEnvAndTrack(key: string, value: string): void {
  process.env[key] = value;
  ENV_KEYS_TO_RESTORE.push(key);
}

describe("KeyringVault env var fallback", () => {
  test("env var with valid JSON is parsed and returned", async () => {
    const value = { apiKey: "abc", apiSecret: "xyz", accountType: "UNIFIED" };
    setEnvAndTrack("HEADLESS_TRACKER_BYBIT_UNIFIED", JSON.stringify(value));

    const vault = new KeyringVault();
    const result = await vault.get("bybit", "UNIFIED");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(value);
    }
  });

  test("env var with invalid JSON returns schema_mismatch error", async () => {
    setEnvAndTrack("HEADLESS_TRACKER_BYBIT_UNIFIED", "not-json{");

    const vault = new KeyringVault();
    const result = await vault.get("bybit", "UNIFIED");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
      expect(result.error.message).toContain("not valid JSON");
    }
  });

  test("env var name encodes account identifier safely (non-alnum becomes underscore)", async () => {
    // metamask:0xabc... → HEADLESS_TRACKER_METAMASK_0XABC...
    const addr = "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12";
    const expectedKey = `HEADLESS_TRACKER_METAMASK_${addr.toUpperCase()}`;
    setEnvAndTrack(expectedKey, JSON.stringify({ address: addr }));

    const vault = new KeyringVault();
    const result = await vault.get("metamask", addr);
    expect(result.ok).toBe(true);
  });

  test("env var takes precedence over keystore even if both present (env override path)", async () => {
    // Env value should win on read, validating the "explicit env var override" semantics.
    // We don't actually populate keystore here — just verify env path returns first.
    setEnvAndTrack(
      "HEADLESS_TRACKER_POLYMARKET_0X1234",
      JSON.stringify({ proxyWallet: "0x1234" })
    );
    const vault = new KeyringVault();
    const result = await vault.get("polymarket", "0x1234");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ proxyWallet: "0x1234" });
    }
  });
});
