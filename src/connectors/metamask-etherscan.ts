// MetaMask / EVM connector — Etherscan V2 transport layer.
//
// Pulled out of metamask.ts so the HTTP call to Etherscan and its error mapping
// live in one place, separate from the connector that decides *what* to fetch.
// `etherscanCall` is the single seam every chain/balance/transaction request
// goes through; it owns status-code and status="0" error classification and
// returns the project's Result<T>.
//
// API docs: https://docs.etherscan.io/etherscan-v2

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

interface EtherscanResponse<T> {
  status: string;   // "1" = success, "0" = error
  message: string;  // "OK" on success
  result: T | string;  // string when status=0 (error message)
}

export async function etherscanCall<T>(
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<Result<T>> {
  const url = new URL(ETHERSCAN_V2_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return err("network_timeout", "Etherscan request aborted");
    }
    return err("network_error", `Etherscan fetch failed: ${(e as Error).message}`, { cause: e });
  }

  if (!resp.ok) {
    if (resp.status === 429) {
      return err("rate_limited", "Etherscan rate limit hit (HTTP 429)");
    }
    if (resp.status === 401 || resp.status === 403) {
      return err("auth_failed", `Etherscan auth failed (HTTP ${resp.status})`);
    }
    return err("upstream_error", `Etherscan HTTP ${resp.status}`);
  }

  let json: EtherscanResponse<T>;
  try {
    json = (await resp.json()) as EtherscanResponse<T>;
  } catch (e) {
    return err("schema_mismatch", "Etherscan returned non-JSON", { cause: e });
  }

  if (json.status === "0") {
    const msg = typeof json.result === "string" ? json.result : json.message;
    // Etherscan returns "No transactions found" with status=0 for empty histories.
    // Treat that as ok([]) at the caller level — here we surface it.
    if (typeof msg === "string" && msg.toLowerCase().includes("no transactions found")) {
      return ok([] as unknown as T);
    }
    if (typeof msg === "string" && (msg.toLowerCase().includes("invalid api key") || msg.toLowerCase().includes("api key"))) {
      return err("auth_failed", `Etherscan: ${msg}`);
    }
    if (typeof msg === "string" && msg.toLowerCase().includes("rate limit")) {
      return err("rate_limited", `Etherscan: ${msg}`);
    }
    return err("upstream_error", `Etherscan error: ${msg}`);
  }

  return ok(json.result as T);
}
