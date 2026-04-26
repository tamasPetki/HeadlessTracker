// Credential vault — primary backend is OS keystore via @napi-rs/keyring
// (eng review 1B: napi-rs/keyring instead of deprecated keytar).
// Fallback: .env env var (HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT>=<json>) for headless
// Linux without Secret Service, CI runs, or users who prefer plain env vars.

import { Entry } from "@napi-rs/keyring";

import type { ConnectorCredentials } from "./connectors/types.ts";
import type { ConnectorId, Result } from "./types.ts";
import { err, ok } from "./types.ts";

const SERVICE = "headless-tracker";

function entryAccountName(connectorId: ConnectorId, accountIdentifier: string): string {
  return `${connectorId}:${accountIdentifier}`;
}

function envVarName(connectorId: ConnectorId, accountIdentifier: string): string {
  // HEADLESS_TRACKER_BYBIT_UNIFIED, HEADLESS_TRACKER_METAMASK_0XABC...
  const safe = accountIdentifier.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `HEADLESS_TRACKER_${connectorId.toUpperCase()}_${safe}`;
}

function tryKeyring(connectorId: ConnectorId, accountIdentifier: string): Entry {
  return new Entry(SERVICE, entryAccountName(connectorId, accountIdentifier));
}

export interface Vault {
  get(connectorId: ConnectorId, accountIdentifier: string): Promise<Result<ConnectorCredentials>>;
  set(connectorId: ConnectorId, accountIdentifier: string, creds: ConnectorCredentials): Promise<Result<void>>;
  remove(connectorId: ConnectorId, accountIdentifier: string): Promise<Result<void>>;
}

export class KeyringVault implements Vault {
  async get(
    connectorId: ConnectorId,
    accountIdentifier: string
  ): Promise<Result<ConnectorCredentials>> {
    // Env var fallback takes precedence — explicit user override beats stored secrets.
    const envValue = process.env[envVarName(connectorId, accountIdentifier)];
    if (envValue) {
      try {
        return ok(JSON.parse(envValue) as ConnectorCredentials);
      } catch (e) {
        return err(
          "schema_mismatch",
          `Env var ${envVarName(connectorId, accountIdentifier)} is not valid JSON`,
          { cause: e }
        );
      }
    }

    try {
      const entry = tryKeyring(connectorId, accountIdentifier);
      const raw = entry.getPassword();
      if (raw === null) {
        return err(
          "not_found",
          `No credentials stored for ${connectorId}:${accountIdentifier}. Run: headless-tracker setup ${connectorId}`
        );
      }
      return ok(JSON.parse(raw) as ConnectorCredentials);
    } catch (e) {
      return err(
        "unknown",
        `Keyring backend unavailable for ${connectorId}:${accountIdentifier}. Set ${envVarName(connectorId, accountIdentifier)} env var as fallback.`,
        { cause: e }
      );
    }
  }

  async set(
    connectorId: ConnectorId,
    accountIdentifier: string,
    creds: ConnectorCredentials
  ): Promise<Result<void>> {
    try {
      const entry = tryKeyring(connectorId, accountIdentifier);
      entry.setPassword(JSON.stringify(creds));
      return ok(undefined);
    } catch (e) {
      return err(
        "unknown",
        `Failed to write credentials to OS keyring. Use ${envVarName(connectorId, accountIdentifier)} env var instead.`,
        { cause: e }
      );
    }
  }

  async remove(connectorId: ConnectorId, accountIdentifier: string): Promise<Result<void>> {
    try {
      const entry = tryKeyring(connectorId, accountIdentifier);
      entry.deletePassword();
      return ok(undefined);
    } catch (e) {
      return err("unknown", "Failed to delete credentials from OS keyring.", { cause: e });
    }
  }
}

let _defaultVault: Vault | null = null;
export function defaultVault(): Vault {
  if (!_defaultVault) {
    _defaultVault = new KeyringVault();
  }
  return _defaultVault;
}
