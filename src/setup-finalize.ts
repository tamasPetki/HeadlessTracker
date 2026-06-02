// Shared tail for every connector setup, used by both the CLI (bin/headless-tracker.ts)
// and the MCP setup_connector tool: persist credentials, then register the account
// so the holdings / pnl / transactions tools can enumerate it.
//
// Headless behavior (the bug this fixes): on systems without an OS Secret Service
// (Docker, WSL, many Linux servers, CI), the keyring write fails. Setup used to
// abort at that point, which left the account unregistered AND left the env-var
// credential fallback in vault.ts unreachable (the data tools enumerate the
// AccountStore, so an account that was never registered is invisible no matter
// what env vars are set). We now register the account regardless and tell the
// user exactly which env var to set. This completes the env-var fallback that
// vault.ts was already designed for. No secrets are written to disk here.

import type { Account, ConnectorId } from "./types.ts";
import type { AccountStore } from "./accounts.ts";
import { envVarName, type Vault } from "./vault.ts";
import type { ConnectorCredentials } from "./connectors/types.ts";

export interface FinalizeResult {
  ok: boolean;
  /** Set when the OS keychain was unavailable; tells the user how to supply creds via env var. */
  warning?: string;
}

export async function finalizeAccountSetup(
  vault: Vault,
  store: AccountStore,
  connectorId: ConnectorId,
  accountIdentifier: string,
  creds: ConnectorCredentials,
  account: Account
): Promise<FinalizeResult> {
  const setResult = await vault.set(connectorId, accountIdentifier, creds);

  // Register the account either way, so the data tools can see it. The account
  // row holds no secrets (id, label, and public metadata like a wallet address).
  store.upsert(account);

  if (setResult.ok) return { ok: true };

  const envVar = envVarName(connectorId, accountIdentifier);
  return {
    ok: true,
    warning:
      `OS keychain unavailable, so credentials were NOT stored (${setResult.error.message}). ` +
      `The account is registered. On a headless system (Docker, WSL, a server, CI), supply the ` +
      `credentials by setting the ${envVar} environment variable to a JSON object in your MCP ` +
      `server's env, then restart. See the README "Headless / no OS keychain" section for the JSON shape.`,
  };
}
