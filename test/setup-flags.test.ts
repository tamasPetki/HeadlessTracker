// Tests for non-interactive setup flag parsing (issue #4). Pure functions, no
// network: deeper credential validation happens in the connector later.

import { describe, expect, test } from "bun:test";
import {
  parseFlags,
  buildSetupArgs,
  ENV_API_KEY,
  ENV_API_SECRET,
  ENV_ETHERSCAN_KEY,
} from "../src/setup-flags.ts";

describe("parseFlags", () => {
  test("parses --key=value, boolean --flag, and values containing '='", () => {
    const f = parseFlags(["--address=abc", "--include-futures", "--rpc=https://x.io/?k=v"]);
    expect(f.address).toBe("abc");
    expect(f["include-futures"]).toBe("true");
    expect(f.rpc).toBe("https://x.io/?k=v");
  });

  test("ignores non-flag tokens", () => {
    expect(parseFlags(["solana", "--address=x"])).toEqual({ address: "x" });
  });
});

describe("buildSetupArgs — solana (public address, no secret)", () => {
  test("builds args from --address with optional rpc/dust", () => {
    const r = buildSetupArgs("solana", parseFlags(["--address=4k3Dyjzvzp", "--rpc=https://r.io", "--dust=1.5"]), {});
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ connector: "solana", solana: { address: "4k3Dyjzvzp", rpcUrl: "https://r.io", dustThresholdUsd: 1.5 } });
  });

  test("requires --address", () => {
    const r = buildSetupArgs("solana", {}, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("--address");
  });

  test("rejects a negative/NaN --dust", () => {
    expect(buildSetupArgs("solana", parseFlags(["--address=x", "--dust=-1"]), {}).ok).toBe(false);
    expect(buildSetupArgs("solana", parseFlags(["--address=x", "--dust=abc"]), {}).ok).toBe(false);
  });
});

describe("buildSetupArgs — polymarket (public address, no secret)", () => {
  test("builds args from --proxy-wallet", () => {
    const r = buildSetupArgs("polymarket", parseFlags(["--proxy-wallet=0xabc", "--size-threshold=0.5"]), {});
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ connector: "polymarket", polymarket: { proxyWallet: "0xabc", sizeThreshold: 0.5 } });
  });

  test("requires --proxy-wallet", () => {
    expect(buildSetupArgs("polymarket", {}, {}).ok).toBe(false);
  });
});

describe("buildSetupArgs — metamask (etherscan key from env, not argv)", () => {
  const env = { [ENV_ETHERSCAN_KEY]: "ESK" };

  test("builds args; chains parsed; secret read from env; bool defaults", () => {
    const r = buildSetupArgs("metamask", parseFlags(["--address=0xWALLET", "--chains=1,137,8453"]), env);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({
      connector: "metamask",
      metamask: { address: "0xWALLET", etherscanApiKey: "ESK", chainIds: [1, 137, 8453], trackCommonTokens: true, hasEtherscanPro: false },
    });
  });

  test("respects --track-common-tokens=false and --etherscan-pro", () => {
    const r = buildSetupArgs("metamask", parseFlags(["--address=0x", "--chains=1", "--track-common-tokens=false", "--etherscan-pro"]), env);
    expect(r.args!.metamask!.trackCommonTokens).toBe(false);
    expect(r.args!.metamask!.hasEtherscanPro).toBe(true);
  });

  test("requires --address, --chains, and the etherscan-key env var", () => {
    expect(buildSetupArgs("metamask", parseFlags(["--chains=1"]), env).error).toContain("--address");
    expect(buildSetupArgs("metamask", parseFlags(["--address=0x"]), env).error).toContain("--chains");
    const noEnv = buildSetupArgs("metamask", parseFlags(["--address=0x", "--chains=1"]), {});
    expect(noEnv.ok).toBe(false);
    expect(noEnv.error).toContain(ENV_ETHERSCAN_KEY);
  });

  test("rejects non-numeric chains", () => {
    expect(buildSetupArgs("metamask", parseFlags(["--address=0x", "--chains=1,foo"]), env).ok).toBe(false);
  });
});

describe("buildSetupArgs — bybit (secret from env, not argv)", () => {
  const env = { [ENV_API_KEY]: "K", [ENV_API_SECRET]: "S" };

  test("builds args with account-type and optional --also fan-out", () => {
    const r = buildSetupArgs("bybit", parseFlags(["--account-type=unified", "--also=FUND,SPOT"]), env);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ connector: "bybit", bybit: { apiKey: "K", apiSecret: "S", accountType: "UNIFIED", accountTypes: ["FUND", "SPOT"] } });
  });

  test("requires a valid --account-type", () => {
    expect(buildSetupArgs("bybit", parseFlags(["--account-type=BOGUS"]), env).ok).toBe(false);
    expect(buildSetupArgs("bybit", {}, env).error).toContain("--account-type");
  });

  test("requires the api-key/secret env vars (kept out of argv)", () => {
    const r = buildSetupArgs("bybit", parseFlags(["--account-type=UNIFIED"]), {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_API_KEY);
  });

  test("rejects an invalid --also type", () => {
    expect(buildSetupArgs("bybit", parseFlags(["--account-type=UNIFIED", "--also=FUND,NOPE"]), env).ok).toBe(false);
  });
});

describe("buildSetupArgs — binance (secret from env, not argv)", () => {
  const env = { [ENV_API_KEY]: "K", [ENV_API_SECRET]: "S" };

  test("builds args; includeFutures + recvWindow", () => {
    const r = buildSetupArgs("binance", parseFlags(["--include-futures", "--recv-window=5000"]), env);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ connector: "binance", binance: { apiKey: "K", apiSecret: "S", includeFutures: true, recvWindow: 5000 } });
  });

  test("defaults includeFutures=false and requires env secrets", () => {
    expect(buildSetupArgs("binance", {}, env).args!.binance!.includeFutures).toBe(false);
    expect(buildSetupArgs("binance", {}, {}).error).toContain(ENV_API_SECRET);
  });

  test("rejects a non-positive --recv-window", () => {
    expect(buildSetupArgs("binance", parseFlags(["--recv-window=0"]), env).ok).toBe(false);
  });
});

describe("buildSetupArgs — unknown connector", () => {
  test("returns an error", () => {
    expect(buildSetupArgs("dogecoin", {}, {}).ok).toBe(false);
  });
});
