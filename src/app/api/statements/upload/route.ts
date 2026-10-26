import { NextResponse } from "next/server";
import { api } from "@/server/api";
import { MAX_UPLOAD_BYTES, detectKind, processUpload } from "@/server/services/statements";

export const runtime = "nodejs";
// Reading a long PDF can take a while; Vercel caps this by plan.
export const maxDuration = 300;

/** One file per request (keeps each upload under Vercel's ~4.5MB body limit and its own timeout). */
export const POST = api(async (req) => {
  const form = await req.formData();
  const symbol = String(form.get("symbol") ?? "").trim();
  const file = form.get("file");
  if (!symbol) return NextResponse.json({ ok: false, error: "ต้องระบุสินทรัพย์" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "ไม่พบไฟล์" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ ok: false, error: "ไฟล์ใหญ่เกิน 4.5MB — ตัดเฉพาะหน้างบการเงินแล้วอัปโหลดใหม่" }, { status: 413 });
  if (!detectKind(file.name, file.type)) {
    return NextResponse.json({ ok: false, error: "รองรับเฉพาะ PDF, Excel (.xlsx) และ CSV" }, { status: 415 });
  }
  const result = await processUpload(symbol, { name: file.name, type: file.type, bytes: await file.arrayBuffer() });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
});
