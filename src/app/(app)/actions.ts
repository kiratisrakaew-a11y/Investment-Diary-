"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { AssetClass } from "@/db/schema";
import { createAsset, getAsset, updateAsset, updateAssetProfile } from "@/server/services/assets";
import { changeAssetLifecycle } from "@/server/services/asset-lifecycle";
import type { LifecycleAction } from "@/lib/asset-lifecycle";
import { createNote, deleteNote, updateNote } from "@/server/services/notes";
import { recordPrice } from "@/server/services/prices";
import { createTransaction, deleteTransaction } from "@/server/services/transactions";
import { saveSettings, saveTargets, saveTimestampPolicy, saveTradingCosts } from "@/server/services/settings";
import { updateAllPrices } from "@/server/services/price-updater";
import { syncHistoricalPrices } from "@/server/services/price-sync";

export type ActionState = { ok?: boolean; error?: string; message?: string } | null;

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return v == null || v === "" ? undefined : String(v);
};
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v == null ? undefined : Number(v);
};
const list = (f: FormData, k: string) =>
  (str(f, k) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function fail(e: unknown): ActionState {
  if (e instanceof ZodError) return { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") };
  return { error: e instanceof Error ? e.message : String(e) };
}

function done(message?: string): ActionState {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

export async function saveNoteAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const input = {
      date: str(f, "date"),
      title: str(f, "title") ?? "",
      body: str(f, "body") ?? "",
      type: (str(f, "type") ?? "idea") as "idea",
      tags: list(f, "tags"),
      symbols: list(f, "symbols"),
      conviction: num(f, "conviction"),
    };
    const id = num(f, "id");
    if (id) await updateNote(id, input);
    else await createNote({ ...input, source: "web" });
    return done("บันทึกแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function deleteNoteAction(id: number) {
  await deleteNote(id);
  revalidatePath("/", "layout");
}

export async function addTransactionAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    await createTransaction({
      date: str(f, "date"),
      type: (str(f, "type") ?? "buy") as "buy",
      symbol: str(f, "symbol"),
      quantity: num(f, "quantity") ?? 0,
      price: num(f, "price") ?? 0,
      fee: num(f, "fee") ?? 0,
      fxRate: num(f, "fxRate"),
      noteId: num(f, "noteId"),
      memo: str(f, "memo"),
      source: "web",
    });
    return done("บันทึกรายการแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTransactionAction(id: number) {
  await deleteTransaction(id);
  revalidatePath("/", "layout");
}

export async function addAssetAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    await createAsset({
      symbol: str(f, "symbol") ?? "",
      name: str(f, "name") ?? "",
      assetClass: (str(f, "assetClass") ?? "thai_stock") as AssetClass,
      currency: (str(f, "currency") ?? "THB") as "THB",
      priceSource: (str(f, "priceSource") ?? "manual") as "manual",
      providerSymbol: str(f, "providerSymbol"),
      couponRate: num(f, "couponRate"),
      maturityDate: str(f, "maturityDate"),
      faceValue: num(f, "faceValue"),
      couponFrequency: num(f, "couponFrequency") as 1 | 2 | 4 | 12 | undefined,
      dayCount: str(f, "dayCount") as "ACT/ACT-ICMA" | undefined,
    });
    return done("เพิ่มสินทรัพย์แล้ว");
  } catch (e) {
    return fail(e);
  }
}

/** Bond terms on an existing asset (coupon, maturity, face, frequency, day count). */
export async function updateBondTermsAction(id: number, _: ActionState, f: FormData): Promise<ActionState> {
  try {
    await updateAsset(id, {
      couponRate: num(f, "couponRate"),
      maturityDate: str(f, "maturityDate"),
      faceValue: num(f, "faceValue"),
      couponFrequency: num(f, "couponFrequency") as 1 | 2 | 4 | 12 | undefined,
      dayCount: str(f, "dayCount") as "ACT/ACT-ICMA" | undefined,
    });
    const asset = await getAsset(id);
    if (asset) {
      // Metadata is replaced as a whole from the form; empty fields are left out (never invented).
      const terms = Object.fromEntries(
        Object.entries({
          issuerType: str(f, "issuerType"),
          issuerCountry: str(f, "issuerCountry")?.toUpperCase(),
          couponType: str(f, "couponType"),
          callable: f.get("callable") === "on" ? true : undefined,
          puttable: f.get("puttable") === "on" ? true : undefined,
          identifiers: str(f, "isin") || str(f, "thaiBma") ? { isin: str(f, "isin")?.toUpperCase(), thaiBma: str(f, "thaiBma") } : undefined,
          riskFreeProxyEligible: f.get("riskFreeProxyEligible") === "on" ? true : undefined,
          source: str(f, "termsSource"),
          asOf: str(f, "termsAsOf"),
        }).filter(([, v]) => v !== undefined),
      );
      await updateAssetProfile({ symbol: asset.symbol, bondTerms: Object.keys(terms).length ? (terms as never) : null });
    }
    revalidatePath("/", "layout");
    return done("บันทึกเงื่อนไขพันธบัตรแล้ว");
  } catch (e) {
    return fail(e);
  }
}

/** Hide / archive / restore / guarded delete by asset id; returns the typed result for the UI. */
export async function assetLifecycleAction(assetId: number, action: LifecycleAction, confirmSymbol?: string) {
  const r = await changeAssetLifecycle({ assetId, action, confirmSymbol, source: "web" });
  revalidatePath("/", "layout");
  return { status: r.status, message: r.message, unchanged: !!r.unchanged, dependencies: r.dependencies ?? null };
}

export async function addPriceAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    await recordPrice({ symbol: str(f, "symbol") ?? "", date: str(f, "date"), close: num(f, "close") ?? 0 });
    return done("บันทึกราคาแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function saveSettingsAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    await saveSettings({
      riskFreeRate: num(f, "riskFreeRate") ?? 0,
      benchmarkSymbol: str(f, "benchmarkSymbol") ?? "^SET.BK",
      equityRiskPremium: num(f, "equityRiskPremium"),
      cashFlowPolicy: (str(f, "cashFlowPolicy") as "strict" | "infer_with_warning" | undefined) ?? undefined,
      twrFlowTiming: (str(f, "twrFlowTiming") as "start_of_day" | "end_of_day" | "modified_dietz" | undefined) ?? undefined,
      benchmarkKind: (str(f, "benchmarkKind") as "price_index" | "total_return" | undefined) ?? undefined,
      // Empty text clears a source (the input becomes illustrative again).
      rfSource: str(f, "rfSource") ?? null,
      rfSeries: str(f, "rfSeries") ?? null,
      rfAsOf: str(f, "rfAsOf") ?? null,
      erpSource: str(f, "erpSource") ?? null,
      erpAsOf: str(f, "erpAsOf") ?? null,
      // Empty = use the risk-free rate as the Sortino minimum acceptable return.
      sortinoMarPct: num(f, "sortinoMarPct") ?? null,
    });
    return done("บันทึกการตั้งค่าแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function saveTradingCostsAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const lot = (k: string) => num(f, `lot_${k}`);
    const classes = ["thai_stock", "us_stock", "fund", "bond", "gold"];
    await saveTradingCosts({
      commissionPct: num(f, "commissionPct") ?? 0,
      minCommission: num(f, "minCommission") ?? 0,
      vatPct: num(f, "vatPct") ?? 0,
      slippageBps: num(f, "slippageBps") ?? 0,
      sellTaxPct: num(f, "sellTaxPct") ?? 0,
      minTradeValue: num(f, "minTradeValue") ?? 0,
      lotSize: Object.fromEntries(classes.flatMap((c) => { const v = lot(c); return v != null && v > 0 ? [[c, v] as const] : []; })),
    });
    return done("บันทึกต้นทุนการซื้อขายแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function saveTimestampPolicyAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    await saveTimestampPolicy({
      inputsMaxAgeDays: num(f, "inputsMaxAgeDays") ?? undefined,
      priceMaxGapDays: num(f, "priceMaxGapDays") ?? undefined,
      statementsMaxAgeDays: num(f, "statementsMaxAgeDays") ?? undefined,
    });
    return done("บันทึกเกณฑ์วันที่ข้อมูลแล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function saveTargetsAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const classes: AssetClass[] = ["thai_stock", "us_stock", "bond", "fund", "gold", "cash"];
    await saveTargets(Object.fromEntries(classes.map((c) => [c, num(f, c) ?? 0])));
    return done("บันทึกเป้าหมายแล้ว");
  } catch (e) {
    return fail(e);
  }
}

