"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ImportResult = {
  format: string | null;
  dryRun: boolean;
  parseErrors: { line: number; reason: string }[];
  parseErrorCount: number;
  results: { symbol: string; status: string; inserted: number; updated: number; skippedExisting: number; coverage?: { observations: number; firstDate: string | null; lastDate: string | null }; warnings: string[]; message?: string }[];
  summary: { rows: number; symbols: number; ok: number; unknown: number; inserted: number; updated: number; skippedExisting: number };
};

const FORMAT_LABEL: Record<string, string> = { long: "symbol, date, close", wide: "date + คอลัมน์ละหุ้น", single: "ไฟล์ของหุ้นตัวเดียว" };

export function PriceImport() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"preview" | "save" | null>(null);

  async function run(dryRun: boolean) {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    if (!(fd.get("file") instanceof File) || !(fd.get("file") as File).size) {
      setError("เลือกไฟล์ก่อน");
      return;
    }
    fd.set("dryRun", String(dryRun));
    setPending(dryRun ? "preview" : "save");
    setError(null);
    try {
      const res = await fetch("/api/v1/prices/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setResult(null);
      } else {
        setResult(data);
        if (!dryRun) router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  const s = result?.summary;
  return (
    <div className="space-y-3">
      <form ref={formRef} className="grid gap-3 sm:grid-cols-6" onSubmit={(e) => e.preventDefault()} onChange={() => setResult(null)}>
        <div className="sm:col-span-3">
          <label className="label">ไฟล์ .csv หรือ .xlsx (ชีตแรกที่มีข้อมูล)</label>
          <input name="file" type="file" accept=".csv,.txt,.xlsx" className="input" />
        </div>
        <div className="sm:col-span-2">
          <label className="label">สัญลักษณ์ (เฉพาะไฟล์ของหุ้นตัวเดียว)</label>
          <input name="symbol" className="input" placeholder="เช่น PTT" />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="overwriteExisting" className="accent-[var(--accent)]" /> เขียนทับราคาเดิม
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
          <button type="button" className="btn-ghost" disabled={!!pending} onClick={() => run(true)}>
            {pending === "preview" ? "กำลังตรวจ…" : "ตรวจสอบก่อน (ไม่บันทึก)"}
          </button>
          <button type="button" className="btn" disabled={!!pending || !result?.dryRun || (!s?.inserted && !s?.updated)} onClick={() => run(false)}>
            {pending === "save" ? "กำลังบันทึก…" : "บันทึก"}
          </button>
          <a href="/api/v1/prices/import/template" className="text-xs text-muted underline">ดาวน์โหลดไฟล์ตัวอย่าง</a>
        </div>
      </form>

      {error && <p className="text-sm text-neg">{error}</p>}

      {result && s && (
        <div className="space-y-2 text-sm">
          <p className={result.dryRun ? "text-muted" : "text-pos"}>
            {result.dryRun ? "ผลตรวจสอบ (ยังไม่บันทึก)" : "บันทึกแล้ว"} · รูปแบบ {result.format ? FORMAT_LABEL[result.format] ?? result.format : "-"} · {s.rows.toLocaleString()} แถว {s.symbols} สัญลักษณ์ ·
            {result.dryRun ? " จะเพิ่ม" : " เพิ่ม"} {s.inserted.toLocaleString()} · {result.dryRun ? "จะแก้" : "แก้"} {s.updated.toLocaleString()} · คงราคาเดิม {s.skippedExisting.toLocaleString()}
            {s.unknown ? ` · ไม่รู้จัก ${s.unknown} สัญลักษณ์` : ""}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3">สัญลักษณ์</th>
                  <th className="pr-3">สถานะ</th>
                  <th className="pr-3">ราคาในระบบ</th>
                  <th className="pr-3 text-right">เพิ่ม</th>
                  <th className="pr-3 text-right">แก้</th>
                  <th className="pr-3 text-right">คงเดิม</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.symbol} className="border-t border-[var(--border)] align-top">
                    <td className="py-1 pr-3 font-medium">{r.symbol}</td>
                    <td className={`pr-3 ${r.status === "ok" ? "text-pos" : "text-neg"}`}>{r.status === "ok" ? "ok" : r.status === "unknown_asset" ? "ยังไม่มีสินทรัพย์นี้" : r.status}</td>
                    <td className="pr-3">{r.coverage?.firstDate ? `${r.coverage.observations} วัน (${r.coverage.firstDate} – ${r.coverage.lastDate})` : "-"}</td>
                    <td className="pr-3 text-right">{r.inserted}</td>
                    <td className="pr-3 text-right">{r.updated}</td>
                    <td className="pr-3 text-right">{r.skippedExisting}</td>
                    <td className="text-muted">{[r.message, ...r.warnings].filter(Boolean).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.parseErrorCount > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-neg">อ่านไม่ได้ {result.parseErrorCount} บรรทัด</summary>
              <ul className="mt-1 max-h-48 overflow-y-auto text-muted">
                {result.parseErrors.map((e, i) => (
                  <li key={i}>บรรทัด {e.line}: {e.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
