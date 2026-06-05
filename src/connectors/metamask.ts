// MetaMask / EVM wallet connector — read-only on-chain wallet tracking.
// Uses Etherscan V2 unified API: single API key, chainid query parameter
// covers Ethereum, Polygon, Base, Arbitrum, Optimism, BSC, etc.
//
// V0 scope:
//   - Native balance for each user-selected chain (ETH/MATIC/BNB)
//   - Bundled "common ERC-20" list (USDC, USDT, WETH, WBTC, LINK, DAI) per chain,
//     opt-in at setup. Custom token lists are V0.2 (Day 8-10 polish).
//   - Native + ERC-20 transactions are fetched separately for each chain.
//
// V0.2 scope (deferred):
//   - User-provided custom token contracts via `headless-tracker token add`
//   - Multiple wallets per Account (currently one address per Account)
//   - ETH/USD price for value computation (Etherscan ethprice endpoint, free)
//
// API docs: https://docs.etherscan.io/etherscan-v2

import type { Connector, ConnectorContext, ConnectorCredentials } from "./types.ts";
import type { Holding, Result, Transaction } from "../types.ts";
import { err, ok } from "../types.ts";
import {
  SUPPORTED_CHAINS,
  type SupportedChainId,
  COMMON_TOKENS,
  FREE_TIER_BLOCKED_MARKER,
} from "./metamask-chains.ts";
import { etherscanCall } from "./metamask-etherscan.ts";

interface MetaMaskCreds extends ConnectorCredentials {
  // Legacy single-address field. New code should populate `addresses[]`. Kept
  // for back-compat: existing v0.7.x vaults have `address` only, and the
  // connector auto-lifts it to a 1-element `addresses` list at runtime.
  address?: string;
  // Multi-wallet: one Account can track several addresses sharing the same
  // Etherscan key + chain selection (e.g. hot wallet + cold wallet for the
  // same user). Connector fans out per-address × per-chain at fetch time.
  addresses?: string[];
  etherscanApiKey: string;         // single key for all chains via V2
  chainIds: SupportedChainId[];    // which chains to query
  trackCommonTokens: boolean;      // include the bundled COMMON_TOKENS list per chain
  customTokens?: Record<SupportedChainId, Array<{ contract: string; symbol: string; decimals: number }>>;
  // If true, the user has confirmed they have an Etherscan Pro plan and wants
  // BSC / Base / other paid-tier chains queried. Default false → those chains
  // are soft-skipped with a warning instead of hard-failing.
  hasEtherscanPro?: boolean;
}

const ADDRESS_RX = /^0x[a-fA-F0-9]{40}$/;

// Normalize legacy single-address vaults to a list. v0.8 #6 multi-wallet lift.
// Returns the canonical list of addresses to fan out over, or empty if neither
// `address` nor `addresses` was populated.
function getAddresses(creds: MetaMaskCreds): string[] {
  if (Array.isArray(creds.addresses) && creds.addresses.length > 0) {
    return creds.addresses;
  }
  if (typeof creds.address === "string" && creds.address.length > 0) {
    return [creds.address];
  }
  return [];
}

function isMetaMaskCreds(c: ConnectorCredentials): c is MetaMaskCreds {
  // Either form is acceptable: legacy single `address` OR new `addresses[]`.
  // At least one address must be a valid hex string.
  const single = typeof c.address === "string" && ADDRESS_RX.test(c.address);
  const list = Array.isArray(c.addresses)
    && c.addresses.length > 0
    && (c.addresses as unknown[]).every((a) => typeof a === "string" && ADDRESS_RX.test(a));
  return (
    (single || list) &&
    typeof c.etherscanApiKey === "string" &&
    Array.isArray(c.chainIds) &&
    typeof c.trackCommonTokens === "boolean"
  );
}

