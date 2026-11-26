import { computeAllocation } from "@/lib/finance/allocation";
import { computeMetrics } from "@/lib/finance/metrics";
import {
  correlationMatrix,
  portfolioStats,
  randomPortfolios,
} from "@/lib/finance/mpt";
import { constrainedFrontier } from "@/lib/finance/optimizer";
import { componentES, riskContribution } from "@/lib/finance/risk-contribution";
import { buildSnapshot, buildValueSeries, investorCashFlows, type AssetInput, type TotalReturnMode, type TxInput } from "@/lib/finance/portfolio";
import { adjAssetsForPortfolio, unrecordedDividends } from "@/lib/finance/total-return-portfolio";
import { benchmarkReportOf, normalizeBenchmarkRequest } from "@/lib/finance/benchmark-resolve";
import { resolveBenchmark } from "./benchmarks";
import { today } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";
import { listAssets } from "./assets";
import {
  loadAdjPriceHistory,
  loadCorporateActionDates,
  loadFxHistory,
  loadPriceHistory,
} from "./prices";
import { priceBasisReport, resolveReturnBasis, type ReturnBasis } from "@/lib/finance/price-basis";
import type { WindowRequest } from "@/lib/finance/window";
import { getSettings, getTargets } from "./settings";
import { allTransactions } from "./transactions";

/** Everything the portfolio calculations read (assets, ledger, prices, FX, settings). Read-only. */
export type PortfolioData = Awaited<ReturnType<typeof loadAll>>;

/**
 * Load once and pass the result to several calculations on the same page (summary, allocation,
 * performance, MPT) instead of each reloading every price row. Callers must not mutate it.
 */
export function loadPortfolioData() {
  return loadAll();
}

async function loadAll() {
  const [assets, txRows, prices, fx, settings] = await Promise.all([
    listAssets(),
    allTransactions(),
    loadPriceHistory(),
    loadFxHistory(),
    getSettings(),
  ]);
  const txs: TxInput[] = txRows.map((t) => ({
    id: t.id,
    date: t.date,
    assetId: t.assetId,
    type: t.type,
    quantity: t.quantity,
    price: t.price,
    fee: t.fee,
    fxRate: t.fxRate,
  }));
  const assetInputs: AssetInput[] = assets.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    assetClass: a.assetClass,
    currency: a.currency,
  }));
  return { assets, assetInputs, txs, prices, fx, settings };
}

/** Units held at the end of each date (ledger replay, share basis of that date). */
export async function holdingsAt(dates: string[]): Promise<Map<string, Map<string, number>>> {
  const { assetInputs, txs, prices, fx } = await loadAll();
  const out = new Map<string, Map<string, number>>();
  for (const d of [...new Set(dates)]) out.set(d, new Map(buildSnapshot(assetInputs, txs, prices, fx, d).positions.map((p) => [p.symbol, p.quantity])));
  return out;
}

export async function getPortfolioSummary(date = today(), data?: PortfolioData) {
  const { assetInputs, txs, prices, fx } = data ?? (await loadAll());
  return buildSnapshot(assetInputs, txs, prices, fx, date);
}

export async function getAllocation(date = today(), data?: PortfolioData) {
  const [snap, targets] = await Promise.all([getPortfolioSummary(date, data), getTargets()]);
  const byClass: Partial<Record<AssetClass, number>> = {};
  for (const p of snap.positions) byClass[p.assetClass] = (byClass[p.assetClass] ?? 0) + p.marketValueThb;
  if (snap.cashThb > 0) byClass.cash = (byClass.cash ?? 0) + snap.cashThb;
  return computeAllocation(byClass, targets);
}

/** Valuation dates: every date with a price, FX, benchmark or transaction, from the first trade until today. */
function valuationDates(txs: TxInput[], prices: Map<number, [string, number][]>, bench: [string, number][], end: string) {
  if (!txs.length) return [];
  const start = txs.reduce((m, t) => (t.date < m ? t.date : m), txs[0].date);
  const set = new Set<string>([end]);
  for (const t of txs) set.add(t.date);
  for (const series of prices.values()) for (const [d] of series) if (d >= start && d <= end) set.add(d);
  for (const [d] of bench) if (d >= start && d <= end) set.add(d);
  // Weekend dates only appear if a transaction was recorded on them.
  return [...set].filter((d) => d >= start && d <= end).sort();
}

