import { getDb, schema } from "@/db";
import { settingsInput, targetsInput } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";

export async function getSettings() {
  const [row] = await getDb().select().from(schema.settings);
  return (
    row ?? {
      id: 1,
      riskFreeRate: 2.0,
      benchmarkSymbol: "^SET.BK",
      equityRiskPremium: 6.0,
      baseCurrency: "THB" as const,
      cashFlowPolicy: "strict" as const,
      twrFlowTiming: "start_of_day" as const,
      benchmarkKind: "price_index" as const,
      rfSource: null as string | null,
      rfSeries: null as string | null,
      rfAsOf: null as string | null,
      erpSource: null as string | null,
      erpAsOf: null as string | null,
    }
  );
}

export async function saveSettings(input: {
  riskFreeRate: number;
  benchmarkSymbol: string;
  equityRiskPremium?: number;
  cashFlowPolicy?: "strict" | "infer_with_warning";
  twrFlowTiming?: "start_of_day" | "end_of_day" | "modified_dietz";
  benchmarkKind?: "price_index" | "total_return";
  rfSource?: string | null;
  rfSeries?: string | null;
  rfAsOf?: string | null;
  erpSource?: string | null;
  erpAsOf?: string | null;
}) {
  // Merge with stored values so a partial update never resets other settings to their defaults.
  const current = await getSettings();
  const defined = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const data = settingsInput.parse({
    riskFreeRate: current.riskFreeRate,
    benchmarkSymbol: current.benchmarkSymbol,
    equityRiskPremium: current.equityRiskPremium,
    cashFlowPolicy: current.cashFlowPolicy,
    twrFlowTiming: current.twrFlowTiming,
    benchmarkKind: current.benchmarkKind,
    rfSource: current.rfSource,
    rfSeries: current.rfSeries,
    rfAsOf: current.rfAsOf,
    erpSource: current.erpSource,
    erpAsOf: current.erpAsOf,
    ...defined,
  });
  await getDb()
    .insert(schema.settings)
    .values({ id: 1, ...data })
    .onConflictDoUpdate({ target: schema.settings.id, set: data });
}

export async function getTargets(): Promise<Partial<Record<AssetClass, number>>> {
  const rows = await getDb().select().from(schema.allocationTargets);
  return Object.fromEntries(rows.map((r) => [r.assetClass, r.targetPct]));
}

export async function saveTargets(input: Partial<Record<AssetClass, number>>) {
  const data = targetsInput.parse(input);
  const sum = Object.values(data).reduce((a, b) => a + (b ?? 0), 0);
  if (Math.abs(sum - 100) > 0.01) throw new Error(`Targets must add up to 100% (got ${sum}%)`);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(schema.allocationTargets);
    const rows = Object.entries(data)
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([assetClass, targetPct]) => ({ assetClass: assetClass as AssetClass, targetPct: targetPct! }));
    if (rows.length) await tx.insert(schema.allocationTargets).values(rows);
  });
}
