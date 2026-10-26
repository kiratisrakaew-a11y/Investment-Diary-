"use server";

import { revalidatePath } from "next/cache";
import type { AssetClass } from "@/db/schema";
import { saveTargets } from "@/server/services/settings";

/** Save optimizer weights (aggregated by asset class, in %) as the allocation targets. */
export async function applyTargetsAction(byClass: Partial<Record<AssetClass, number>>): Promise<{ ok: boolean; error?: string }> {
  try {
    const entries = Object.entries(byClass).map(([k, v]) => [k, Math.round((v ?? 0) * 10) / 10] as const);
    // Push rounding residue onto the largest class so the targets sum to exactly 100.
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    const largest = entries.reduce((m, e) => (e[1] > m[1] ? e : m), entries[0]);
    const fixed = Object.fromEntries(entries.map(([k, v]) => [k, k === largest[0] ? Math.round((v + 100 - sum) * 10) / 10 : v]));
    await saveTargets(fixed);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
