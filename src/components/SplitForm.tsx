"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Preview = {
  dryRun: boolean;
  symbol: string;
  date: string;
  ratio: number;
  label: string;
  transactionId?: number;
  prices: { status: string; message: string; rowsToAdjust: number; rowsAdjusted: number; before: { date: string; close: number } | null; after: { date: string; close: number } | null } | null;
};

/** Record a split / reverse split: preview (quantity and price repair) → save. */
export function SplitForm({ symbols, today }: { symbols: string[]; today: string }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(symbols[0] ?? "");
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("2");
  const [adjust, setAdjust] = useState(true);
  const [res, setRes] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function send(dryRun: boolean) {
    setPending(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/transactions/split", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, date, splitFrom: Number(from), splitTo: Number(to), adjustPrices: adjust, dryRun, source: "web" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}`);
      setRes(data);
      if (!dryRun) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setPending(false);
    }
  }

  const ratio = Number(to) / Number(from);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-6" onChange={() => setRes(null)}>
        <label className="block sm:col-span-2">
          <span className="label">สินทรัพย์</span>
          <select className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">วันที่มีผล (XS/วันแรกที่ซื้อขายราคาใหม่)</span>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">หุ้นเดิม</span>
          <input className="input" inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">หุ้นใหม่</span>
          <input className="input" inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="flex items-end text-xs text-muted">
          {Number.isFinite(ratio) && ratio > 0 ? (ratio > 1 ? `แตกพาร์: หุ้น ×${+ratio.toFixed(4)}` : ratio < 1 ? `รวมพาร์: หุ้น ×${+ratio.toFixed(4)}` : "1:1 ไม่มีผล") : ""}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} className="accent-[var(--accent)]" /> ปรับราคาย้อนหลังที่ยังเป็นราคาเดิมให้ด้วย (ตรวจก่อน ไม่ปรับซ้ำ)
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost" disabled={pending || !symbol} onClick={() => send(true)}>
          {pending ? "กำลังตรวจ…" : "ตรวจสอบก่อน"}
        </button>
        <button type="button" className="btn" disabled={pending || !res?.dryRun} onClick={() => send(false)}>
          บันทึกแตกพาร์
        </button>
      </div>
      {error && <p className="text-sm text-neg">{error}</p>}
      {res && (
        <div className="space-y-1 text-sm">
          <p className={res.dryRun ? "text-muted" : "text-pos"}>
            {res.dryRun ? "ตรวจแล้ว (ยังไม่บันทึก)" : `บันทึกแล้ว (รายการ #${res.transactionId})`} · {res.symbol} {res.label} วันที่ {res.date} · จำนวนหุ้น ×{+res.ratio.toFixed(4)} ต้นทุนรวมเท่าเดิม ไม่กระทบเงินสด
          </p>
          {res.prices && (
            <p className="text-xs text-muted">
              ราคาย้อนหลัง: {res.prices.message}
              {res.prices.before && res.prices.after && ` (ก่อน ${res.prices.before.date} = ${res.prices.before.close}, หลัง ${res.prices.after.date} = ${res.prices.after.close})`}
              {!res.dryRun && ` · ปรับแล้ว ${res.prices.rowsAdjusted} วัน`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
