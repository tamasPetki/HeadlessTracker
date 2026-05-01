// MCP prompts — shape sanity tests + integration smoke test.
//
// We can't easily introspect McpServer's registered prompts (the field is
// private), so the integration test just confirms server construction
// doesn't throw with prompts wired up. The bulk of the coverage is on the
// builder functions, which are pure and easy to assert against.

import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../../src/mcp/server.ts";
import {
  DASHBOARD_PROMPT_NAME,
  DASHBOARD_PROMPT_CONFIG,
  buildDashboardPrompt,
} from "../../src/mcp/prompts/dashboard.ts";
import {
  WEEKLY_REVIEW_PROMPT_NAME,
  WEEKLY_REVIEW_PROMPT_CONFIG,
  buildWeeklyReviewPrompt,
} from "../../src/mcp/prompts/weekly_review.ts";
import {
  RISK_CHECK_PROMPT_NAME,
  RISK_CHECK_PROMPT_CONFIG,
  buildRiskCheckPrompt,
} from "../../src/mcp/prompts/risk_check.ts";

describe("portfolio-dashboard prompt", () => {
  test("name is stable (clients pin to it)", () => {
    expect(DASHBOARD_PROMPT_NAME).toBe("portfolio-dashboard");
  });

  test("config has title + description", () => {
    expect(DASHBOARD_PROMPT_CONFIG.title).toBeTruthy();
    expect(DASHBOARD_PROMPT_CONFIG.description).toBeTruthy();
    expect(DASHBOARD_PROMPT_CONFIG.description.length).toBeGreaterThan(40);
  });

  test("builds a single user-message prompt with text content", () => {
    const r = buildDashboardPrompt();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.content.type).toBe("text");
  });

  test("steers Claude toward the right tools", () => {
    const text = (buildDashboardPrompt().messages[0]!.content as { text: string }).text;
    expect(text).toContain("get_holdings");
    expect(text).toContain("get_allocations");
    expect(text).toContain("get_pnl");
    expect(text).toContain("get_polymarket_positions");
  });

  test("preserves the honest-rendering rule (no fake percentages)", () => {
    const text = (buildDashboardPrompt().messages[0]!.content as { text: string }).text;
    expect(text.toLowerCase()).toContain("not");
    expect(text).toMatch(/honest|fabric|do not|don't/i);
  });
});

describe("weekly-review prompt", () => {
  test("name is stable", () => {
    expect(WEEKLY_REVIEW_PROMPT_NAME).toBe("weekly-review");
  });

  test("config has title + description", () => {
    expect(WEEKLY_REVIEW_PROMPT_CONFIG.title).toBeTruthy();
    expect(WEEKLY_REVIEW_PROMPT_CONFIG.description).toBeTruthy();
  });

  test("calls get_pnl with timeframe=7d (the whole point of the prompt)", () => {
    const text = (buildWeeklyReviewPrompt().messages[0]!.content as { text: string }).text;
    expect(text).toContain("get_pnl");
    expect(text).toContain("7d");
    expect(text).toContain("get_transactions");
  });

  test("surfaces the windowDelta approximation caveat to the user", () => {
    const text = (buildWeeklyReviewPrompt().messages[0]!.content as { text: string }).text;
    // The caveat is the whole reason we mention it — the prompt should ensure
    // the user gets told this is not "true" windowed PnL.
    expect(text).toContain("approximation");
    expect(text).toContain("not");
  });
});

describe("risk-check prompt", () => {
  test("name is stable", () => {
    expect(RISK_CHECK_PROMPT_NAME).toBe("risk-check");
  });

  test("config has title + description", () => {
    expect(RISK_CHECK_PROMPT_CONFIG.title).toBeTruthy();
    expect(RISK_CHECK_PROMPT_CONFIG.description).toBeTruthy();
  });

  test("evaluates concentration + venue + stablecoin reserve dimensions", () => {
    const text = (buildRiskCheckPrompt().messages[0]!.content as { text: string }).text;
    expect(text.toLowerCase()).toContain("concentration");
    expect(text.toLowerCase()).toContain("stablecoin");
    expect(text.toLowerCase()).toMatch(/venue|connector/);
    expect(text.toLowerCase()).toContain("prediction");
  });

  test("uses tiered status (PASS/WARN/ALERT)", () => {
    const text = (buildRiskCheckPrompt().messages[0]!.content as { text: string }).text;
    expect(text).toContain("PASS");
    expect(text).toContain("WARN");
    expect(text).toContain("ALERT");
  });
});

describe("MCP server integration", () => {
  test("createMcpServer() registers prompts without throwing", () => {
    // We can't introspect _registeredPrompts (private), so this is a smoke
    // test: if registerPrompt() args were malformed, the SDK would throw at
    // construction time. The fact that this returns a server is the signal.
    const server = createMcpServer();
    expect(server).toBeDefined();
  });
});
