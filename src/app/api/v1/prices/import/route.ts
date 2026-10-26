import { NextResponse } from "next/server";
import { api } from "@/server/api";
import { importPrices } from "@/server/services/price-sync";
import { workbookToCsv } from "@/lib/spreadsheet";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BYTES = 4_400_000;

/**
 * Bulk price import. multipart/form-data: file (.csv / .xlsx, first sheet with data), symbol?, overwriteExisting?, dryRun?
 * or JSON: { rows | csv, symbol?, overwriteExisting?, dryRun? }.
 */
export const POST = api(async (req) => {
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) return importPrices(await req.json());
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "ไม่พบไฟล์" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "ไฟล์ใหญ่เกิน 4.4MB — แบ่งไฟล์" }, { status: 413 });
  const name = file.name.toLowerCase();
  let csv: string;
  if (name.endsWith(".xlsx")) {
    const sheets = await workbookToCsv(await file.arrayBuffer());
    if (!sheets.length) return NextResponse.json({ error: "ไฟล์ Excel ไม่มีข้อมูล" }, { status: 422 });
    csv = sheets[0].csv;
  } else if (name.endsWith(".csv") || name.endsWith(".txt") || file.type.startsWith("text/")) {
    csv = await file.text();
  } else {
    return NextResponse.json({ error: "รองรับเฉพาะ .csv และ .xlsx" }, { status: 415 });
  }
  const flag = (k: string) => form.get(k) === "true" || form.get(k) === "on";
  return importPrices({ csv, symbol: String(form.get("symbol") ?? "") || undefined, overwriteExisting: flag("overwriteExisting"), dryRun: flag("dryRun") });
});
