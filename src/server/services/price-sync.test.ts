/**
 * Roadmap Phase 1 — syncHistoricalPrices with injected provider and store (no network, no DB).
 */
import { describe, expect, it } from "vitest";
import { syncHistoricalPrices, type SyncDeps } from "./price-sync";

type Row = { close: number; adjClose: number | null };

function fakeDeps(
  opts: { failTimes?: Record<string, number>; splits?: boolean } = {},
) {
  const assets = [
    {
      id: 1,
      symbol: "BBL",
      assetClass: "thai_stock",
      currency: "THB",
      priceSource: "yahoo",
      providerSymbol: "BBL.BK",
    },
    {
      id: 2,
      symbol: "AP",
      assetClass: "thai_stock",
      currency: "THB",
      priceSource: "yahoo",
      providerSymbol: "AP.BK",
    },
    {
      id: 3,
      symbol: "LB29DA",
      assetClass: "bond",
      currency: "THB",
      priceSource: "manual",
      providerSymbol: null,
    },
  ];
  const store = new Map<string, Map<string, Row>>(); // key: series id
  store.set(
    "asset:1",
    new Map([["2026-01-05", { close: 150, adjClose: null }]]),
  );
  const calls: string[] = [];
  const fails = { ...(opts.failTimes ?? {}) };
  const days = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const deps: SyncDeps = {
    today: () => "2026-01-31",
    findAsset: async (s) =>
      assets.find((a) => a.symbol === s.toUpperCase()) ?? null,
    fetchHistory: async (provider, range) => {
      calls.push(`${provider}:${range.from}:${range.to}`);
      if ((fails[provider] ?? 0) > 0) {
        fails[provider]--;
        throw new Error("503 Service Unavailable");
      }
      const base =
        provider === "THB=X" ? 35 : provider === "^SET.BK" ? 1400 : 100;
      return {
        rows: days.map((d, i) => ({
          date: d,
          close: base + i,
          adjClose: base + i - 1,
        })),
        splits:
          opts.splits && provider === "AP.BK"
            ? [{ date: "2026-01-06", numerator: 2, denominator: 1 }]
            : [],
        dividends: [],
      };
    },
    fetchFundNav: async () => null,
    loadExisting: async (key) => new Map(store.get(key) ?? []),
    write: async (key, inserts, updates) => {
      const m = store.get(key) ?? new Map<string, Row>();
      for (const r of [...inserts, ...updates])
        m.set(r.date, { close: r.close, adjClose: r.adjClose });
      store.set(key, m);
    },
    loadFx: async () => [["2025-12-01", 35]],
    sleep: async () => {},
    eligibility: async (symbols) => ({
      lookbackDays: 365,
      ok: false,
      eligible: [],
      skipped: symbols.map((s) => ({ symbol: s, reason: "test" })),
    }),
    benchmarkSymbol: async () => "^SET.BK",
    heldAssetIds: async () => new Set([2]),
  };
  return { deps, store, calls };
}

