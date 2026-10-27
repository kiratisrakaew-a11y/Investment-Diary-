import { computeAllocation } from "@/lib/finance/allocation";
import { computeMetrics } from "@/lib/finance/metrics";
import {
  covarianceDiagnostics,
  estimateInputs,
  correlationMatrix,
  portfolioStats,
  randomPortfolios,
} from "@/lib/finance/mpt";
import { constrainedFrontier } from "@/lib/finance/optimizer";
import { componentES, riskContribution } from "@/lib/finance/risk-contribution";
import { asOf, buildSnapshot, buildValueSeries, investorCashFlows, type AssetInput, type TxInput } from "@/lib/finance/portfolio";
import { simpleReturns } from "@/lib/finance/stats";
import { today } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";
import { listAssets } from "./assets";
import { loadBenchmark, loadFxHistory, loadPriceHistory } from "./prices";
import { getSettings, getTargets } from "./settings";
import { allTransactions } from "./transactions";

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

export async function getPortfolioSummary(date = today()) {
  const { assetInputs, txs, prices, fx } = await loadAll();
  return buildSnapshot(assetInputs, txs, prices, fx, date);
}

export async function getAllocation(date = today()) {
  const [snap, targets] = await Promise.all([getPortfolioSummary(date), getTargets()]);
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

export async function getPerformance(end = today()) {
  const { assetInputs, txs, prices, fx, settings } = await loadAll();
  const bench = await loadBenchmark(settings.benchmarkSymbol);
  const dates = valuationDates(txs, prices, bench, end);
  const series = buildValueSeries(assetInputs, txs, prices, fx, dates);
  const last = series[series.length - 1];
  const metrics = computeMetrics({
    values: series,
    cashFlows: investorCashFlows(txs.filter((t) => t.date <= end), assetInputs),
    finalValue: last?.value ?? 0,
    finalDate: end,
    riskFreeRate: settings.riskFreeRate / 100,
    flowTiming: settings.twrFlowTiming,
    riskDates: series.filter((p) => p.carriedPositions === 0).map((p) => p.date),
    benchmark: bench.length ? { symbol: settings.benchmarkSymbol, series: bench, kind: settings.benchmarkKind } : null,
  });
  const inferredFlows = series.filter((p) => p.inferredFlow > 0).map((p) => ({ date: p.date, amount: p.inferredFlow }));
  if (inferredFlows.length) {
    metrics.dataQuality.warnings.push(
      `มีเงินฝากที่ระบบอนุมาน ${inferredFlows.length} ครั้ง (รวม ${Math.round(inferredFlows.reduce((a, f) => a + f.amount, 0)).toLocaleString()} บาท) เพราะบันทึกซื้อโดยไม่มีเงินสด — TWR/XIRR ถือเป็นเงินลงทุนจากภายนอก`,
    );
  }
  return {
    ...metrics,
    inferredFlows,
    valueSeries: series.map((p) => ({ date: p.date, value: p.value, contributed: p.contributed })),
  };
}

/**
 * Markowitz analysis of the assets currently held: expected returns and
 * covariance from aligned daily THB returns over the look-back window.
 */
export async function getMptAnalysis(lookbackDays = 365 * 2) {
  const { assetInputs, txs, prices, fx, settings } = await loadAll();
  const snap = buildSnapshot(assetInputs, txs, prices, fx, today());
  const held = snap.positions.filter((p) => p.quantity > 0 && p.assetClass !== "cash");
  const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const rf = settings.riskFreeRate / 100;

  // USD assets need USDTHB for every date; never substitute FX = 1.
  const fxStart = fx[0]?.[0];
  const usable = held.filter(
    (p) =>
      (prices.get(p.assetId)?.filter(([d]) => d >= from).length ?? 0) >= 30 &&
      (p.currency !== "USD" || (fxStart != null && fxStart <= (prices.get(p.assetId)!.find(([d]) => d >= from)?.[0] ?? from))),
  );
  const skipped = held.filter((p) => !usable.includes(p)).map((p) => p.symbol);
  if (usable.length < 2) {
    return { ok: false as const, reason: "Need at least 2 held assets with 30+ days of price history.", skipped };
  }

  // Dates on which every usable asset has a price.
  const dateSets = usable.map((p) => new Set(prices.get(p.assetId)!.filter(([d]) => d >= from).map(([d]) => d)));
  const common = [...dateSets[0]].filter((d) => dateSets.every((s) => s.has(d))).sort();
  if (common.length < 30) {
    return { ok: false as const, reason: "Not enough overlapping price dates between holdings.", skipped };
  }
  const series = usable.map((p) => {
    const hist = prices.get(p.assetId)!;
    return simpleReturns(
      common.map((d) => (asOf(hist, d) ?? 0) * (p.currency === "USD" ? (asOf(fx, d) ?? NaN) : 1)),
    );
  });
  const years = (Date.parse(common[common.length - 1]) - Date.parse(common[0])) / (365 * 86_400_000);
  const periodsPerYear = years > 0 ? (common.length - 1) / years : 252;
  const { mu, cov } = estimateInputs(series, periodsPerYear);
  const covWarnings = covarianceDiagnostics(cov).warnings;
  const totalHeld = usable.reduce((s, p) => s + p.marketValueThb, 0);
  const current = portfolioStats(usable.map((p) => p.marketValueThb / totalHeld), mu, cov, rf);
  // Same QP engine as the optimizer page (long-only, fully invested).
  const f = constrainedFrontier(mu, cov, rf, { min: 0, max: 1 }, 100);
  const tangency = f.tangency;

  return {
    ok: true as const,
    symbols: usable.map((p) => p.symbol),
    skipped,
    observations: common.length,
    periodsPerYear,
    covarianceWarnings: covWarnings,
    from: common[0],
    to: common[common.length - 1],
    riskFreeRate: rf,
    assets: usable.map((p, i) => ({ symbol: p.symbol, expectedReturn: mu[i], volatility: Math.sqrt(cov[i][i]) })),
    correlation: correlationMatrix(cov),
    /** Risk decomposition of the current holdings (σ annual; component ES on periodic returns). */
    risk: {
      ...riskContribution(usable.map((p) => p.symbol), current.weights, cov),
      componentES95: componentES(usable.map((p) => p.symbol), current.weights, series),
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
