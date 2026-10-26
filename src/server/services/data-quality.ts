import { assessDataQuality, marketInputProvenance } from "@/lib/governance";
import { today } from "@/lib/validation";
import { listAssets } from "./assets";
import { getPortfolioSummary } from "./portfolio";
import { loadBenchmark, loadPriceHistory } from "./prices";
import { getSettings } from "./settings";
import { listValuations } from "./valuations";

/** Everything that can make a number in the app unreliable, in one list (UI, MCP and REST). */
export async function dataQualityReport() {
  const [settings, summary, assets, valuations, prices] = await Promise.all([
    getSettings(),
    getPortfolioSummary(),
    listAssets(),
    listValuations({ limit: 2000 }),
    loadPriceHistory(),
  ]);
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const bench = await loadBenchmark(settings.benchmarkSymbol);
  const held = new Set(summary.positions.filter((p) => p.quantity > 0).map((p) => p.assetId));
  return assessDataQuality({
    provenance: marketInputProvenance(settings),
    positions: summary.positions
      .filter((p) => p.quantity > 0)
      .map((p) => ({ symbol: p.symbol, priceStatus: p.priceStatus, priceAgeDays: p.priceAgeDays, fxStatus: p.fxStatus })),
    reconciliation: summary.reconciliation,
    ledgerIssues: summary.issues,
    benchmark: { symbol: settings.benchmarkSymbol, lastDate: bench[bench.length - 1]?.[0] ?? null, kind: settings.benchmarkKind },
    today: today(),
    valuations: valuations.map((v) => ({ id: v.id, symbol: v.symbol, modelVersion: (v.result as { modelVersion?: string } | null)?.modelVersion })),
    bonds: assets.filter((a) => a.assetClass === "bond" && held.has(a.id)).map((a) => ({ symbol: a.symbol, conventionsSet: a.couponFrequency != null && a.dayCount != null })),
    history: assets
      .filter((a) => held.has(a.id) && a.assetClass !== "cash")
      .map((a) => ({ symbol: a.symbol, observations: (prices.get(a.id) ?? []).filter(([d]) => d >= since).length, lookbackDays: 365 })),
  });
}