export async function getPerformance(
  end = today(),
  data?: PortfolioData,
  opts: { returnBasis?: ReturnBasis; benchmark?: string } = {},
) {
  const { assets, assetInputs, txs, prices, fx, settings } = data ?? (await loadAll());
  // PRICE_BASIS_BENCHMARK_SPEC F1: request → Settings → price_return; benchmark request → Settings → Settings' index.
  const basisInfo = resolveReturnBasis(opts.returnBasis, settings.defaultReturnBasis ?? null, "price_return");
  const start = txs.length ? txs.reduce((m, t) => (t.date < m ? t.date : m), txs[0].date) : undefined;
  const benchRequest = normalizeBenchmarkRequest(opts.benchmark ?? settings.defaultBenchmark);
  // D5: the real portfolio includes dividends either way, so the matching index is a total-return one (fixes B2
  // with "auto"); "default" keeps Settings' index, whose kind mismatch metrics.ts already reports.
  const resolved = await resolveBenchmark({
    request: benchRequest,
    wanted: "total_return",
    from: benchRequest === "default" ? undefined : start,
    featureDefault: "settings",
  });
  const bench = resolved?.series ?? [];
  const dates = valuationDates(txs, prices, bench, end);

  let tr: { mode: TotalReturnMode; fallback: { symbol: string; reason: string }[] } | null = null;
  if (basisInfo.used === "total_return") {
    const [adj, actions] = await Promise.all([loadAdjPriceHistory(), loadCorporateActionDates()]);
    const sel = adjAssetsForPortfolio(
      assets.map((a) => ({ ...assetInputs.find((x) => x.id === a.id)!, assetClass: a.assetClass })),
      txs,
      prices,
      adj,
      end,
      (a) => actions.for(a),
    );
    tr = { mode: { adj, assetIds: sel.assetIds }, fallback: sel.fallback };
  }
  const series = buildValueSeries(assetInputs, txs, prices, fx, dates, tr?.mode);
  const last = series[series.length - 1];
  const metrics = computeMetrics({
    values: series,
    cashFlows: investorCashFlows(txs.filter((t) => t.date <= end), assetInputs),
    finalValue: last?.value ?? 0,
    finalDate: end,
    riskFreeRate: settings.riskFreeRate / 100,
    sortinoMar: settings.sortinoMarPct != null ? settings.sortinoMarPct / 100 : null,
    flowTiming: settings.twrFlowTiming,
    riskDates: series.filter((p) => p.carriedPositions === 0).map((p) => p.date),
    benchmark: bench.length && resolved ? { symbol: resolved.symbol, series: bench, kind: resolved.kind } : null,
  });
  const inferredFlows = series.filter((p) => p.inferredFlow > 0).map((p) => ({ date: p.date, amount: p.inferredFlow }));
  if (inferredFlows.length) {
    metrics.dataQuality.warnings.push(
      `มีเงินฝากที่ระบบอนุมาน ${inferredFlows.length} ครั้ง (รวม ${Math.round(inferredFlows.reduce((a, f) => a + f.amount, 0)).toLocaleString()} บาท) เพราะบันทึกซื้อโดยไม่มีเงินสด — TWR/XIRR ถือเป็นเงินลงทุนจากภายนอก`,
    );
  }
  let unrecorded: ReturnType<typeof unrecordedDividends> = [];
  if (tr) {
    const symbolOf = new Map(assetInputs.map((a) => [a.id, a.symbol]));
    unrecorded = unrecordedDividends(series, txs, (id) => symbolOf.get(id) ?? String(id), end);
    if (unrecorded.length)
      metrics.dataQuality.warnings.push(
        `ราคาปรับปันผลนับปันผลที่ไม่ได้บันทึก ${unrecorded.length} ครั้ง (${unrecorded
          .slice(0, 6)
          .map((u) => `${u.symbol} XD ${u.exDate}${u.pending ? " ยังไม่ถึงกำหนดจ่าย?" : ""}`)
          .join(", ")}${unrecorded.length > 6 ? " …" : ""}) — TWR แบบ Adjusted Close จึงสูงกว่าแบบ Close ราวปันผลนั้น · บันทึกเงินปันผลที่ได้รับเพื่อให้สองแบบตรงกัน`,
      );
  }
  const info = benchmarkReportOf(resolved);
  return {
    ...metrics,
    // The §5 benchmark block (basis / wanted / source / warning) merged into the statistics block.
    benchmark: metrics.benchmark
      ? {
          ...metrics.benchmark,
          basis: info?.basis ?? (metrics.benchmark.kind === "total_return" ? ("total_return" as const) : ("price" as const)),
          wanted: "total_return" as const,
          source: info?.source ?? ("default" as const),
          warning: info?.warning ?? null,
        }
      : null,
    inferredFlows,
    valueSeries: series.map((p) => ({ date: p.date, value: p.value, contributed: p.contributed })),
    priceBasis: priceBasisReport(basisInfo, tr?.fallback ?? [], []),
    ...(tr ? { unrecordedDividends: unrecorded } : {}),
  };
}

