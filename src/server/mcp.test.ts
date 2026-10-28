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
    expect(names).toContain("update_asset_profile");
    expect(names).toContain("screen_dividend_stocks");
    expect(names).toContain("get_dividend_income");
    expect(names).toContain("record_dividend_event");
    expect(names).toContain("list_dividend_events");
    expect(names).toContain("screen_factor_stocks");
    expect(names).toContain("plan_bond_ladder");
    for (const n of ["get_performance_metrics", "analyze_valuation", "manage_asset_lifecycle", "get_risk_free_rate", "value_security", "add_asset", "list_assets"]) expect(names).toContain(n);
  });
  it("registers the 12 asset custom-metric tools", () => {
    const names = mcpToolNames();
    for (const n of [
      "list_asset_metrics",
      "create_asset_metric",
      "update_asset_metric",
      "delete_asset_metric",
      "record_metric_observation",
      "update_metric_observation",
      "delete_metric_observation",
      "get_metric_history",
      "list_metric_thresholds",
      "preview_metric_threshold",
      "set_metric_threshold",
      "get_metric_series",
    ])
      expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });
  it("version carries the formula version and commit", () => {
    expect(serverVersion().startsWith(MODEL_VERSION)).toBe(true);
  });
});