/** Historical price backfill from the holdings page (same service as sync_historical_prices). */
export async function syncHistoryAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const symbols = (str(f, "symbols") ?? "").split(/[\s,]+/).filter(Boolean);
    const r = await syncHistoricalPrices({
      symbols,
      startDate: str(f, "startDate"),
      endDate: str(f, "endDate"),
      lookbackDays: str(f, "startDate") ? undefined : num(f, "lookbackDays"),
      priceType: f.get("adjusted") ? "adjusted_close" : "close",
      overwriteExisting: !!f.get("overwrite"),
      dryRun: !!f.get("dryRun"),
    });
    if (!r.dryRun) revalidatePath("/", "layout");
    const by = (s: string) => r.results.filter((x) => x.status === s).map((x) => (x.message && s !== "ok" ? `${x.symbol} (${x.message})` : x.symbol));
    const parts = [
      `${r.dryRun ? "[ทดลอง ไม่บันทึก] " : ""}${r.range.from} → ${r.range.to}: สำเร็จ ${r.summary.ok}/${r.summary.requested} · เพิ่ม ${r.summary.inserted} แถว · อัปเดต ${r.summary.updated}`,
      by("unknown_asset").length && `ไม่พบ: ${by("unknown_asset").join(", ")}`,
      by("unsupported").length && `ไม่รองรับ: ${by("unsupported").join(", ")}`,
      by("error").length && `ผิดพลาด: ${by("error").join(", ")}`,
      r.eligibility && `จัดพอร์ตได้: ${r.eligibility.eligible.join(", ") || "–"}${r.eligibility.skipped.length ? ` · ยังไม่พอ: ${r.eligibility.skipped.map((s) => `${s.symbol} (${s.reason})`).join(", ")}` : ""}`,
      ...r.results.flatMap((x) => x.warnings),
    ].filter(Boolean);
    return r.summary.failed || r.summary.ok === 0 ? { ok: false, error: parts.join(" | ") } : done(parts.join(" | "));
  } catch (e) {
    return fail(e);
  }
}

export async function updatePricesAction(_: ActionState): Promise<ActionState> {
  try {
    const results = await updateAllPrices();
    const failed = results.filter((r) => !r.ok);
    revalidatePath("/", "layout");
    return failed.length
      ? { ok: false, error: `อัปเดตไม่สำเร็จ: ${failed.map((r) => `${r.symbol} (${r.error})`).join(", ")}` }
      : { ok: true, message: `อัปเดต ${results.length} รายการแล้ว` };
  } catch (e) {
    return fail(e);
  }
}
