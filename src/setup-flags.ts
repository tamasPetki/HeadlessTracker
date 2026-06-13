// Non-interactive setup: map CLI flags (+ env for secrets) into the same
// SetupConnectorArgs the interactive flow and the MCP setup tool already use.
//
// Why this exists (issue #4): `headless-tracker setup <connector>` was
// interactive-only — it drove readline prompts and took no flags, so any
// non-interactive invocation (a pipe, a script, a Dockerfile, CI) silently
// no-opped (the readline question never resolves on a non-TTY, the process
// exits 0 before registering anything). That broke the headless/automation
// use case the README and SECURITY.md explicitly describe.
//
// SECRETS NEVER COME FROM ARGV. API keys/secrets and the Etherscan key are
// read from environment variables, never from `--flags`, so they don't leak
// into shell history or the process list. Public on-chain addresses (Solana,
// MetaMask, Polymarket) are not secrets and are passed as flags.

import type { SetupConnectorArgs } from "./mcp/tools/setup_connector.ts";

export type Flags = Record<string, string>;

// Env var names for the one-shot setup secrets (distinct from the runtime
// HEADLESS_TRACKER_<CONNECTOR>_<ACCOUNT> credential fallback in vault.ts).
export const ENV_API_KEY = "HT_SETUP_API_KEY";
export const ENV_API_SECRET = "HT_SETUP_API_SECRET";
export const ENV_ETHERSCAN_KEY = "HT_SETUP_ETHERSCAN_KEY";

/** Parse `--key=value` / `--flag` (boolean) tokens. A value may contain `=`. */
export function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]!] = m[2] ?? "true";
  }
  return flags;
}

function boolish(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return v === "true" || v === "1" || v === "yes";
}

export interface BuildResult {
  ok: boolean;
  args?: SetupConnectorArgs;
  error?: string;
}

type Env = Record<string, string | undefined>;

const BYBIT_TYPES = ["UNIFIED", "CONTRACT", "SPOT", "FUND"] as const;
type BybitType = (typeof BYBIT_TYPES)[number];

/**
 * Build SetupConnectorArgs from CLI flags + env. Validates presence/shape of
 * inputs; deeper validation (address format, upstream reachability) happens in
 * the connector's validateCredentials when the args are executed. Returns a
 * clear error instead of throwing, so the CLI can print it and exit non-zero.
 */
export function buildSetupArgs(connector: string, flags: Flags, env: Env): BuildResult {
  switch (connector) {
    case "solana": {
      const address = flags.address;
      if (!address) return { ok: false, error: "solana requires --address=<base58 address>" };
      const solana: NonNullable<SetupConnectorArgs["solana"]> = { address };
      if (flags.rpc) solana.rpcUrl = flags.rpc;
      if (flags.dust !== undefined) {
        const d = Number(flags.dust);
        if (Number.isNaN(d) || d < 0) return { ok: false, error: `invalid --dust value: ${flags.dust}` };
        solana.dustThresholdUsd = d;
      }
      return { ok: true, args: { connector: "solana", solana } };
    }

    case "polymarket": {
      const proxyWallet = flags["proxy-wallet"];
      if (!proxyWallet) return { ok: false, error: "polymarket requires --proxy-wallet=<0x address>" };
      const polymarket: NonNullable<SetupConnectorArgs["polymarket"]> = { proxyWallet };
      if (flags["size-threshold"] !== undefined) {
        const s = Number(flags["size-threshold"]);
        if (Number.isNaN(s) || s < 0) return { ok: false, error: `invalid --size-threshold value: ${flags["size-threshold"]}` };
        polymarket.sizeThreshold = s;
      }
      return { ok: true, args: { connector: "polymarket", polymarket } };
    }

    case "metamask": {
      const address = flags.address;
      if (!address) return { ok: false, error: "metamask requires --address=<0x address>" };
      if (!flags.chains) return { ok: false, error: "metamask requires --chains=<comma-separated chain ids, e.g. 1,137,8453>" };
      const chainIds = flags.chains.split(",").map((s) => parseInt(s.trim(), 10));
      if (chainIds.some((n) => Number.isNaN(n))) return { ok: false, error: `invalid --chains value: ${flags.chains}` };
      const etherscanApiKey = env[ENV_ETHERSCAN_KEY];
      if (!etherscanApiKey) {
        return { ok: false, error: `metamask requires the Etherscan key in the ${ENV_ETHERSCAN_KEY} env var (kept out of argv)` };
      }
      const metamask: NonNullable<SetupConnectorArgs["metamask"]> = {
        address,
        etherscanApiKey,
        chainIds,
        trackCommonTokens: boolish(flags["track-common-tokens"], true),
        hasEtherscanPro: boolish(flags["etherscan-pro"], false),
      };
      return { ok: true, args: { connector: "metamask", metamask } };
    }

    case "bybit": {
      const accountType = (flags["account-type"] || "").toUpperCase();
      if (!BYBIT_TYPES.includes(accountType as BybitType)) {
        return { ok: false, error: "bybit requires --account-type=UNIFIED|CONTRACT|SPOT|FUND" };
      }
      const apiKey = env[ENV_API_KEY];
      const apiSecret = env[ENV_API_SECRET];
      if (!apiKey || !apiSecret) {
        return { ok: false, error: `bybit requires ${ENV_API_KEY} and ${ENV_API_SECRET} env vars (kept out of argv)` };
      }
      const bybit: NonNullable<SetupConnectorArgs["bybit"]> = {
        apiKey,
        apiSecret,
        accountType: accountType as BybitType,
      };
      if (flags.also) {
        const extras = flags.also.split(",").map((s) => s.trim().toUpperCase());
        const bad = extras.find((t) => !BYBIT_TYPES.includes(t as BybitType));
        if (bad) return { ok: false, error: `invalid --also account type: ${bad}` };
        bybit.accountTypes = extras as BybitType[];
      }
      return { ok: true, args: { connector: "bybit", bybit } };
    }

    case "binance": {
      const apiKey = env[ENV_API_KEY];
      const apiSecret = env[ENV_API_SECRET];
      if (!apiKey || !apiSecret) {
        return { ok: false, error: `binance requires ${ENV_API_KEY} and ${ENV_API_SECRET} env vars (kept out of argv)` };
      }
      const binance: NonNullable<SetupConnectorArgs["binance"]> = {
        apiKey,
        apiSecret,
        includeFutures: boolish(flags["include-futures"], false),
      };
      if (flags["recv-window"] !== undefined) {
        const r = parseInt(flags["recv-window"], 10);
        if (Number.isNaN(r) || r <= 0) return { ok: false, error: `invalid --recv-window value: ${flags["recv-window"]}` };
        binance.recvWindow = r;
      }
      return { ok: true, args: { connector: "binance", binance } };
    }

    default:
      return { ok: false, error: `unknown connector: ${connector}` };
  }
}
