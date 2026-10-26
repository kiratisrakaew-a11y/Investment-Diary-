/**
 * Roadmap Phase 1 — syncHistoricalPrices with injected provider and store (no network, no DB).
 */
import { describe, expect, it } from "vitest";
import { syncHistoricalPrices, type SyncDeps } from "./price-sync";

type Row = { close: number; adjClose: number | null };

function fakeDeps(opts: { failTimes?: Record<string, number>; splits?: boolean } = {}) {
  const assets = [
    { id: 1, symbol: "BBL", assetClass: "thai_stock", currency: "THB", priceSource: "yahoo", providerSymbol: "BBL.BK" },
    { id: 2, symbol: "AP", assetClass: "thai_stock", currency: "THB", priceSource: "yahoo", providerSymbol: "AP.BK" },
    { id: 3, symbol: "LB29DA", assetClass: "bond", currency: "THB", priceSource: "manual", providerSymbol: null },
  ];
  const store = new Map<string, Map<string, Row>>(); // key: series id
  store.set("asset:1", new Map([["2026-01-05", { close: 150, adjClose: null }]]));
  const calls: string[] = [];
  const fails = { ...(opts.failTimes ?? {}) };
  const days = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const deps: SyncDeps = {
    today: () => "2026-01-31",
    findAsset: async (s) => assets.find((a) => a.symbol === s.toUpperCase()) ?? null,
    fetchHistory: async (provider, range) => {
      calls.push(`${provider}:${range.from}:${range.to}`);
      if ((fails[provider] ?? 0) > 0) {
        fails[provider]--;
        throw new Error("503 Service Unavailable");
      }
      const base = provider === "THB=X" ? 35 : provider === "^SET.BK" ? 1400 : 100;
      return {
        rows: days.map((d, i) => ({ date: d, close: base + i, adjClose: base + i - 1 })),
        splits: opts.splits && provider === "AP.BK" ? [{ date: "2026-01-06", numerator: 2, denominator: 1 }] : [],
        dividends: [],
      };
    },
    fetchFundNav: async () => null,
    loadExisting: async (key) => new Map(store.get(key) ?? []),
    write: async (key, inserts, updates) => {
      const m = store.get(key) ?? new Map<string, Row>();
      for (const r of [...inserts, ...updates]) m.set(r.date, { close: r.close, adjClose: r.adjClose });
      store.set(key, m);
    },
    loadFx: async () => [["2025-12-01", 35]],
    sleep: async () => {},
    eligibility: async (symbols) => ({ lookbackDays: 365, ok: false, eligible: [], skipped: symbols.map((s) => ({ symbol: s, reason: "test" })) }),
    benchmarkSymbol: async () => "^SET.BK",
    heldAssetIds: async () => new Set([2]),
  };
  return { deps, store, calls };
}

describe("syncHistoricalPrices", () => {
  it("backfills known assets over the range, keeps existing prices, reports unknown and unsupported symbols", async () => {
    const { deps, store } = fakeDeps();
    const r = await syncHistoricalPrices({ symbols: ["BBL", "AP", "KBANK", "LB29DA"], startDate: "2026-01-01", endDate: "2026-01-31" }, deps);
    const by = Object.fromEntries(r.results.map((x) => [x.symbol, x]));
    expect(by.BBL.status).toBe("ok");
    expect(by.BBL.inserted).toBe(3);
    expect(by.BBL.skippedExisting).toBe(1);
    expect(store.get("asset:1")!.get("2026-01-05")!.close).toBe(150); // not overwritten
    expect(by.AP.inserted).toBe(4);
    expect(by.KBANK.status).toBe("unknown_asset");
    expect(by.KBANK.message).toContain("add_asset");
    expect(by.LB29DA.status).toBe("unsupported");
    expect(r.summary).toMatchObject({ requested: 4, ok: 2, inserted: 7 });
  });

  it("dry run fetches and plans but writes nothing", async () => {
    const { deps, store } = fakeDeps();
    const r = await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30, dryRun: true }, deps);
    expect(r.results[0].inserted).toBe(4);
    expect(store.get("asset:2")).toBeUndefined();
    expect(r.dryRun).toBe(true);
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { deps } = fakeDeps();
    await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30 }, deps);
    const again = await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30 }, deps);
    expect(again.results[0].inserted).toBe(0);
    expect(again.results[0].skippedExisting).toBe(4);
  });

  it("overwriteExisting updates changed prices", async () => {
    const { deps, store } = fakeDeps();
    const r = await syncHistoricalPrices({ symbols: ["BBL"], startDate: "2026-01-01", endDate: "2026-01-31", overwriteExisting: true }, deps);
    expect(r.results[0].updated).toBe(1);
    expect(store.get("asset:1")!.get("2026-01-05")!.close).toBe(101);
  });

  it("adjusted_close stores the adjusted series separately; close keeps its meaning", async () => {
    const { deps, store } = fakeDeps();
    await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30, priceType: "adjusted_close" }, deps);
    const row = store.get("asset:2")!.get("2026-01-02")!;
    expect(row.close).toBe(100);
    expect(row.adjClose).toBe(99);
  });

  it("retries transient provider errors and continues after a permanent failure", async () => {
    const { deps } = fakeDeps({ failTimes: { "BBL.BK": 2, "AP.BK": 9 } });
    const r = await syncHistoricalPrices({ symbols: ["BBL", "AP"], lookbackDays: 30 }, deps);
    const by = Object.fromEntries(r.results.map((x) => [x.symbol, x]));
    expect(by.BBL.status).toBe("ok");
    expect(by.AP.status).toBe("error");
    expect(r.summary.failed).toBe(1);
  });

  it("warns on a split inside the range for a held asset", async () => {
    const { deps } = fakeDeps({ splits: true });
    const r = await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30 }, deps);
    expect(r.results[0].warnings.some((w) => w.includes("split"))).toBe(true);
  });

  it("also syncs the benchmark and USDTHB over the same range by default", async () => {
    const { deps, calls } = fakeDeps();
    const r = await syncHistoricalPrices({ symbols: ["AP"], startDate: "2026-01-01", endDate: "2026-01-31" }, deps);
    expect(calls).toContain("^SET.BK:2026-01-01:2026-01-31");
    expect(calls).toContain("THB=X:2026-01-01:2026-01-31");
    expect(r.benchmark?.status).toBe("ok");
    expect(r.fx?.status).toBe("ok");
  });

  it("rejects too many symbols", async () => {
    const { deps } = fakeDeps();
    await expect(syncHistoricalPrices({ symbols: Array.from({ length: 51 }, (_, i) => `S${i}`) }, deps)).rejects.toThrow();
  });
});
