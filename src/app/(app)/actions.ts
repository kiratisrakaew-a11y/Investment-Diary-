"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import type { AssetClass } from "@/db/schema";
import { createAsset, deleteAsset } from "@/server/services/assets";
import { createNote, deleteNote, updateNote } from "@/server/services/notes";
import { recordPrice } from "@/server/services/prices";
import { createTransaction, deleteTransaction } from "@/server/services/transactions";
import { saveSettings, saveTargets } from "@/server/services/settings";
import { updateAllPrices } from "@/server/services/price-updater";

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
    });
    return done("เพิ่มสินทรัพย์แล้ว");
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAssetAction(id: number) {
  await deleteAsset(id);
  revalidatePath("/", "layout");
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
    });
    return done("บันทึกการตั้งค่าแล้ว");
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
