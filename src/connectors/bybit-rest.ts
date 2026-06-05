// Minimal Bybit V5 REST client — replaces the `bybit-api` SDK.
//
// Why hand-rolled: `bybit-api` ships its build toolchain (webpack, webpack-cli,
// ts-loader, source-map-loader, webpack-bundle-analyzer) as `optionalDependencies`,
// which npm installs by default. That dragged ~250 transitive packages and a
// deprecated `abab` warning into every `npx headless-tracker` install, for a
// connector that only needs two signed GET requests. This client uses Node's
// built-in `fetch` + `crypto`, so it adds zero dependencies and zero install noise.
//
// The signing is exactly what the official SDK does (verified against its source,
// util/BaseRestClient.js): HMAC-SHA256 over `timestamp + apiKey + recvWindow +
// queryString`, hex-encoded. Bybit recomputes the HMAC over the query string it
// receives, so the rule that makes a request valid is "sign exactly what you send".
//
// V5 auth docs: https://bybit-exchange.github.io/docs/v5/guide#authentication

import { createHmac } from "node:crypto";

const REST_BASE = "https://api.bybit.com";
const REST_BASE_TESTNET = "https://api-testnet.bybit.com";
const RECV_WINDOW = "5000";

// Bybit wraps every V5 response in { retCode, retMsg, result, ... }.
// retCode 0 = success; non-zero = logical error (mapped by mapBybitError).
export interface BybitV5Response<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

export interface BybitWalletBalanceResult {
  list: Array<{
    accountType: string;
    coin: Array<{
      coin: string;
      walletBalance?: string;
      usdValue?: string;
      equity?: string;
      unrealisedPnl?: string;
      cumRealisedPnl?: string;
    }>;
  }>;
}

export interface BybitTransactionLogResult {
  list: Array<{
    type?: string;
    symbol?: string;
    qty?: string;
    tradePrice?: string;
    fee?: string;
    currency?: string;
    transactionTime: string;
    tradeId?: string;
    cashFlow?: string;
    change?: string;
    funding?: string;
  }>;
}

export interface BybitRestOptions {
  key: string;
  secret: string;
  testnet?: boolean;
}

export class BybitRestClient {
  private readonly key: string;
  private readonly secret: string;
  private readonly base: string;

  constructor(opts: BybitRestOptions) {
    this.key = opts.key;
    this.secret = opts.secret;
    this.base = opts.testnet ? REST_BASE_TESTNET : REST_BASE;
  }

  // Build the query string the same way the SDK does for GET: insertion order
  // (no alphabetical sort), URI-encoded values, undefined/null params omitted.
  // Exposed (and pure) so the signing can be unit-tested without a network call.
  static serializeParams(params: Record<string, string | number | undefined | null>): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
  }

  // HMAC-SHA256(timestamp + apiKey + recvWindow + queryString), hex. Pure helper
  // so a test can pin the exact sign string the client commits to.
  static sign(secret: string, timestamp: string, key: string, recvWindow: string, queryString: string): string {
    return createHmac("sha256", secret).update(timestamp + key + recvWindow + queryString).digest("hex");
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal
  ): Promise<BybitV5Response<T>> {
    const query = BybitRestClient.serializeParams(params);
    const timestamp = Date.now().toString();
    const sign = BybitRestClient.sign(this.secret, timestamp, this.key, RECV_WINDOW, query);
    const url = query ? `${this.base}${path}?${query}` : `${this.base}${path}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": this.key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
        "X-BAPI-SIGN-TYPE": "2",
      },
      signal,
    });
    if (!resp.ok) {
      // Bybit usually returns logical errors as HTTP 200 with a non-zero
      // retCode, but its gateway rejects auth/rate problems at the HTTP layer
      // (observed: a revoked key returns 401 with an empty body and the reason
      // in statusText). Prefer a Bybit-shaped body if there is one; otherwise
      // translate the well-known auth/rate statuses into the matching retCode so
      // the connector's mapBybitError path labels them correctly, and throw on
      // everything else (5xx, gateway) as a genuine reachability failure.
      let body: unknown = null;
      try {
        body = await resp.json();
      } catch {
        // empty or non-JSON error body — fall through to status mapping
      }
      if (body && typeof (body as { retCode?: unknown }).retCode === "number") {
        return body as BybitV5Response<T>;
      }
      const reason = resp.statusText || `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        return { retCode: 10003, retMsg: reason, result: {} as T };
      }
      if (resp.status === 429) {
        return { retCode: 10006, retMsg: reason, result: {} as T };
      }
      throw new Error(`Bybit HTTP ${resp.status} ${reason}`);
    }
    return (await resp.json()) as BybitV5Response<T>;
  }

  getWalletBalance(
    params: { accountType: string },
    signal?: AbortSignal
  ): Promise<BybitV5Response<BybitWalletBalanceResult>> {
    return this.signedGet("/v5/account/wallet-balance", { accountType: params.accountType }, signal);
  }

  getTransactionLog(
    params: { accountType: string; startTime?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<BybitV5Response<BybitTransactionLogResult>> {
    return this.signedGet(
      "/v5/account/transaction-log",
      { accountType: params.accountType, startTime: params.startTime, limit: params.limit },
      signal
    );
  }
}
