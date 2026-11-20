/** MPT_FIX_SPEC phases M4–M5 checks on the local database (TEST-LOCAL PBM-* data, removed by mpt-check). */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { expectedReturnsDetailed, loadUniverse, optimizePortfolio, universeYears } from "../server/services/optimizer";
import { backtestPortfolio } from "../server/services/backtest";
import { getSettings, saveSettings } from "../server/services/settings";
import { blendHistWeight } from "../lib/finance/mu-estimate";
import { stdev } from "../lib/finance/stats";

type Check = (name: string, ok: boolean, detail?: string) => void;

export async function laterChecks(check: Check, days: string[]) {
  const db = getDb();
  const settings = await getSettings();
  const restore = () =>
    saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, muCapPct: settings.muCapPct ?? null });
  try {
    // ---------------------------------------------------------------- P1-7 μ estimators
    const syms = ["PTT", "CPALL", "GOLD", "K-FIXED"];
    const u = await loadUniverse(730, syms);
    const years = universeYears(u);
    const blend = expectedReturnsDetailed(u, "blend");
    const w = blendHistWeight(years);
    const a0 = u.assets[0];
    check(
      "P1-7 blend under 3 years leans on CAPM: μ = w·hist + (1 − w)·CAPM with w = 0.5·years/3, with a note",
      years < 3 && Math.abs(blend.mu[0] - (w * a0.historicalReturn + (1 - w) * (a0.capmReturn ?? a0.historicalReturn))) < 1e-12 && blend.notes.some((n) => n.includes("< 3 ปี")),
      `years ${years.toFixed(2)}, w ${w.toFixed(3)}`,
    );
    const hist = expectedReturnsDetailed(u, "historical").mu;
    const shr = expectedReturnsDetailed(u, "shrinkage");
    check(
      "P1-7 shrinkage reduces the dispersion of μ vs historical",
      stdev(shr.mu) < stdev(hist) && shr.notes.some((n) => n.includes("Bayes–Stein")),
      `σ(μ) ${stdev(hist).toFixed(4)} → ${stdev(shr.mu).toFixed(4)}`,
    );
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, muCapPct: 1 });
    const capped = await optimizePortfolio({ symbols: syms, lookbackDays: 730, returnMethod: "historical" });
    await restore();
    const capm = u.assets.map((a) => a.capmReturn ?? a.historicalReturn);
    check(
      "P1-7 Settings cap |μ − CAPM| ≤ 1%: applied and reported before / after",
      capped.ok &&
        capped.assets.every((a, i) => Math.abs(a.expectedReturn - capm[i]) <= 0.01 + 1e-12) &&
        capped.warnings.some((x) => x.includes("ถูกจำกัดไม่ให้ห่าง CAPM")),
    );
    // ---------------------------------------------------------------- P1-8 ERP provenance
    const erp = await optimizePortfolio({ symbols: syms, lookbackDays: 730, returnMethod: "capm" });
    check(
      "P1-8 illustrative ERP → optimizer warning (CAPM-based μ)",
      erp.ok && (settings.erpSource ? true : erp.warnings.some((x) => x.includes("ERP") && x.includes("ค่าตัวอย่าง"))),
    );

    // ---------------------------------------------------------------- P1-7 (4) BL views from valuations
    const n = days.length;
    const [V] = await db
      .insert(schema.assets)
      .values({ symbol: "PBM-V", name: "TEST-LOCAL PBM-V (sample)", assetClass: "thai_stock", priceSource: "manual", sector: "Test" })
      .returning();
    await db.insert(schema.prices).values(days.map((d, i) => ({ assetId: V.id, date: d, close: 20 * (1 + 0.05 * Math.sin(i / 17)) })));
    const lastPx = 20 * (1 + 0.05 * Math.sin((n - 1) / 17));
    const val = (fv: number, createdAt: Date, scenario?: number[]) => ({
      assetId: V.id,
      symbol: "PBM-V",
      date: createdAt.toISOString().slice(0, 10),
      method: "dcf_fcff" as const,
      assumptions: {},
      result: scenario ? { value: fv, scenarioAnalysis: { scenarios: scenario.map((v, i) => ({ id: String(i), value: v })) } } : { value: fv },
      intrinsicValue: fv,
      createdAt,
    });
    await db.insert(schema.valuations).values(val(lastPx * 1.2, new Date(), [lastPx * 1.0, lastPx * 1.2, lastPx * 1.4]));
    const blSyms = ["PTT", "CPALL", "PBM-V"];
    const mw = { PTT: 0.5, CPALL: 0.3, "PBM-V": 0.2 };
    const bl = await optimizePortfolio({
      symbols: blSyms,
      lookbackDays: 730,
      returnMethod: "black_litterman",
      blackLitterman: { marketWeights: mw, views: [], viewsFromValuations: true },
    });
    const vv = bl.ok ? (bl.blackLitterman as { valuationViews?: { symbol: string; viewReturn: number; confidence: number }[] } | null)?.valuationViews : undefined;
    const withVal = new Set((await db.select({ s: schema.valuations.symbol }).from(schema.valuations)).map((r) => r.s));
    const pv = vv?.find((x) => x.symbol === "PBM-V");
    check(
      "P1-7 BL view from a saved valuation: view = FV / price − 1; no valuation → no view; confidence from the bear–bull width",
      !!pv && Math.abs(pv.viewReturn - 0.2) < 1e-9 && Math.abs(pv.confidence - 1 / (1 + 2 * (0.4 / 1.2))) < 1e-9 &&
        (vv ?? []).every((x) => withVal.has(x.symbol)) &&
        blSyms.filter((x) => !withVal.has(x)).every((x) => !(vv ?? []).some((y) => y.symbol === x)),
      JSON.stringify(vv?.map((x) => ({ ...x, expected: 1 / (1 + 2 * (0.4 / 1.2)) }))),
    );
    await db.update(schema.valuations).set({ createdAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(schema.valuations.symbol, "PBM-V"));
    const old = await optimizePortfolio({
      symbols: blSyms,
      lookbackDays: 730,
      returnMethod: "black_litterman",
      blackLitterman: { marketWeights: mw, views: [], viewsFromValuations: true },
    });
    check("P1-7 a valuation older than 90 days is skipped with a warning", old.ok && old.warnings.some((x) => x.includes("PBM-V") && x.includes("90 วัน")));

    // ---------------------------------------------------------------- BT-6 BL point in time in the backtest
    await db.delete(schema.valuations).where(eq(schema.valuations.symbol, "PBM-V"));
    await db.insert(schema.valuations).values(val(lastPx * 1.2, new Date()));
    const btNone = await backtestPortfolio({
      strategy: "black_litterman",
      symbols: blSyms,
      windowDays: 120,
      blackLitterman: { marketWeights: mw, views: [], viewsFromValuations: true },
    } as never).catch((e) => e as Error);
    check(
      "BT-6 only valuations saved after the test → NOT_BACKTESTABLE_NO_ASOF_DATA",
      btNone instanceof Error && btNone.message.includes("NOT_BACKTESTABLE_NO_ASOF_DATA"),
    );
    const mid = days[Math.floor(n * 0.7)];
    await db.update(schema.valuations).set({ createdAt: new Date(`${mid}T12:00:00Z`), date: mid }).where(eq(schema.valuations.symbol, "PBM-V"));
    const bt = await backtestPortfolio({
      strategy: "black_litterman",
      symbols: blSyms,
      windowDays: 120,
      rebalance: "monthly",
      blackLitterman: { marketWeights: mw, views: [], viewsFromValuations: true, valuationMaxAgeDays: 730 },
    } as never);
    const used = bt.warnings.find((x) => x.startsWith("views จาก valuation ถูกใช้"));
    const m = used?.match(/ถูกใช้ (\d+) จาก (\d+)/);
    check(
      "BT-6 views only from valuations saved before each rebalance (used in the later rounds only)",
      !!m && Number(m[1]) > 0 && Number(m[1]) < Number(m[2]),
      used,
    );

    // ---------------------------------------------------------------- A6 net of withholding tax
    const [Dv] = await db
      .insert(schema.assets)
      .values({ symbol: "PBM-DIV", name: "TEST-LOCAL PBM-DIV (sample)", assetClass: "thai_stock", priceSource: "manual", sector: "Test" })
      .returning();
    // Price drifts with noise; a 2.5% dividend every quarter; adj chain consistent with the dividends.
    const xds = days.map((_, i) => i).filter((i) => i > 0 && i % 63 === 0);
    const dps = 1.25;
    // Realistic: the close falls by the dividend on each ex-date.
    const close = days.map((_, i) => 50 * (1 + 0.0003 * i + 0.02 * Math.sin(i / 7)) - dps * xds.filter((k) => k <= i).length);
    const factor = days.map(() => 1);
    for (const k of xds) for (let i = 0; i < k; i++) factor[i] *= 1 - dps / close[k - 1];
    await db.insert(schema.prices).values(days.map((d, i) => ({ assetId: Dv.id, date: d, close: close[i], adjClose: close[i] * factor[i] })));
    await db.insert(schema.dividendEvents).values(
      xds.map((k, j) => ({ symbol: "PBM-DIV", assetId: Dv.id, exDate: days[k], dividendPerShare: dps, source: "test", sourceEventId: `PBM-DIV-${j}` })),
    );
    const s2 = ["PTT", "PBM-DIV"];
    const gross = await loadUniverse(730, s2, { returnBasis: "total_return" });
    const net0 = await loadUniverse(730, s2, { returnBasis: "total_return", dividendWithholding: 0 });
    const net10 = await loadUniverse(730, s2, { returnBasis: "total_return", dividendWithholding: 0.1 });
    const mu = (x: typeof gross) => x.assets.find((a) => a.symbol === "PBM-DIV")!.historicalReturn;
    const yieldPa = (dps * 4) / 50;
    check(
      "A6 wht 0 (close + dividends) vs adj_close: ≤ 0.1%/yr apart",
      net0.returnBasisByAsset?.["PBM-DIV"] === "net_dividends" && Math.abs(mu(net0) - mu(gross)) <= 0.001,
      `${(mu(gross) * 100).toFixed(3)}% vs ${(mu(net0) * 100).toFixed(3)}%`,
    );
    const drop = mu(net0) - mu(net10);
    check(
      "A6 wht 10% → lower by ≈ 10% of the dividend yield",
      Math.abs(drop - 0.1 * yieldPa) <= 0.003,
      `drop ${(drop * 100).toFixed(2)}% vs ${(0.1 * yieldPa * 100).toFixed(2)}%`,
    );
  } finally {
    await restore();
  }
}
