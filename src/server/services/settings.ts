import { getDb, schema } from "@/db";
import { settingsInput, targetsInput } from "@/lib/validation";
import type { AssetClass } from "@/db/schema";

export async function getSettings() {
  const [row] = await getDb().select().from(schema.settings);
  return row ?? { id: 1, riskFreeRate: 2.0, benchmarkSymbol: "^SET.BK", baseCurrency: "THB" as const };
}

export async function saveSettings(input: { riskFreeRate: number; benchmarkSymbol: string }) {
  const data = settingsInput.parse(input);
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
