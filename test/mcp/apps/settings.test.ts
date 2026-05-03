// Settings MCP App — registration smoke + bundle artifact + tool-name pinning.
// Mirrors test/mcp/apps/dashboard.test.ts shape; the actual rendering happens
// in a sandboxed iframe and isn't unit-testable from server-side.

import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../../src/mcp/server.ts";
import {
  SETTINGS_TOOL_NAME,
  SETTINGS_RESOURCE_URI,
  RENDER_SETTINGS_DESCRIPTION,
} from "../../../src/mcp/apps/settings/register.ts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

describe("settings MCP App registration", () => {
  test("tool name is render_settings (pinned)", () => {
    expect(SETTINGS_TOOL_NAME).toBe("render_settings");
  });

  test("resource URI uses ui:// scheme", () => {
    expect(SETTINGS_RESOURCE_URI.startsWith("ui://")).toBe(true);
  });

  test("description mentions all four tabs", () => {
    const d = RENDER_SETTINGS_DESCRIPTION.toLowerCase();
    expect(d).toContain("accounts");
    expect(d).toContain("add account");
    expect(d).toContain("wallets");
    expect(d).toContain("custom tokens");
  });

  test("description carries the credential-handling behavior contract for the LLM", () => {
    // The contract: when the user pastes credentials in chat, prefer pointing
    // at the Settings UI (form keeps secrets out of conversation transcript).
    // Critical for not training the LLM to echo secrets back.
    const d = RENDER_SETTINGS_DESCRIPTION.toLowerCase();
    expect(d).toContain("transcript");
    expect(d).toContain("credentials");
  });

  test("createMcpServer() registers settings without throwing (smoke)", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });
});

describe("settings bundle artifact", () => {
  const bundlePath = join(import.meta.dir, "../../../dist/mcp-apps/settings.html");

  test("dist/mcp-apps/settings.html exists", async () => {
    const s = await stat(bundlePath);
    expect(s.isFile()).toBe(true);
  });

  test("bundle contains the doctype + script tag (real bundle, not placeholder)", async () => {
    const html = await readFile(bundlePath, "utf-8");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<script");
    expect(html).not.toContain("__BUNDLED_JS__");
  });

  test("bundle includes the postMessage protocol marker", async () => {
    const html = await readFile(bundlePath, "utf-8");
    expect(html).toContain("ui/initialize");
  });

  test("bundle is reasonable size (<1MB sanity guard)", async () => {
    const s = await stat(bundlePath);
    expect(s.size).toBeLessThan(1_000_000);
  });

  test("bundle includes the security disclosure copy (so users can't miss it)", async () => {
    const html = await readFile(bundlePath, "utf-8");
    // The disclosure block in iframe.ts mentions Bybit's no-withdraw constraint
    // verbatim; it's the user-visible safeguard explaining the trust path.
    expect(html.toLowerCase()).toContain("read-only");
    expect(html.toLowerCase()).toContain("withdraw");
  });
});
