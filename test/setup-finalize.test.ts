// finalizeAccountSetup — the shared setup tail that fixes headless onboarding.
// In-memory AccountStore, fake Vault, no network or keychain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AccountStore } from "../src/accounts.ts";
import { finalizeAccountSetup } from "../src/setup-finalize.ts";
import { err, ok, type Account, type Result } from "../src/types.ts";
import type { Vault } from "../src/vault.ts";
import type { ConnectorCredentials } from "../src/connectors/types.ts";

const account: Account = {
  id: "solana:ADDR",
  connectorId: "solana",
  label: "Solana ADDR",
  createdAt: 1,
  metadata: { address: "ADDR" },
};
const creds = { address: "ADDR" } as ConnectorCredentials;

function makeVault(keychainOk: boolean): Vault {
  return {
    async get(): Promise<Result<ConnectorCredentials>> {
      return err("not_found", "n/a");
    },
    async set(): Promise<Result<void>> {
      return keychainOk
        ? ok(undefined)
        : err("unknown", "Failed to write credentials to OS keyring.");
    },
    async remove(): Promise<Result<void>> {
      return ok(undefined);
    },
  };
}

let store: AccountStore;
beforeEach(() => {
  store = new AccountStore({ dbPath: ":memory:" });
});
afterEach(() => {
  store.close();
});

describe("finalizeAccountSetup", () => {
  test("keychain available: registers account, no warning", async () => {
    const r = await finalizeAccountSetup(makeVault(true), store, "solana", "ADDR", creds, account);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
    expect(store.get("solana:ADDR")).not.toBeNull();
  });

  test("keychain unavailable (headless): still registers account + returns env-var warning", async () => {
    const r = await finalizeAccountSetup(makeVault(false), store, "solana", "ADDR", creds, account);
    // Does NOT abort — this was the bug: setup used to fail here and never register.
    expect(r.ok).toBe(true);
    // Account is registered despite the keychain write failing, so the data tools can see it.
    expect(store.get("solana:ADDR")).not.toBeNull();
    // The warning names the exact env var the user must set as the credential fallback.
    expect(r.warning).toContain("HEADLESS_TRACKER_SOLANA_ADDR");
  });
});
