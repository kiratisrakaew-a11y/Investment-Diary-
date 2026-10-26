"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { fetchFundamentals, type Fundamentals } from "@/lib/prices/yahoo";
import type { ValuationInput } from "@/lib/valuation-schemas";
import { getAssetBySymbol } from "@/server/services/assets";
import { deleteValuation, saveValuation } from "@/server/services/valuations";
import { deleteYear, getStatementsWithMeta, saveYears } from "@/server/services/statements";
import type { FinancialYear } from "@/lib/financials";

export async function saveValuationAction(payload: {
  id?: number;
  symbol: string;
  title: string;
  note: string;
  valuation: ValuationInput;
}): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  try {
    const { valuation } = await saveValuation({ ...payload, source: "web" });
    revalidatePath("/", "layout");
    return { ok: true, id: valuation.id };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteValuationAction(id: number) {
  await deleteValuation(id);
  revalidatePath("/", "layout");
}

export async function fetchFundamentalsAction(symbol: string): Promise<{ ok: true; data: Fundamentals; yahoo: string } | { ok: false; error: string }> {
  const asset = await getAssetBySymbol(symbol);
  const yahoo = asset?.providerSymbol ?? (asset?.assetClass === "thai_stock" ? `${asset.symbol}.BK` : symbol);
  try {
    return { ok: true, data: await fetchFundamentals(yahoo), yahoo };
  } catch (e) {
    return { ok: false, error: `ดึงข้อมูลจาก Yahoo (${yahoo}) ไม่สำเร็จ: ${(e as Error).message}` };
  }
}

export async function saveStatementYearAction(symbol: string, year: FinancialYear) {
  try {
    await saveYears(symbol, [year], { preferIncoming: true });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteStatementYearAction(symbol: string, fiscalYear: number) {
  await deleteYear(symbol, fiscalYear);
}

export async function loadStatementsAction(symbol: string) {
  return getStatementsWithMeta(symbol);
}
