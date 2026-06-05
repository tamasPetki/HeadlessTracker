// MetaMask / EVM connector — static chain + token configuration.
//
// Pulled out of metamask.ts so the chain catalog and the curated common-token
// list live in one place, separate from the connector's fetch logic. Pure data:
// no I/O, no connector state. Imported by the connector and by src/tokens.ts
// (custom-token management needs the same chain catalog).

// Supported chains for V0.
// `freeTier: true` means Etherscan V2's free API key works for that chain.
// `freeTier: false` means a paid Etherscan API plan ("Pro") is required —
// the connector will soft-skip these chains for free-tier users (with a warning
// surfaced in the response) instead of returning a hard "All chains failed" error.
// Verified empirically against the V2 API in 2026-04: BSC and Base require Pro.
export const SUPPORTED_CHAINS = {
  1: { name: "Ethereum", nativeSymbol: "ETH", nativeDecimals: 18, freeTier: true },
  137: { name: "Polygon", nativeSymbol: "POL", nativeDecimals: 18, freeTier: true },
  56: { name: "BNB Smart Chain", nativeSymbol: "BNB", nativeDecimals: 18, freeTier: false },
  8453: { name: "Base", nativeSymbol: "ETH", nativeDecimals: 18, freeTier: false },
  42161: { name: "Arbitrum One", nativeSymbol: "ETH", nativeDecimals: 18, freeTier: true },
  10: { name: "Optimism", nativeSymbol: "ETH", nativeDecimals: 18, freeTier: true },
} as const;

export type SupportedChainId = keyof typeof SUPPORTED_CHAINS;

// Marker error message — the Etherscan V2 API surfaces this verbatim when a free-tier
// key hits a non-free-tier chain (e.g. BSC or Base). Used to soft-skip vs hard-fail.
export const FREE_TIER_BLOCKED_MARKER = "free api access is not supported";

// Curated common token list per chain. Contracts are checksummed mainnet addresses.
// V0.2 will expand this from a token-list source (Trustwallet, Coingecko verified).
export const COMMON_TOKENS: Record<SupportedChainId, Array<{ contract: string; symbol: string; decimals: number }>> = {
  1: [
    { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    { contract: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
    { contract: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18 },
    { contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
  ],
  137: [
    { contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
    { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
    { contract: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18 },
    { contract: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", symbol: "WBTC", decimals: 8 },
  ],
  56: [
    { contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    { contract: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
  ],
  8453: [
    { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    { contract: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  ],
  42161: [
    { contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    { contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
  ],
  10: [
    { contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 },
    { contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", decimals: 6 },
  ],
};
