// Tests for the dependency-free Sentry client. No network: globalThis.fetch is
// mocked and the captured envelope is inspected. Covers disabled-by-default,
// envelope shape, DSN parsing, privacy scrubbing, and never-throws behavior.

import { afterEach, describe, expect, test } from "bun:test";
import {
  captureException,
  captureMessage,
  initSentry,
  isSentryEnabled,
  scrub,
} from "../../src/observability/sentry.ts";

const FAKE_DSN = "https://pub1ickey@o0.ingest.sentry.io/42";
const realFetch = globalThis.fetch;

function mockFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  initSentry(undefined); // reset to disabled
});

describe("Sentry enabled/disabled", () => {
  test("disabled with no DSN: isSentryEnabled false, capture is a no-op", async () => {
    initSentry(undefined);
    expect(isSentryEnabled()).toBe(false);
    const { calls } = mockFetch();
    await captureException(new Error("boom"));
    await captureMessage("hi");
    expect(calls).toHaveLength(0);
  });

  test("malformed DSN stays disabled (does not throw)", () => {
    initSentry("not a url");
    expect(isSentryEnabled()).toBe(false);
  });

  test("valid DSN enables it", () => {
    initSentry(FAKE_DSN);
    expect(isSentryEnabled()).toBe(true);
  });
});

describe("captureException envelope", () => {
  test("POSTs a well-formed envelope to the DSN-derived endpoint", async () => {
    initSentry(FAKE_DSN, "9.9.9");
    const { calls } = mockFetch();

    await captureException(new TypeError("kaboom"), { connector: "bybit", operation: "holdings" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://o0.ingest.sentry.io/api/42/envelope/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-sentry-envelope"
    );

    const lines = (init.body as string).trim().split("\n");
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]!);
    const itemHeader = JSON.parse(lines[1]!);
    const event = JSON.parse(lines[2]!);

    expect(header.dsn).toBe(FAKE_DSN); // self-authenticating
    expect(header.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(itemHeader.type).toBe("event");
    expect(event.level).toBe("error");
    expect(event.release).toBe("9.9.9");
    expect(event.exception.values[0].type).toBe("TypeError");
    expect(event.exception.values[0].value).toBe("kaboom");
    expect(event.tags).toEqual({ connector: "bybit", operation: "holdings" });
    expect(Array.isArray(event.exception.values[0].stacktrace.frames)).toBe(true);
  });

  test("never throws even if the transport fails", async () => {
    initSentry(FAKE_DSN);
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    // Must resolve, not reject.
    await expect(captureException(new Error("x"))).resolves.toBeUndefined();
  });
});

describe("captureMessage", () => {
  test("sends a message event", async () => {
    initSentry(FAKE_DSN);
    const { calls } = mockFetch();
    await captureMessage("schema_mismatch: /positions returned non-array", { connector: "polymarket" });
    expect(calls).toHaveLength(1);
    const event = JSON.parse((calls[0]!.init.body as string).trim().split("\n")[2]!);
    expect(event.message.formatted).toContain("schema_mismatch");
    expect(event.tags).toEqual({ connector: "polymarket" });
  });
});

describe("privacy scrubbing", () => {
  test("scrub redacts EVM addresses, base58, and OS usernames", () => {
    expect(scrub("failed for 0x1234567890abcdef1234567890ABCDEF12345678 now")).toBe(
      "failed for 0x<redacted> now"
    );
    expect(scrub("wallet 7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs done")).toContain(
      "<redacted>"
    );
    expect(scrub("/Users/alice/code/x.ts")).toBe("/~/code/x.ts");
    expect(scrub("/home/bob/x.ts")).toBe("/~/x.ts");
  });

  test("a captured message containing an address is scrubbed before send", async () => {
    initSentry(FAKE_DSN);
    const { calls } = mockFetch();
    await captureMessage("balance for 0xAbCdef0123456789AbCdef0123456789aBCDeF01 high");
    const event = JSON.parse((calls[0]!.init.body as string).trim().split("\n")[2]!);
    expect(event.message.formatted).not.toContain("0xAbCdef0123456789");
    expect(event.message.formatted).toContain("0x<redacted>");
  });
});
