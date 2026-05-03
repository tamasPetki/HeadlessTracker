// Bybit connector tests — covers the pure logic (error mapping, credential
// schema validation). The SDK-call path is exercised via the Day 1 manual
// smoke test and the Day 11-14 burn-in; mocking `bybit-api`'s class hierarchy
// at the module level is high-effort, low-marginal-value for V0.

import { describe, expect, test } from "bun:test";
import { BybitConnector, mapBybitError } from "../../src/connectors/bybit.ts";

describe("mapBybitError", () => {
  test("auth retCodes (10003, 10004, 10005, 33004, 110001) → auth_failed", () => {
    for (const code of [10003, 10004, 10005, 33004, 110001]) {
      const { kind } = mapBybitError(code, "any");
      expect(kind).toBe("auth_failed");
    }
  });

  test("rate-limit retCodes (10006, 10018) → rate_limited", () => {
    expect(mapBybitError(10006, "too many").kind).toBe("rate_limited");
    expect(mapBybitError(10018, "throttled").kind).toBe("rate_limited");
  });

  test("server-side retCodes (10016, 10002) → upstream_error", () => {
    expect(mapBybitError(10016, "server").kind).toBe("upstream_error");
    expect(mapBybitError(10002, "time mismatch").kind).toBe("upstream_error");
  });

  test("unknown retCode falls through to upstream_error with code in message", () => {
    const { kind, message } = mapBybitError(99999, "weird new code");
    expect(kind).toBe("upstream_error");
    expect(message).toContain("99999");
    expect(message).toContain("weird new code");
  });
});

describe("BybitConnector.validateCredentials shape check", () => {
  test("rejects credentials missing apiKey/apiSecret/accountType", async () => {
    const c = new BybitConnector();
    const result = await c.validateCredentials({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
    }
  });

  test("rejects credentials with invalid accountType", async () => {
    const c = new BybitConnector();
    const result = await c.validateCredentials({
      apiKey: "k", apiSecret: "s", accountType: "INVALID_TYPE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
    }
  });

  test("metadata: connector identity is stable", () => {
    const c = new BybitConnector();
    expect(c.id).toBe("bybit");
    expect(c.defaultCacheTtlSec).toBe(120);
    expect(c.displayName).toContain("Bybit");
  });

  test("rejects credentials with invalid accountTypes element", async () => {
    const c = new BybitConnector();
    const result = await c.validateCredentials({
      apiKey: "k",
      apiSecret: "s",
      accountType: "UNIFIED",
      accountTypes: ["FUND", "GHOST"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
    }
  });

  test("rejects empty accountTypes array (must be omitted or non-empty)", async () => {
    const c = new BybitConnector();
    const result = await c.validateCredentials({
      apiKey: "k",
      apiSecret: "s",
      accountType: "UNIFIED",
      accountTypes: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
    }
  });

  test("rejects accountTypes that's not an array", async () => {
    const c = new BybitConnector();
    const result = await c.validateCredentials({
      apiKey: "k",
      apiSecret: "s",
      accountType: "UNIFIED",
      accountTypes: "FUND",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_mismatch");
    }
  });
});