describe("syncHistoricalPrices", () => {
  it("backfills known assets over the range, keeps existing prices, reports unknown and unsupported symbols", async () => {
    const { deps, store } = fakeDeps();
    const r = await syncHistoricalPrices(
      {
        symbols: ["BBL", "AP", "KBANK", "LB29DA"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
      deps,
    );
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
    const r = await syncHistoricalPrices(
      { symbols: ["AP"], lookbackDays: 30, dryRun: true },
      deps,
    );
    expect(r.results[0].inserted).toBe(4);
    expect(store.get("asset:2")).toBeUndefined();
    expect(r.dryRun).toBe(true);
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { deps } = fakeDeps();
    await syncHistoricalPrices({ symbols: ["AP"], lookbackDays: 30 }, deps);
    const again = await syncHistoricalPrices(
      { symbols: ["AP"], lookbackDays: 30 },
      deps,
    );
    expect(again.results[0].inserted).toBe(0);
    expect(again.results[0].skippedExisting).toBe(4);
  });

  it("overwriteExisting updates changed prices", async () => {
    const { deps, store } = fakeDeps();
    const r = await syncHistoricalPrices(
      {
        symbols: ["BBL"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        overwriteExisting: true,
      },
      deps,
    );
    expect(r.results[0].updated).toBe(1);
    expect(store.get("asset:1")!.get("2026-01-05")!.close).toBe(101);
  });

  it("adjusted_close stores the adjusted series separately; close keeps its meaning", async () => {
    const { deps, store } = fakeDeps();
    await syncHistoricalPrices(
      { symbols: ["AP"], lookbackDays: 30, priceType: "adjusted_close" },
      deps,
    );
    const row = store.get("asset:2")!.get("2026-01-02")!;
    expect(row.close).toBe(100);
    expect(row.adjClose).toBe(99);
  });

  it("retries transient provider errors and continues after a permanent failure", async () => {
    const { deps } = fakeDeps({ failTimes: { "BBL.BK": 2, "AP.BK": 9 } });
    const r = await syncHistoricalPrices(
      { symbols: ["BBL", "AP"], lookbackDays: 30 },
      deps,
    );
    const by = Object.fromEntries(r.results.map((x) => [x.symbol, x]));
    expect(by.BBL.status).toBe("ok");
    expect(by.AP.status).toBe("error");
    expect(r.summary.failed).toBe(1);
  });

  it("warns on a split inside the range for a held asset", async () => {
    const { deps } = fakeDeps({ splits: true });
    const r = await syncHistoricalPrices(
      { symbols: ["AP"], lookbackDays: 30 },
      deps,
    );
    expect(r.results[0].warnings.some((w) => w.includes("split"))).toBe(true);
  });

  it("also syncs the benchmark and USDTHB over the same range by default", async () => {
    const { deps, calls } = fakeDeps();
    const r = await syncHistoricalPrices(
      { symbols: ["AP"], startDate: "2026-01-01", endDate: "2026-01-31" },
      deps,
    );
    expect(calls).toContain("^SET.BK:2026-01-01:2026-01-31");
    expect(calls).toContain("THB=X:2026-01-01:2026-01-31");
    expect(r.benchmark?.status).toBe("ok");
    expect(r.fx?.status).toBe("ok");
  });

  it("rejects too many symbols", async () => {
    const { deps } = fakeDeps();
    await expect(
      syncHistoricalPrices(
        { symbols: Array.from({ length: 51 }, (_, i) => `S${i}`) },
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe("importPrices", () => {
  it("writes new prices per asset, keeps existing ones, reports unknown symbols, accepts manual assets", async () => {
    const { importPrices } = await import("./price-sync");
    const { deps, store } = fakeDeps();
    const r = await importPrices(
      {
        rows: [
          { symbol: "BBL", date: "2026-01-05", close: 999, adjClose: null }, // already stored (150) → kept
          { symbol: "BBL", date: "2026-01-06", close: 151, adjClose: null },
          {
            symbol: "LB29DA",
            date: "2026-01-06",
            close: 1007.5,
            adjClose: null,
          },
          { symbol: "KBANK", date: "2026-01-06", close: 140, adjClose: null },
        ],
      },
      deps,
    );
    const by = Object.fromEntries(r.results.map((x) => [x.symbol, x]));
    expect(by.BBL).toMatchObject({
      status: "ok",
      inserted: 1,
      skippedExisting: 1,
    });
    expect(store.get("asset:1")!.get("2026-01-05")!.close).toBe(150);
    expect(by.LB29DA).toMatchObject({ status: "ok", inserted: 1 });
    expect(by.KBANK.status).toBe("unknown_asset");
    expect(r.summary.inserted).toBe(2);
  });

  it("dry run writes nothing; duplicate dates in the file are flagged (last one wins); rerun is idempotent", async () => {
    const { importPrices } = await import("./price-sync");
    const { deps, store } = fakeDeps();
    const rows = [
      { symbol: "AP", date: "2026-01-06", close: 10, adjClose: null },
      { symbol: "AP", date: "2026-01-06", close: 10.5, adjClose: null },
    ];
    const dry = await importPrices({ rows, dryRun: true }, deps);
    expect(store.get("asset:2")).toBeUndefined();
    expect(dry.results[0].warnings.some((w) => w.includes("ซ้ำ"))).toBe(true);
    await importPrices({ rows }, deps);
    expect(store.get("asset:2")!.get("2026-01-06")!.close).toBe(10.5);
    const again = await importPrices({ rows }, deps);
    expect(again.summary.inserted).toBe(0);
  });

  it("rejects future dates", async () => {
    const { importPrices } = await import("./price-sync");
    const { deps } = fakeDeps();
    const r = await importPrices(
      {
        rows: [{ symbol: "AP", date: "2027-01-01", close: 10, adjClose: null }],
      },
      deps,
    );
    expect(r.results[0].inserted).toBe(0);
    expect(r.results[0].warnings.some((w) => w.includes("อนาคต"))).toBe(true);
  });
});

describe("MPT_FIX_SPEC P0-A1: adjusted close on rows that already have a close", () => {
  it("fills adj_close where it is empty, keeps close, counts each row once per column, coverage 100%", async () => {
    const { deps, store } = fakeDeps();
    // Close only on every provider day (as written by the daily close-only updater).
    store.set(
      "asset:1",
      new Map(
        ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"].map((d, i) => [
          d,
          { close: 200 + i, adjClose: null },
        ]),
      ),
    );
    const before = new Map(store.get("asset:1")!);
    const dry = await syncHistoricalPrices(
      {
        symbols: ["BBL"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        priceType: "adjusted_close",
        dryRun: true,
      },
      deps,
    );
    expect(dry.results[0].adjCloseFilled).toBe(4);
    expect(dry.results[0].adjCloseCoverage).toEqual({
      withAdjClose: 4,
      withClose: 4,
      ratio: 1,
    });
    expect(
      [...store.get("asset:1")!.values()].every((r) => r.adjClose == null),
    ).toBe(true); // dry run writes nothing

    const r = (
      await syncHistoricalPrices(
        {
          symbols: ["BBL"],
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          priceType: "adjusted_close",
        },
        deps,
      )
    ).results[0];
    const rows = store.get("asset:1")!;
    expect([...rows.values()].every((x) => x.adjClose != null)).toBe(true);
    for (const [d, x] of rows) expect(x.close).toBe(before.get(d)!.close); // close untouched
    // close column: inserted + closeUpdated + unchanged + skippedExisting = fetched; adj column separately.
    expect(
      r.inserted! + r.closeUpdated! + r.unchanged + r.skippedExisting,
    ).toBe(r.fetched);
    expect(r.adjCloseFilled).toBe(4);
    expect(r.adjCloseRebased).toBe(0);
    expect(r.adjCloseCoverage!.ratio).toBe(1);
  });
  it("overwrite mode: a changed close is closeUpdated, a replaced adj_close is adjCloseRebased — never both buckets of one column", async () => {
    const { deps, store } = fakeDeps();
    store.set(
      "asset:1",
      new Map([["2026-01-05", { close: 150, adjClose: 140 }]]),
    );
    const r = (
      await syncHistoricalPrices(
        {
          symbols: ["BBL"],
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          priceType: "adjusted_close",
          overwriteExisting: true,
        },
        deps,
      )
    ).results[0];
    expect(r.closeUpdated).toBe(1);
    expect(r.adjCloseRebased).toBe(1);
    expect(r.skippedExisting).toBe(0);
    expect(
      r.inserted! + r.closeUpdated! + r.unchanged + r.skippedExisting,
    ).toBe(r.fetched);
  });
});

describe("MPT_FIX_SPEC P0-A2: one base for adjusted closes", () => {
  type Meta = { adjBaseDate: string; adjLastEventDate: string | null };
  function withAdj(opts: { failRebase?: boolean } = {}) {
    const f = fakeDeps();
    const days = [
      "2026-01-02",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
    ];
    // Provider state: a factor applied to every adjusted close (a new dividend rescales history).
    const state = {
      factor: 0.9,
      dividends: [] as { date: string; amount: number }[],
      today: "2026-01-31",
    };
    const meta = new Map<number, Meta>();
    f.store.delete("asset:1");
    const deps: SyncDeps = {
      ...f.deps,
      today: () => state.today,
      fetchHistory: async (_p, range) => ({
        rows: days
          .filter((d) => d >= range.from && d <= range.to)
          .map((d) => ({
            date: d,
            close: 100 + days.indexOf(d),
            adjClose: (100 + days.indexOf(d)) * state.factor,
          })),
        splits: [],
        dividends: state.dividends.filter(
          (x) => x.date >= range.from && x.date <= range.to,
        ),
      }),
      loadAdjMeta: async (id) => meta.get(id) ?? null,
      adjStats: async (key) => {
        const m = f.store.get(key) ?? new Map();
        const ds = [...m.keys()].sort();
        return {
          firstDate: ds[0] ?? null,
          adjRows: [...m.values()].filter((r) => r.adjClose != null).length,
        };
      },
      rebaseAdj: async (key, adj, m) => {
        if (opts.failRebase) throw new Error("connection lost during rebase");
        const rows = f.store.get(key)!;
        for (const [d, r] of rows)
          rows.set(d, { ...r, adjClose: adj.get(d) ?? null });
        meta.set(Number(key.split(":")[1]), m);
      },
      setAdjMeta: async (id, m) => void meta.set(id, m),
    };
    return { ...f, deps, state, meta, days };
  }
  const sync = (deps: SyncDeps, from: string, to: string, dryRun = false) =>
    syncHistoricalPrices(
      {
        symbols: ["BBL"],
        startDate: from,
        endDate: to,
        priceType: "adjusted_close",
        dryRun,
      },
      deps,
    );

  it("a new dividend rebases EVERY stored row to the new fetch (base date and values), close untouched", async () => {
    const t = withAdj();
    await sync(t.deps, "2026-01-01", "2026-01-06");
    expect(t.meta.get(1)).toEqual({
      adjBaseDate: "2026-01-31",
      adjLastEventDate: null,
    });
    // A dividend on 01-08 rescales the provider's whole adjusted history.
    t.state.factor = 0.85;
    t.state.dividends = [{ date: "2026-01-08", amount: 2 }];
    t.state.today = "2026-02-15";
    const r = (await sync(t.deps, "2026-01-07", "2026-01-09")).results[0];
    expect(r.adjRebase).toMatchObject({ rebased: true, rowsChanged: 3 });
    expect(t.meta.get(1)).toEqual({
      adjBaseDate: "2026-02-15",
      adjLastEventDate: "2026-01-08",
    });
    const rows = t.store.get("asset:1")!;
    expect([...rows.keys()].sort()).toEqual(t.days);
    for (const [, x] of rows)
      expect(x.adjClose).toBeCloseTo(x.close * 0.85, 12); // every row on the new base
    // No jump where the two syncs meet: the adjusted return equals the close return (no dividend here).
    const a = rows.get("2026-01-06")!;
    const b = rows.get("2026-01-07")!;
    expect(b.adjClose! / a.adjClose! - 1).toBeCloseTo(
      b.close / a.close - 1,
      12,
    );
  });
  it("same base → no rebase; a dry run reports the rebase without writing", async () => {
    const t = withAdj();
    await sync(t.deps, "2026-01-01", "2026-01-06");
    const same = (await sync(t.deps, "2026-01-05", "2026-01-07")).results[0];
    expect(same.adjRebase, JSON.stringify(same.adjRebase)).toMatchObject({
      rebased: false,
      rowsChanged: 0,
    });
    t.state.factor = 0.8;
    const before = JSON.stringify([...t.store.get("asset:1")!]);
    const dry = (await sync(t.deps, "2026-01-07", "2026-01-09", true))
      .results[0]; // overlaps a stored day, like the daily update
    expect(dry.adjRebase?.rebased).toBe(true);
    expect(JSON.stringify([...t.store.get("asset:1")!])).toBe(before);
  });
  it("a rebase that fails leaves the stored data unchanged", async () => {
    const t = withAdj({ failRebase: true });
    t.store.set(
      "asset:1",
      new Map(
        t.days
          .slice(0, 3)
          .map((d, i) => [d, { close: 100 + i, adjClose: 50 + i }]),
      ),
    ); // unknown old base
    const before = JSON.stringify([...t.store.get("asset:1")!]);
    const r = (await sync(t.deps, "2026-01-07", "2026-01-09")).results[0];
    expect(r.status).toBe("error");
    expect(JSON.stringify([...t.store.get("asset:1")!])).toBe(before);
  });
});
