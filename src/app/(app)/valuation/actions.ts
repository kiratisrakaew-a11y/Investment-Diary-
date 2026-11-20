"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { fetchFundamentals, type Fundamentals } from "@/lib/prices/yahoo";
import type { ValuationInput } from "@/lib/valuation-schemas";
import { yahooSymbolFor } from "@/server/services/assets";
import { deleteConsensus, recordConsensus, refreshConsensusFromYahoo } from "@/server/services/consensus";
import type { ConsensusInput } from "@/lib/consensus";
import { deleteValuation, saveValuation } from "@/server/services/valuations";
import { deleteYear, getStatementsWithMeta, saveYears } from "@/server/services/statements";
import type { FinancialYear } from "@/lib/financials";
import { analyzeRequest, analyzeValuation, type AnalyzeRequest, type AnalyzeResult } from "@/lib/valuation-analyze";

/** Server-side analyses (Monte Carlo runs here so large SOTP simulations do not block the browser). */
export async function analyzeValuationAction(req: AnalyzeRequest): Promise<{ ok: true; result: AnalyzeResult } | { ok: false; error: string }> {
  try {
    return { ok: true, result: analyzeValuation(analyzeRequest.parse(req)) };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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

/** PRICE_BASIS_BENCHMARK_SPEC F9: re-estimate β (2 years, daily) with the chosen price basis and index. */
export async function estimateBetaAction(
  symbol: string,
  returnBasis: "price_return" | "total_return",
  benchmark: string,
): Promise<{ ok: true; beta: number; betaSource: string } | { ok: false; error: string }> {
  try {
    const { editorDefaults } = await import("@/server/services/valuation-defaults");
    const { defaults } = await editorDefaults(symbol, { returnBasis, benchmark });
    const src = defaults.inputMeta?.betaSource;
    if (!src) return { ok: false, error: `คำนวณ β ของ ${symbol} ไม่ได้ — ประวัติราคาไม่พอ ไม่มีราคาปรับปันผลครบ หรือไม่มีข้อมูลดัชนีในช่วงนี้` };
    return { ok: true, beta: defaults.beta, betaSource: src };
  } catch (e) {
    const err = e as Error & { code?: string; issue?: { suggestion?: string } };
    return { ok: false, error: `${err.message}${err.code ? ` [${err.code}]` : ""}${err.issue?.suggestion ? ` — ${err.issue.suggestion}` : ""}` };
  }
}

export async function fetchFundamentalsAction(symbol: string): Promise<{ ok: true; data: Fundamentals; yahoo: string } | { ok: false; error: string }> {
  const yahoo = await yahooSymbolFor(symbol);
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

/** Analyst consensus: fetch from Yahoo now (button). Nothing is overwritten when Yahoo has no data. */
export async function refreshConsensusAction(symbol: string) {
  try {
    const r = await refreshConsensusFromYahoo(symbol);
    if (r.status === "UPDATED") revalidatePath("/", "layout");
    return { ok: r.status === "UPDATED", status: r.status, message: r.message };
  } catch (e) {
    return { ok: false, status: "ERROR", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveConsensusAction(input: ConsensusInput): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await recordConsensus(input, "manual");
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join(" · ") };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteConsensusAction(id: number, symbol: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await deleteConsensus(id, symbol);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
