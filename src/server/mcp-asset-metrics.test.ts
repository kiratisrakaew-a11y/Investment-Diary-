/** MCP asset-metric tools: registration, schemas and delegation to the service (mocked — no DB). */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ASSET_METRIC_TOOL_NAMES, metricToolHandlers, registerAssetMetricTools, type MetricToolDeps } from "./mcp-asset-metrics";
import { MetricError } from "./services/asset-metrics";
import { createMcpServer, safe } from "./mcp";
import { evaluateThreshold } from "@/lib/asset-metrics/thresholds";

const TOOLS = [
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
];
const READ_ONLY = ["list_asset_metrics", "get_metric_history", "list_metric_thresholds", "preview_metric_threshold", "get_metric_series"];

function mockDeps(assets: Record<string, number> = { SAMPLE: 7 }) {
  const svc = {
    metricsOverview: vi.fn(async () => [{ id: 1, name: "NPL Ratio", observations: [] }]),
    createMetric: vi.fn(async (_a: number, x: object) => ({ id: 1, ...x })),
    updateMetric: vi.fn(async () => ({ id: 1 })),
    deleteMetric: vi.fn(async () => ({ deleted: true, observations: 0, thresholds: 0 })),
    addObservation: vi.fn(async () => ({ id: 9 })),
    updateObservation: vi.fn(async () => ({ id: 9 })),
    deleteObservation: vi.fn(async () => ({ deleted: true, id: 9 })),
    listObservations: vi.fn(async () => ({ metric: { id: 1 }, total: 0, limit: 200, offset: 0, observations: [] })),
    listThresholds: vi.fn(async () => []),
    previewThreshold: vi.fn(async () => ({ effectiveFrom: "2026-01-01", affected: 0, changed: 0, rows: [] })),
    addThresholdVersion: vi.fn(async () => ({ id: 3 })),
    metricSeries: vi.fn(async () => ({ series: [] })),
  };
  const resolveAsset = vi.fn(async (s: string) => {
    const k = s.trim().toUpperCase();
    return k in assets ? { id: assets[k], symbol: k } : null;
  });
  return { deps: { resolveAsset, svc } as unknown as MetricToolDeps, svc, resolveAsset };
}

async function errCode(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof MetricError ? e.code : e instanceof Error && e.name === "ZodError" ? "VALIDATION_ERROR" : String(e);
  }
}

describe("registration (spec 6A)", () => {
  it("exports exactly the 12 tool names", () => {
    expect([...ASSET_METRIC_TOOL_NAMES].sort()).toEqual([...TOOLS].sort());
  });

  it("tools/list on the built server exposes them with input schemas and read-only hints", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of TOOLS) {
      const t = byName.get(n);
      expect(t, n).toBeDefined();
      expect(t!.inputSchema.properties).toHaveProperty("symbol");
      expect(t!.annotations?.readOnlyHint, n).toBe(READ_ONLY.includes(n));
    }
    expect(byName.get("delete_asset_metric")!.annotations?.destructiveHint).toBe(true);
    expect(byName.get("delete_metric_observation")!.annotations?.destructiveHint).toBe(true);
    expect(byName.get("record_metric_observation")!.inputSchema.required).toEqual(expect.arrayContaining(["symbol", "metricId", "observedOn", "value"]));
    // get_server_info reports the same names on the built server.
    const info = await client.callTool({ name: "get_server_info", arguments: {} });
    const text = (info.content as { text: string }[])[0].text;
    for (const n of TOOLS) expect(text).toContain(n);
    await client.close();
  });

  it("errors carry a machine-readable code through the real safe() wrapper", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const { deps } = mockDeps();
    registerAssetMetricTools(server, safe, deps); // production wrapper, mocked services
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const notFound = await client.callTool({ name: "list_asset_metrics", arguments: { symbol: "NOPE" } });
    expect(notFound.isError).toBe(true);
    const c = notFound.content as { text: string }[];
    expect(c[0].text).toMatch(/^Error: .*\[ASSET_NOT_FOUND\]$/);
    expect(JSON.parse(c[1].text)).toEqual({ code: "ASSET_NOT_FOUND" });
    const reversed = await client.callTool({ name: "get_metric_history", arguments: { symbol: "SAMPLE", metricId: 1, from: "2025-12-31", to: "2025-01-01" } });
    expect((reversed.content as { text: string }[])[0].text).toContain("[VALIDATION_ERROR]");
    const badRule = await client.callTool({ name: "preview_metric_threshold", arguments: { symbol: "SAMPLE", metricId: 1, ruleType: "lower_is_better", effectiveFrom: "2026-01-01", greenBound: 5, yellowBound: 4 } });
    expect(badRule.isError).toBe(true);
    expect((badRule.content as { text: string }[])[0].text).toContain("VALIDATION_ERROR");
    const noConfirm = await client.callTool({ name: "delete_metric_observation", arguments: { symbol: "SAMPLE", metricId: 1, observationId: 9, confirmDelete: false } });
    expect(noConfirm.isError).toBe(true);
    await client.close();
  });
});

