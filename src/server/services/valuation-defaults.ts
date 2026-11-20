import { listAssets, getAssetBySymbol } from "./assets";
import { priceHistoryFor } from "./prices";
import { getSettings } from "./settings";
import { loadUniverse } from "./optimizer";
import { BenchmarkError } from "@/lib/finance/benchmark-resolve";
import { listBenchmarks } from "./benchmarks";
import type { EditorDefaults } from "@/components/ValuationEditor";
import { defaultInputMeta, marketInputProvenance, readTimestampPolicy } from "@/lib/governance";

/** Starting assumptions for the valuation editor: app settings + latest price + estimated beta. */
export async function editorDefaults(
  symbol: string,
  opts: { returnBasis?: "price_return" | "total_return"; benchmark?: string } = {},
): Promise<{ defaults: EditorDefaults; symbols: string[] }> {
  const [settings, assets, asset] = await Promise.all([getSettings(), listAssets(), symbol ? getAssetBySymbol(symbol) : null]);
  let price = 0;
  let priceDate: string | null = null;
  let beta = 1;
  let betaInfo: Parameters<typeof defaultInputMeta>[1] = null;
  if (asset) {
    const hist = await priceHistoryFor(asset.id);
    price = hist[hist.length - 1]?.close ?? 0;
    priceDate = hist[hist.length - 1]?.date ?? null;
    // Historical beta vs. the benchmark, when there is enough price history.
    const u = await loadUniverse(365 * 2, undefined, opts).catch((e) => {
      if (e instanceof BenchmarkError) throw e;
      return null;
    });
    const b = u?.assets.find((x) => x.symbol === asset.symbol)?.beta;
    if (b != null && Number.isFinite(b)) {
      beta = Number(b.toFixed(2));
      betaInfo = {
        beta,
        observations: u!.observations,
        benchmark: u!.benchmark?.symbol ?? settings.benchmarkSymbol,
        returnBasis: u!.returnBasis,
        benchmarkKind: u!.benchmark?.kind,
        from: u!.from,
        to: u!.to,
        frequency: u!.frequency,
      };
    }
  }
  return {
    defaults: {
      riskFree: settings.riskFreeRate / 100,
      equityRiskPremium: settings.equityRiskPremium / 100,
      currentPrice: price,
      beta,
      inputMeta: defaultInputMeta(settings, betaInfo),
      provenance: marketInputProvenance(settings),
      priceDate,
      timestampPolicy: readTimestampPolicy(settings.timestampPolicy),
      // PRICE_BASIS_BENCHMARK_SPEC F9: what the default β used, and the indexes the editor can re-estimate against.
      betaBasis: {
        basis: opts.returnBasis ?? settings.defaultReturnBasis,
        bench: opts.benchmark ?? settings.defaultBenchmark,
      },
      benchmarks: (await listBenchmarks()).map((b) => ({ symbol: b.symbol, kind: b.kind, days: b.days })),
    },
    symbols: assets.filter((a) => a.assetClass !== "cash").map((a) => a.symbol),
  };
}
