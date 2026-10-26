import { listAssets, getAssetBySymbol } from "./assets";
import { priceHistoryFor } from "./prices";
import { getSettings } from "./settings";
import { loadUniverse } from "./optimizer";
import type { EditorDefaults } from "@/components/ValuationEditor";
import { defaultInputMeta, marketInputProvenance } from "@/lib/governance";

/** Starting assumptions for the valuation editor: app settings + latest price + estimated beta. */
export async function editorDefaults(symbol: string): Promise<{ defaults: EditorDefaults; symbols: string[] }> {
  const [settings, assets, asset] = await Promise.all([getSettings(), listAssets(), symbol ? getAssetBySymbol(symbol) : null]);
  let price = 0;
  let beta = 1;
  let betaInfo: { beta: number; observations: number; benchmark: string } | null = null;
  if (asset) {
    const hist = await priceHistoryFor(asset.id);
    price = hist[hist.length - 1]?.close ?? 0;
    // Historical beta vs. the benchmark, when there is enough price history.
    const u = await loadUniverse(365 * 2).catch(() => null);
    const b = u?.assets.find((x) => x.symbol === asset.symbol)?.beta;
    if (b != null && Number.isFinite(b)) {
      beta = Number(b.toFixed(2));
      betaInfo = { beta, observations: u!.observations, benchmark: u!.benchmark };
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
    },
    symbols: assets.filter((a) => a.assetClass !== "cash").map((a) => a.symbol),
  };
}