describe("delegation (spec 6B)", () => {
  it("1. create resolves the symbol and delegates with source mcp", async () => {
    const { deps, svc, resolveAsset } = mockDeps();
    const h = metricToolHandlers(deps);
    const r = await h.create_asset_metric({ symbol: "sample", name: "NPL Ratio", unit: "%", frequency: "quarterly", decimals: 2, description: null, chartColor: null, sourceDefault: null });
    expect(resolveAsset).toHaveBeenCalledWith("sample");
    expect(svc.createMetric).toHaveBeenCalledWith(7, expect.objectContaining({ name: "NPL Ratio", unit: "%", frequency: "quarterly" }), "mcp");
    expect(r.symbol).toBe("SAMPLE");
  });

  it("unknown symbol → ASSET_NOT_FOUND and nothing is created", async () => {
    const { deps, svc } = mockDeps();
    const h = metricToolHandlers(deps);
    expect(await errCode(h.create_asset_metric({ symbol: "NEW", name: "x", unit: "%", frequency: "irregular", decimals: 2, description: null, chartColor: null, sourceDefault: null }))).toBe("ASSET_NOT_FOUND");
    expect(svc.createMetric).not.toHaveBeenCalled();
  });

  it("2. list defaults to summaries only for the resolved asset", async () => {
    const { deps, svc } = mockDeps();
    const r = await metricToolHandlers(deps).list_asset_metrics({ symbol: "SAMPLE", includeInactive: false, withObservations: false });
    expect(svc.metricsOverview).toHaveBeenCalledWith(7, { includeInactive: false, withObservations: false });
    expect(r).toMatchObject({ symbol: "SAMPLE", assetId: 7 });
  });

  it("every write passes source mcp", async () => {
    const { deps, svc } = mockDeps();
    const h = metricToolHandlers(deps);
    await h.update_asset_metric({ symbol: "SAMPLE", metricId: 1, isActive: false });
    await h.record_metric_observation({ symbol: "SAMPLE", metricId: 1, observedOn: "2025-12-31", value: "-0.5", source: "report", note: null, publishedOn: "2026-02-15" });
    await h.update_metric_observation({ symbol: "SAMPLE", metricId: 1, observationId: 9, value: "0" });
    await h.delete_metric_observation({ symbol: "SAMPLE", metricId: 1, observationId: 9, confirmDelete: true });
    await h.delete_asset_metric({ symbol: "SAMPLE", metricId: 1, confirmName: "NPL Ratio" });
    await h.set_metric_threshold({ symbol: "SAMPLE", metricId: 1, ruleType: "lower_is_better", effectiveFrom: "2026-01-01", greenBound: "2.5", yellowBound: "3.5", greenMin: null, greenMax: null, yellowMin: null, yellowMax: null, reason: null, source: null });
    expect(svc.updateMetric).toHaveBeenCalledWith(7, 1, { isActive: false }, "mcp");
    expect(svc.addObservation).toHaveBeenCalledWith(7, 1, { observedOn: "2025-12-31", value: "-0.5", source: "report", note: null, publishedOn: "2026-02-15" }, "mcp");
    expect(svc.updateObservation).toHaveBeenCalledWith(7, 1, 9, { value: "0" }, "mcp");
    expect(svc.deleteObservation).toHaveBeenCalledWith(7, 1, 9, "mcp");
    expect(svc.deleteMetric).toHaveBeenCalledWith(7, 1, "NPL Ratio", "mcp");
    expect(svc.addThresholdVersion).toHaveBeenCalledWith(7, 1, expect.objectContaining({ greenBound: "2.5", yellowBound: "3.5" }), "mcp");
  });

  it("7. deleting an observation needs confirmDelete true", async () => {
    const { deps, svc } = mockDeps();
    const h = metricToolHandlers(deps);
    expect(await errCode(h.delete_metric_observation({ symbol: "SAMPLE", metricId: 1, observationId: 9, confirmDelete: false as unknown as true }))).toBe("CONFIRMATION_REQUIRED");
    expect(svc.deleteObservation).not.toHaveBeenCalled();
  });

  it("11. invalid threshold fails in the wrapper; preview delegates to the read-only service", async () => {
    const { deps, svc } = mockDeps();
    const h = metricToolHandlers(deps);
    const bad = { symbol: "SAMPLE", metricId: 1, ruleType: "lower_is_better" as const, effectiveFrom: "2026-01-01", greenBound: "5", yellowBound: "4", greenMin: null, greenMax: null, yellowMin: null, yellowMax: null, reason: null, source: null };
    expect(await errCode(h.set_metric_threshold(bad))).toBe("VALIDATION_ERROR");
    expect(await errCode(h.preview_metric_threshold(bad))).toBe("VALIDATION_ERROR");
    expect(svc.addThresholdVersion).not.toHaveBeenCalled();
    const ok = await h.preview_metric_threshold({ ...bad, greenBound: "2.5", yellowBound: "3.5" });
    expect(svc.previewThreshold).toHaveBeenCalledTimes(1);
    expect(ok.saved).toBe(false);
  });

  it("17. history pagination is passed through; reversed ranges fail visibly", async () => {
    const { deps, svc } = mockDeps();
    const h = metricToolHandlers(deps);
    await h.get_metric_history({ symbol: "SAMPLE", metricId: 1, from: "2024-01-01", to: "2024-12-31", limit: 10, offset: 20 });
    expect(svc.listObservations).toHaveBeenCalledWith(7, 1, { from: "2024-01-01", to: "2024-12-31", limit: 10, offset: 20 });
    expect(await errCode(h.get_metric_history({ symbol: "SAMPLE", metricId: 1, from: "2025-01-01", to: "2024-01-01", limit: 10, offset: 0 }))).toBe("VALIDATION_ERROR");
    expect(await errCode(h.get_metric_series({ symbol: "SAMPLE", from: "2025-01-01", to: "2024-01-01", mode: "actual" }))).toBe("VALIDATION_ERROR");
    expect(svc.metricSeries).not.toHaveBeenCalled();
  });
});

