import type { AssetClass } from "@/db/schema";

export interface AllocationRow {
  assetClass: AssetClass;
  value: number;
  actualPct: number;
  targetPct: number;
  driftPct: number;
  /** Amount (THB) to buy (+) or sell (−) to get back to target. */
  rebalanceAmount: number;
}

export const ASSET_CLASSES: AssetClass[] = ["thai_stock", "us_stock", "bond", "fund", "gold", "cash"];

/** Actual vs. target allocation by asset class, with drift and rebalance amounts. */
export function computeAllocation(
  valueByClass: Partial<Record<AssetClass, number>>,
  targets: Partial<Record<AssetClass, number>>,
): { total: number; rows: AllocationRow[] } {
  const total = ASSET_CLASSES.reduce((s, c) => s + (valueByClass[c] ?? 0), 0);
  const rows = ASSET_CLASSES.map((assetClass) => {
    const value = valueByClass[assetClass] ?? 0;
    const actualPct = total > 0 ? (value / total) * 100 : 0;
    const targetPct = targets[assetClass] ?? 0;
    return {
      assetClass,
      value,
      actualPct,
      targetPct,
      driftPct: actualPct - targetPct,
      rebalanceAmount: (targetPct / 100) * total - value,
    };
  }).filter((r) => r.value > 0 || r.targetPct > 0);
  return { total, rows };
}