/**
 * Markowitz analysis of the assets currently held: expected returns and
 * covariance from aligned daily THB returns over the look-back window.
 */
export async function getMptAnalysis(
  lookbackDays?: number,
  data?: PortfolioData,
  opts: {
    returnBasis?: ReturnBasis;
    window?: WindowRequest;
    frequency?: "daily" | "weekly" | "monthly";
    historyPolicy?: "common" | "drop_short" | "pairwise";
    covMethod?: "sample" | "ledoit_wolf";
  } = {},
) {
  const { assetInputs, txs, prices, fx } = data ?? (await loadAll());
  const snap = buildSnapshot(assetInputs, txs, prices, fx, today());
  const held = snap.positions.filter((p) => p.quantity > 0 && p.assetClass !== "cash");
  // spec-lookback-window: the same universe loader as optimize_portfolio (window, frequency, history policy,
  // price basis), so the two report the same period and windowInfo for the same input.
  if (!held.length)
    return {
      ok: false as const,
      reason: "ยังไม่มีสินทรัพย์ที่ถืออยู่",
      skipped: [] as string[],
      skippedDetail: [],
      priceBasis: priceBasisReport(resolveReturnBasis(opts.returnBasis, null, "price_return")),
      windowInfo: undefined,
      coverage: undefined,
    };
  const { loadUniverse } = await import("./optimizer");
  const u = await loadUniverse(lookbackDays, held.map((p) => p.symbol), {
    withSeries: true,
    window: opts.window,
    returnBasis: opts.returnBasis,
    frequency: opts.frequency,
    historyPolicy: opts.historyPolicy,
  });
  const priceBasis = u.priceBasis ?? priceBasisReport(resolveReturnBasis(opts.returnBasis, null, "price_return"));
  const used = new Set(u.assets.map((a) => a.symbol));
  const skipped = held.filter((p) => !used.has(p.symbol)).map((p) => p.symbol);
  if (!u.ok || u.assets.length < 2)
    return {
      ok: false as const,
      reason: u.reason ?? "ต้องมีสินทรัพย์ที่ถืออยู่และมีประวัติราคาพออย่างน้อย 2 ตัว",
      skipped,
      skippedDetail: u.skipped,
      priceBasis,
      windowInfo: u.windowInfo,
      coverage: u.coverage,
    };
  const symbols = u.assets.map((a) => a.symbol);
  const mu = u.assets.map((a) => a.historicalReturn);
  const cov = opts.covMethod === "ledoit_wolf" ? u.covShrunk : u.cov;
  const rf = u.riskFree;
  const totalHeld = u.assets.reduce((s, a) => s + a.currentValue, 0);
  const current = portfolioStats(u.assets.map((a) => (totalHeld > 0 ? a.currentValue / totalHeld : 1 / u.assets.length)), mu, cov, rf);
  // Same QP engine as the optimizer page (long-only, fully invested).
  const f = constrainedFrontier(mu, cov, rf, { min: 0, max: 1 }, 100);
  const tangency = f.tangency;
  return {
    ok: true as const,
    symbols,
    skipped,
    skippedDetail: u.skipped,
    priceBasis,
    windowInfo: u.windowInfo,
    coverage: u.coverage,
    frequency: u.frequency,
    covMethod: opts.covMethod ?? "sample",
    observations: u.observations,
    periodsPerYear: u.periodsPerYear,
    covarianceWarnings: u.covarianceWarnings,
    from: u.from!,
    to: u.to!,
    riskFreeRate: rf,
    assets: u.assets.map((a, i) => ({ symbol: a.symbol, expectedReturn: mu[i], volatility: Math.sqrt(cov[i][i]) })),
    correlation: correlationMatrix(cov),
    /** Risk decomposition of the current holdings (σ annual; component ES on periodic returns). */
    risk: {
      ...riskContribution(symbols, current.weights, cov),
      componentES95: componentES(symbols, current.weights, u.series?.returns ?? []),
    },
    current,
    minVariance: f.gmv,
    /** null when no long-only portfolio earns more than Rf. */
    tangency,
    frontier: f.curve.filter((p) => p.efficient).map((p) => portfolioStats(p.weights, mu, cov, rf)),
    warnings: tangency ? [] : [`ไม่มีพอร์ตที่ผลตอบแทนคาดหวังสูงกว่า Rf (${(rf * 100).toFixed(2)}%) — ไม่มี tangency portfolio`],
    cloud: randomPortfolios(mu, cov, rf, 400).map((p) => ({ volatility: p.volatility, expectedReturn: p.expectedReturn })),
    /** Capital Market Line: E[R] = Rf + Sharpe_tangency · σ */
    cml: tangency?.sharpe != null ? { intercept: rf, slope: tangency.sharpe } : null,
  };
}