// Exported for unit-testability — converts wei-style integer strings to decimal numbers.
export function applyDecimals(raw: string, decimals: number): number {
  // BigInt division to avoid Number precision loss for 18-decimal values.
  // Then convert to Number for the public Holding type. Acceptable lossy at the
  // output boundary; internal arithmetic stays in BigInt.
  if (raw === "0" || raw === "") return 0;
  const negative = raw.startsWith("-");
  const abs = negative ? raw.slice(1) : raw;
  const padded = abs.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  const intPart = padded.slice(0, cut);
  const fracPart = padded.slice(cut).replace(/0+$/, "");
  const decimalStr = fracPart ? `${intPart}.${fracPart}` : intPart;
  const num = parseFloat(decimalStr);
  return negative ? -num : num;
}

export class MetaMaskConnector implements Connector {
  readonly id = "metamask" as const;
  readonly displayName = "MetaMask / EVM wallet (Etherscan V2)";
  readonly defaultCacheTtlSec = 60;

  async validateCredentials(
    creds: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<Result<void>> {
    if (!isMetaMaskCreds(creds)) {
      return err(
        "schema_mismatch",
        "MetaMask credentials must include { address (or addresses[]), etherscanApiKey, chainIds[], trackCommonTokens }"
      );
    }
    if (creds.chainIds.length === 0) {
      return err("schema_mismatch", "At least one chainId must be selected");
    }
    for (const chainId of creds.chainIds) {
      if (!(chainId in SUPPORTED_CHAINS)) {
        return err("schema_mismatch", `Unsupported chainId: ${chainId}`);
      }
    }
    const addresses = getAddresses(creds);
    if (addresses.length === 0) {
      return err("schema_mismatch", "At least one address must be provided (address or addresses[])");
    }

    // Validate the API key by checking ETH balance on chain 1 for the FIRST
    // address (cheapest call). If the key works for one address, it works
    // for all on that chain.
    const result = await etherscanCall<string>(
      {
        chainid: "1",
        module: "account",
        action: "balance",
        address: addresses[0]!,
        tag: "latest",
        apikey: creds.etherscanApiKey,
      },
      signal
    );
    if (!result.ok) return result;
    return ok(undefined);
  }

  async fetchHoldings(ctx: ConnectorContext): Promise<Result<Holding[]>> {
    if (!isMetaMaskCreds(ctx.credentials)) {
      return err("schema_mismatch", "MetaMask credentials malformed");
    }
    const creds = ctx.credentials;
    const addresses = getAddresses(creds);
    const allHoldings: Holding[] = [];
    const chainErrors: string[] = [];
    const skippedChains: string[] = [];     // soft-skipped (e.g. free tier blocked)

    // Filter the user's selected chains down to "we will actually try this chain".
    // Free-tier-blocked chains are skipped (with a warning) unless the user has
    // explicitly opted into Pro tier.
    const chainsToQuery: SupportedChainId[] = [];
    for (const chainId of creds.chainIds) {
      const info = SUPPORTED_CHAINS[chainId];
      if (!info.freeTier && !creds.hasEtherscanPro) {
        skippedChains.push(`${info.name} (chain ${chainId}) requires Etherscan Pro — set hasEtherscanPro:true in credentials to query it`);
        continue;
      }
      chainsToQuery.push(chainId);
    }

    // Fan out per-(address, chain) in parallel. With N=1 wallet (the v0.7
    // case) and chains=6, this is the same 6 calls as before. With N=2
    // wallets it's 12 calls — Etherscan free tier is 5 calls/sec, but the
    // SDK absorbs short bursts via retries, and our chain-level token
    // sub-fetch is already sequential per chain to stay under that limit.
    const perAddrChain = await Promise.all(
      addresses.flatMap((address) =>
        chainsToQuery.map(async (chainId): Promise<{ chainId: SupportedChainId; address: string; result: Result<Holding[]> }> => {
          const chainResult = await this.fetchChainHoldings(ctx, chainId, address);
          return { chainId, address, result: chainResult };
        })
      )
    );

    for (const { chainId, address, result } of perAddrChain) {
      if (!result.ok) {
        if (result.error.message.toLowerCase().includes(FREE_TIER_BLOCKED_MARKER)) {
          const info = SUPPORTED_CHAINS[chainId];
          skippedChains.push(`${info.name} (chain ${chainId}) returned 'free tier not supported' at runtime — Etherscan key may not have access`);
          continue;
        }
        // Tag the error with the address so a multi-wallet user can see which
        // wallet had the issue.
        const tag = addresses.length > 1 ? ` (wallet ${address.slice(0, 6)}...${address.slice(-4)})` : "";
        chainErrors.push(`chain ${chainId}${tag}: ${result.error.message}`);
        continue;
      }
      allHoldings.push(...result.value);
    }

    // Partial success policy: if at least one chain returned data, return it.
    // Hard error only when EVERY queried chain failed AND nothing was soft-skipped.
    // If everything was soft-skipped (e.g. user picked only paid-tier chains without
    // hasEtherscanPro), return ok([]) with the warnings attached.
    if (allHoldings.length === 0 && chainErrors.length > 0) {
      return err("upstream_error", `All chains failed: ${chainErrors.join("; ")}`);
    }

    // Surface chain-level warnings via the first holding's metadata as a side-channel
    // (the Holding[] result type can't carry top-level warnings cleanly without changing
    // Result<T>). Callers that care can read `__chainWarnings` from the result; the
    // orchestrator + tools layer will eventually surface this in tool meta.
    if ((skippedChains.length > 0 || chainErrors.length > 0) && allHoldings.length > 0) {
      const warnings = [...skippedChains, ...chainErrors];
      const first = allHoldings[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: warnings };
    }

    return ok(allHoldings);
  }

  private async fetchChainHoldings(
    ctx: ConnectorContext,
    chainId: SupportedChainId,
    address: string
  ): Promise<Result<Holding[]>> {
    const creds = ctx.credentials as MetaMaskCreds;
    const chainInfo = SUPPORTED_CHAINS[chainId];
    const now = Date.now();
    const holdings: Holding[] = [];

    // Native balance.
    const nativeRes = await etherscanCall<string>(
      {
        chainid: String(chainId),
        module: "account",
        action: "balance",
        address,
        tag: "latest",
        apikey: creds.etherscanApiKey,
      },
      ctx.signal
    );
    if (!nativeRes.ok) return nativeRes;
    const nativeQty = applyDecimals(nativeRes.value, chainInfo.nativeDecimals);
    if (nativeQty > 0) {
      holdings.push({
        accountId: ctx.account.id,
        symbol: chainInfo.nativeSymbol,
        assetClass: "crypto",
        quantity: nativeQty,
        valueCurrency: "USD",
        metadata: { chainId, chainName: chainInfo.name, native: true, address },
        fetchedAt: now,
      });
    }

    // ERC-20 balances — common bundled list + custom tokens.
    const tokensToCheck: Array<{ contract: string; symbol: string; decimals: number }> = [];
    if (creds.trackCommonTokens) {
      tokensToCheck.push(...COMMON_TOKENS[chainId]);
    }
    if (creds.customTokens?.[chainId]) {
      tokensToCheck.push(...creds.customTokens[chainId]);
    }

    // Etherscan V2 has separate `tokenbalance` calls per contract.
    // Etherscan free tier: 5 calls/second. Sequential per chain to stay under.
    // (Could parallelize with throttling; kept simple for V0.)
    for (const token of tokensToCheck) {
      const tokenRes = await etherscanCall<string>(
        {
          chainid: String(chainId),
          module: "account",
          action: "tokenbalance",
          contractaddress: token.contract,
          address,
          tag: "latest",
          apikey: creds.etherscanApiKey,
        },
        ctx.signal
      );
      if (!tokenRes.ok) {
        if (tokenRes.error.kind === "rate_limited") break;
        continue;
      }
      const qty = applyDecimals(tokenRes.value, token.decimals);
      if (qty === 0) continue; // dust filter
      holdings.push({
        accountId: ctx.account.id,
        symbol: token.symbol,
        assetClass: "crypto",
        quantity: qty,
        valueCurrency: "USD",
        metadata: {
          chainId,
          chainName: chainInfo.name,
          contract: token.contract,
          decimals: token.decimals,
          address,
        },
        fetchedAt: now,
      });
    }

    return ok(holdings);
  }

  async fetchTransactions(
    ctx: ConnectorContext,
    since?: number
  ): Promise<Result<Transaction[]>> {
    if (!isMetaMaskCreds(ctx.credentials)) {
      return err("schema_mismatch", "MetaMask credentials malformed");
    }
    const creds = ctx.credentials;
    const addresses = getAddresses(creds);
    const allTxs: Transaction[] = [];
    const chainErrors: string[] = [];
    const skippedChains: string[] = [];

    // Same free-tier filtering as fetchHoldings.
    const chainsToQuery: SupportedChainId[] = [];
    for (const chainId of creds.chainIds) {
      const info = SUPPORTED_CHAINS[chainId];
      if (!info.freeTier && !creds.hasEtherscanPro) {
        skippedChains.push(`${info.name} (chain ${chainId}) requires Etherscan Pro`);
        continue;
      }
      chainsToQuery.push(chainId);
    }

    const startBlockApprox = since ? Math.max(0, Math.floor(since / 1000 / 13)) : 0;
    // ~13s avg block time on Ethereum, faster on L2s — coarse but Etherscan ignores
    // bad block numbers gracefully (returns empty if startBlock > tip).

    // Same fan-out shape as fetchHoldings: per-(address × chain) parallel.
    const perAddrChain = await Promise.all(
      addresses.flatMap((address) =>
        chainsToQuery.map(async (chainId): Promise<{ chainId: SupportedChainId; address: string; result: Result<Transaction[]> }> => {
          const chainResult = await this.fetchChainTransactions(ctx, chainId, startBlockApprox, address);
          return { chainId, address, result: chainResult };
        })
      )
    );

    for (const { chainId, address, result } of perAddrChain) {
      if (!result.ok) {
        if (result.error.message.toLowerCase().includes(FREE_TIER_BLOCKED_MARKER)) {
          const info = SUPPORTED_CHAINS[chainId];
          skippedChains.push(`${info.name} (chain ${chainId}) returned 'free tier not supported' at runtime`);
          continue;
        }
        const tag = addresses.length > 1 ? ` (wallet ${address.slice(0, 6)}...${address.slice(-4)})` : "";
        chainErrors.push(`chain ${chainId}${tag}: ${result.error.message}`);
        continue;
      }
      allTxs.push(...result.value);
    }

    if (allTxs.length === 0 && chainErrors.length > 0) {
      return err("upstream_error", `All chains failed: ${chainErrors.join("; ")}`);
    }

    if ((skippedChains.length > 0 || chainErrors.length > 0) && allTxs.length > 0) {
      const warnings = [...skippedChains, ...chainErrors];
      const first = allTxs[0]!;
      first.metadata = { ...(first.metadata ?? {}), __chainWarnings: warnings };
    }

    return ok(allTxs);
  }

  private async fetchChainTransactions(
    ctx: ConnectorContext,
    chainId: SupportedChainId,
    startBlock: number,
    address: string
  ): Promise<Result<Transaction[]>> {
    const creds = ctx.credentials as MetaMaskCreds;
    const chainInfo = SUPPORTED_CHAINS[chainId];
    const txs: Transaction[] = [];
    const myAddr = address.toLowerCase();

    interface NormalTx {
      blockNumber: string;
      timeStamp: string;
      hash: string;
      from: string;
      to: string;
      value: string;
      gasUsed: string;
      gasPrice: string;
      isError: string;
    }

    interface TokenTx {
      blockNumber: string;
      timeStamp: string;
      hash: string;
      from: string;
      to: string;
      value: string;             // raw, needs tokenDecimal
      contractAddress: string;
      tokenName: string;
      tokenSymbol: string;
      tokenDecimal: string;
      gasUsed: string;
      gasPrice: string;
    }

    // Fan out native + ERC-20 transfer fetches in parallel. Etherscan free tier
    // is 5 calls/sec, two simultaneous calls per chain stays well under that.
    const [normalRes, tokenRes] = await Promise.all([
      etherscanCall<NormalTx[]>(
        {
          chainid: String(chainId),
          module: "account",
          action: "txlist",
          address,
          startblock: String(startBlock),
          endblock: "latest",
          page: "1",
          offset: "50",
          sort: "desc",
          apikey: creds.etherscanApiKey,
        },
        ctx.signal
      ),
      etherscanCall<TokenTx[]>(
        {
          chainid: String(chainId),
          module: "account",
          action: "tokentx",
          address,
          startblock: String(startBlock),
          endblock: "latest",
          page: "1",
          offset: "50",
          sort: "desc",
          apikey: creds.etherscanApiKey,
        },
        ctx.signal
      ),
    ]);

    // If the native call hard-failed (auth, free-tier-blocked, etc.) the chain is
    // unusable — bubble that up. Token transfer call failure on its own is softer:
    // we still return whatever native transfers we got.
    if (!normalRes.ok) return normalRes;

    for (const tx of normalRes.value) {
      const isOutbound = tx.from.toLowerCase() === myAddr;
      const valueNative = applyDecimals(tx.value, chainInfo.nativeDecimals);
      const feeNative =
        applyDecimals(tx.gasUsed, 0) * applyDecimals(tx.gasPrice, chainInfo.nativeDecimals);

      txs.push({
        accountId: ctx.account.id,
        txId: `${chainId}:${tx.hash}`,
        type: isOutbound ? "withdraw" : "deposit",
        symbol: chainInfo.nativeSymbol,
        quantity: valueNative,
        fee: isOutbound ? feeNative : 0,
        feeCurrency: chainInfo.nativeSymbol,
        valueCurrency: "USD",
        timestamp: parseInt(tx.timeStamp, 10) * 1000,
        metadata: {
          chainId,
          chainName: chainInfo.name,
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          blockNumber: tx.blockNumber,
          isError: tx.isError === "1",
          asset: "native",
        },
      });
    }

    if (tokenRes.ok) {
      for (const tx of tokenRes.value) {
        const isOutbound = tx.from.toLowerCase() === myAddr;
        const decimals = parseInt(tx.tokenDecimal, 10);
        // Defensive: malformed tokenDecimal shows up as NaN — skip rather than emit garbage.
        if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) continue;
        const qty = applyDecimals(tx.value, decimals);
        // Fee is paid in native, only by the sender. Etherscan returns the same
        // fee fields on both legs (in/out) of a token transfer because they describe
        // the underlying tx — but we only attribute it to the outbound leg.
        const feeNative = isOutbound
          ? applyDecimals(tx.gasUsed, 0) * applyDecimals(tx.gasPrice, chainInfo.nativeDecimals)
          : 0;

        txs.push({
          accountId: ctx.account.id,
          // Disambiguate from native: txhash alone is not unique when an account both
          // sends native AND triggers a token transfer in the same tx (rare but real,
          // e.g. permit + transfer). Suffix with the contract address keeps txId unique.
          txId: `${chainId}:${tx.hash}:${tx.contractAddress.toLowerCase()}`,
          type: isOutbound ? "withdraw" : "deposit",
          symbol: tx.tokenSymbol,
          quantity: qty,
          fee: feeNative,
          feeCurrency: chainInfo.nativeSymbol,
          valueCurrency: "USD",
          timestamp: parseInt(tx.timeStamp, 10) * 1000,
          metadata: {
            chainId,
            chainName: chainInfo.name,
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            blockNumber: tx.blockNumber,
            asset: "erc20",
            contract: tx.contractAddress,
            tokenName: tx.tokenName,
            tokenDecimals: decimals,
          },
        });
      }
    }
    // If tokenRes failed but normalRes succeeded: silent pass — most often this is
    // a per-call rate limit on a heavy chain. Native data is still useful.

    return ok(txs);
  }
}
