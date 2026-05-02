// Dashboard MCP App — registration smoke + resource handler test.
//
// We can't introspect McpServer's registered tools/resources directly (those
// fields are private), so the registration test just confirms construction
// doesn't throw with the new tool wired in. The resource-fetch test exercises
// the bundled-HTML loading path: we hit the same readFile + cache logic the
// real server uses, but don't depend on the host MCP roundtrip.

import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../../src/mcp/server.ts";
import {
  DASHBOARD_TOOL_NAME,
  DASHBOARD_RESOURCE_URI,
  RENDER_DASHBOARD_DESCRIPTION,
} from "../../../src/mcp/apps/dashboard/register.ts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

describe("dashboard MCP App registration", () => {
  test("tool name is render_dashboard (clients pin to it)", () => {
    expect(DASHBOARD_TOOL_NAME).toBe("render_dashboard");
  });

  test("resource URI uses ui:// scheme (required by spec)", () => {
    expect(DASHBOARD_RESOURCE_URI.startsWith("ui://")).toBe(true);
  });

  test("description is substantial enough for LLM tool selection (>200 chars)", () => {
    expect(RENDER_DASHBOARD_DESCRIPTION.length).toBeGreaterThan(200);
  });

  test("description mentions the three tabs and currency switcher", () => {
    const d = RENDER_DASHBOARD_DESCRIPTION.toLowerCase();
    expect(d).toContain("portfolio");
    expect(d).toContain("weekly");
    expect(d).toContain("risk");
    expect(d).toContain("currency");
  });

  test("createMcpServer() registers without throwing (smoke test)", () => {
    // If registerAppTool or registerAppResource args were malformed, this
    // throws at construction. Server returning is enough signal.
    const server = createMcpServer();
    expect(server).toBeDefined();
  });
});

describe("dashboard bundle artifact", () => {
  // The build script (scripts/build-mcp-apps.ts) produces this file. It must
  // exist on disk because the server reads it at first resource fetch.
  // If you see this test fail in CI, run `bun run build:apps` first.
  const bundlePath = join(import.meta.dir, "../../../dist/mcp-apps/dashboard.html");

  test("dist/mcp-apps/dashboard.html exists", async () => {
    const s = await stat(bundlePath);
    expect(s.isFile()).toBe(true);
  });

  test("bundled HTML contains the doctype and a <script> tag (real bundle, not placeholder)", async () => {
    const html = await readFile(bundlePath, "utf-8");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<script");
    // The placeholder must NOT remain — that would mean the bundler didn't run.
    expect(html).not.toContain("__BUNDLED_JS__");
  });

  test("bundle includes the App class import / postMessage transport (sanity check)", async () => {
    const html = await readFile(bundlePath, "utf-8");
    // After minification the literal name "App" is mangled, but the
    // PostMessage protocol uses a stable string "ui/initialize" that survives
    // minification because it's a JSON-RPC method name.
    expect(html).toContain("ui/initialize");
  });

  test("bundle is reasonable size (< 1 MB — sanity guard against accidental balloon)", async () => {
    const s = await stat(bundlePath);
    expect(s.size).toBeLessThan(1_000_000);
  });
});
