import { describe, expect, it } from "vitest";
import { mcpToolNames, serverVersion } from "./mcp";
import { MODEL_VERSION } from "@/lib/governance";

describe("MCP build info", () => {
  it("lists the multi-stage residual income tool and the server-info tool", () => {
    const names = mcpToolNames();
    expect(names).toContain("multi_stage_residual_income");
    expect(names).toContain("save_valuation");
    expect(names).toContain("get_server_info");
    expect(names).toContain("sync_historical_prices");
    expect(names).toContain("import_prices");
    expect(names).toContain("rebalance_portfolio");
    expect(names).toContain("stress_test_portfolio");
    expect(names).toContain("backtest_portfolio");
    expect(names).toContain("record_split");
  });
  it("version carries the formula version and commit", () => {
    expect(serverVersion().startsWith(MODEL_VERSION)).toBe(true);
  });
});