describe("10. threshold boundaries (equality)", () => {
  const s = (v: number | string, r: Parameters<typeof evaluateThreshold>[1]) => evaluateThreshold(v, r).status;
  it("lower_is_better 2.5 / 3.5", () => {
    const r = { ruleType: "lower_is_better" as const, greenBound: "2.5", yellowBound: "3.5" };
    expect([s(2.5, r), s(3.5, r), s("3.5001", r), s(0, r), s(-1, r)]).toEqual(["GREEN", "YELLOW", "RED", "GREEN", "GREEN"]);
  });
  it("higher_is_better 150 / 180", () => {
    const r = { ruleType: "higher_is_better" as const, yellowBound: 150, greenBound: 180 };
    expect([s(180, r), s(179.99, r), s(150, r), s(149.99, r)]).toEqual(["GREEN", "YELLOW", "YELLOW", "RED"]);
  });
  it("target_range -1 < 0 ≤ g ≤ 2 < 3", () => {
    const r = { ruleType: "target_range" as const, yellowMin: -1, greenMin: 0, greenMax: 2, yellowMax: 3 };
    expect([s(0, r), s(2, r), s(-1, r), s(3, r), s(-1.01, r), s(3.01, r)]).toEqual(["GREEN", "GREEN", "YELLOW", "YELLOW", "RED", "RED"]);
  });
});
